import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildSscc,
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
  MAX_SYNC_BATCH_ID_CHARS,
} from "@markiro/domain";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { createSyncEngine } from "../src/lib/sync.js";
import { PALLET_EXTENSION_DIGIT } from "../src/lib/close-pallet.js";
import { disassemblePallet, reprintPallet } from "../src/lib/pallets.js";
import { makeExec } from "./support/sqlite-exec.js";

// Several tests here deliberately fail the POST to exercise the retry path,
// which logs through `console.error` by design. Each of those spies on it
// explicitly; restoring afterwards keeps unexpected errors elsewhere visible.
afterEach(() => {
  vi.restoreAllMocks();
});

const SHIFT = "9f2f1e5a-0c9a-4a1a-9d4e-2b5c7a1f0d31";
const TERMINAL = "t1";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const ISO = "2026-09-11T10:00:00.000Z";
/** A 9-digit GS1 issuer prefix -- see sscc-pool.ts for why the pool is keyed by prefix. */
const ISSUER_PREFIX = "460123456";
const BOX_SSCC = buildSscc(0, ISSUER_PREFIX, 17);

/** One pallet SSCC per serial, built exactly as `closeCurrentPallet` builds them. */
function palletSscc(serial: number): string {
  return buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, serial);
}

interface SentPallet {
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string;
  closedAt: string;
  operatorId: string | null;
  printVerifiedAt: string | null;
  printSkippedAt: string | null;
}

interface SentPalletException {
  kind: string;
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string;
  occurredAt: string;
}

interface SentBox {
  boxId: string;
  devicePalletId: string | null;
}

interface SentBody {
  batchId: string;
  items: unknown[];
  boxes: SentBox[];
  pallets: SentPallet[];
  palletExceptions: SentPalletException[];
  exceptions: unknown[];
}

