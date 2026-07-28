import { describe, expect, it } from "vitest";
import { appendJournal, readJournal } from "../src/store/journal.js";
import type { JournalEntry } from "../src/store/journal.js";

const entry = (orderNo: string): JournalEntry => ({
  at: "2026-07-28T06:00:00.000Z",
  deviceSeq: 1,
  orderNo,
  conflicts: [],
});

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
