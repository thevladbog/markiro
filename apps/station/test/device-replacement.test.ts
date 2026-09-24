import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFileDatabase, makeRotatingExec } from "./support/sqlite-exec.js";
import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { StationGrantAdmission } from "../src/lib/offline-grants/admission.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import {
  prepareReplacementReadiness,
  applyReplacementClosure,
  acknowledgeReplacementClosure,
  replacementBlocksNewWork,
  drainReplacementReadiness,
  reportReplacementReadiness,
  readReplacementDrain,
  readReplacementMeasurements,
  replacementCanEnterTask,
} from "../src/lib/device-replacement.js";
const intent = {
  intentId: "11111111-1111-4111-8111-111111111111",
  preparationId: "22222222-2222-4222-8222-222222222222",
  credentialEpoch: 1,
  preparationRevision: 2,
  requestedAt: "2026-09-16T10:00:00.000Z",
  expiresAt: "2026-09-16T10:05:00.000Z",
};
function setup(path?: string) {
  const db = path ? openFileDatabase(path) : new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
  }
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  const generation = createCredentialGeneration("station-test-key");
  return {
    db,
    exec,
    generation,
    clientBuild: "station:test",
    expectedDevice: { tenantId: "tenant", deviceId: "device" },
  };
}
describe("replacement durable drain", () => {
  it("keeps acknowledged but unconfirmed boxes and issues in replacement readiness", async () => {
    const s = setup();
    s.db.exec(`INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,acked_at)
      VALUES('box-recheck','shift','123456789012345675','now','later','ack');
      INSERT INTO boxes_mirror(box_id,shift_id,opened_at,closed_at,acked_at)
      VALUES('box-without-sscc','shift','now','later','ack');
      INSERT INTO box_reconciliation_issues(box_id,shift_id,status,reason_code,local_item_count,checked_at)
      VALUES('box-recheck','shift','identity_conflict','sscc_conflict',1,'now');`);
    const measured = await readReplacementMeasurements(s.exec);
    expect(measured.pending.boxes).toBe(1);
    expect(measured.pending.exceptions).toBe(1);
  });
  it("persists the authenticated intent and retires device authority atomically", async () => {
    const s = setup();
    s.db.exec(
      `INSERT INTO offline_grant_grants VALUES('device','key','signed','{"kindOfGrant":"device"}',1,1); INSERT INTO offline_grant_grants VALUES('task','key','signed-task','{"kindOfGrant":"task"}',1,1);`,
    );
    await prepareReplacementReadiness({ ...s, intent });
    expect(await readReplacementDrain(s.exec)).not.toBeNull();
    expect(s.db.prepare("SELECT grant_id FROM offline_grant_grants").all()).toEqual([
      { grant_id: "task" },
    ]);
  });
  it("normalizes all channels and does not export journal payload", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    s.db.exec(
      `INSERT INTO outbox(shift_id,raw,verdict,scanned_at) VALUES('shift','secret-code','ok','now'); INSERT INTO inventory_outbox(inventory_id,snapshot_id,event_id,device_sequence,payload_json,created_at) VALUES('i','s','e',1,'{}','now'); INSERT INTO boxes_mirror(box_id,shift_id,opened_at,print_state) VALUES('b','shift','now','printing'); INSERT INTO conflicts_mirror VALUES('hash',NULL,'now','now'); INSERT INTO box_exceptions_mirror(kind,box_id,shift_id,at,reason) VALUES('reprint','b','shift','now','reason');`,
    );
    const report = await drainReplacementReadiness(s);
    expect(report?.body.pending).toEqual({
      scans: 1,
      inventories: 1,
      shiftClosures: 0,
      productLabels: 0,
      boxes: 1,
      exceptions: 1,
    });
    expect(report?.body.conflicts).toBe(1);
    expect(report?.body.unknownPrints).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret-code");
  });
  it("replays the exact persisted request after response loss and restart, then advances on the same intent", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    const first = await drainReplacementReadiness(s);
    expect(first).not.toBeNull();
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockImplementation(async (_p, body) => ({
        requestId: body.requestId,
        intentId: body.intentId,
        receivedAt: "2026-09-16T10:01:00Z",
        unsupportedChannels: [],
        eligibility: { status: "eligible", reasons: [] },
      }));
    await expect(reportReplacementReadiness({ ...s, client: { post } })).rejects.toThrow("lost");
    s.db.exec(`INSERT INTO outbox(shift_id,raw,verdict,scanned_at) VALUES('s','raw','ok','now')`);
    await reportReplacementReadiness({
      ...s,
      generation: createCredentialGeneration("station-test-key"),
      client: { post },
    });
    expect(post.mock.calls[0]?.[1]).toEqual(post.mock.calls[1]?.[1]);
    const next = await drainReplacementReadiness(s);
    expect(next?.body.intentId).toBe(intent.intentId);
    expect(next?.body.reportSequence).toBe(1);
    expect(next?.body.pending.scans).toBe(1);
  });
  it("cannot replace an unacknowledged request with a newer intent", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    await drainReplacementReadiness(s);
    await expect(
      prepareReplacementReadiness({
        ...s,
        intent: { ...intent, intentId: "33333333-3333-4333-8333-333333333333" },
      }),
    ).rejects.toThrow("PENDING");
  });
  it("rejects delayed device grant insertion during drain", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    expect(() =>
      s.db.exec(
        `INSERT INTO offline_grant_grants VALUES('late','key','signed','{"kindOfGrant":"device"}',1,2)`,
      ),
    ).toThrow("REPLACEMENT_DRAIN");
  });
  it("cannot acknowledge using another credential and propagates cancellation", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    await drainReplacementReadiness(s);
    const post = vi.fn();
    await expect(
      reportReplacementReadiness({
        ...s,
        generation: createCredentialGeneration("different"),
        client: { post },
      }),
    ).rejects.toThrow("credential");
    expect(post).not.toHaveBeenCalled();
    const aborted = new DOMException("cancelled", "AbortError");
    post.mockRejectedValue(aborted);
    await expect(reportReplacementReadiness({ ...s, client: { post } })).rejects.toBe(aborted);
    await sealCredentialGeneration(s.generation);
    await expect(reportReplacementReadiness({ ...s, client: { post } })).rejects.toThrow(
      "credential",
    );
  });
  it("blocks incomplete container printing even after the container is synchronized", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    s.db.exec(
      `INSERT INTO boxes_mirror(box_id,shift_id,opened_at,closed_at,acked_at,print_state) VALUES('b','s','now','now','now','pending'); INSERT INTO pallets_mirror(pallet_id,shift_id,opened_at,closed_at,acked_at,print_state) VALUES('p','s','now','now','now','printed');`,
    );
    expect((await readReplacementMeasurements(s.exec)).unknownPrints).toBe(2);
    s.db.exec(
      `UPDATE boxes_mirror SET print_verified_at='now'; UPDATE pallets_mirror SET print_skipped_at='now';`,
    );
    expect((await readReplacementMeasurements(s.exec)).unknownPrints).toBe(0);
  });
  it("measures missing channels as unsupported, never zero", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    s.db.exec("DROP TABLE conflicts_mirror");
    const body = (await drainReplacementReadiness(s))?.body;
    expect(body?.conflicts).toBe("unsupported");
    expect(body?.pending.scans).toBe("unsupported");
  });
  it("persists a zero-work active task for recovery but blocks different task entry and observe-mode new work", async () => {
    const s = setup();
    const taskId = "33333333-3333-4333-8333-333333333333";
    await prepareReplacementReadiness({ ...s, intent, activeTask: { taskId, kind: "shift" } });
    expect(await replacementCanEnterTask(s.exec, taskId, "shift")).toBe(true);
    expect(await replacementCanEnterTask(s.exec, "different", "shift")).toBe(false);
    const admission = new StationGrantAdmission(s.exec, async () => ({
      bootId: "boot",
      monotonicMs: 1,
      wallMs: 1,
    }));
    expect(
      (
        await admission.assessNewWork({
          owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 1 },
          capability: "shift.start.v1",
          taskId: "task",
          snapshotDigest: "start",
          eventId: "start",
          eventType: "shift.scan.v1",
          cost: {},
        })
      ).allow,
    ).toBe(false);
  });
  it("supersedes only acknowledged evidence and never rolls back to an older server intent", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    const newer = {
      ...intent,
      intentId: "33333333-3333-4333-8333-333333333333",
      requestedAt: "2026-09-16T10:02:00Z",
    };
    await expect(prepareReplacementReadiness({ ...s, intent: newer })).rejects.toThrow("PENDING");
    const post = vi.fn(async (_p: string, body: unknown) => {
      const b = body as { requestId: string; intentId: string };
      return {
        requestId: b.requestId,
        intentId: b.intentId,
        receivedAt: "2026-09-16T10:01:00Z",
        unsupportedChannels: [],
        eligibility: { status: "eligible", reasons: [] },
      };
    });
    await reportReplacementReadiness({ ...s, client: { post } });
    await prepareReplacementReadiness({ ...s, intent: newer });
    expect((await drainReplacementReadiness(s))?.body.intentId).toBe(newer.intentId);
    await expect(prepareReplacementReadiness({ ...s, intent })).rejects.toThrow("STALE");
    expect((await readReplacementDrain(s.exec))?.intent_id).toBe(newer.intentId);
  });
  it("does not acknowledge a response that arrives after credential sealing", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    const post = vi.fn(async (_p: string, body: unknown) => {
      await sealCredentialGeneration(s.generation);
      const b = body as { requestId: string; intentId: string };
      return {
        requestId: b.requestId,
        intentId: b.intentId,
        receivedAt: "2026-09-16T10:01:00Z",
        unsupportedChannels: [],
        eligibility: { status: "eligible", reasons: [] },
      };
    });
    await expect(reportReplacementReadiness({ ...s, client: { post } })).rejects.toThrow(
      "credential",
    );
    expect((await readReplacementDrain(s.exec))?.acknowledged_at).toBeNull();
  });
  it("counts label, close, quarantine and pinned channels without treating completed print history as unresolved", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    // Build isolated channel fixtures; production FK/acceptance atomicity is
    // exercised by the existing product-label SQLite and workflow suites.
    s.db.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO shift_close_outbox(event_id,shift_id,device_id,product_id,product_name,actual_qty,closed_box_count,closed_at) VALUES('close','s','d','p','product',0,0,'now');
      INSERT INTO product_label_jobs(credential_ownership,job_id,shift_id,projection_json,status,updated_at) VALUES('owner','job','s','{"attemptState":"delivery_unknown"}','attention','now');
      INSERT INTO product_label_outbox(credential_ownership,event_id,queued_at) VALUES('owner','event','now');
      INSERT INTO product_label_events(credential_ownership,event_id,job_id,sequence,event_json) VALUES('owner','quarantine','job',42,'{}');
      INSERT INTO product_label_receipts(credential_ownership,event_id,event_json,outcome,rejection_code,received_at) VALUES('owner','quarantine','{}','quarantined','storage_invalid','now');
      INSERT INTO station_meta(key,value) VALUES('offline_grant_evidence_pin:old-epoch','{}');
      PRAGMA foreign_keys=ON;`);
    let measured = await readReplacementMeasurements(s.exec);
    expect(measured.pending).toEqual({
      scans: 0,
      inventories: 0,
      shiftClosures: 1,
      productLabels: 2,
      boxes: 0,
      exceptions: 2,
    });
    expect(measured.unknownPrints).toBe(1);
    expect(measured.highestSequence).toBe(42);
    s.db.exec("UPDATE product_label_jobs SET status='completed'");
    measured = await readReplacementMeasurements(s.exec);
    expect(measured.unknownPrints).toBe(0);
    expect(measured.pending.productLabels).toBe(1);
  });
  it("reopens the exact pending report from a real SQLite file across pooled connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "station-replacement-"));
    const path = join(directory, "station.sqlite");
    const initial = setup(path);
    let second: DatabaseSync | null = null;
    let reopened: DatabaseSync | null = null;
    try {
      second = openFileDatabase(path);
      const exec = makeRotatingExec([initial.db, second]);
      await prepareReplacementReadiness({ ...initial, exec, intent });
      const pending = await drainReplacementReadiness({ ...initial, exec });
      second.close();
      second = null;
      initial.db.close();
      const restored = setup(path);
      reopened = restored.db;
      expect(await drainReplacementReadiness(restored)).toEqual(pending);
      expect(await replacementCanEnterTask(restored.exec, "new-task", "shift")).toBe(false);
    } finally {
      if (initial.db.isOpen) initial.db.close();
      second?.close();
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rolls back both intent and grant retirement when SQLite interrupts the atomic statement", async () => {
    const s = setup();
    s.db
      .exec(`INSERT INTO offline_grant_grants VALUES('device','key','signed','{"kindOfGrant":"device"}',1,1);
      CREATE TRIGGER interrupt_retirement BEFORE DELETE ON offline_grant_grants BEGIN SELECT RAISE(ABORT,'disk failure'); END;`);
    await expect(prepareReplacementReadiness({ ...s, intent })).rejects.toThrow("disk failure");
    expect(await readReplacementDrain(s.exec)).toBeNull();
    expect(s.db.prepare("SELECT grant_id FROM offline_grant_grants").all()).toEqual([
      { grant_id: "device" },
    ]);
  });
  it("keeps cancellation fenced across restart, failed ACK delivery, invalid responses and a failed durable commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "station-cancellation-"));
    const path = join(directory, "station.sqlite");
    const first = setup(path);
    let reopened: DatabaseSync | null = null;
    try {
      await prepareReplacementReadiness({ ...first, intent });
      await applyReplacementClosure({
        ...first,
        tombstone: {
          version: 1,
          state: "cancelled",
          intentId: intent.intentId,
          preparationId: intent.preparationId,
          credentialEpoch: 1,
          preparationRevision: 3,
          closedAt: "2026-09-16T10:02:00Z",
        },
      });
      const saved = (await readReplacementDrain(first.exec))?.closure_json;
      first.db.close();
      const restored = setup(path);
      reopened = restored.db;
      const assertFenced = async () => {
        expect((await readReplacementDrain(restored.exec))?.closure_acknowledged_at).toBeNull();
        expect(await replacementBlocksNewWork(restored.exec)).toBe(true);
        expect(await replacementCanEnterTask(restored.exec, "new-task", "shift")).toBe(false);
        const admission = new StationGrantAdmission(restored.exec, async () => ({
          bootId: "boot",
          monotonicMs: 1,
          wallMs: 1,
        }));
        const work = {
          owner: { tenantId: "t", deviceId: "d", kind: "station" as const, credentialEpoch: 1 },
          capability: "inventory.start.v1" as const,
          taskId: "new-task",
          snapshotDigest: "start",
          eventId: "start",
          eventType: "inventory.scan.v1" as const,
          cost: {},
        };
        expect((await admission.assessNewWork(work)).allow).toBe(false);
        expect(
          (
            await admission.commitNewWork(
              {
                intent: work,
                execution: {
                  taskKind: "inventory",
                  taskId: "new-task",
                  scope: {
                    manifest: {},
                    snapshotId: "snapshot",
                    combinedDigest: "a".repeat(64),
                    contentDigest: "b".repeat(64),
                  },
                },
              },
              restored.generation,
            )
          ).allow,
        ).toBe(false);
        expect(() =>
          restored.db.exec(
            `INSERT INTO offline_grant_grants VALUES('late','key','signed','{"kindOfGrant":"device"}',1,1000)`,
          ),
        ).toThrow("REPLACEMENT_DRAIN");
        expect(() =>
          restored.db.exec(
            `INSERT INTO offline_grant_task_admission_commands(admission_id,payload_json) VALUES('new-admission','{}')`,
          ),
        ).toThrow("REPLACEMENT_DRAIN");
      };
      await assertFenced();
      for (const reason of ["not delivered", "response lost"]) {
        await expect(
          acknowledgeReplacementClosure({
            ...restored,
            client: {
              post: async () => {
                throw new Error(reason);
              },
            },
          }),
        ).rejects.toThrow(reason);
        await assertFenced();
      }
      for (const mismatch of ["request", "tombstone"]) {
        await expect(
          acknowledgeReplacementClosure({
            ...restored,
            client: {
              post: async (_path, body) => ({
                ...(body as object),
                ...(mismatch === "request"
                  ? { requestId: "77777777-7777-4777-8777-777777777777" }
                  : {
                      tombstone: {
                        ...JSON.parse(saved ?? "{}").tombstone,
                        preparationRevision: 99,
                      },
                    }),
                acknowledgedAt: "2026-09-16T10:03:00Z",
              }),
            },
          }),
        ).rejects.toThrow("response mismatch");
        await assertFenced();
      }
      const noCommit: SqlExecutor = {
        all: restored.exec.all.bind(restored.exec),
        run: async () => undefined,
      };
      await expect(
        acknowledgeReplacementClosure({
          ...restored,
          exec: noCommit,
          client: {
            post: async (_path, body) => ({
              ...(body as object),
              acknowledgedAt: "2026-09-16T10:03:00Z",
            }),
          },
        }),
      ).rejects.toThrow("acknowledgement not persisted");
      await assertFenced();
      await expect(
        acknowledgeReplacementClosure({
          ...restored,
          generation: createCredentialGeneration("different-device"),
          client: {
            post: async () => {
              throw new Error("must not send");
            },
          },
        }),
      ).rejects.toThrow("credential mismatch");
      await assertFenced();
      restored.db.exec(
        `CREATE TRIGGER interrupt_closure_ack BEFORE UPDATE OF closure_acknowledged_at ON device_replacement_drain BEGIN SELECT RAISE(ABORT,'disk failure'); END`,
      );
      const post = vi.fn(async (_path: string, body: unknown) => ({
        ...(body as object),
        acknowledgedAt: "2026-09-16T10:03:00Z",
      }));
      await expect(
        acknowledgeReplacementClosure({ ...restored, client: { post } }),
      ).rejects.toThrow("disk failure");
      await assertFenced();
      restored.db.exec("DROP TRIGGER interrupt_closure_ack");
      expect(await acknowledgeReplacementClosure({ ...restored, client: { post } })).toBe(true);
      expect(JSON.stringify(post.mock.calls[0]?.[1])).toBe(saved);
      expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
      expect(await replacementBlocksNewWork(restored.exec)).toBe(false);
      expect(await replacementCanEnterTask(restored.exec, "new-task", "shift")).toBe(true);
    } finally {
      if (first.db.isOpen) first.db.close();
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps a completed source closed to new work after its terminal acknowledgement", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    await applyReplacementClosure({
      ...s,
      tombstone: {
        version: 1,
        state: "closed",
        intentId: intent.intentId,
        preparationId: intent.preparationId,
        credentialEpoch: 1,
        preparationRevision: 4,
        closedAt: "2026-09-16T10:04:00Z",
      },
    });
    expect(
      await acknowledgeReplacementClosure({
        ...s,
        client: {
          post: async (_path, body) => ({
            ...(body as object),
            acknowledgedAt: "2026-09-16T10:05:00Z",
          }),
        },
      }),
    ).toBe(false);
    expect(await replacementBlocksNewWork(s.exec)).toBe(true);
    expect(await replacementCanEnterTask(s.exec, "new-shift", "shift")).toBe(false);
    expect(await drainReplacementReadiness(s)).toBeNull();
  });
  it("releases only the exact newer cancellation, preserves an ACK retry and rejects delayed active responses", async () => {
    const s = setup();
    await prepareReplacementReadiness({ ...s, intent });
    await drainReplacementReadiness(s);
    const tombstone = {
      version: 1 as const,
      state: "cancelled" as const,
      intentId: intent.intentId,
      preparationId: intent.preparationId,
      credentialEpoch: 1,
      preparationRevision: 3,
      closedAt: "2026-09-16T10:02:00Z",
    };
    await expect(
      applyReplacementClosure({
        ...s,
        tombstone: { ...tombstone, intentId: "33333333-3333-4333-8333-333333333333" },
      }),
    ).rejects.toThrow("mismatch");
    expect(await replacementBlocksNewWork(s.exec)).toBe(true);
    await expect(
      applyReplacementClosure({
        ...s,
        tombstone: {
          ...tombstone,
          preparationRevision: intent.preparationRevision,
        },
      }),
    ).rejects.toThrow("mismatch");
    await applyReplacementClosure({ ...s, tombstone });
    expect(await replacementBlocksNewWork(s.exec)).toBe(true);
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (_path, body) => ({
        ...body,
        acknowledgedAt: "2026-09-16T10:03:00Z",
      }));
    await expect(acknowledgeReplacementClosure({ ...s, client: { post } })).rejects.toThrow(
      "response lost",
    );
    await expect(
      prepareReplacementReadiness({
        ...s,
        intent: {
          ...intent,
          intentId: "55555555-5555-4555-8555-555555555555",
          preparationId: "66666666-6666-4666-8666-666666666666",
          requestedAt: "2026-09-16T10:04:00Z",
        },
      }),
    ).rejects.toThrow("REPLACEMENT_PENDING_CLOSURE_ACK");
    await acknowledgeReplacementClosure({
      ...s,
      generation: createCredentialGeneration("station-test-key"),
      client: { post },
    });
    expect(post.mock.calls[0]?.[1]).toEqual(post.mock.calls[1]?.[1]);
    await expect(prepareReplacementReadiness({ ...s, intent })).rejects.toThrow("STALE");
    expect(await replacementBlocksNewWork(s.exec)).toBe(false);
    await expect(
      prepareReplacementReadiness({
        ...s,
        intent: {
          ...intent,
          intentId: "44444444-4444-4444-8444-444444444444",
          requestedAt: "2026-09-16T10:01:00Z",
          preparationRevision: 3,
        },
      }),
    ).rejects.toThrow("STALE");
    expect(() =>
      s.db.exec(
        `INSERT INTO offline_grant_configuration_commands(request_sequence,payload_json) VALUES(0,'{}')`,
      ),
    ).toThrow("STALE");
    await prepareReplacementReadiness({
      ...s,
      intent: {
        ...intent,
        intentId: "55555555-5555-4555-8555-555555555555",
        preparationId: "66666666-6666-4666-8666-666666666666",
        requestedAt: "2026-09-16T10:04:00Z",
      },
      activeTask: { taskId: "new-active-shift", kind: "shift" },
    });
    expect(await replacementCanEnterTask(s.exec, "new-active-shift", "shift")).toBe(true);
  });
});