describe("sync engine: pallets", () => {
  let exec: SqlExecutor;
  let post = vi.fn();

  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
    post = vi.fn().mockResolvedValue({ applied: 0, alreadyApplied: false, conflicts: [] });
  });

  /** A closed, not-yet-acknowledged pallet, written straight onto the mirror row. */
  async function closedPallet(palletId: string, sscc: string, closedAt = ISO): Promise<void> {
    await exec.run(
      `INSERT INTO pallets_mirror
         (pallet_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by)
       VALUES (?,?,?,?,?,?,?)`,
      [palletId, SHIFT, TERMINAL, sscc, ISO, closedAt, OPERATOR],
    );
  }

  /** A closed box, optionally standing on `palletId`. */
  async function closedBox(boxId: string, palletId: string | null, sscc = BOX_SSCC): Promise<void> {
    await exec.run(
      `INSERT INTO boxes_mirror
         (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by, pallet_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [boxId, SHIFT, TERMINAL, sscc, ISO, ISO, OPERATOR, palletId],
    );
  }

  async function unackedPallets(): Promise<Array<{ pallet_id: string }>> {
    return exec.all<{ pallet_id: string }>(
      `SELECT pallet_id FROM pallets_mirror
        WHERE closed_at IS NOT NULL AND acked_at IS NULL ORDER BY rowid`,
    );
  }

  async function queuedPalletExceptions(): Promise<Array<{ id: number; pallet_id: string }>> {
    return exec.all<{ id: number; pallet_id: string }>(
      "SELECT id, pallet_id FROM pallet_exceptions_mirror ORDER BY id",
    );
  }

  /** Every `/station/scans` body this run posted, ignoring the reconciliation endpoints. */
  function sentBodies(): SentBody[] {
    return post.mock.calls
      .filter((call) => call[0] === "/station/scans")
      .map((call) => call[1] as SentBody);
  }

  const EMPTY_BODY: SentBody = {
    batchId: "",
    items: [],
    boxes: [],
    pallets: [],
    palletExceptions: [],
    exceptions: [],
  };

  /**
   * Drains once through a fresh engine bound to the shared `post` mock, and
   * returns the LAST `/station/scans` body it sent -- or an empty stand-in
   * when it sent none, so a test can prove a second drain carries nothing.
   */
  async function drainOnce(): Promise<{ body: SentBody; bodies: SentBody[] }> {
    post.mockClear();
    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: () => {},
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
    const bodies = sentBodies();
    return { body: bodies.at(-1) ?? EMPTY_BODY, bodies };
  }

  it("sends a closed pallet and acknowledges it", async () => {
    await closedPallet("p1", palletSscc(4));

    const sent = await drainOnce();

    expect(sent.body.pallets).toEqual([
      {
        palletId: "p1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        sscc: palletSscc(4),
        closedAt: ISO,
        operatorId: OPERATOR,
        printVerifiedAt: null,
        printSkippedAt: null,
      },
    ]);
    expect(await unackedPallets()).toHaveLength(0);
  });

  it("carries the pallet id on the box closure", async () => {
    await closedPallet("p1", palletSscc(4));
    await closedBox("b1", "p1");

    const sent = await drainOnce();

    expect(sent.body.boxes[0]?.devicePalletId).toBe("p1");
  });

  it("reports a box that stands on no pallet with a null pallet id", async () => {
    await closedBox("b1", null);

    const sent = await drainOnce();

    expect(sent.body.boxes[0]?.devicePalletId).toBeNull();
  });

  it("caps pallets at the shared limit and delivers the remainder next", async () => {
    for (let i = 0; i < MAX_PALLET_CLOSURES_PER_SYNC_BATCH + 5; i += 1) {
      await closedPallet(`p${i}`, palletSscc(i + 1));
    }

    const drained = await drainOnce();

    // No batch may exceed what the server's own `syncBatchSchema.pallets`
    // accepts, or the device retries a 400 forever.
    expect(drained.bodies[0]?.pallets).toHaveLength(MAX_PALLET_CLOSURES_PER_SYNC_BATCH);
    expect(drained.bodies[0]?.pallets.map((pallet) => pallet.palletId)).toEqual(
      Array.from({ length: MAX_PALLET_CLOSURES_PER_SYNC_BATCH }, (_unused, i) => `p${i}`),
    );
    // The drain loop's own `for` is what delivers the rest: the capped batch
    // acks, the next iteration reads fresh and picks up the remainder.
    expect(drained.bodies[1]?.pallets.map((pallet) => pallet.palletId)).toEqual([
      "p20",
      "p21",
      "p22",
      "p23",
      "p24",
    ]);
    expect(drained.bodies).toHaveLength(2);
    expect(await unackedPallets()).toHaveLength(0);
  });

  it("does not resend an acknowledged pallet", async () => {
    await closedPallet("p1", palletSscc(4));
    await drainOnce();

    expect((await drainOnce()).body.pallets).toEqual([]);
  });

  it("retries the same batch id with the same pallet set after a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closedPallet("p1", palletSscc(4));
    post.mockRejectedValueOnce(new Error("link down"));

    const first = await drainOnce();
    const second = await drainOnce();

    expect(second.body.batchId).toBe(first.body.batchId);
    expect(second.body.pallets).toEqual(first.body.pallets);
  });

  /**
   * The trap the handheld already hit, in its pallet form. The server claims
   * batch ids and short-circuits an already-claimed one with `alreadyApplied`
   * BEFORE its pallet loop, so a retry that silently grew its pallet set
   * would have the new closure acknowledged on the device without ever being
   * applied server-side -- a physically labelled pallet lost for good.
   */
  it("keeps a pallet that closes mid-flight out of the pinned batch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closedPallet("p1", palletSscc(4));
    post.mockRejectedValueOnce(new Error("link down"));
    const first = await drainOnce();

    await closedPallet("p2", palletSscc(5));
    const retried = await drainOnce();

    expect(retried.bodies[0]?.batchId).toBe(first.body.batchId);
    expect(retried.bodies[0]?.pallets.map((pallet) => pallet.palletId)).toEqual(["p1"]);
    // p2 rides a LATER batch, under a key the server has never seen.
    expect(retried.bodies[1]?.pallets.map((pallet) => pallet.palletId)).toEqual(["p2"]);
    expect(retried.bodies[1]?.batchId).not.toBe(first.body.batchId);
  });

  it("gives consecutive pallet-only batches distinct ids so server dedup cannot swallow one", async () => {
    await closedPallet("p1", palletSscc(4));
    const first = await drainOnce();
    await closedPallet("p2", palletSscc(5));
    const second = await drainOnce();

    expect(second.body.batchId).not.toBe(first.body.batchId);
    expect(second.body.pallets.map((pallet) => pallet.palletId)).toEqual(["p2"]);
  });

  it("survives a restart with the pinned pallet set intact", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closedPallet("p1", palletSscc(4));
    const failing = vi.fn().mockRejectedValue(new Error("link down"));
    const crashed = createSyncEngine({
      exec,
      client: { post: failing },
      machineId: "m1",
      onState: () => {},
    });
    crashed.nudge();
    await crashed.idle();
    crashed.stop();
    const pinned = failing.mock.calls[0]![1] as SentBody;

    // A brand-new engine over the same database -- an app restart mid-batch.
    await closedPallet("p2", palletSscc(5));
    const resumed = await drainOnce();

    expect(resumed.bodies[0]?.batchId).toBe(pinned.batchId);
    expect(resumed.bodies[0]?.pallets.map((pallet) => pallet.palletId)).toEqual(["p1"]);
    expect(resumed.bodies[1]?.pallets.map((pallet) => pallet.palletId)).toEqual(["p2"]);
  });

  it("drains pallet exceptions in queue order and deletes them only after acknowledgement", async () => {
    await closedPallet("p1", palletSscc(4));
    await disassemblePallet(exec, {
      palletId: "p1",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "повреждён поддон",
      occurredAt: ISO,
    });
    await reprintPallet(exec, {
      palletId: "p1",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "принтер зажевал этикетку",
      occurredAt: "2026-09-11T10:05:00.000Z",
    });

    const sent = await drainOnce();

    expect(sent.body.palletExceptions).toEqual([
      {
        kind: "disassemble",
        palletId: "p1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        operatorId: OPERATOR,
        reason: "повреждён поддон",
        occurredAt: ISO,
      },
      {
        kind: "reprint",
        palletId: "p1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        operatorId: OPERATOR,
        reason: "принтер зажевал этикетку",
        occurredAt: "2026-09-11T10:05:00.000Z",
      },
    ]);
    expect(await queuedPalletExceptions()).toEqual([]);
  });

  it("keeps a pallet exception queued after the batch carrying it fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closedPallet("p1", palletSscc(4));
    await reprintPallet(exec, {
      palletId: "p1",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "смазанный код",
      occurredAt: ISO,
    });
    post.mockRejectedValueOnce(new Error("link down"));

    await drainOnce();

    expect((await queuedPalletExceptions()).map((row) => row.pallet_id)).toEqual(["p1"]);
  });

  it("keeps a pallet exception queued mid-flight out of the pinned batch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reprintPallet(exec, {
      palletId: "p1",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "смазанный код",
      occurredAt: ISO,
    });
    post.mockRejectedValueOnce(new Error("link down"));
    const first = await drainOnce();

    await reprintPallet(exec, {
      palletId: "p2",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "оторвалась этикетка",
      occurredAt: "2026-09-11T10:06:00.000Z",
    });
    const retried = await drainOnce();

    expect(retried.bodies[0]?.batchId).toBe(first.body.batchId);
    expect(retried.bodies[0]?.palletExceptions.map((row) => row.palletId)).toEqual(["p1"]);
    expect(retried.bodies[1]?.palletExceptions.map((row) => row.palletId)).toEqual(["p2"]);
  });

  it("counts unacknowledged pallets and pallet exceptions as pending work", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closedPallet("p1", palletSscc(4));
    await reprintPallet(exec, {
      palletId: "p1",
      shiftId: SHIFT,
      terminalId: TERMINAL,
      operatorId: OPERATOR,
      reason: "смазанный код",
      occurredAt: ISO,
    });
    const states: number[] = [];
    const engine = createSyncEngine({
      exec,
      client: { post: vi.fn().mockRejectedValue(new Error("link down")) },
      machineId: "m1",
      onState: (state) => states.push(state.pending),
    });
    engine.nudge();
    await engine.idle();
    engine.stop();

    expect(states.at(-1)).toBe(2);
  });

  /**
   * Migration 0132 widened the server's sync-quarantine kind CHECK for
   * exactly these two kinds. `isDeniedStationRecord` filters unknown kinds,
   * so without teaching it both the operator never learns a pallet was
   * quarantined.
   */
  it("preserves pallet records the server quarantined", async () => {
    await closedPallet("p1", palletSscc(4));
    post.mockResolvedValue({
      applied: 0,
      alreadyApplied: false,
      conflicts: [],
      denied: [
        { recordKind: "pallet", recordIndex: 0, shiftId: SHIFT, code: "subscription_read_only" },
        {
          recordKind: "pallet_exception",
          recordIndex: 0,
          shiftId: SHIFT,
          code: "parent_missing",
        },
      ],
    });

    await drainOnce();

    const [row] = await exec.all<{ value: string }>(
      "SELECT value FROM station_meta WHERE key = 'sync_last_recovery_denied'",
    );
    expect(JSON.parse(row!.value).denied).toEqual([
      { recordKind: "pallet", recordIndex: 0, shiftId: SHIFT, code: "subscription_read_only" },
      { recordKind: "pallet_exception", recordIndex: 0, shiftId: SHIFT, code: "parent_missing" },
    ]);
  });

  /**
   * A batch id longer than the server's own `batchId` bound is a 400 the
   * drain retries forever -- the same permanent wedge an over-limit payload
   * would be. Four full channels plus two UUID identity components overflow
   * the plain form, so the device must fall back to a bounded, still
   * deterministic key rather than posting something the server refuses.
   */
  it("keeps the batch id within the server's bound when every channel is full", async () => {
    const machineId = "3f6c1e28-5a1d-4f6e-9c2a-7b8d0e1f2a3b";
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [
      "install_id",
      "8c1a0d5f-2b3e-4c7a-9f10-6d5e4c3b2a19",
    ]);
    for (let i = 0; i < MAX_BOX_CLOSURES_PER_SYNC_BATCH; i += 1) {
      await exec.run(
        `INSERT INTO boxes_mirror
           (rowid, box_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          9_000_000 + i,
          `b${i}`,
          SHIFT,
          TERMINAL,
          buildSscc(0, ISSUER_PREFIX, i + 1),
          ISO,
          ISO,
          null,
        ],
      );
    }
    for (let i = 0; i < MAX_PALLET_CLOSURES_PER_SYNC_BATCH; i += 1) {
      await exec.run(
        `INSERT INTO pallets_mirror
           (rowid, pallet_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [900_000 + i, `p${i}`, SHIFT, TERMINAL, palletSscc(i + 1), ISO, ISO, null],
      );
    }
    await exec.run(
      `INSERT INTO box_exceptions_mirror
         (id, kind, box_id, code_hash, target_scanned_at, shift_id, terminal_id, operator_id, reason, at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [99_999, "reprint", "b0", null, null, SHIFT, TERMINAL, null, "смазанный код", ISO],
    );
    await exec.run(
      `INSERT INTO pallet_exceptions_mirror
         (id, kind, pallet_id, shift_id, terminal_id, operator_id, reason, occurred_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [99_999, "reprint", "p0", SHIFT, TERMINAL, null, "смазанный код", ISO],
    );

    post.mockClear();
    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId,
      onState: () => {},
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
    const body = sentBodies()[0]!;

    expect(body.boxes).toHaveLength(MAX_BOX_CLOSURES_PER_SYNC_BATCH);
    expect(body.pallets).toHaveLength(MAX_PALLET_CLOSURES_PER_SYNC_BATCH);
    expect(body.palletExceptions).toHaveLength(1);
    expect(body.batchId.length).toBeLessThanOrEqual(MAX_SYNC_BATCH_ID_CHARS);
    // Pinned so a future change that shortens the assembled key cannot leave
    // this test passing vacuously: this particular set really does overflow,
    // so the bounded form -- not the plain one -- is what went on the wire.
    expect(body.batchId.startsWith("sync:")).toBe(true);
    expect(body.batchId).not.toContain(":box:");
  });
});
