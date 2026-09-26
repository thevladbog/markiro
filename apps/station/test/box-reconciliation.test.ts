import { DatabaseSync } from "node:sqlite";
import { boxMembershipDigestV1, canonicalizeKm, kmHash } from "@markiro/domain";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../src/lib/mirror.js";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { createSyncEngine } from "../src/lib/sync.js";
import { disassembleBox } from "../src/lib/boxes.js";
import {
  applyBoxReconciliationResults,
  readBoxReconciliationBatch,
  readBoxReconciliationIssues,
  readBoxReconciliationSummary,
  requestFullShiftReconciliation,
} from "../src/lib/box-reconciliation.js";

function fixture(): { exec: SqlExecutor; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  for (const migration of STATION_MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return {
    db,
    exec: {
      async run(sql, params = []) {
        db.prepare(sql).run(...(params as never[]));
      },
      async all<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
      async atomic(statements) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const changed = statements.map(({ sql, values = [], expectedChanges }) => {
            const result = db.prepare(sql).run(...(values as never[]));
            if (expectedChanges !== undefined && result.changes !== expectedChanges)
              throw new Error("unexpected changed rows");
            return Number(result.changes);
          });
          db.exec("COMMIT");
          return changed;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

function box(db: DatabaseSync, id: string, acked = true): void {
  db.prepare(
    `INSERT INTO boxes_mirror(box_id,shift_id,terminal_id,sscc,opened_at,closed_at,acked_at)
    VALUES(?,?,?,?,?,?,?)`,
  ).run(
    id,
    "shift-1",
    "dev-1",
    "123456789012345675",
    "2026-09-23T00:00:00.000Z",
    "2026-09-23T00:03:00.000Z",
    acked ? "2026-09-23T00:04:00.000Z" : null,
  );
}

function scans(db: DatabaseSync, boxId: string, count: number, omitJournal = -1): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = `010400638133393121S-${i}`;
    const canonical = canonicalizeKm(raw);
    const hash = kmHash(canonical);
    const at = new Date(Date.UTC(2026, 8, 23, 0, 1, i)).toISOString();
    hashes.push(hash);
    db.prepare(
      `INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id)
      VALUES(?,?,?,?,?,?)`,
    ).run(hash, "shift-1", canonical.gtin14, canonical.serial, at, boxId);
    if (i !== omitJournal)
      db.prepare(
        `INSERT INTO scan_events_mirror(shift_id,terminal_id,raw,verdict,scanned_at,operator_id)
      VALUES(?,?,?,?,?,?)`,
      ).run("shift-1", "dev-1", raw, "ok", at, "operator-1");
  }
  return hashes;
}

describe("closed-box reconciliation", () => {
  it("keeps the 201st due box for the next bounded request", async () => {
    const { db, exec } = fixture();
    for (let i = 0; i < 201; i++) {
      db.prepare(
        `INSERT INTO boxes_mirror
        (box_id,shift_id,terminal_id,sscc,opened_at,closed_at,acked_at)
        VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `b-${i}`,
        "shift-1",
        "dev-1",
        `sscc-${i}`,
        "2026-09-23T00:00:00.000Z",
        "2026-09-23T00:03:00.000Z",
        "2026-09-23T00:04:00.000Z",
      );
    }
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    expect(first).toHaveLength(200);
    await applyBoxReconciliationResults(
      exec,
      first,
      first.map((fact) => ({
        boxId: fact.boxId,
        status: "confirmed",
        reasonCode: "matched",
        serverItemCount: 0,
      })),
    );
    const second = await readBoxReconciliationBatch(exec, "shift-1");
    expect(second.map((fact) => fact.boxId)).toEqual(["b-200"]);
  });
  it("never associates a replayed outbox row with a concurrent new grant scan", async () => {
    const { db, exec } = fixture();
    db.prepare(
      `INSERT INTO offline_grant_event_evidence(event_id,grant_id,compact,scan_pending)
      VALUES(?,NULL,NULL,1)`,
    ).run("new-event");
    db.prepare(
      `INSERT INTO offline_grant_decisions(event_id,event_digest,decision_json,result_json)
      VALUES(?,?,?,?)`,
    ).run("new-event", "digest", '{"allow":true}', "{}");
    await exec.run(
      `INSERT INTO outbox(shift_id,raw,verdict,scanned_at,replay_origin)
      VALUES(?,?,?,?,1)`,
      ["s1", "OLD", "ok", "2026-09-23T00:00:00.000Z"],
    );
    expect(
      db
        .prepare(
          "SELECT scan_pending,outbox_id FROM offline_grant_event_evidence WHERE event_id='new-event'",
        )
        .get(),
    ).toEqual({ scan_pending: 1, outbox_id: null });
    await exec.run(
      `INSERT INTO outbox(shift_id,raw,verdict,scanned_at)
      VALUES(?,?,?,?)`,
      ["s1", "NEW", "ok", "2026-09-23T00:00:01.000Z"],
    );
    expect(
      db
        .prepare(
          "SELECT scan_pending,outbox_id FROM offline_grant_event_evidence WHERE event_id='new-event'",
        )
        .get(),
    ).toEqual({ scan_pending: 0, outbox_id: 2 });
  });
  it("runs the comparison inside the device-wide drain and resends a missing box with a fresh batch", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 2);
    const posts: string[] = [];
    let replayDelivered = false;
    const engine = createSyncEngine({
      exec,
      machineId: "machine-1",
      credentialGeneration: createCredentialGeneration("test-key"),
      onState: () => {},
      client: {
        async post<T>(path: string): Promise<T> {
          posts.push(path);
          if (path === "/station/boxes/reconciliation")
            return {
              results: [
                replayDelivered
                  ? { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 2 }
                  : {
                      boxId: "b1",
                      status: "replay_required",
                      reasonCode: "box_absent",
                      serverItemCount: null,
                    },
              ],
            } as T;
          if (path === "/station/scans") {
            replayDelivered = true;
            return { applied: 2, alreadyApplied: false, conflicts: [] } as T;
          }
          if (path === "/station/conflicts/status") return { reviewedCodeHashes: [] } as T;
          if (path === "/station/codes/releases")
            return { until: "0", releasedCodeHashes: [] } as T;
          throw new Error(`unexpected route ${path}`);
        },
      },
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
    expect(posts.filter((path) => path === "/station/boxes/reconciliation")).toHaveLength(2);
    expect(posts.filter((path) => path === "/station/scans")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT acked_at IS NOT NULL acked FROM boxes_mirror WHERE box_id='b1'").get(),
    ).toEqual({ acked: 1 });
    expect((await readBoxReconciliationSummary(exec, "shift-1")).confirmed).toBe(1);
  });

  it("uses a fresh batch identity when repairing a previously delivered box-only closure", async () => {
    const { db, exec } = fixture();
    box(db, "b1", false);
    scans(db, "b1", 1);
    const deliveredBatchIds: string[] = [];
    const claimed = new Set<string>();
    const engine = createSyncEngine({
      exec,
      machineId: "machine-1",
      credentialGeneration: createCredentialGeneration("test-key"),
      onState: () => {},
      client: {
        async post<T>(path: string, body?: unknown): Promise<T> {
          if (path === "/station/scans") {
            const batchId = (body as { batchId: string }).batchId;
            deliveredBatchIds.push(batchId);
            const alreadyApplied = claimed.has(batchId);
            claimed.add(batchId);
            return { applied: 0, alreadyApplied, conflicts: [] } as T;
          }
          if (path === "/station/boxes/reconciliation")
            return {
              results: [
                { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 1 },
              ],
            } as T;
          if (path === "/station/conflicts/status") return { reviewedCodeHashes: [] } as T;
          if (path === "/station/codes/releases")
            return { until: "0", releasedCodeHashes: [] } as T;
          throw new Error(`unexpected route ${path}`);
        },
      },
    });
    engine.nudge();
    await engine.idle();
    await requestFullShiftReconciliation(exec, "shift-1");
    const facts = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, facts, [
      { boxId: "b1", status: "replay_required", reasonCode: "closure_absent", serverItemCount: 1 },
    ]);
    engine.nudge();
    await engine.idle();
    engine.stop();
    expect(deliveredBatchIds).toHaveLength(2);
    expect(deliveredBatchIds[1]).not.toBe(deliveredBatchIds[0]);
    expect(claimed.size).toBe(2);
  });

  it("does not apply a reconciliation reply after its credential generation is sealed", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const generation = createCredentialGeneration("test-key");
    let beginRequest!: () => void;
    const started = new Promise<void>((resolve) => {
      beginRequest = resolve;
    });
    let resolveRequest!: (value: unknown) => void;
    const delayed = new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    });
    const engine = createSyncEngine({
      exec,
      machineId: "machine-1",
      credentialGeneration: generation,
      onState: () => {},
      client: {
        async post<T>(path: string): Promise<T> {
          if (path === "/station/boxes/reconciliation") {
            beginRequest();
            return delayed as Promise<T>;
          }
          if (path === "/station/conflicts/status") return { reviewedCodeHashes: [] } as T;
          if (path === "/station/codes/releases")
            return { until: "0", releasedCodeHashes: [] } as T;
          throw new Error(`unexpected route ${path}`);
        },
      },
    });
    engine.nudge();
    await started;
    await sealCredentialGeneration(generation);
    resolveRequest({
      results: [
        { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
      ],
    });
    await engine.idle();
    engine.stop();
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT acked_at FROM boxes_mirror WHERE box_id='b1'").get()).toEqual({
      acked_at: "2026-09-23T00:04:00.000Z",
    });
  });
  it("records full-audit intent and confirms only the checked revision", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    expect(first).toHaveLength(1);
    expect(first[0]?.itemCount).toBe(1);
    await requestFullShiftReconciliation(exec, "shift-1");
    await applyBoxReconciliationResults(exec, first, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 1 },
    ]);
    expect(
      db
        .prepare(
          "SELECT reconciliation_revision revision, confirmed_revision confirmed FROM boxes_mirror WHERE box_id='b1'",
        )
        .get(),
    ).toEqual({ revision: 2, confirmed: 0 });
    const next = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, next, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 1 },
    ]);
    expect((await readBoxReconciliationSummary(exec, "shift-1")).confirmed).toBe(1);
  });

  it("requeues a complete historic box, preserving exact raw and attribution", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    const hashes = scans(db, "b1", 20);
    const batch = await readBoxReconciliationBatch(exec, "shift-1");
    expect(batch[0]?.membershipDigest).toBe(boxMembershipDigestV1(hashes));
    await applyBoxReconciliationResults(exec, batch, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox WHERE box_id='b1'").get()).toEqual({ n: 20 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM outbox WHERE operator_id='operator-1' AND terminal_id='dev-1'",
        )
        .get(),
    ).toEqual({ n: 20 });
    expect(db.prepare("SELECT acked_at FROM boxes_mirror WHERE box_id='b1'").get()).toEqual({
      acked_at: null,
    });
    await applyBoxReconciliationResults(exec, batch, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox WHERE box_id='b1'").get()).toEqual({ n: 20 });
  });

  it("invalidates an earlier confirmation and checks immediately after replay acknowledgement", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 2);
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, first, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 2 },
    ]);
    await requestFullShiftReconciliation(exec, "shift-1");
    const audit = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, audit, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    expect((await readBoxReconciliationSummary(exec, "shift-1")).confirmed).toBe(0);
    expect((await readBoxReconciliationSummary(exec, "shift-1")).pending).toBe(1);
    expect(await readBoxReconciliationBatch(exec, "shift-1")).toEqual([]);
    await exec.run("DELETE FROM outbox WHERE box_id='b1'");
    await exec.run("UPDATE boxes_mirror SET acked_at=? WHERE box_id='b1'", [
      "2026-09-23T00:06:00.000Z",
    ]);
    expect(await readBoxReconciliationBatch(exec, "shift-1")).toHaveLength(1);
  });

  it("does not count a previously confirmed box with a new hard mismatch as confirmed", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, first, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 1 },
    ]);
    await requestFullShiftReconciliation(exec, "shift-1");
    const next = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, next, [
      {
        boxId: "b1",
        status: "content_mismatch",
        reasonCode: "digest_mismatch",
        serverItemCount: 1,
      },
    ]);
    expect(await readBoxReconciliationSummary(exec, "shift-1")).toMatchObject({
      confirmed: 0,
      pending: 1,
      issues: 1,
    });
    expect(await readBoxReconciliationBatch(exec, "shift-1")).toEqual([]);
  });

  it("does not periodically recheck a confirmed revision", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    const facts = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, facts, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 0 },
    ]);
    expect(
      await readBoxReconciliationBatch(exec, "shift-1", 200, "9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("retries an unresolved issue only after its two-minute check window", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    const facts = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, facts, [
      { boxId: "b1", status: "content_mismatch", reasonCode: "count_mismatch", serverItemCount: 1 },
    ]);
    expect(await readBoxReconciliationBatch(exec, "shift-1")).toEqual([]);
    expect(
      await readBoxReconciliationBatch(exec, "shift-1", 200, "9999-01-01T00:00:00.000Z"),
    ).toHaveLength(1);
  });

  it("clears a pallet conflict once a later check confirms the box", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, first, [
      {
        boxId: "b1",
        status: "identity_conflict",
        reasonCode: "pallet_conflict",
        serverItemCount: 1,
      },
    ]);
    expect(await readBoxReconciliationSummary(exec, "shift-1")).toMatchObject({
      confirmed: 0,
      issues: 1,
    });
    const retry = await readBoxReconciliationBatch(
      exec,
      "shift-1",
      200,
      "9999-01-01T00:00:00.000Z",
    );
    await applyBoxReconciliationResults(exec, retry, [
      { boxId: "b1", status: "confirmed", reasonCode: "matched", serverItemCount: 1 },
    ]);
    expect(await readBoxReconciliationSummary(exec, "shift-1")).toMatchObject({
      confirmed: 1,
      pending: 0,
      issues: 0,
    });
  });

  it("drops the issue of a box the operator takes apart", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const facts = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, facts, [
      { boxId: "b1", status: "content_mismatch", reasonCode: "count_mismatch", serverItemCount: 0 },
    ]);
    expect(await readBoxReconciliationSummary(exec, "shift-1")).toMatchObject({ issues: 1 });

    // A disassembled box is never checked again, so only its retirement can
    // resolve the issue it carried.
    await disassembleBox(exec, {
      boxId: "b1",
      shiftId: "shift-1",
      terminalId: "dev-1",
      operatorId: null,
      reason: "Пересборка",
      at: "2026-09-26T10:00:00.000Z",
    });
    expect(await readBoxReconciliationSummary(exec, "shift-1")).toMatchObject({ issues: 0 });
    expect(await readBoxReconciliationIssues(exec)).toEqual([]);
  });

  it("stops automatic replay when the server still reports the box absent after re-ack", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const first = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, first, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    await exec.run("DELETE FROM outbox WHERE box_id='b1'");
    await exec.run("UPDATE boxes_mirror SET acked_at='ack' WHERE box_id='b1'");
    const control = await readBoxReconciliationBatch(exec, "shift-1");
    expect(control[0]?.controlAfterReplay).toBe(true);
    await applyBoxReconciliationResults(exec, control, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT reason_code FROM box_reconciliation_issues WHERE box_id='b1'").get(),
    ).toEqual({ reason_code: "replay_not_confirmed" });
    expect(await readBoxReconciliationBatch(exec, "shift-1")).toEqual([]);
  });

  it.each(["box_absent", "closure_absent"])(
    "retains the post-replay control marker when the process stops after %s commit",
    async (reasonCode) => {
      const { db, exec } = fixture();
      box(db, "b1");
      scans(db, "b1", 1);
      const facts = await readBoxReconciliationBatch(exec, "shift-1");
      const crashAfterCommit: SqlExecutor = {
        ...exec,
        atomic: async (statements) => {
          await exec.atomic!(statements);
          throw new Error("process stopped after commit");
        },
      };
      await expect(
        applyBoxReconciliationResults(crashAfterCommit, facts, [
          { boxId: "b1", status: "replay_required", reasonCode, serverItemCount: 1 },
        ]),
      ).rejects.toThrow("process stopped after commit");
      expect(
        db
          .prepare("SELECT last_checked_revision checked FROM boxes_mirror WHERE box_id='b1'")
          .get(),
      ).toEqual({ checked: 1 });
      await exec.run("DELETE FROM outbox WHERE box_id='b1'");
      await exec.run("UPDATE boxes_mirror SET acked_at='ack' WHERE box_id='b1'");
      expect((await readBoxReconciliationBatch(exec, "shift-1"))[0]?.controlAfterReplay).toBe(true);
    },
  );

  it("does not queue a partial box when one historic scan is missing", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 20, 7);
    const batch = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, batch, [
      { boxId: "b1", status: "replay_required", reasonCode: "box_absent", serverItemCount: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT acked_at FROM boxes_mirror WHERE box_id='b1'").get()).toEqual({
      acked_at: "2026-09-23T00:04:00.000Z",
    });
    expect(
      db.prepare("SELECT status FROM box_reconciliation_issues WHERE box_id='b1'").get(),
    ).toEqual({ status: "replay_evidence_missing" });
  });

  it("does not commit a partial replay when the held transaction fails", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 2);
    const batch = await readBoxReconciliationBatch(exec, "shift-1");
    const failing: SqlExecutor = {
      ...exec,
      atomic: async (statements) => {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO outbox")))
          throw new Error("simulated native transaction failure");
        return exec.atomic!(statements);
      },
    };
    await expect(
      applyBoxReconciliationResults(failing, batch, [
        {
          boxId: "b1",
          status: "replay_required",
          reasonCode: "box_absent",
          serverItemCount: null,
        },
      ]),
    ).rejects.toThrow("simulated native transaction failure");
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT acked_at FROM boxes_mirror WHERE box_id='b1'").get()).toEqual({
      acked_at: "2026-09-23T00:04:00.000Z",
    });
  });

  it("does not apply a late response after a newer full-audit request", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    const old = await readBoxReconciliationBatch(exec, "shift-1");
    await requestFullShiftReconciliation(exec, "shift-1");
    await applyBoxReconciliationResults(exec, old, [
      {
        boxId: "b1",
        status: "confirmed",
        reasonCode: "matched",
        serverItemCount: 1,
      },
    ]);
    expect(
      db.prepare("SELECT confirmed_revision confirmed FROM boxes_mirror WHERE box_id='b1'").get(),
    ).toEqual({ confirmed: 0 });
  });

  it("refuses an ambiguous historic journal instead of selecting an arbitrary scan", async () => {
    const { db, exec } = fixture();
    box(db, "b1");
    scans(db, "b1", 1);
    db.exec(`INSERT INTO scan_events_mirror(shift_id,terminal_id,raw,verdict,scanned_at,operator_id)
      SELECT shift_id,terminal_id,raw,verdict,scanned_at,operator_id FROM scan_events_mirror`);
    const batch = await readBoxReconciliationBatch(exec, "shift-1");
    await applyBoxReconciliationResults(exec, batch, [
      {
        boxId: "b1",
        status: "replay_required",
        reasonCode: "box_absent",
        serverItemCount: null,
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM outbox").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT reason_code FROM box_reconciliation_issues WHERE box_id='b1'").get(),
    ).toEqual({ reason_code: "replay_evidence_missing" });
  });
});
