import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationPath = join(migrationsFolder, "0152_offline_grant_activation.sql");

describe("offline grant activation migration", () => {
  it("installs constrained, empty activation persistence", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('CREATE TABLE "offline_grant_activation_preparations"');
    expect(sql).toContain('CREATE TABLE "offline_grant_activation_members"');
    expect(sql).toContain('CREATE TABLE "offline_grant_device_activations"');
    expect(sql).toContain("offline_grant_activation_confirm_actor_check");
    expect(sql).toContain("confirmed_by_platform_user_id");
    expect(sql).toContain("prepared_by_platform_user_id");
    expect(sql).toContain("offline_grant_device_activations_station_active_uq");
    expect(sql).toContain("offline_grant_device_activations_kiosk_active_uq");
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+"?(?:offline_grant_activation|entitlement_lifecycle_policies)/i,
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("offline grant activation forward migration", () => {
  const name = `grant_activation_${randomUUID().replaceAll("-", "_")}`;
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  databaseUrl.search = "";
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const stationId = randomUUID();
  const configurationId = randomUUID();
  const reportId = randomUUID();
  let temporaryRoot = "";
  let created = false;
  let before: unknown;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-grant-activation-"));
    const throughReadiness = join(temporaryRoot, "through-readiness");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: throughReadiness,
      lastIncludedIndex: 151,
    });
    await migrate(drizzle(pool), { migrationsFolder: throughReadiness });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('activation-a','A','activation-a',now())",
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name,kind) VALUES ($1,'activation-a','Line A','station')",
      [stationId],
    );
    await pool.query(
      "INSERT INTO device_grant_configurations(id,tenant_id,owner_kind,station_device_id,credential_epoch,mode) VALUES ($1,'activation-a','station',$2,1,'observe')",
      [configurationId, stationId],
    );
    await pool.query(
      `INSERT INTO device_grant_client_readiness_reports(
        id,tenant_id,owner_kind,station_device_id,credential_epoch,request_id,payload_digest,
        client_build,storage_revision,reported_mode,matches_current_configuration,
        verified_grant_matched,received_at
      ) VALUES ($1,'activation-a','station',$2,1,$3,$4,'station:legacy',1,'observe',false,false,now())`,
      [reportId, stationId, randomUUID(), "a".repeat(64)],
    );
    before = (
      await pool.query(
        `SELECT c.id,c.tenant_id,c.owner_kind,c.station_device_id,c.kiosk_id,
                c.credential_epoch,c.mode,c.policy_id,c.policy_revision,c.decision_reference,c.issued_at,
                r.id AS report_id,r.payload_digest,r.client_build,r.received_at
           FROM device_grant_configurations c
           JOIN device_grant_client_readiness_reports r ON r.configuration_id IS NULL
          WHERE c.id=$1 AND r.id=$2`,
        [configurationId, reportId],
      )
    ).rows;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("preserves legacy readiness and configuration facts without activating devices", async () => {
    const after = (
      await pool.query(
        `SELECT c.id,c.tenant_id,c.owner_kind,c.station_device_id,c.kiosk_id,
                c.credential_epoch,c.mode,c.policy_id,c.policy_revision,c.decision_reference,c.issued_at,
                r.id AS report_id,r.payload_digest,r.client_build,r.received_at
           FROM device_grant_configurations c
           JOIN device_grant_client_readiness_reports r ON r.configuration_id IS NULL
          WHERE c.id=$1 AND r.id=$2`,
        [configurationId, reportId],
      )
    ).rows;
    expect(after).toEqual(before);
    expect(
      (
        await pool.query("SELECT activation_id FROM device_grant_configurations WHERE id=$1", [
          configurationId,
        ])
      ).rows,
    ).toEqual([{ activation_id: null }]);
    for (const table of [
      "offline_grant_activation_preparations",
      "offline_grant_activation_members",
      "offline_grant_device_activations",
    ]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows).toEqual([
        { count: 0 },
      ]);
    }
  });

  it("keeps the migration set idempotent", async () => {
    await migrate(drizzle(pool), { migrationsFolder });
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM offline_grant_device_activations"))
        .rows,
    ).toEqual([{ count: 0 }]);
  });
});
