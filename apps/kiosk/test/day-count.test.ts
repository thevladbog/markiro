import { describe, expect, it } from "vitest";
import { countTakenToday, startOfUtcDay, utcDayOf } from "../src/session/day-count.js";
import type { JournalEntry } from "../src/store/journal.js";
import type { QueuedOrder } from "../src/store/queue.js";

const ME = "e1";
const SOMEBODY_ELSE = "e2";
const TODAY = "2026-07-28";

const journalled = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  at: "2026-07-28T09:00:01.000Z",
  createdAt: "2026-07-28T09:00:00.000Z",
  deviceSeq: 1,
  orderNo: "ORD-26-0001",
  conflicts: [],
  employeeId: ME,
  acceptedCount: 1,
  ...over,
});

const queued = (
  over: Partial<Omit<QueuedOrder, "body">> & { items?: number; createdAt?: string } = {},
): QueuedOrder => ({
  deviceSeq: over.deviceSeq ?? 1,
  employeeId: over.employeeId ?? ME,
  body: {
    deviceSeq: over.deviceSeq ?? 1,
    badgeCode: "BADGE-1",
    reason: "buy",
    items: Array.from({ length: over.items ?? 1 }, (_, i) => ({ rawKm: `01…${i}` })),
    createdAt: over.createdAt ?? "2026-07-28T09:00:00.000Z",
  },
});

const count = (journal: JournalEntry[], queue: QueuedOrder[] = []): number =>
  countTakenToday({ employeeId: ME, today: TODAY, journal, queued: queue });

describe("utcDayOf", () => {
  /**
   * UTC, deliberately, because `applyDayLimit` compares
   * `(created_at at time zone 'utc')::date` — a device that counted by its own
   * local midnight would disagree with the server for the hours between the
   * two boundaries, in whichever direction the kiosk's timezone offset points.
   *
   * Both edges are asserted: an implementation reading local calendar fields
   * gets the 23:30 instant wrong in any timezone ahead of UTC and the 00:30
   * one wrong in any timezone behind it.
   */
  it("reads the UTC calendar day, not the device's own", () => {
    expect(utcDayOf(new Date("2026-07-28T23:30:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T00:30:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T00:00:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T23:59:59.999Z"))).toBe("2026-07-28");
  });

  it("starts the day at UTC midnight", () => {
    expect(startOfUtcDay(new Date("2026-07-28T23:30:00.000Z")).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(startOfUtcDay(new Date("2026-07-28T00:00:00.000Z")).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
  });
});

describe("countTakenToday", () => {
  it("is zero on a device that has handed out nothing", () => {
    expect(count([])).toBe(0);
  });

  it("adds up what the server accepted from this employee's orders today", () => {
    expect(
      count([
        journalled({ deviceSeq: 1, acceptedCount: 2 }),
        journalled({ deviceSeq: 2, acceptedCount: 1 }),
      ]),
    ).toBe(3);
  });

  // A refused item never counted against the worker server-side, so it must
  // not count here either: `acceptedCount` is the server's own number, not the
  // length of what the device scanned.
  it("counts what the server accepted, not what was scanned", () => {
    expect(
      count([
        journalled({
          acceptedCount: 1,
          conflicts: [
            { rawKm: "01…a", reason: "duplicate" },
            { rawKm: "01…b", reason: "over_limit" },
          ],
        }),
      ]),
    ).toBe(1);
  });

  it("ignores another employee's orders", () => {
    expect(count([journalled({ employeeId: SOMEBODY_ELSE, acceptedCount: 4 })])).toBe(0);
  });

  /**
   * The boundary the server draws. `applyDayLimit` counts orders whose
   * `created_at` falls on the UTC date of THIS order's `created_at`, so an
   * order stamped 23:59:59.999Z yesterday is spent allowance the worker gets
   * back one millisecond later, and one stamped 00:00:00.000Z today is not.
   */
  it("counts the UTC day of the order's own scan time and nothing either side of it", () => {
    expect(
      count([
        journalled({ deviceSeq: 1, createdAt: "2026-07-27T23:59:59.999Z", acceptedCount: 9 }),
        journalled({ deviceSeq: 2, createdAt: "2026-07-28T00:00:00.000Z" }),
        journalled({ deviceSeq: 3, createdAt: "2026-07-28T23:59:59.999Z" }),
        journalled({ deviceSeq: 4, createdAt: "2026-07-29T00:00:00.000Z", acceptedCount: 9 }),
      ]),
    ).toBe(2);
  });

  // The scan time, not the sync time: an order queued through an outage is
  // filed by the server under the moment it was taken, and `at` — when the
  // device finally got an answer — can be days later.
  it("places an order by when it was taken, not by when it synced", () => {
    expect(
      count([
        journalled({ at: "2026-07-28T09:00:00.000Z", createdAt: "2026-07-26T09:00:00.000Z" }),
      ]),
    ).toBe(0);
    expect(
      count([
        journalled({ at: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-28T09:00:00.000Z" }),
      ]),
    ).toBe(1);
  });

  it("counts a still-queued order in full — the server has not yet said what it accepts", () => {
    expect(count([], [queued({ items: 3 })])).toBe(3);
  });

  it("ignores a queued order belonging to somebody else, or to another day", () => {
    expect(
      count(
        [],
        [
          queued({ deviceSeq: 1, employeeId: SOMEBODY_ELSE, items: 3 }),
          queued({ deviceSeq: 2, createdAt: "2026-07-27T23:59:59.999Z", items: 3 }),
        ],
      ),
    ).toBe(0);
  });

  /**
   * `flushQueue` journals BEFORE it dequeues, so a crash — or a failing
   * `dequeueOrder` — leaves one order in both places at once. Counting it twice
   * would charge a worker for bottles they took once, which is the one
   * direction this count must never lean.
   */
  it("counts an order once when it is both journalled and still queued", () => {
    expect(
      count([journalled({ deviceSeq: 7, acceptedCount: 1 })], [queued({ deviceSeq: 7 })]),
    ).toBe(1);
  });

  it("counts a replayed order once, however often its verdict was journalled", () => {
    expect(
      count([
        journalled({ deviceSeq: 7 }),
        journalled({ deviceSeq: 7 }),
        journalled({ deviceSeq: 7 }),
      ]),
    ).toBe(1);
  });

  /**
   * Records written before this change carry no employee and no accepted
   * count. They cannot be attributed to anyone, so they are skipped — never
   * charged to whoever happens to badge in next, and never allowed to throw on
   * the path that opens a worker's cart.
   */
  it("skips a journal entry written before the journal carried an employee", () => {
    const legacy = {
      at: "2026-07-28T09:00:00.000Z",
      deviceSeq: 1,
      orderNo: "ORD-26-0001",
      conflicts: [],
    } as unknown as JournalEntry;

    expect(count([legacy])).toBe(0);
    expect(count([legacy, journalled({ deviceSeq: 2, acceptedCount: 2 })])).toBe(2);
  });

  it("skips a queued order left behind by an older app version", () => {
    const legacy = { deviceSeq: 1, body: queued().body } as unknown as QueuedOrder;

    expect(count([], [legacy])).toBe(0);
  });

  it("skips a record it cannot place in time", () => {
    expect(count([journalled({ createdAt: "not-a-date" })])).toBe(0);
    expect(count([journalled({ createdAt: "" })])).toBe(0);
  });

  it("skips a journal entry whose accepted count is not a number", () => {
    expect(count([journalled({ acceptedCount: "2" as unknown as number })])).toBe(0);
  });
});
