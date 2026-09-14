import { createSyncEngine } from "../src/lib/sync.js";
import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import {
  recordScanWithOfflineGrant,
  type AcceptedCode,
  type ScanEventRow,
} from "../src/lib/journal.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

const actualScope = {
  shift: {
    id: "shift",
    productId: "product",
    mode: "aggregation",
    lineId: null,
    counterpartyId: null,
    counterpartyName: null,
    labelTemplateId: null,
    boxLabelTemplateId: null,
    palletLabelTemplateId: null,
    validationPrintMode: null,
    allowPreviouslyAcceptedCodes: false,
    validationPrintVerification: null,
    validationPrintTemplateId: null,
    validationPrintSnapshot: null,
    validationPrintPolicyRevision: null,
    boxCapacity: 12,
    palletsEnabled: false,
    palletBoxCapacity: null,
    stationClosePolicy: null,
    stationCloseOwnerDeviceId: null,
    plannedDate: null,
    productionDate: null,
    number: "SEP26-001",
  },
  product: {
    id: "product",
    gtin14: "04600000000001",
    name: "Product",
    printName: null,
    egaisCode: null,
    shelfLifeDays: null,
  },
  templates: [],
};
const signedScope = {
  ...actualScope,
  shift: { ...actualScope.shift, numberMonthKey: "SEP26", numberSeq: 1, createdFrom: "admin" },
};

function fixture(
  maximum = 1,
  beforeAtomic?: () => void,
  grantId = "11111111-1111-4111-8111-111111111111",
) {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  const exec: SqlExecutor = {
    async run(sql: string, values = []) {
      if (sql.includes("offline_grant_scan_commands")) beforeAtomic?.();
      db.prepare(sql).run(...(values as never[]));
    },
    async all<T>(sql: string, values = []) {
      return db.prepare(sql).all(...(values as never[])) as T[];
    },
    async atomic(statements) {
      beforeAtomic?.();
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map((statement) =>
          Number(
            db.prepare(statement.sql).run(...([...(statement.values ?? [])] as never[])).changes,
          ),
        );
        db.exec("COMMIT");
        return changes;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const grant = {
    version: 1,
    kindOfGrant: "task",
    issuer: "https://issuer.invalid",
    grantId,
    tenantId: "tenant",
    deviceId: "device",
    kind: "station",
    credentialEpoch: 3,
    entitlementRevision: "entitlement",
    policyRevision: "policy",
    issuedAt: 50,
    notBefore: 50,
    taskKind: "shift",
    taskId: "shift",
    snapshotDigest: "digest",
    completeNotAfter: 1_000,
    eventTypes: ["shift.scan.v1"],
    budget: [
      { id: "shift.scan.v1:events", unit: "event", maximum },
      { id: "shift.scan.v1:units", unit: "unit", maximum },
    ],
  };
  db.prepare(
    "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,?,?,?,1)",
  ).run("operator", "Operator", "operator", "hash");
  db.prepare(
    "INSERT INTO shift_mirror(id,status,mode,product_id,execution_scope_json) VALUES(?,?,?,?,?)",
  ).run("shift", "active", "aggregation", "product", JSON.stringify(actualScope));
  db.exec(`INSERT INTO offline_grant_install_state(id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
    VALUES(1,'tenant','device','station',3,1,'strict');
    INSERT INTO offline_grant_clock(id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
    VALUES(1,100,10,'boot',100,200);`);
  db.prepare(
    "INSERT INTO offline_grant_grants(grant_id,kid,compact,grant_json,credential_epoch,installed_sequence) VALUES(?,?,?,?,?,?)",
  ).run(grantId, "kid", "compact", JSON.stringify(grant), 3, 1);
  db.prepare(
    "INSERT INTO offline_grant_snapshots(task_kind,task_id,snapshot_digest,canonical,scope_json,installed_sequence) VALUES(?,?,?,?,?,?)",
  ).run("shift", "shift", "digest", "canonical", JSON.stringify(signedScope), 1);
  return { db, exec, generation: createCredentialGeneration("secret") };
}

const event = (eventId: string): ScanEventRow => ({
  eventId,
  shiftId: "shift",
  terminalId: "device",
  raw: "raw",
  verdict: "ok",
  scannedAt: "2026-09-13T00:00:00.000Z",
  operatorId: "operator",
});
const code = (hash: string): AcceptedCode => ({
  codeHash: hash,
  shiftId: "shift",
  gtin14: "04600000000001",
  serial: "serial",
  scannedAt: "2026-09-13T00:00:00.000Z",
  boxId: null,
});
const clock = async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 });

