import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { remainingSerials } from "../src/floor/work/block-supply.js";
import {
  knownBlocksRequestSchema,
  knownBlocksResponseSchema,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  KnownBlocksMismatchError,
  MAX_KNOWN_BLOCKS,
  noteRestoreEpoch,
  readRestoreStatus,
  reconcileRestore,
  restoreDue,
  RESEND_WINDOW_MS,
} from "../src/local/restore-reconcile.js";
import {
  failingWrites,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/** The block of `known-blocks-request.json`, as the host once issued it to this station. */
const REQUEST = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
const [FIXTURE_BLOCK] = REQUEST.blocks;
/** `restoreEpoch` of `hello-restored.json`, and the epoch of a later restore. */
const EPOCH = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const LATER_EPOCH = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const NOW = new Date("2026-10-11T08:00:00.000Z");

/** Block ids `…b0001`, `…b0002`, … */
function blockId(index: number): string {
  return `00000000-0000-4000-8000-b${String(index).padStart(11, "0")}`;
}

/** The fixture's block, received first, then `more` blocks of 2 000 serials above it. */
function seedBlocks(db: DatabaseSync, more = 0): void {
  if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
  seedBlock(db, {
    blockId: FIXTURE_BLOCK.id,
    from: FIXTURE_BLOCK.fromSerial,
    to: FIXTURE_BLOCK.toSerial,
    next: FIXTURE_BLOCK.fromSerial + 100,
    receivedAt: "2026-10-08T06:00:00.000Z",
  });
  for (let index = 1; index <= more; index += 1) {
    const from = FIXTURE_BLOCK.toSerial + 1 + (index - 1) * 2000;
    seedBlock(db, {
      blockId: blockId(index),
      from,
      to: from + 1999,
      receivedAt: `2026-10-09T06:${String(index % 60).padStart(2, "0")}:00.000Z`,
    });
  }
}

/** The host's answer: each block `known`, unless `outcomes` names another. */
function answering(outcomes: Record<string, KnownBlocksResponse["results"][number]> = {}) {
  return vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> =>
    knownBlocksResponseSchema.parse({
      results: request.blocks.map(
        (block) => outcomes[block.id] ?? { id: block.id, outcome: "known", code: null },
      ),
    }),
  );
}

function refused(id: string, code: string) {
  return { id, outcome: "refused" as const, code };
}

function epochs(db: DatabaseSync) {
  return rows(
    db,
    "SELECT host_id, device_id, epoch, seen_at, reconciled_at, refused FROM floor_restore_epochs " +
      "ORDER BY device_id",
  );
}

function fromZero(db: DatabaseSync) {
  return rows(db, "SELECT value FROM sync_state WHERE key = 'from_zero'");
}

describe("the host's restore epoch on the station", () => {
  it("is noted once per pairing, and the station owes the host its blocks until it reconciles", async () => {
    const { db, executor } = openLocalDb();
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(true);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date(NOW.getTime() + 1))).toBe(
      false,
    );
    expect(epochs(db)).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        epoch: EPOCH,
        seen_at: NOW.toISOString(),
        reconciled_at: null,
        refused: 0,
      },
    ]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    // Another pairing's epoch is its own.
    const other = { ...PAIRING, deviceId: OTHER_DEVICE };
    expect(await restoreDue(executor, other)).toBe(false);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(false);
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    // A later restore owes everything again.
    expect(await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW)).toBe(true);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    expect(epochs(db)).toMatchObject([{ epoch: LATER_EPOCH, reconciled_at: null, refused: 0 }]);
  });

  it("does nothing while no new epoch is owed", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    const register = answering();
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "none" });
    expect(register).not.toHaveBeenCalled();
    expect(fromZero(db)).toEqual([]);
  });
});

