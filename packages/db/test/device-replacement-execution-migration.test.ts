import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const hash = "a".repeat(64);

describe.skipIf(!databaseUrl)("replacement execution forward migration", () => {
  const name = `markiro_execution_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;
  let legacyBytes: string;
  let relationFiles: unknown;
  const source = randomUUID();
  const otherSource = randomUUID();
  const foreignSource = randomUUID();
  const target = randomUUID();
  const preparation = randomUUID();
  const activePreparation = randomUUID();
  let intent: string;
  let report: string;

  async function legacyRows() {
    return JSON.stringify(
      (
        await pool.query(
          "SELECT row_to_json(p)::text AS bytes FROM working_device_replacement_preparations p ORDER BY id",
        )
      ).rows,
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-execution-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: temporaryRoot,
      lastIncludedIndex: 167,
    });
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder: temporaryRoot,
      log: () => undefined,
    });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('exec-a','A','exec-a',now()),('exec-b','B','exec-b',now())",
    );
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name,kind) VALUES ($1,'exec-a','Source','station'),($2,'exec-a','Other','station'),($3,'exec-b','Foreign','station'),($4,'exec-a','Target','station')",
      [source, otherSource, foreignSource, target],
    );
    for (const id of [preparation, activePreparation]) {
      const preview = randomUUID();
      await pool.query(
        `INSERT INTO working_device_replacement_previews
        (id,tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expires_at)
        VALUES ($1,'exec-a',$2,'cabinet','owner',$3,'{}',$4,$4,'{}',now()+interval '5 minutes')`,
        [preview, source, randomUUID(), hash],
      );
      await pool.query(
        `INSERT INTO working_device_replacement_preparations
        (id,tenant_id,device_id,preview_id,actor_domain,actor_id,observation,facts_fingerprint)
        VALUES ($1,'exec-a',$2,$3,'cabinet','owner','{}',$4)`,
        [id, source, preview, hash],
      );
      // Cancel the first row so both legacy terminal and active rows exist before upgrade.
      if (id === preparation)
        await pool.query(
          `UPDATE working_device_replacement_preparations SET state='cancelled',revision=2,cancelled_at=now(),cancelled_actor_domain='cabinet',cancelled_actor_id='owner' WHERE id=$1`,
          [id],
        );
    }
    legacyBytes = await legacyRows();
    relationFiles = (
      await pool.query(
        "SELECT oid,relfilenode FROM pg_class WHERE oid IN ('working_device_replacement_preparations'::regclass,'station_pairing_codes'::regclass,'working_device_events'::regclass,'working_device_assignments'::regclass) ORDER BY oid",
      )
    ).rows;
    await pool.query(`CREATE TABLE replacement_test_ddl_trace (tx bigint, statement text);
      CREATE FUNCTION replacement_test_trace() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO replacement_test_ddl_trace VALUES (txid_current(),current_query()); END; $$;
      CREATE EVENT TRIGGER replacement_test_trace_trigger ON ddl_command_end EXECUTE FUNCTION replacement_test_trace();`);
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  const insertIntent = async (patch: Record<string, unknown> = {}) => {
    const data = {
      id: randomUUID(),
      tenant_id: "exec-a",
      device_id: source,
      preparation_id: activePreparation,
      actor_domain: "cabinet",
      actor_id: "owner",
      request_id: randomUUID(),
      request_hash: hash,
      credential_epoch: 1,
      preparation_revision: 1,
      assignment_revision: 1,
      entitlement_revision: 1,
      usage_revision: 1,
      facts_fingerprint: hash,
      requested_at: new Date("2026-09-16T10:00:00Z"),
      expires_at: new Date("2026-09-16T10:05:00Z"),
      ...patch,
    };
    return insert("working_device_replacement_readiness_intents", data);
  };
  const insertReport = async (patch: Record<string, unknown> = {}) =>
    insert("working_device_replacement_readiness_reports", {
      id: randomUUID(),
      tenant_id: "exec-a",
      device_id: source,
      preparation_id: activePreparation,
      intent_id: intent,
      request_id: randomUUID(),
      credential_epoch: 1,
      report_sequence: 0,
      client_build: "2.1.0",
      storage_revision: 1,
      payload: {},
      payload_hash: hash,
      counters: {
        scans: 0,
        inventories: 0,
        shiftClosures: 0,
        productLabels: 0,
        boxes: 0,
        exceptions: 0,
        conflicts: 0,
        unknownPrints: 0,
      },
      eligibility: { status: "eligible", reasons: [] },
      response: {},
      ...patch,
    });
  const insertExecution = async (patch: Record<string, unknown> = {}) =>
    insert("working_device_replacement_executions", {
      id: randomUUID(),
      tenant_id: "exec-a",
      device_id: source,
      preparation_id: activePreparation,
      actor_domain: "cabinet",
      actor_id: "owner",
      request_id: randomUUID(),
      request_hash: hash,
      mode: "normal",
      source_credential_epoch: 1,
      facts_fingerprint: hash,
      readiness_report_id: report,
      offline_authority_until: new Date("2026-09-16T10:00:00Z"),
      new_work_allowed_at: new Date("2026-09-16T10:00:00Z"),
      ...patch,
    });
  async function insert(table: string, data: Record<string, unknown>) {
    const fields = Object.keys(data);
    await pool.query(
      `INSERT INTO ${table} (${fields.map((field) => `"${field}"`).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(data).map((value) =>
        value !== null && typeof value === "object" && !(value instanceof Date)
          ? JSON.stringify(value)
          : value,
      ),
    );
    return String(data.id);
  }

  it("preserves legacy prepared/cancelled rows byte for byte across upgrade and replay", async () => {
    expect(await legacyRows()).toBe(legacyBytes);
    expect(
      (
        await pool.query(
          "SELECT oid,relfilenode FROM pg_class WHERE oid IN ('working_device_replacement_preparations'::regclass,'station_pairing_codes'::regclass,'working_device_events'::regclass,'working_device_assignments'::regclass) ORDER BY oid",
        )
      ).rows,
    ).toEqual(relationFiles);
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(await legacyRows()).toBe(legacyBytes);
  });
  it("commits constraint addition before the separate validation transaction", async () => {
    const added = (
      await pool.query(
        "SELECT DISTINCT tx FROM replacement_test_ddl_trace WHERE statement LIKE '%ADD CONSTRAINT%NOT VALID%'",
      )
    ).rows;
    const validated = (
      await pool.query(
        "SELECT DISTINCT tx FROM replacement_test_ddl_trace WHERE statement LIKE '%VALIDATE CONSTRAINT%'",
      )
    ).rows;
    expect(added).toHaveLength(1);
    expect(validated).toHaveLength(1);
    expect(added).not.toEqual(validated);
  });
  it("preserves full-width entitlement revisions and accepts absent grant configuration", async () => {
    const id = await insertIntent({
      entitlement_revision: "9007199254740992",
      usage_revision: "9007199254740993",
      grant_configuration_id: null,
      grant_configuration_sequence: null,
      state: "superseded",
      closed_at: new Date("2026-09-16T10:01:00Z"),
    });
    expect(
      (
        await pool.query(
          "SELECT entitlement_revision,usage_revision FROM working_device_replacement_readiness_intents WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ entitlement_revision: "9007199254740992", usage_revision: "9007199254740993" }]);
  });
  it("creates all execution tables and validates their payload constraints", async () => {
    const result = await pool.query(
      "SELECT convalidated FROM pg_constraint WHERE conname='working_device_replacement_reports_payload_check'",
    );
    expect(result.rows).toEqual([{ convalidated: true }]);
  });
  it("rejects cross-tenant and cross-source preparation bindings", async () => {
    await expect(insertIntent({ device_id: foreignSource })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insertIntent({ device_id: otherSource })).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertIntent({ tenant_id: "exec-b", device_id: foreignSource }),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("requires positive finite epochs, revisions and intent intervals", async () => {
    for (const field of ["credential_epoch", "preparation_revision", "assignment_revision"]) {
      await expect(insertIntent({ [field]: 0 })).rejects.toMatchObject({ code: "23514" });
    }
    await expect(insertIntent({ expires_at: "infinity" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertIntent({ actor_id: " " })).rejects.toMatchObject({ code: "23514" });
  });
  it("allows one active intent and scopes request identities to the tenant and actor domain", async () => {
    const request = randomUUID();
    intent = await insertIntent({ request_id: request });
    await expect(insertIntent()).rejects.toMatchObject({ code: "23505" });
    await expect(
      insertIntent({
        state: "superseded",
        closed_at: new Date("2026-09-16T10:01:00Z"),
        request_id: request,
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await insertIntent({
      state: "superseded",
      closed_at: new Date("2026-09-16T10:01:00Z"),
      actor_domain: "platform",
      request_id: request,
    });
  });
  it("pins append-only reports to their source, intent epoch, sequence and request", async () => {
    await expect(insertReport({ credential_epoch: 2 })).rejects.toMatchObject({ code: "23503" });
    await expect(insertReport({ device_id: otherSource })).rejects.toMatchObject({ code: "23503" });
    await expect(insertReport({ report_sequence: -1 })).rejects.toMatchObject({ code: "23514" });
    const request = randomUUID();
    report = await insertReport({ request_id: request });
    await expect(insertReport()).rejects.toMatchObject({ code: "23505" });
    await expect(insertReport({ report_sequence: 1, request_id: request })).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      pool.query(
        "UPDATE working_device_replacement_readiness_reports SET payload='{}' WHERE id=$1",
        [report],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM working_device_replacement_readiness_reports WHERE id=$1", [report]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects arrays, oversized payloads and invalid normalized measurements", async () => {
    for (const value of [null, true, -1, 0.5, "0", "unknown", 9007199254740992]) {
      await expect(
        insertReport({
          report_sequence: 10,
          counters: {
            scans: value,
            inventories: 0,
            shiftClosures: 0,
            productLabels: 0,
            boxes: 0,
            exceptions: 0,
            conflicts: 0,
            unknownPrints: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
    for (const patch of [
      { payload: [] },
      { payload: { huge: "x".repeat(262_145) } },
      { counters: [] },
      { counters: { scans: -1 } },
      { counters: { scans: null } },
      { eligibility: { status: "eligible", reasons: ["pending_scans"] } },
    ]) {
      await expect(insertReport({ report_sequence: 10, ...patch })).rejects.toMatchObject({
        code: "23514",
      });
    }
  });
  it("requires normal readiness and emergency reason/recovery correlation", async () => {
    await expect(insertExecution({ revision: 0 })).rejects.toMatchObject({ code: "23514" });
    await expect(insertExecution({ readiness_report_id: null })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insertExecution({ mode: "emergency", readiness_report_id: null }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(insertExecution({ target_device_id: target })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insertExecution({ new_work_allowed_at: "infinity" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insertExecution({ recovery_state: "completed" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insertExecution({ source_credential_epoch: 2 })).rejects.toMatchObject({
      code: "23503",
    });
  });
  it("creates at most one execution/target and cannot complete before credential revocation", async () => {
    const execution = await insertExecution();
    await expect(insertExecution()).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,state='completed',step='transferred',target_device_id=$2,executed_at=now(),response='{}' WHERE id=$1",
        [execution, target],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,step='credential_revoked',credential_revoked_at=now() WHERE id=$1",
      [execution],
    );
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,state='completed',step='transferred',target_device_id=$2,executed_at=now(),response='{}' WHERE id=$1",
      [execution, target],
    );
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET target_device_id=$2 WHERE id=$1",
        [execution, otherSource],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("allows lifecycle transitions with revision fencing and preserves terminal preparation history", async () => {
    await pool.query(
      "UPDATE working_device_replacement_preparations SET state='draining',revision=revision+1 WHERE id=$1",
      [activePreparation],
    );
    await expect(
      pool.query("UPDATE working_device_replacement_preparations SET state='ready' WHERE id=$1", [
        activePreparation,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const state of ["ready", "executing", "completed"])
      await pool.query(
        "UPDATE working_device_replacement_preparations SET state=$2,revision=revision+1 WHERE id=$1",
        [activePreparation, state],
      );
    await expect(
      pool.query(
        "UPDATE working_device_replacement_preparations SET state='cancelled',revision=revision+1,cancelled_at=now(),cancelled_actor_domain='cabinet',cancelled_actor_id='owner' WHERE id=$1",
        [activePreparation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps completed preparation revisions frozen while recovery belongs to execution", async () => {
    await expect(
      pool.query(
        "UPDATE working_device_replacement_preparations SET revision=revision+1 WHERE id=$1",
        [activePreparation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("retains emergency recovery until an explicit terminal close and rejects duplicate targets", async () => {
    const preview = randomUUID();
    const emergencyPreparation = randomUUID();
    await pool.query(
      `INSERT INTO working_device_replacement_previews (id,tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expires_at) VALUES ($1,'exec-a',$2,'cabinet','owner',$3,'{}',$4,$4,'{}',now()+interval '5 minutes')`,
      [preview, otherSource, randomUUID(), hash],
    );
    await pool.query(
      `INSERT INTO working_device_replacement_preparations (id,tenant_id,device_id,preview_id,actor_domain,actor_id,observation,facts_fingerprint) VALUES ($1,'exec-a',$2,$3,'cabinet','owner','{}',$4)`,
      [emergencyPreparation, otherSource, preview, hash],
    );
    const id = await insertExecution({
      device_id: otherSource,
      preparation_id: emergencyPreparation,
      mode: "emergency",
      emergency_reason: "Lost device",
      recovery_state: "required",
      readiness_report_id: null,
    });
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,step='credential_revoked',credential_revoked_at=now() WHERE id=$1",
      [id],
    );
    const complete = (targetId: string) =>
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,state='completed',step='transferred',target_device_id=$2,executed_at=now(),response='{}' WHERE id=$1",
        [id, targetId],
      );
    await expect(complete(foreignSource)).rejects.toMatchObject({ code: "23503" });
    await expect(complete(target)).rejects.toMatchObject({ code: "23505" });
    const freshTarget = randomUUID();
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name) VALUES ($1,'exec-a','Emergency target')",
      [freshTarget],
    );
    await complete(freshTarget);
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET recovery_state='draining' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,recovery_state='draining',recovery_credential_epoch=3 WHERE id=$1",
      [id],
    );
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,recovery_state='evidence_unavailable' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,recovery_state='evidence_unavailable',recovery_closed_at=now(),recovery_close_reason='Storage destroyed' WHERE id=$1",
      [id],
    );
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,recovery_state='required',recovery_closed_at=null,recovery_close_reason=null WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    "replacement_drain_requested",
    "replacement_ready",
    "replacement_execution_started",
    "replacement_transferred",
    "replacement_recovery_started",
    "replacement_recovery_completed",
    "replacement_recovery_unavailable",
  ])("requires actor and matching immutable receipt for %s", async (action) => {
    const request = randomUUID();
    const row = {
      id: randomUUID(),
      tenant_id: "exec-a",
      device_id: source,
      actor_domain: "cabinet",
      actor_id: "owner",
      action,
      before: { state: "assigned" },
      after: { state: "released" },
      request_id: request,
      request_hash: hash,
      response: { requestId: request },
    };
    await expect(insert("working_device_events", { ...row, response: {} })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("working_device_events", { ...row, actor_id: null })).rejects.toMatchObject(
      { code: "23514" },
    );
    await insert("working_device_events", row);
    await expect(
      pool.query("UPDATE working_device_events SET response='{}' WHERE id=$1", [row.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps a transferred assignment terminal", async () => {
    await pool.query(
      "INSERT INTO working_device_assignments (tenant_id,device_id,state,provenance,released_at,release_reason) VALUES ('exec-a',$1,'released','runtime',now(),'replacement_transferred')",
      [source],
    );
    await expect(
      pool.query(
        "UPDATE working_device_assignments SET state='assigned',released_at=null,release_reason=null WHERE tenant_id='exec-a' AND device_id=$1",
        [source],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("preserves normal pairing defaults and rejects unknown purposes", async () => {
    const row = {
      id: randomUUID(),
      tenant_id: "exec-a",
      station_device_id: target,
      code_hash: hash,
      expires_at: new Date("2026-09-16T11:00:00Z"),
      issued_by_user_id: "owner",
    };
    await expect(
      insert("station_pairing_codes", { ...row, purpose: "production_recovery" }),
    ).rejects.toMatchObject({ code: "23514" });
    await insert("station_pairing_codes", row);
    expect(
      (await pool.query("SELECT purpose FROM station_pairing_codes WHERE id=$1", [row.id])).rows,
    ).toEqual([{ purpose: "normal" }]);
  });
});