const success = (batchId: string, result: unknown = { applied: 1, alreadyApplied: false }) => ({
  protocol: "offline-grants-v1",
  batchId,
  outcome: "accepted",
  reason: null,
  receiptId: "22222222-2222-4222-8222-222222222222",
  reconciliation: { status: "applied", statusCode: 201, result },
});

describe("Station negotiated scan recovery", () => {
  it("never ACKs a changed queue row under the original frozen receipt", async () => {
    const { db, exec, generation } = fixture(5);
    await recordScanWithOfflineGrant(exec, event("bound"), code("bound"), generation, clock);
    const post = vi.fn().mockImplementation(async (_path: string, body: { batchId: string }) => {
      db.exec("UPDATE outbox SET raw='changed-after-send'");
      return success(body.batchId);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "device",
      credentialGeneration: generation,
      onState() {},
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
    expect(db.prepare("SELECT raw FROM outbox").all()).toEqual([{ raw: "changed-after-send" }]);
    expect(
      db.prepare("SELECT value FROM station_meta WHERE key='sync_pending_batch_id'").get(),
    ).toBeDefined();
    log.mockRestore();
    db.close();
  });

  it("splits a newly assembled legacy prefix and negotiated observe prefix", async () => {
    const { db, exec, generation } = fixture(5);
    db.prepare(
      "INSERT INTO outbox(shift_id,terminal_id,raw,verdict,scanned_at,operator_id) VALUES(?,?,?,?,?,?)",
    ).run("shift", "device", "legacy", "invalid", event("x").scannedAt, "operator");
    db.exec(
      "UPDATE offline_grant_install_state SET mode='observe'; DELETE FROM offline_grant_grants;",
    );
    await recordScanWithOfflineGrant(exec, event("observed"), code("observed"), generation, clock);
    const post = vi
      .fn()
      .mockImplementation(async (path: string, body: { batchId: string }) =>
        path.includes("/evidence/") ? success(body.batchId) : { applied: 1, alreadyApplied: false },
      );
    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "device",
      credentialGeneration: generation,
      onState() {},
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      "/station/scans",
      "/station/grants/v1/evidence/scans",
    ]);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ items: [{ raw: "legacy" }] });
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      grants: [],
      eventGrants: {},
      payload: { items: [{ raw: "raw" }] },
    });
    expect(db.prepare("SELECT count(*) count FROM outbox").get()).toEqual({ count: 0 });
    db.close();
  });

  it("repairs partial local ACK from its immutable receipt after restart without extending the envelope", async () => {
    const { db, exec, generation } = fixture(5);
    await recordScanWithOfflineGrant(
      exec,
      { ...event("retained"), raw: "ABC\u001d93tail" },
      code("retained"),
      generation,
      clock,
    );
    let failAck = true;
    const interrupted: SqlExecutor = {
      ...exec,
      async atomic(statements) {
        if (
          failAck &&
          statements.some(
            (s) =>
              s.sql.startsWith("DELETE FROM station_meta") &&
              s.values?.includes("sync_pending_batch_id"),
          )
        ) {
          failAck = false;
          throw new Error("power loss after outbox ACK");
        }
        if (!exec.atomic) throw new Error("missing held connection");
        return exec.atomic(statements);
      },
      async run(sql, values) {
        if (
          failAck &&
          sql.startsWith("DELETE FROM station_meta") &&
          values?.includes("sync_pending_batch_id")
        ) {
          failAck = false;
          throw new Error("power loss after outbox ACK");
        }
        await exec.run(sql, values);
      },
    };
    const post = vi
      .fn()
      .mockImplementation(async (_path: string, body: { batchId: string }) =>
        success(body.batchId),
      );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = createSyncEngine({
      exec: interrupted,
      client: { post },
      machineId: "device",
      credentialGeneration: generation,
      onState() {},
    });
    first.nudge();
    await first.idle();
    first.stop();
    expect(db.prepare("SELECT count(*) count FROM outbox").get()).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT value FROM station_meta WHERE key='sync_pending_batch_id'").get(),
    ).toBeDefined();
    db.exec("DELETE FROM offline_grant_grants");
    const restarted = createSyncEngine({
      exec,
      client: { post },
      machineId: "device",
      credentialGeneration: createCredentialGeneration("secret"),
      onState() {},
    });
    restarted.nudge();
    await restarted.idle();
    restarted.stop();
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT value FROM station_meta WHERE key='sync_pending_batch_id'").get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT count(*) count FROM station_meta WHERE key LIKE 'offline_grant_evidence_receipt:%'",
        )
        .get(),
    ).toEqual({ count: 1 });
    log.mockRestore();
    db.close();
  });
});