describe("the reconciliation after a restore", () => {
  it("sends every block of the pairing as the host issued it, in requests of 64", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    seedBlock(db, { blockId: blockId(999), from: 900_000, to: 901_999, deviceId: OTHER_DEVICE });
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering({
      [blockId(1)]: { id: blockId(1), outcome: "registered", code: null },
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 1, known: 64, refused: 0 });
    const sent = register.mock.calls.map(([request]) => request);
    expect(sent.map((request) => request.blocks.length)).toEqual([64, 1]);
    // The station's first block goes exactly as the host's fixture names it.
    expect(sent[0]?.blocks[0]).toEqual(FIXTURE_BLOCK);
    for (const request of sent) expect(knownBlocksRequestSchema.parse(request)).toEqual(request);
    expect(sent.flatMap((request) => request.blocks).map((block) => block.id)).not.toContain(
      blockId(999),
    );
    expect(epochs(db)).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        epoch: EPOCH,
        seen_at: NOW.toISOString(),
        reconciled_at: NOW.toISOString(),
        refused: 0,
      },
    ]);
  });

  it("stops using every block the host refused, so the boxes close from the blocks it kept", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, 2);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const before = await remainingSerials(executor, PAIRING, PREFIX);
    expect(before).toBe(1900 + 2000 + 2000);
    const register = answering({
      [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap"),
      [blockId(2)]: refused(blockId(2), "prefix_unknown"),
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 1, refused: 2 });
    expect(
      rows(db, "SELECT block_id, next_serial, to_serial FROM floor_sscc_blocks ORDER BY block_id"),
    ).toEqual([
      { block_id: blockId(1), next_serial: 5500, to_serial: 7499 },
      { block_id: blockId(2), next_serial: 9500, to_serial: 9499 },
      { block_id: FIXTURE_BLOCK.id, next_serial: 5500, to_serial: 5499 },
    ]);
    expect(await remainingSerials(executor, PAIRING, PREFIX)).toBe(2000);
    // Which blocks, and why, in the order they went: for support, until the next restore.
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 2,
      refusedBlocks: [
        { id: FIXTURE_BLOCK.id, code: "block_overlap" },
        { id: blockId(2), code: "prefix_unknown" },
      ],
    });
  });

  it("asks the next sync to start from zero and sends the records of the last 30 days again", async () => {
    const { db, executor } = openLocalDb();
    const [recent, old, waiting] = await unsentScans(executor, 3);
    const ack = (id: string | undefined, at: Date) =>
      db
        .prepare(
          "UPDATE outbox SET outcome = 'rejected', outcome_code = 'sscc_not_issued', " +
            "outcome_details = '{\"x\":1}', acked_at = ? WHERE id = ?",
        )
        .run(at.toISOString(), id ?? "");
    ack(recent, new Date(NOW.getTime() - RESEND_WINDOW_MS + 60_000));
    ack(old, new Date(NOW.getTime() - RESEND_WINDOW_MS - 60_000));
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering();
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    // No block: nothing to ask the host.
    expect(register).not.toHaveBeenCalled();
    expect(
      rows(
        db,
        "SELECT id, outcome, outcome_code, outcome_details, acked_at FROM outbox ORDER BY seq",
      ),
    ).toEqual([
      { id: recent, outcome: null, outcome_code: null, outcome_details: null, acked_at: null },
      {
        id: old,
        outcome: "rejected",
        outcome_code: "sscc_not_issued",
        outcome_details: '{"x":1}',
        acked_at: new Date(NOW.getTime() - RESEND_WINDOW_MS - 60_000).toISOString(),
      },
      { id: waiting, outcome: null, outcome_code: null, outcome_details: null, acked_at: null },
    ]);
    expect(fromZero(db)).toEqual([{ value: EPOCH }]);
  });

  it("keeps owing the blocks when a request fails, and the next run sends them all again", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    const [recent] = await unsentScans(executor, 1);
    db.prepare("UPDATE outbox SET outcome = 'accepted', acked_at = ? WHERE id = ?").run(
      NOW.toISOString(),
      recent ?? "",
    );
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const register = answering({ [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap") });
    const first = register.getMockImplementation();
    register.mockImplementationOnce(async (request) => {
      if (first === undefined) throw new Error("no answer");
      return first(request);
    });
    register.mockImplementationOnce(async () => {
      throw down;
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBe(down);
    // The refused block is not used meanwhile; nothing else moved.
    expect(
      rows(db, "SELECT next_serial FROM floor_sscc_blocks WHERE block_id = ?", FIXTURE_BLOCK.id),
    ).toEqual([{ next_serial: 5500 }]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    expect(fromZero(db)).toEqual([]);
    expect(rows(db, "SELECT acked_at FROM outbox")).toEqual([{ acked_at: NOW.toISOString() }]);

    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 64, refused: 1 });
    expect(register.mock.calls.map(([request]) => request.blocks.length)).toEqual([64, 1, 64, 1]);
    expect(epochs(db)).toMatchObject([{ reconciled_at: NOW.toISOString(), refused: 1 }]);
    expect(rows(db, "SELECT acked_at FROM outbox")).toEqual([{ acked_at: null }]);
  });

  it("owes nothing more to a host that says it was never restored", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "the host was never restored: it lost no block",
        details: { constraint: "no_restore" },
      });
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 0, refused: 0 });
    expect(register).toHaveBeenCalledTimes(1);
    expect(fromZero(db)).toEqual([{ value: EPOCH }]);
  });

  it("keeps owing the blocks after any other refusal of the host", async () => {
    const { executor, db } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const forbidden = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "other",
      details: { constraint: "something_else" },
    });
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw forbidden;
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBe(forbidden);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });

  it("keeps nothing of an answer that does not answer the blocks sent", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, 1);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const short = vi.fn(async (): Promise<KnownBlocksResponse> => ({
      results: [refused(FIXTURE_BLOCK.id, "block_overlap")],
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register: short, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    const swapped = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => ({
      results: request.blocks.map((_, index) =>
        refused(request.blocks[1 - index]?.id ?? "", "block_overlap"),
      ),
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register: swapped, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    expect(
      rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks WHERE next_serial > to_serial"),
    ).toEqual([{ n: 0 }]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });

  it("does not settle a later epoch noted while it ran", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      // The host was restored again while the first answer was on its way.
      await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW);
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    await expect(
      reconcileRestore({
        local: executor,
        pairing: PAIRING,
        register: answering(),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ kind: "reconciled", epoch: LATER_EPOCH });
    expect(fromZero(db)).toEqual([{ value: LATER_EPOCH }]);
  });

  it("keeps owing everything when this computer cannot write the end", async () => {
    const { executor, db } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await expect(
      reconcileRestore({
        local: failingWrites(executor),
        pairing: PAIRING,
        register: answering(),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: true,
      refused: 0,
      refusedBlocks: [],
    });
  });
});

// Beyond the plan's examples: the guards each of its statements and branches adds, one test for
// each, written against the mutants listed in the task report.
const OTHER_HOST = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

/** Acknowledges the outbox record `id` with `outcome` at `at`, as the host's receipt would. */
function acknowledge(db: DatabaseSync, id: string | undefined, at: string, outcome = "accepted") {
  db.prepare("UPDATE outbox SET outcome = ?, acked_at = ? WHERE id = ?").run(outcome, at, id ?? "");
}

function ackedAt(db: DatabaseSync) {
  return rows(db, "SELECT acked_at FROM outbox ORDER BY seq").map((row) => row["acked_at"]);
}

describe("the blocks the reconciliation sends", () => {
  it("sends the used up blocks and the pallets' blocks too, in the order the host issued them", async () => {
    const { db, executor } = openLocalDb();
    // Written in no particular order: two received at one instant, one used up, one a pallet's.
    seedBlock(db, {
      blockId: blockId(3),
      from: 20_000,
      to: 21_999,
      next: 22_000,
      receivedAt: "2026-10-09T06:00:00.000Z",
    });
    seedBlock(db, {
      blockId: blockId(2),
      from: 10_000,
      to: 10_999,
      extension: 1,
      prefix: "460070123",
      receivedAt: "2026-10-09T06:00:00.000Z",
    });
    seedBlock(db, {
      blockId: blockId(1),
      from: 1_000,
      to: 1_999,
      receivedAt: "2026-10-10T06:00:00.000Z",
    });
    seedBlock(db, {
      blockId: blockId(4),
      from: 100,
      to: 199,
      receivedAt: "2026-10-08T06:00:00.000Z",
    });
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering();
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    expect(register.mock.calls.map(([request]) => request.blocks)).toEqual([
      [
        { id: blockId(4), issuerPrefix: PREFIX, extension: 0, fromSerial: 100, toSerial: 199 },
        {
          id: blockId(2),
          issuerPrefix: "460070123",
          extension: 1,
          fromSerial: 10_000,
          toSerial: 10_999,
        },
        {
          id: blockId(3),
          issuerPrefix: PREFIX,
          extension: 0,
          fromSerial: 20_000,
          toSerial: 21_999,
        },
        { id: blockId(1), issuerPrefix: PREFIX, extension: 0, fromSerial: 1_000, toSerial: 1_999 },
      ],
    ]);
    // Nothing is moved by being sent.
    expect(
      rows(db, "SELECT block_id, next_serial FROM floor_sscc_blocks ORDER BY block_id"),
    ).toEqual([
      { block_id: blockId(1), next_serial: 1_000 },
      { block_id: blockId(2), next_serial: 10_000 },
      { block_id: blockId(3), next_serial: 22_000 },
      { block_id: blockId(4), next_serial: 100 },
    ]);
  });

  it("returns each block once across the requests, and counts the refused ones of every request", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, 2 * MAX_KNOWN_BLOCKS + 1);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    // The host refuses the first block of each request.
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => ({
      results: request.blocks.map((block, index) =>
        index === 0
          ? refused(block.id, "block_overlap")
          : { id: block.id, outcome: "known" as const, code: null },
      ),
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({
      kind: "reconciled",
      epoch: EPOCH,
      registered: 0,
      known: 2 * MAX_KNOWN_BLOCKS + 2 - 3,
      refused: 3,
    });
    const requests = register.mock.calls.map(([request]) =>
      request.blocks.map((block) => block.id),
    );
    expect(requests.map((ids) => ids.length)).toEqual([64, 64, 2]);
    const sent = requests.flat();
    expect(new Set(sent).size).toBe(2 * MAX_KNOWN_BLOCKS + 2);
    expect(new Set(sent)).toEqual(
      new Set(rows(db, "SELECT block_id FROM floor_sscc_blocks").map((row) => row["block_id"])),
    );
    expect(
      rows(
        db,
        "SELECT block_id FROM floor_sscc_blocks WHERE next_serial > to_serial ORDER BY block_id",
      ).map((row) => row["block_id"]),
    ).toEqual(requests.map((ids) => ids[0]).sort());
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 3,
      refusedBlocks: requests.map((ids) => ({ id: ids[0], code: "block_overlap" })),
    });
  });

  it("keeps nothing of an answer that carries more results than the blocks sent", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const long = vi.fn(async (): Promise<KnownBlocksResponse> => ({
      results: [
        refused(FIXTURE_BLOCK.id, "block_overlap"),
        { id: blockId(7), outcome: "registered", code: null },
      ],
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register: long, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    expect(rows(db, "SELECT next_serial, to_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 3600, to_serial: 5499 },
    ]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });
});

describe("the obligation of each pairing", () => {
  it("starts over with a later epoch: owed again, seen again, nothing refused yet", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering({ [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap") }),
      now: () => NOW,
    });
    // The same epoch noted again is no new restore: the codes stay.
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(false);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 1,
      refusedBlocks: [{ id: FIXTURE_BLOCK.id, code: "block_overlap" }],
    });
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, later)).toBe(true);
    expect(epochs(db)).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        epoch: LATER_EPOCH,
        seen_at: later.toISOString(),
        reconciled_at: null,
        refused: 0,
      },
    ]);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: true,
      refused: 0,
      refusedBlocks: [],
    });
    // Noting the same epoch again, however late, changes nothing.
    expect(
      await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, new Date(later.getTime() + 1)),
    ).toBe(false);
    expect(epochs(db)).toMatchObject([{ seen_at: later.toISOString() }]);
  });

  it("is one pairing's own: another device or host neither owes nor settles it", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const otherDevice = { ...PAIRING, deviceId: OTHER_DEVICE };
    const otherHost = { ...PAIRING, hostId: OTHER_HOST };
    for (const pairing of [PAIRING, otherDevice, otherHost]) {
      await noteRestoreEpoch(executor, pairing, EPOCH, NOW);
    }
    seedBlock(db, { blockId: blockId(77), from: 800_000, to: 801_999, deviceId: OTHER_DEVICE });
    seedBlock(db, { blockId: blockId(78), from: 810_000, to: 811_999, hostId: OTHER_HOST });
    const register = answering({ [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap") });
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    // Only this pairing's block went, and only this pairing is settled.
    expect(
      register.mock.calls.flatMap(([request]) => request.blocks.map((block) => block.id)),
    ).toEqual([FIXTURE_BLOCK.id]);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 1,
      refusedBlocks: [{ id: FIXTURE_BLOCK.id, code: "block_overlap" }],
    });
    for (const pairing of [otherDevice, otherHost]) {
      expect(await restoreDue(executor, pairing)).toBe(true);
      expect(await readRestoreStatus(executor, pairing)).toEqual({
        due: true,
        refused: 0,
        refusedBlocks: [],
      });
    }
    expect(
      rows(db, "SELECT block_id FROM floor_sscc_blocks WHERE next_serial > to_serial ORDER BY 1"),
    ).toEqual([{ block_id: FIXTURE_BLOCK.id }]);
    // A pairing that never saw an epoch owes nothing, whatever the others owe.
    const stranger = { hostId: OTHER_HOST, deviceId: OTHER_DEVICE };
    expect(await restoreDue(executor, stranger)).toBe(false);
    expect(await readRestoreStatus(executor, stranger)).toEqual({
      due: false,
      refused: 0,
      refusedBlocks: [],
    });
    // The others settle in their turn, each with its own count.
    await reconcileRestore({
      local: executor,
      pairing: otherDevice,
      register: answering(),
      now: () => NOW,
    });
    expect(await readRestoreStatus(executor, otherDevice)).toEqual({
      due: false,
      refused: 0,
      refusedBlocks: [],
    });
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 1,
      refusedBlocks: [{ id: FIXTURE_BLOCK.id, code: "block_overlap" }],
    });
    expect(await restoreDue(executor, otherHost)).toBe(true);
  });
});

