import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  readDeliveryStuck,
  readOutboxStatus,
  readSerialsLeft,
  waitUnits,
} from "../src/floor/outbox-status.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { ENTERED, PAIRING, seedBlock } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = { hostId: HOST_ID, deviceId: "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6" };
const OTHER_HOST = { hostId: "7c6b5a49-3827-4165-9403-f2e1d0c9b8a7", deviceId: DEVICE_ID };
const THEIR_PREFIX = "4607004650";

let next = 0;

/** `count` records of `pairing` with the verdict `outcome` (none: not delivered yet). */
function put(
  db: DatabaseSync,
  pairing: { hostId: string; deviceId: string },
  count: number,
  outcome: "accepted" | "rejected" | "conflict" | null,
  created = "2026-10-08T06:00:00.000Z",
): void {
  for (let n = 0; n < count; n += 1) {
    next += 1;
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
        "outcome, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', '{}', ?, ?, ?)",
    ).run(
      `record-${next}`,
      pairing.hostId,
      pairing.deviceId,
      created,
      outcome,
      outcome === null ? null : "2026-10-08T06:30:00.000Z",
    );
  }
}

describe("the outbox's counts", () => {
  it("count a pairing's records without a receipt, rejected and in conflict, each by its own filter", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 2, null);
    put(db, PAIRING, 3, "accepted");
    put(db, PAIRING, 4, "rejected");
    put(db, PAIRING, 5, "conflict");
    // The same ids of outcome in the same table under other pairings: none of them is ours.
    for (const other of [OTHER_DEVICE, OTHER_HOST]) {
      put(db, other, 7, null);
      put(db, other, 8, "rejected");
      put(db, other, 9, "conflict");
      put(db, other, 10, "accepted");
    }
    await expect(readOutboxStatus(executor, PAIRING)).resolves.toEqual({
      unsent: 2,
      rejected: 4,
      conflicts: 5,
    });
    await expect(readOutboxStatus(executor, OTHER_DEVICE)).resolves.toEqual({
      unsent: 7,
      rejected: 8,
      conflicts: 9,
    });
    await expect(readOutboxStatus(executor, OTHER_HOST)).resolves.toEqual({
      unsent: 7,
      rejected: 8,
      conflicts: 9,
    });
  });

  it("are all zero for an empty outbox and for a pairing with no record", async () => {
    const { db, executor } = openLocalDb();
    const zero = { unsent: 0, rejected: 0, conflicts: 0 };
    await expect(readOutboxStatus(executor, PAIRING)).resolves.toEqual(zero);
    put(db, OTHER_DEVICE, 3, null);
    await expect(readOutboxStatus(executor, PAIRING)).resolves.toEqual(zero);
  });
});

