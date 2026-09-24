import { createSyncEngine } from "../src/lib/sync.js";
import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import {
  OfflineGrantDeniedError,
  recordScanWithOfflineGrant,
  type AcceptedCode,
  type ScanEventRow,
} from "../src/lib/journal.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { closeShiftOfflineWithGrant } from "../src/lib/shift-close.js";
import { closeCurrentBox, closeCurrentBoxWithOfflineGrant } from "../src/lib/close-box.js";

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

function fixture(maximum = 1, beforeAtomic?: () => void, grantId = "grant") {
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
      // Command inserts are the commit boundary for the paths that drive their
      // trigger through `run` rather than `atomic`.
      if (
        sql.includes("offline_grant_scan_commands") ||
        sql.includes("offline_grant_box_close_commands")
      )
        beforeAtomic?.();
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

describe("grant-backed scan owner transaction", () => {
  it("retains the accepted box identity in the grant-backed scan journal", async () => {
    const { db, exec, generation } = fixture();
    await recordScanWithOfflineGrant(
      exec,
      event("boxed"),
      { ...code("hash-boxed"), boxId: "box-1" },
      generation,
      clock,
    );
    expect(db.prepare("SELECT code_hash,box_id FROM scan_events_mirror").get()).toEqual({
      code_hash: "hash-boxed",
      box_id: "box-1",
    });
    db.close();
  });
  it("uploads retired grant evidence from the actual scan owner and ACKs only native reconciliation", async () => {
    const grantId = "11111111-1111-4111-8111-111111111111";
    const { db, exec, generation } = fixture(2, undefined, grantId);
    await recordScanWithOfflineGrant(
      exec,
      { ...event("scan-evidence"), raw: "ABC\u001d93tail" },
      code("hash"),
      generation,
      clock,
    );
    db.exec("DELETE FROM offline_grant_grants");
    const post = vi.fn().mockImplementation(async (_path: string, body: { batchId: string }) => ({
      protocol: "offline-grants-v1",
      batchId: body.batchId,
      outcome: "accepted",
      reason: null,
      receiptId: "22222222-2222-4222-8222-222222222222",
      reconciliation: {
        status: "applied",
        statusCode: 201,
        result: { applied: 1, alreadyApplied: false },
      },
    }));
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
    expect(post.mock.calls[0]?.[0]).toBe("/station/grants/v1/evidence/scans");
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      grants: ["compact"],
      eventGrants: { "/items/0#shift.scan.v1": grantId },
      payload: { items: [{ raw: "ABC\u001d93tail" }] },
    });
    expect(db.prepare("SELECT count(*) count FROM outbox").get()).toEqual({ count: 0 });
    db.close();
  });

  it("pins the exact committed grant and scan outbox identity across retirement", async () => {
    const { db, exec, generation } = fixture(2);
    await recordScanWithOfflineGrant(exec, event("first"), code("same"), generation, clock);
    await recordScanWithOfflineGrant(exec, event("duplicate"), code("same"), generation, clock);
    db.exec("DELETE FROM offline_grant_grants");
    expect(
      db
        .prepare(
          "SELECT event_id,grant_id,compact,outbox_id FROM offline_grant_event_evidence ORDER BY outbox_id",
        )
        .all(),
    ).toEqual([
      { event_id: "first", grant_id: "grant", compact: "compact", outbox_id: 1 },
      { event_id: "duplicate", grant_id: "grant", compact: "compact", outbox_id: 2 },
    ]);
    expect(() =>
      db.exec("UPDATE offline_grant_event_evidence SET compact='replacement'"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM offline_grant_event_evidence")).toThrow();
    db.close();
  });

  it("commits the last unit with its fact, event, charge and outbox, then denies the racer", async () => {
    const { db, exec, generation } = fixture();
    await expect(
      recordScanWithOfflineGrant(exec, event("winner"), code("hash-1"), generation, clock),
    ).resolves.toEqual({ storedCode: true, alreadyPresent: false });
    await expect(
      recordScanWithOfflineGrant(exec, event("loser"), code("hash-2"), generation, clock),
    ).rejects.toEqual(expect.objectContaining({ reason: "budget_exhausted" }));
    expect(db.prepare("SELECT count(*) count FROM codes_mirror").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM scan_events_mirror").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM outbox").get()).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT budget_line_id,consumed FROM offline_grant_consumption ORDER BY budget_line_id",
        )
        .all(),
    ).toEqual([
      { budget_line_id: "shift.scan.v1:events", consumed: 1 },
      { budget_line_id: "shift.scan.v1:units", consumed: 1 },
    ]);
    expect(
      db
        .prepare(
          "SELECT json_extract(decision_json,'$.reason') reason FROM offline_grant_decisions WHERE event_id='loser'",
        )
        .get(),
    ).toEqual({ reason: "budget_exhausted" });
  });

  it("rolls back the grant decision and charge when the productive outbox write fails", async () => {
    const { db, exec, generation } = fixture();
    db.exec(
      "CREATE TRIGGER fail_scan_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'outbox failed'); END",
    );
    await expect(
      recordScanWithOfflineGrant(exec, event("failed"), code("hash"), generation, clock),
    ).rejects.toThrow(/outbox failed/);
    for (const table of [
      "codes_mirror",
      "scan_events_mirror",
      "outbox",
      "offline_grant_decisions",
      "offline_grant_consumption",
      "offline_grant_event_commands",
    ]) {
      expect(db.prepare(`SELECT count(*) count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
  });

  it("charges no unit when a concurrent code owner turns the scan into a duplicate", async () => {
    const { db, exec, generation } = fixture(2);
    await recordScanWithOfflineGrant(exec, event("first"), code("same"), generation, clock);
    await expect(
      recordScanWithOfflineGrant(exec, event("duplicate"), code("same"), generation, clock),
    ).resolves.toEqual({ storedCode: false, alreadyPresent: true });
    expect(
      db
        .prepare(
          "SELECT budget_line_id,consumed FROM offline_grant_consumption ORDER BY budget_line_id",
        )
        .all(),
    ).toEqual([
      { budget_line_id: "shift.scan.v1:events", consumed: 1 },
      { budget_line_id: "shift.scan.v1:units", consumed: 1 },
    ]);
    expect(db.prepare("SELECT verdict,code_hash FROM outbox ORDER BY id").all()).toEqual([
      { verdict: "ok", code_hash: "same" },
      { verdict: "duplicate", code_hash: null },
    ]);
  });

  it("requires the signed-in operator to remain active in the durable roster", async () => {
    const { db, exec, generation } = fixture();
    db.prepare("UPDATE operators_mirror SET active=0 WHERE operator_id='operator'").run();
    await expect(
      recordScanWithOfflineGrant(exec, event("inactive"), null, generation, clock),
    ).rejects.toBeInstanceOf(OfflineGrantDeniedError);
  });

  it("authorizes only the published roster bank", async () => {
    const revoked = fixture();
    revoked.db.exec(`INSERT INTO operators_mirror_b(operator_id,name,role,pin_hash,active)
      VALUES('operator','Operator','operator','hash',0);
      INSERT INTO station_meta(key,value) VALUES('operators_slot','b');`);
    await expect(
      recordScanWithOfflineGrant(revoked.exec, event("revoked-b"), null, revoked.generation, clock),
    ).rejects.toBeInstanceOf(OfflineGrantDeniedError);

    const authorized = fixture();
    authorized.db.exec(`UPDATE operators_mirror SET active=0 WHERE operator_id='operator';
      INSERT INTO operators_mirror_b(operator_id,name,role,pin_hash,active)
      VALUES('operator','Operator','operator','hash',1);
      INSERT INTO station_meta(key,value) VALUES('operators_slot','b');`);
    await expect(
      recordScanWithOfflineGrant(
        authorized.exec,
        event("authorized-b"),
        code("authorized-hash"),
        authorized.generation,
        clock,
      ),
    ).resolves.toEqual({ storedCode: true, alreadyPresent: false });
  });

  it("rejects publication that revokes the operator between admission and commit", async () => {
    const holder: { db?: DatabaseSync } = {};
    const raced = fixture(1, () => {
      if (!holder.db) throw new Error("missing test database");
      holder.db.exec(`DELETE FROM operators_mirror_b;
        INSERT INTO station_meta(key,value) VALUES('operators_slot','b')
        ON CONFLICT(key) DO UPDATE SET value='b';`);
    });
    holder.db = raced.db;
    await expect(
      recordScanWithOfflineGrant(raced.exec, event("roster-race"), null, raced.generation, clock),
    ).rejects.toThrow(/OPERATOR_UNAUTHORIZED/);
    expect(raced.db.prepare("SELECT count(*) count FROM scan_events_mirror").get()).toEqual({
      count: 0,
    });
  });

  it("rejects an accepted code whose GTIN differs from the signed execution", async () => {
    const { db, exec, generation } = fixture();
    await expect(
      recordScanWithOfflineGrant(
        exec,
        event("wrong-gtin"),
        { ...code("wrong-gtin-hash"), gtin14: "04600000000018" },
        generation,
        clock,
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: "wrong_task" }));
    expect(db.prepare("SELECT count(*) count FROM codes_mirror").get()).toEqual({ count: 0 });
  });

  it("rejects when the durable execution changes between owner read and commit", async () => {
    const holder: { db?: DatabaseSync } = {};
    const raced = fixture(1, () => {
      if (!holder.db) throw new Error("missing test database");
      holder.db
        .prepare("UPDATE shift_mirror SET execution_scope_json=? WHERE id='shift'")
        .run(
          JSON.stringify({ ...actualScope, product: { ...actualScope.product, name: "Changed" } }),
        );
    });
    holder.db = raced.db;
    await expect(
      recordScanWithOfflineGrant(
        raced.exec,
        event("execution-race"),
        code("execution-race-hash"),
        raced.generation,
        clock,
      ),
    ).rejects.toThrow(/EXECUTION_CHANGED/);
    expect(raced.db.prepare("SELECT count(*) count FROM codes_mirror").get()).toEqual({ count: 0 });
  });

  it("commits shift closure, its event outbox and task charge together", async () => {
    const { db, exec, generation } = fixture();
    const stored = JSON.parse(
      (
        db.prepare("SELECT grant_json FROM offline_grant_grants WHERE grant_id='grant'").get() as {
          grant_json: string;
        }
      ).grant_json,
    );
    stored.eventTypes.push("shift.close.v1");
    stored.budget.push({ id: "shift.close.v1:events", unit: "event", maximum: 1 });
    db.prepare("UPDATE offline_grant_grants SET grant_json=? WHERE grant_id='grant'").run(
      JSON.stringify(stored),
    );
    const closed = await closeShiftOfflineWithGrant(
      exec,
      { shiftId: "shift", deviceId: "device", operatorId: "operator" },
      generation,
      () => new Date("2026-09-13T01:00:00.000Z"),
      clock,
    );
    expect(closed).toEqual(expect.objectContaining({ shiftId: "shift", actualQty: 0 }));
    expect(db.prepare("SELECT status FROM shift_mirror WHERE id='shift'").get()).toEqual({
      status: "closed",
    });
    expect(db.prepare("SELECT event_id FROM shift_close_outbox").get()).toEqual({
      event_id: closed.eventId,
    });
    expect(
      db
        .prepare(
          "SELECT consumed FROM offline_grant_consumption WHERE budget_line_id='shift.close.v1:events'",
        )
        .get(),
    ).toEqual({ consumed: 1 });
  });

  it("closes a box with the same durable charge and serial allocation", async () => {
    const { db, exec, generation } = fixture();
    const stored = JSON.parse(
      (
        db.prepare("SELECT grant_json FROM offline_grant_grants WHERE grant_id='grant'").get() as {
          grant_json: string;
        }
      ).grant_json,
    );
    stored.eventTypes.push("shift.box.close.v1");
    stored.budget.push(
      { id: "shift.box.close.v1:events", unit: "event", maximum: 1 },
      { id: "shift.box.close.v1:containers", unit: "container", maximum: 1 },
    );
    db.prepare("UPDATE offline_grant_grants SET grant_json=? WHERE grant_id='grant'").run(
      JSON.stringify(stored),
    );
    db.exec(
      "INSERT INTO boxes_mirror(box_id,shift_id,opened_at) VALUES('box','shift','2026-09-13T00:00:00.000Z'); INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES('boxed','shift','04600000000001','s','2026-09-13T00:00:00.000Z','box'); INSERT INTO sscc_pool(issuer_prefix,extension_digit,from_serial,to_serial,next_serial) VALUES('460068200',0,1,1,1)",
    );
    const result = await closeCurrentBoxWithOfflineGrant(
      {
        exec,
        issuerPrefix: "460068200",
        palletBoxCapacity: null,
        terminalId: "device",
        now: () => Date.parse("2026-09-13T01:00:00.000Z"),
      },
      "shift",
      "operator",
      generation,
      clock,
    );
    expect(result).toEqual(expect.objectContaining({ status: "closed", itemCount: 1 }));
    expect(
      db.prepare("SELECT closed_at,print_state FROM boxes_mirror WHERE box_id='box'").get(),
    ).toEqual({ closed_at: "2026-09-13T01:00:00.000Z", print_state: "pending" });
    expect(db.prepare("SELECT next_serial FROM sscc_pool").get()).toEqual({ next_serial: 2 });
    expect(
      db
        .prepare(
          "SELECT budget_line_id,consumed FROM offline_grant_consumption WHERE budget_line_id LIKE 'shift.box.close.v1:%' ORDER BY budget_line_id",
        )
        .all(),
    ).toEqual([
      { budget_line_id: "shift.box.close.v1:containers", consumed: 1 },
      { budget_line_id: "shift.box.close.v1:events", consumed: 1 },
    ]);
  });

  it("names a box another owner closed first, instead of claiming a second SSCC", async () => {
    const holder: { db?: DatabaseSync } = {};
    // The winner commits between `currentBox` and this caller's own commit, so
    // the trigger's `closed_at IS NULL` guard leaves our SSCC unused.
    let racedOnce = false;
    const raced = fixture(1, () => {
      // The hook also fires while the fixture itself writes; the race is the
      // first commit that finds this box open.
      if (racedOnce || !holder.db) return;
      const changed = holder.db
        .prepare(
          // The winner's own SSCC, cut from a different serial than ours.
          "UPDATE boxes_mirror SET sscc='046006820000000025',closed_at='2026-09-13T00:30:00.000Z' WHERE box_id='box' AND closed_at IS NULL",
        )
        .run();
      racedOnce = Number(changed.changes) === 1;
    });
    holder.db = raced.db;
    const stored = JSON.parse(
      (
        raced.db
          .prepare("SELECT grant_json FROM offline_grant_grants WHERE grant_id='grant'")
          .get() as { grant_json: string }
      ).grant_json,
    );
    stored.eventTypes.push("shift.box.close.v1");
    stored.budget.push(
      { id: "shift.box.close.v1:events", unit: "event", maximum: 1 },
      { id: "shift.box.close.v1:containers", unit: "container", maximum: 1 },
    );
    raced.db
      .prepare("UPDATE offline_grant_grants SET grant_json=? WHERE grant_id='grant'")
      .run(JSON.stringify(stored));
    raced.db.exec(
      "INSERT INTO boxes_mirror(box_id,shift_id,opened_at) VALUES('box','shift','2026-09-13T00:00:00.000Z'); INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES('boxed','shift','04600000000001','s','2026-09-13T00:00:00.000Z','box'); INSERT INTO sscc_pool(issuer_prefix,extension_digit,from_serial,to_serial,next_serial) VALUES('460068200',0,1,1,1)",
    );

    const result = await closeCurrentBoxWithOfflineGrant(
      {
        exec: raced.exec,
        issuerPrefix: "460068200",
        palletBoxCapacity: null,
        terminalId: "device",
        now: () => Date.parse("2026-09-13T01:00:00.000Z"),
      },
      "shift",
      "operator",
      raced.generation,
      clock,
    );

    expect(racedOnce).toBe(true);
    expect(result).toEqual({ status: "already-closed" });
    expect(raced.db.prepare("SELECT sscc FROM boxes_mirror WHERE box_id='box'").get()).toEqual({
      sscc: "046006820000000025",
    });
  });

  it("does not leave the exported legacy box writer usable with active grant state", async () => {
    const { exec } = fixture();
    await expect(
      closeCurrentBox(
        { exec, issuerPrefix: "460068200", palletBoxCapacity: null, terminalId: "device" },
        "shift",
        "operator",
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: "grant_aware_owner_required" }));
  });
});