describe("the records sent again", () => {
  it("takes the records of the window and no other: its first instant is in, the one before is out", async () => {
    const { db, executor } = openLocalDb();
    const [edge, before, rejected, conflicting] = await unsentScans(executor, 4);
    const since = new Date(NOW.getTime() - RESEND_WINDOW_MS);
    acknowledge(db, edge, since.toISOString());
    acknowledge(db, before, new Date(since.getTime() - 1).toISOString());
    acknowledge(db, rejected, NOW.toISOString(), "rejected");
    acknowledge(db, conflicting, NOW.toISOString(), "conflict");
    // The attempts already made and when the last was sent stay as they were.
    db.prepare("UPDATE outbox SET attempts = 3, sent_at = ? WHERE id = ?").run(
      "2026-10-10T07:00:00.000Z",
      edge ?? "",
    );
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(
      rows(db, "SELECT id, outcome, acked_at, attempts, sent_at FROM outbox ORDER BY seq"),
    ).toEqual([
      { id: edge, outcome: null, acked_at: null, attempts: 3, sent_at: "2026-10-10T07:00:00.000Z" },
      {
        id: before,
        outcome: "accepted",
        acked_at: new Date(since.getTime() - 1).toISOString(),
        attempts: 0,
        sent_at: null,
      },
      { id: rejected, outcome: null, acked_at: null, attempts: 0, sent_at: null },
      { id: conflicting, outcome: null, acked_at: null, attempts: 0, sent_at: null },
    ]);
  });

  it("leaves the records of another pairing as they are", async () => {
    const { db, executor } = openLocalDb();
    const otherDevice = { ...PAIRING, deviceId: OTHER_DEVICE };
    const otherHost = { ...PAIRING, hostId: OTHER_HOST };
    const [mine] = await unsentScans(executor, 1);
    const [device] = await unsentScans(executor, 1, otherDevice, 11);
    const [host] = await unsentScans(executor, 1, otherHost, 21);
    for (const id of [mine, device, host]) acknowledge(db, id, NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(rows(db, "SELECT id, acked_at FROM outbox ORDER BY id")).toEqual([
      { id: mine, acked_at: null },
      { id: device, acked_at: NOW.toISOString() },
      { id: host, acked_at: NOW.toISOString() },
    ]);
  });
});

/**
 * A warehouse reprint record (`wh_outbox`, plan СКЛ) of `pairing`, answered with `outcome` at
 * `ackedAt` (`null` — not yet answered).
 */
function warehouseRecord(
  db: DatabaseSync,
  id: string,
  outcome: "accepted" | "rejected" | null,
  ackedAt: string | null,
  pairing: { hostId: string; deviceId: string } = PAIRING,
) {
  db.prepare(
    "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at, " +
      "attempts, sent_at, outcome, outcome_code, acked_at) VALUES (?, ?, ?, 's-1', ?, ?, 2, ?, ?, ?, ?)",
  ).run(
    id,
    pairing.hostId,
    pairing.deviceId,
    JSON.stringify({ id }),
    "2026-10-01T06:00:00.000Z",
    "2026-10-01T06:00:01.000Z",
    outcome,
    outcome === "rejected" ? "subject_unknown" : null,
    ackedAt,
  );
}

function warehouseRecords(db: DatabaseSync) {
  return rows(
    db,
    "SELECT id, outcome, outcome_code, acked_at, attempts, sent_at FROM wh_outbox ORDER BY id",
  );
}

describe("the warehouse reprint's records sent again (plan СКЛ)", () => {
  const since = new Date(NOW.getTime() - RESEND_WINDOW_MS);
  const sent = { attempts: 2, sent_at: "2026-10-01T06:00:01.000Z" };

  it("takes the accepted records of the window: its first instant is in, the one before is out", async () => {
    const { db, executor } = openLocalDb();
    warehouseRecord(db, "a-edge", "accepted", since.toISOString());
    warehouseRecord(db, "b-before", "accepted", new Date(since.getTime() - 1).toISOString());
    warehouseRecord(db, "c-recent", "accepted", NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    // The attempts already made and when the last was sent stay as they were.
    expect(warehouseRecords(db)).toEqual([
      { id: "a-edge", outcome: null, outcome_code: null, acked_at: null, ...sent },
      {
        id: "b-before",
        outcome: "accepted",
        outcome_code: null,
        acked_at: new Date(since.getTime() - 1).toISOString(),
        ...sent,
      },
      { id: "c-recent", outcome: null, outcome_code: null, acked_at: null, ...sent },
    ]);
  });

  it("never sends a refused record again, and leaves one still waiting as it is", async () => {
    const { db, executor } = openLocalDb();
    warehouseRecord(db, "a-refused", "rejected", NOW.toISOString());
    warehouseRecord(db, "b-waiting", null, null);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(warehouseRecords(db)).toEqual([
      {
        id: "a-refused",
        outcome: "rejected",
        outcome_code: "subject_unknown",
        acked_at: NOW.toISOString(),
        ...sent,
      },
      { id: "b-waiting", outcome: null, outcome_code: null, acked_at: null, ...sent },
    ]);
  });

  it("leaves the records of another pairing as they are", async () => {
    const { db, executor } = openLocalDb();
    warehouseRecord(db, "a-mine", "accepted", NOW.toISOString());
    warehouseRecord(db, "b-device", "accepted", NOW.toISOString(), {
      ...PAIRING,
      deviceId: OTHER_DEVICE,
    });
    warehouseRecord(db, "c-host", "accepted", NOW.toISOString(), {
      ...PAIRING,
      hostId: OTHER_HOST,
    });
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(rows(db, "SELECT id, acked_at FROM wh_outbox ORDER BY id")).toEqual([
      { id: "a-mine", acked_at: null },
      { id: "b-device", acked_at: NOW.toISOString() },
      { id: "c-host", acked_at: NOW.toISOString() },
    ]);
  });

  it("goes with the settling: a later epoch noted meanwhile leaves every record answered", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    warehouseRecord(db, "a-recent", "accepted", NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW);
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT acked_at FROM wh_outbox")).toEqual([{ acked_at: NOW.toISOString() }]);
  });

  it("sends them once per epoch: a record answered again after the settling stays answered", async () => {
    const { db, executor } = openLocalDb();
    warehouseRecord(db, "a-recent", "accepted", NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const run = () =>
      reconcileRestore({
        local: executor,
        pairing: PAIRING,
        register: answering(),
        now: () => NOW,
      });
    await expect(run()).resolves.toMatchObject({ kind: "reconciled" });
    expect(rows(db, "SELECT acked_at FROM wh_outbox")).toEqual([{ acked_at: null }]);
    // It went and came back accepted; the same epoch noted again is no new restore.
    const later = new Date(NOW.getTime() + 1000).toISOString();
    db.prepare("UPDATE wh_outbox SET outcome = 'accepted', acked_at = ?").run(later);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(false);
    await expect(run()).resolves.toEqual({ kind: "none" });
    expect(rows(db, "SELECT acked_at FROM wh_outbox")).toEqual([{ acked_at: later }]);
  });
});

describe("the end of a reconciliation", () => {
  it("applies none of it when a later epoch was noted meanwhile: no mark, no record sent again", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    const [recent] = await unsentScans(executor, 1);
    acknowledge(db, recent, NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW);
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    // The failed batch rolled back whole: the mark and the reopening went with the settling.
    expect(fromZero(db)).toEqual([]);
    expect(ackedAt(db)).toEqual([NOW.toISOString()]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });

  it("is settled once: a second run that settled the same epoch meanwhile sends nothing again", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    const [recent] = await unsentScans(executor, 1);
    acknowledge(db, recent, NOW.toISOString());
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    let inner = false;
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      if (!inner) {
        inner = true;
        // Another run reconciles the same epoch while this one waits, and the records it
        // reopened go and come back acknowledged.
        await reconcileRestore({
          local: executor,
          pairing: PAIRING,
          register: answering(),
          now: () => NOW,
        });
        acknowledge(db, recent, new Date(NOW.getTime() + 1000).toISOString());
      }
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(ackedAt(db)).toEqual([new Date(NOW.getTime() + 1000).toISOString()]);
    expect(await restoreDue(executor, PAIRING)).toBe(false);
  });

  it("settles when the same epoch is noted again meanwhile: that is no new restore", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(false);
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toMatchObject({ kind: "reconciled", epoch: EPOCH });
    expect(fromZero(db)).toEqual([{ value: EPOCH }]);
  });
});

describe("what the host's refusals mean", () => {
  const noRestore = {
    kind: "api" as const,
    code: "conflict",
    status: 409,
    message: "the host was never restored",
    details: { constraint: "no_restore" },
  };

  it.each([
    ["a failed call that is no answer of the host", { ...noRestore, kind: "transport" as const }],
    ["another refusal with the same constraint", { ...noRestore, code: "validation_failed" }],
    ["a conflict of another constraint", { ...noRestore, details: { constraint: "other" } }],
    ["a conflict that names none", { ...noRestore, details: {} }],
  ])("keeps owing the blocks after %s", async (_name, init) => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const error = new HostError(init);
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw error;
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBe(error);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    expect(fromZero(db)).toEqual([]);
  });

  it("owes nothing after the first request says the host was never restored, and sends no more", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw new HostError(noRestore);
    });
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    expect(register).toHaveBeenCalledTimes(1);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({
      due: false,
      refused: 0,
      refusedBlocks: [],
    });
  });
});
