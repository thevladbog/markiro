import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";

const migrationsFolder = join(__dirname, "../migrations");
const migrationPath = join(migrationsFolder, "0149_offline_grant_readiness.sql");

it("installs immutable readiness storage with owner-scoped request identities", async () => {
  const sql = await readFile(migrationPath, "utf8");

  expect(sql).toContain('CREATE TABLE "device_grant_client_readiness_reports"');
  expect(sql).toContain("device_grant_client_readiness_station_request_uq");
  expect(sql).toContain("device_grant_client_readiness_kiosk_request_uq");
  expect(sql).toContain("device_grant_client_readiness_reports_immutable");
  expect(sql).toContain("device_grant_client_readiness_configuration_fk");
  expect(sql).toContain("device_grant_client_readiness_verified_grant_fk");
});

describe.skipIf(!process.env.DATABASE_URL)("offline grant readiness forward migration", () => {
  const name = `grant_readiness_${randomUUID().replaceAll("-", "_")}`;
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const stationId = randomUUID();
  const handheldId = randomUUID();
  const kioskId = randomUUID();
  const foreignStationId = randomUUID();
  const configurationId = randomUUID();
  const grantId = randomUUID();
  const policyId = randomUUID();
  const requestId = randomUUID();
  let created = false;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await runRuntimeMigrations({
      databaseUrl: databaseUrl.toString(),
      migrationsFolder,
      log: () => {},
    });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('readiness-a','A','readiness-a',now()),('readiness-b','B','readiness-b',now())",
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name,kind) VALUES ($1,'readiness-a','Station','station'),($2,'readiness-a','Handheld','handheld'),($3,'readiness-b','Foreign','station')",
      [stationId, handheldId, foreignStationId],
    );
    await pool.query("INSERT INTO kiosks(id,tenant_id,name) VALUES ($1,'readiness-a','Kiosk')", [
      kioskId,
    ]);
    await pool.query(
      "INSERT INTO platform_users(id,name,email,role) VALUES ('readiness-approver','Approver','readiness@example.invalid','platform_admin')",
    );
    await pool.query(
      "INSERT INTO entitlement_lifecycle_policies(id,policy_key,version,status,payload,payload_hash,decision_reference,approved_at,approved_by_platform_user_id,created_by_platform_user_id) VALUES ($1,'readiness',1,'approved','{}',$2,'fixture',now(),'readiness-approver','readiness-approver')",
      [policyId, "a".repeat(64)],
    );
    await pool.query(
      "INSERT INTO device_grant_configurations(id,tenant_id,owner_kind,station_device_id,credential_epoch,mode,policy_id,policy_revision,decision_reference) VALUES ($1,'readiness-a','station',$2,1,'observe',$3,'policy-1','fixture')",
      [configurationId, stationId, policyId],
    );
    await pool.query(
      "INSERT INTO device_grant_issuances(grant_id,tenant_id,owner_kind,station_device_id,credential_epoch,kind_of_grant,policy_id,policy_revision,entitlement_revision,request_identity,header_kid,compact_jws,payload_digest,issued_at,start_not_after) VALUES ($1,'readiness-a','station',$2,1,'device',$3,'policy-1','entitlement-1',$4,'key-1','header.payload.signature',$5,now(),now()+interval '1 hour')",
      [grantId, stationId, policyId, randomUUID(), "b".repeat(64)],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  });

  const insertReport = (overrides: Record<string, unknown> = {}) => {
    const values = {
      tenantId: "readiness-a",
      ownerKind: "station",
      stationDeviceId: stationId,
      kioskId: null,
      credentialEpoch: 1,
      requestId,
      payloadDigest: "c".repeat(64),
      clientBuild: "station:fixture",
      storageRevision: 1,
      reportedMode: "observe",
      reportedPolicyRevision: "policy-1",
      reportedKeysetRevision: "keyset-1",
      reportedGrantId: grantId,
      configurationId,
      verifiedGrantId: grantId,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
      ...overrides,
    };
    return pool.query(
      `INSERT INTO device_grant_client_readiness_reports(
        tenant_id,owner_kind,station_device_id,kiosk_id,credential_epoch,request_id,
        payload_digest,client_build,storage_revision,reported_mode,reported_policy_revision,
        reported_keyset_revision,reported_grant_id,configuration_id,verified_grant_id,
        matches_current_configuration,verified_grant_matched,received_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now()) RETURNING id`,
      Object.values(values),
    );
  };

  it("retains one immutable payload for a complete request identity", async () => {
    const inserted = await insertReport();
    await expect(insertReport()).rejects.toMatchObject({ code: "23505" });
    await expect(insertReport({ payloadDigest: "d".repeat(64) })).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      pool.query(
        "UPDATE device_grant_client_readiness_reports SET client_build='changed' WHERE id=$1",
        [inserted.rows[0]?.id],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects invalid owner and cross-tenant matched facts", async () => {
    await expect(
      insertReport({
        ownerKind: "kiosk",
        stationDeviceId: stationId,
        kioskId: null,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23514)$/) });
    await expect(
      insertReport({
        tenantId: "readiness-b",
        stationDeviceId: foreignStationId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps the migration runner idempotent", async () => {
    const before = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='device_grant_client_readiness_reports' ORDER BY indexname",
    );
    await runRuntimeMigrations({
      databaseUrl: databaseUrl.toString(),
      migrationsFolder,
      log: () => {},
    });
    const after = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='device_grant_client_readiness_reports' ORDER BY indexname",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
