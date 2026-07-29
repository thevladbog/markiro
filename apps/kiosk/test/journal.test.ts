import { describe, expect, it } from "vitest";
import { countTakenToday, startOfUtcDay, utcDayOf } from "../src/session/day-count.js";
import {
  appendJournal,
  JOURNAL_RETENTION_MS,
  readJournal,
  readJournalSince,
} from "../src/store/journal.js";
import type { JournalEntry } from "../src/store/journal.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const EMPLOYEE = "e1";

/** `at` and `createdAt` an instant apart, which is the normal online case:
 * the order is scanned and acknowledged in the same breath. */
const entry = (orderNo: string, over: Partial<JournalEntry> = {}): JournalEntry => ({
  at: "2026-07-28T06:00:01.000Z",
  createdAt: "2026-07-28T06:00:00.000Z",
  deviceSeq: 1,
  orderNo,
  conflicts: [],
  employeeId: EMPLOYEE,
  acceptedCount: 1,
  ...over,
});

/** An instant `ms` before the frozen `NOW`, as an ISO stamp. */
const before = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const DAY_MS = 24 * 60 * 60_000;

describe("journal", () => {
  it("returns [] before anything is stored", async () => {
    await expect(readJournal(10)).resolves.toEqual([]);
  });

  it("round-trips a single entry", async () => {
    await appendJournal(entry("A"));
    expect((await readJournal(10)).map((e) => e.orderNo)).toEqual(["A"]);
  });

  it("returns entries most-recent-first", async () => {
    await appendJournal(entry("A"));
    await appendJournal(entry("B"));
    await appendJournal(entry("C"));
    expect((await readJournal(10)).map((e) => e.orderNo)).toEqual(["C", "B", "A"]);
  });

  it("respects the limit when more entries exist", async () => {
    await appendJournal(entry("A"));
    await appendJournal(entry("B"));
    await appendJournal(entry("C"));
    expect((await readJournal(2)).map((e) => e.orderNo)).toEqual(["C", "B"]);
  });

  it("returns fewer than the limit when fewer entries exist", async () => {
    await appendJournal(entry("A"));
    await appendJournal(entry("B"));
    expect((await readJournal(10)).map((e) => e.orderNo)).toEqual(["B", "A"]);
  });
});

/**
 * The store is append-only and every entry carries the raw marking codes of
 * whatever the server refused, so without this a kiosk accumulates scanned
 * codes in IndexedDB for the life of the device.
 */
describe("journal retention", () => {
  it("drops entries that have fallen out of the window when a new one is appended", async () => {
    await appendJournal(entry("OLD", { at: before(JOURNAL_RETENTION_MS + DAY_MS) }));
    await appendJournal(entry("RECENT", { at: before(DAY_MS) }));
    await appendJournal(entry("NEW", { at: NOW.toISOString() }));

    expect((await readJournal(10)).map((e) => e.orderNo)).toEqual(["NEW", "RECENT"]);
  });

  it("keeps an entry exactly at the horizon and drops the millisecond past it", async () => {
    await appendJournal(entry("PAST", { at: before(JOURNAL_RETENTION_MS + 1) }));
    await appendJournal(entry("EDGE", { at: before(JOURNAL_RETENTION_MS) }));
    await appendJournal(entry("NEW", { at: NOW.toISOString() }));

    expect((await readJournal(10)).map((e) => e.orderNo)).toEqual(["NEW", "EDGE"]);
  });

  it("prunes many at once, and leaves the store readable", async () => {
    for (let day = 60; day > 0; day--) {
      await appendJournal(entry(`D-${day}`, { at: before(day * DAY_MS) }));
    }
    await appendJournal(entry("TODAY", { at: NOW.toISOString() }));

    const kept = await readJournal(200);
    expect(kept.length).toBe(Math.floor(JOURNAL_RETENTION_MS / DAY_MS) + 1);
    expect(kept[0]?.orderNo).toBe("TODAY");
  });

  /**
   * The retention window is bounded, the day-limit query is not allowed to be:
   * whatever else is pruned, every order taken TODAY has to survive, or a
   * worker's allowance quietly resets mid-day.
   */
  it("never prunes anything the day count needs, even at the day's first minute", async () => {
    const justAfterMidnight = new Date("2026-07-28T00:00:30.000Z");
    for (let day = 60; day > 0; day--) {
      await appendJournal(
        entry(`D-${day}`, {
          deviceSeq: 100 + day,
          at: new Date(justAfterMidnight.getTime() - day * DAY_MS).toISOString(),
          createdAt: new Date(justAfterMidnight.getTime() - day * DAY_MS - 1000).toISOString(),
        }),
      );
    }
    await appendJournal(
      entry("TODAY", {
        deviceSeq: 1,
        at: justAfterMidnight.toISOString(),
        createdAt: "2026-07-28T00:00:10.000Z",
        acceptedCount: 2,
      }),
    );

    const journal = await readJournalSince(startOfUtcDay(justAfterMidnight));
    expect(
      countTakenToday({
        employeeId: EMPLOYEE,
        today: utcDayOf(justAfterMidnight),
        journal,
        queued: [],
      }),
    ).toBe(2);
  });
});

describe("readJournalSince", () => {
  it("returns nothing from an empty store", async () => {
    await expect(readJournalSince(startOfUtcDay(NOW))).resolves.toEqual([]);
  });

  it("stops walking once it is past the instant asked for", async () => {
    await appendJournal(entry("YESTERDAY", { at: before(DAY_MS) }));
    await appendJournal(entry("EARLY", { at: "2026-07-28T00:00:00.000Z" }));
    await appendJournal(entry("LATE", { at: "2026-07-28T11:00:00.000Z" }));

    const found = await readJournalSince(startOfUtcDay(NOW));

    // Newest-first, and the walk ends at the first entry outside the window —
    // it may still hand that one back, which is why the count filters again.
    expect(found.slice(0, 2).map((e) => e.orderNo)).toEqual(["LATE", "EARLY"]);
    expect(found.filter((e) => e.orderNo === "YESTERDAY").length).toBeLessThanOrEqual(1);
  });

  /**
   * The subtle one. An order queued through an outage is journalled when it
   * finally syncs, so a THREE-DAY-OLD order can be the newest entry in the
   * store — and today's order sits behind it. A walk that stopped at the first
   * entry created before today would never reach today's own order and would
   * hand the worker their whole allowance back.
   */
  it("reaches today's order sitting behind an outage replay journalled after it", async () => {
    await appendJournal(
      entry("TODAY", {
        deviceSeq: 1,
        at: "2026-07-28T09:01:00.000Z",
        createdAt: "2026-07-28T09:00:00.000Z",
        acceptedCount: 2,
      }),
    );
    await appendJournal(
      entry("OUTAGE", {
        deviceSeq: 2,
        at: "2026-07-28T09:02:00.000Z",
        createdAt: "2026-07-25T08:00:00.000Z",
        acceptedCount: 3,
      }),
    );

    const journal = await readJournalSince(startOfUtcDay(NOW));

    expect(journal.map((e) => e.orderNo)).toEqual(["OUTAGE", "TODAY"]);
    expect(
      countTakenToday({ employeeId: EMPLOYEE, today: utcDayOf(NOW), journal, queued: [] }),
    ).toBe(2);
  });
});
