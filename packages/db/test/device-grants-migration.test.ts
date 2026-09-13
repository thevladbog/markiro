import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

describe.skipIf(!process.env.DATABASE_URL)("offline grant forward migration", () => {
  const name = `grant_migration_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const admin = new pg.Pool({ connectionString: url.toString() });
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const device = randomUUID(),
    otherDevice = randomUUID(),
    foreignDevice = randomUUID(),
    policy = randomUUID(),
    source = randomUUID(),
    grant = randomUUID();
  let created = false,
    temporary = "";
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporary = await mkdtemp(join(tmpdir(), "grant-migration-"));
    const migrations = join(__dirname, "../migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrations,
      targetFolder: temporary,
      lastIncludedIndex: 145,
    });
    await migrate(drizzle(pool), { migrationsFolder: temporary });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('grant-a','A','grant-a',now()),('grant-b','B','grant-b',now())",
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name) VALUES ($1,'grant-a','Legacy'),($2,'grant-a','Other'),($3,'grant-b','Foreign')",
      [device, otherDevice, foreignDevice],
    );
    await migrate(drizzle(pool), { migrationsFolder: migrations });
    await pool.query(
      "INSERT INTO platform_users(id,name,email,role) VALUES ('grant-approver','Approver','grant-approver@example.invalid','platform_admin')",
    );
    await pool.query(
      "INSERT INTO entitlement_lifecycle_policies(id,policy_key,version,status,payload,payload_hash,decision_reference,approved_at,approved_by_platform_user_id,created_by_platform_user_id) VALUES ($1,'test-only',1,'approved','{}',$2,'fixture',now(),'grant-approver','grant-approver')",
      [policy, "a".repeat(64)],
    );
    await pool.query(
      "INSERT INTO device_grant_task_sources(id,tenant_id,owner_kind,station_device_id,credential_epoch,task_kind,task_id,snapshot_digest,scope,event_types,budget,policy_id,policy_revision) VALUES ($1,'grant-a','station',$2,1,'shift',$3,$4,'{}','[\"shift.close.v1\"]','[{\"id\":\"shift.close.v1:events\",\"unit\":\"event\",\"maximum\":1}]',$5,'revision')",
      [source, device, randomUUID(), "b".repeat(64), policy],
    );
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  async function issuance(owner = device, tenant = "grant-a", id = grant) {
    return pool.query(
      "INSERT INTO device_grant_issuances(grant_id,tenant_id,owner_kind,station_device_id,credential_epoch,kind_of_grant,task_source_id,policy_id,policy_revision,entitlement_revision,request_identity,header_kid,compact_jws,payload_digest,issued_at,complete_not_after) VALUES($1,$2,'station',$3,1,'task',$4,$5,'revision','0',$7,'test-key','test.signed.bytes',$6,now(),now()+interval '1 second')",
      [id, tenant, owner, source, policy, "c".repeat(64), id],
    );
  }
  it("initializes existing devices without reassigning identity", async () => {
    expect(
      (await pool.query("SELECT credential_epoch,name FROM station_devices WHERE id=$1", [device]))
        .rows,
    ).toEqual([{ credential_epoch: 1, name: "Legacy" }]);
  });
  it("rejects cross-tenant native ownership", async () => {
    await expect(issuance(foreignDevice)).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a same-tenant source belonging to another device", async () => {
    await expect(issuance(otherDevice)).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps original issuance and source bytes immutable after epoch advance", async () => {
    await issuance();
    await pool.query("UPDATE station_devices SET api_key_id='new-owner' WHERE id=$1", [device]);
    expect(
      (
        await pool.query("SELECT credential_epoch FROM device_grant_issuances WHERE grant_id=$1", [
          grant,
        ])
      ).rows[0],
    ).toEqual({ credential_epoch: 1 });
    await expect(
      pool.query("UPDATE device_grant_issuances SET compact_jws='changed' WHERE grant_id=$1", [
        grant,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM device_grant_task_sources WHERE id=$1", [source]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