describe("how long the delivery has been stuck", () => {
  const NOW = new Date("2026-10-08T09:53:00.000Z");

  it("is read from the oldest record not delivered, in the order the sender takes them", async () => {
    const { db, executor } = openLocalDb();
    // Another pairing's record is older and first in the table: it is not ours.
    put(db, OTHER_DEVICE, 1, null, "2026-10-08T05:00:00.000Z");
    put(db, PAIRING, 1, "accepted", "2026-10-08T06:00:00.000Z");
    put(db, PAIRING, 1, null, "2026-10-08T09:41:00.000Z");
    put(db, PAIRING, 1, null, "2026-10-08T09:30:00.000Z");
    db.prepare(
      "UPDATE outbox SET attempts = 5, sent_at = '2026-10-08T09:50:30.000Z' " +
        "WHERE host_id = ? AND device_id = ? AND created_at = '2026-10-08T09:41:00.000Z'",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 12 * 60_000,
      attempts: 5,
      sinceLastAttemptMs: 150_000,
    });
  });

  it("is nothing when no record waits, and never a negative wait", async () => {
    const { db, executor } = openLocalDb();
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toBeNull();
    put(db, PAIRING, 2, "accepted");
    put(db, OTHER_DEVICE, 2, null);
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toBeNull();
    put(db, PAIRING, 1, null, "2026-10-08T11:00:00.000Z");
    db.prepare(
      "UPDATE outbox SET sent_at = '2026-10-08T11:30:00.000Z' WHERE acked_at IS NULL",
    ).run();
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 0,
      attempts: 0,
      sinceLastAttemptMs: 0,
    });
  });

  it("has no last attempt for a record that was never sent", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 1, null, "2026-10-08T09:43:00.000Z");
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 10 * 60_000,
      attempts: 0,
      sinceLastAttemptMs: null,
    });
  });

  /** A restore of the host this pairing settled at `at` (`floor_restore_epochs`, plan РК-С). */
  function reconciled(
    db: DatabaseSync,
    pairing: { hostId: string; deviceId: string },
    at: string | null,
  ): void {
    db.prepare(
      "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at, reconciled_at) " +
        "VALUES (?, ?, '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e', '2026-10-08T09:00:00.000Z', ?)",
    ).run(pairing.hostId, pairing.deviceId, at);
  }

  it("counts from the reconciliation after a restore, not from a reopened record's creation", async () => {
    const { db, executor } = openLocalDb();
    // Acknowledged weeks ago and sent again by the reconciliation five minutes ago.
    put(db, PAIRING, 1, null, "2026-09-18T06:00:00.000Z");
    db.prepare(
      "UPDATE outbox SET attempts = 1, sent_at = '2026-09-18T06:00:05.000Z' WHERE acked_at IS NULL",
    ).run();
    reconciled(db, PAIRING, "2026-10-08T09:48:00.000Z");
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 5 * 60_000,
      attempts: 1,
      // The send before the restore is not this delivery's.
      sinceLastAttemptMs: null,
    });
    // A send after the reconciliation is.
    db.prepare(
      "UPDATE outbox SET attempts = 2, sent_at = '2026-10-08T09:51:00.000Z' WHERE acked_at IS NULL",
    ).run();
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 5 * 60_000,
      attempts: 2,
      sinceLastAttemptMs: 2 * 60_000,
    });
  });

  it("counts a record written after the reconciliation from its own creation", async () => {
    const { db, executor } = openLocalDb();
    reconciled(db, PAIRING, "2026-10-08T08:53:00.000Z");
    put(db, PAIRING, 1, null, "2026-10-08T09:43:00.000Z");
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual({
      waitedMs: 10 * 60_000,
      attempts: 0,
      sinceLastAttemptMs: null,
    });
  });

  it("is not clamped by an obligation still owed, nor by another pairing's reconciliation", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 1, null, "2026-10-08T06:53:00.000Z");
    db.prepare(
      "UPDATE outbox SET attempts = 3, sent_at = '2026-10-08T09:23:00.000Z' WHERE acked_at IS NULL",
    ).run();
    reconciled(db, OTHER_DEVICE, "2026-10-08T09:50:00.000Z");
    reconciled(db, OTHER_HOST, "2026-10-08T09:50:00.000Z");
    const unclamped = { waitedMs: 3 * 60 * 60_000, attempts: 3, sinceLastAttemptMs: 30 * 60_000 };
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual(unclamped);
    reconciled(db, PAIRING, null);
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).resolves.toEqual(unclamped);
  });

  it("is not read from a time it cannot understand", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 1, null, "not a time");
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).rejects.toThrow();
    db.prepare(
      "UPDATE outbox SET created_at = '2026-10-08T09:43:00.000Z', sent_at = 'never'",
    ).run();
    await expect(readDeliveryStuck(executor, PAIRING, NOW)).rejects.toThrow();
  });

  it("is written as the two largest units, rounded down, and as nothing under a minute", () => {
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const cases: [number, ReturnType<typeof waitUnits>][] = [
      [0, []],
      [MINUTE - 1, []],
      [MINUTE, [{ unit: "minute", n: 1 }]],
      [59 * MINUTE + 59_999, [{ unit: "minute", n: 59 }]],
      [HOUR, [{ unit: "hour", n: 1 }]],
      [
        HOUR + MINUTE,
        [
          { unit: "hour", n: 1 },
          { unit: "minute", n: 1 },
        ],
      ],
      [
        2 * HOUR + 5 * MINUTE + 59_000,
        [
          { unit: "hour", n: 2 },
          { unit: "minute", n: 5 },
        ],
      ],
      [
        DAY - 1,
        [
          { unit: "hour", n: 23 },
          { unit: "minute", n: 59 },
        ],
      ],
      [DAY, [{ unit: "day", n: 1 }]],
      [
        DAY + 3 * HOUR + 59 * MINUTE,
        [
          { unit: "day", n: 1 },
          { unit: "hour", n: 3 },
        ],
      ],
      [25 * DAY, [{ unit: "day", n: 25 }]],
      [3 * DAY + MINUTE, [{ unit: "day", n: 3 }]],
    ];
    for (const [ms, units] of cases) expect(waitUnits(ms), String(ms)).toEqual(units);
  });
});

describe("the serials left for a shift", () => {
  /** The same fixture shift under another pairing, with the issuer prefix of another organization. */
  async function twoPairings() {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    await keepEnteredShift(executor, OTHER_DEVICE, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    db.prepare(
      "UPDATE floor_shifts SET snapshot = json_set(snapshot, '$.issuerPrefix', ?) WHERE device_id = ?",
    ).run(THEIR_PREFIX, OTHER_DEVICE.deviceId);
    return { db, executor };
  }

  it("are those of the shift's own issuer prefix and pairing, not of any other", async () => {
    const { db, executor } = await twoPairings();
    // ENTERED's prefix is 460068200: this pairing has 990 left of it and 500 of the other prefix.
    seedBlock(db, { blockId: "00000000-0000-4000-8000-0000000000a1", from: 1, to: 1000, next: 11 });
    seedBlock(db, {
      blockId: "00000000-0000-4000-8000-0000000000a2",
      from: 1,
      to: 500,
      prefix: THEIR_PREFIX,
    });
    // The other pairing's own: 70 of its prefix, and some of ours that are not its.
    seedBlock(db, {
      blockId: "00000000-0000-4000-8000-0000000000b1",
      from: 1,
      to: 70,
      prefix: THEIR_PREFIX,
      deviceId: OTHER_DEVICE.deviceId,
    });
    seedBlock(db, {
      blockId: "00000000-0000-4000-8000-0000000000b2",
      from: 1,
      to: 300,
      deviceId: OTHER_DEVICE.deviceId,
    });
    await expect(readSerialsLeft(executor, PAIRING, ENTERED.id)).resolves.toBe(990);
    await expect(readSerialsLeft(executor, OTHER_DEVICE, ENTERED.id)).resolves.toBe(70);
  });

  it("are counted for boxes, not pallets, and a used-up block has none", async () => {
    const { db, executor } = await twoPairings();
    seedBlock(db, {
      blockId: "00000000-0000-4000-8000-0000000000a1",
      from: 1,
      to: 100,
      next: 101,
    });
    seedBlock(db, {
      blockId: "00000000-0000-4000-8000-0000000000a2",
      from: 0,
      to: 99,
      extension: 1,
    });
    await expect(readSerialsLeft(executor, PAIRING, ENTERED.id)).resolves.toBe(0);
  });

  it("are not known for a shift without a snapshot or without a copy", async () => {
    const { db, executor } = await twoPairings();
    seedBlock(db, { blockId: "00000000-0000-4000-8000-0000000000a1", from: 1, to: 100 });
    await expect(readSerialsLeft(executor, PAIRING, "no-such-shift")).resolves.toBeNull();
    db.prepare(
      "UPDATE floor_shifts SET snapshot = NULL, entered_at = NULL WHERE device_id = ?",
    ).run(PAIRING.deviceId);
    await expect(readSerialsLeft(executor, PAIRING, ENTERED.id)).resolves.toBeNull();
  });
});

describe("resolved records (plan ОЧ)", () => {
  it("count neither as refused nor as in conflict once a person resolved them", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 3, "rejected");
    put(db, PAIRING, 2, "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = '2026-10-11T08:00:00.000Z', " +
        "resolved_by = 'op-1' WHERE id IN (SELECT id FROM outbox WHERE outcome = 'rejected' " +
        "ORDER BY seq LIMIT 2) OR id IN (SELECT id FROM outbox WHERE outcome = 'conflict' " +
        "ORDER BY seq LIMIT 1)",
    ).run();
    await expect(readOutboxStatus(executor, PAIRING)).resolves.toEqual({
      unsent: 0,
      rejected: 1,
      conflicts: 1,
    });
  });
});
