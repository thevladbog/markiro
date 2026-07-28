import { describe, expect, it } from "vitest";
import {
  resolveOwnership,
  type ClaimItem,
  type OwnerRow,
} from "../src/modules/station-scans/conflict-resolution";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const at = (iso: string) => new Date(iso);

function item(codeHash: string, terminalId: string, iso: string): ClaimItem {
  return { codeHash, shiftId: "s1", terminalId, scannedAt: at(iso) };
}
function owner(codeHash: string, terminalId: string, iso: string): OwnerRow {
  return { codeHash, shiftId: "s1", terminalId, scannedAt: at(iso) };
}

describe("resolveOwnership", () => {
  it("claims an unowned code with no conflict", () => {
    const r = resolveOwnership([item(HASH, "t1", "2026-07-28T10:00:00.000Z")], []);
    expect(r.claims).toHaveLength(1);
    expect(r.conflicts).toEqual([]);
    expect(r.lostByThisBatch).toEqual([]);
  });

  it("loses to an earlier incumbent and reports it to the sender", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims).toEqual([]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.terminalId).toBe("t2");
    expect(r.conflicts[0]!.winning.terminalId).toBe("t1");
    expect(r.lostByThisBatch).toEqual(r.conflicts);
  });

  it("displaces a later incumbent and does NOT report that to the sender", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:00.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:05.000Z")],
    );
    expect(r.claims).toHaveLength(1);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.terminalId).toBe("t1");
    expect(r.conflicts[0]!.winning.terminalId).toBe("t2");
    // The sender won; it must not be told its own scan is in trouble.
    expect(r.lostByThisBatch).toEqual([]);
  });

  it("leaves ownership with the incumbent on an exact tie", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:00.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims).toEqual([]);
    expect(r.conflicts[0]!.winning.terminalId).toBe("t1");
  });

  it("collapses a code appearing twice in one batch, keeping the earliest", () => {
    const r = resolveOwnership(
      [item(HASH, "t1", "2026-07-28T10:00:05.000Z"), item(HASH, "t1", "2026-07-28T10:00:00.000Z")],
      [],
    );
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.scannedAt.toISOString()).toBe("2026-07-28T10:00:05.000Z");
  });

  it("handles several codes independently", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z"), item(OTHER, "t2", "2026-07-28T10:00:06.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims.map((c) => c.codeHash)).toEqual([OTHER]);
    expect(r.conflicts.map((c) => c.codeHash)).toEqual([HASH]);
  });

  it("collapses three in-batch duplicates so every conflict names the true earliest as winner", () => {
    // Regression for a pairwise fold: comparing each item only against the
    // current running winner can make an early loser lose to an
    // intermediate value that a still-earlier duplicate later beats.
    const r = resolveOwnership(
      [
        item(HASH, "ta", "2026-07-28T10:00:05.000Z"),
        item(HASH, "tb", "2026-07-28T10:00:03.000Z"),
        item(HASH, "tc", "2026-07-28T10:00:00.000Z"),
      ],
      [],
    );

    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.terminalId).toBe("tc");
    expect(r.claims[0]!.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");

    expect(r.conflicts).toHaveLength(2);
    for (const c of r.conflicts) {
      expect(c.winning.terminalId).toBe("tc");
    }
    expect(r.conflicts.map((c) => c.losing.terminalId).sort()).toEqual(["ta", "tb"]);
  });

  it("produces the same claim and the same losing/winning pairs regardless of batch array order", () => {
    const items = [
      item(HASH, "ta", "2026-07-28T10:00:05.000Z"),
      item(HASH, "tb", "2026-07-28T10:00:03.000Z"),
      item(HASH, "tc", "2026-07-28T10:00:00.000Z"),
    ];
    const pairs = (r: ReturnType<typeof resolveOwnership>) =>
      r.conflicts.map((c) => `${c.losing.terminalId}->${c.winning.terminalId}`).sort();

    const descending = resolveOwnership(items, []);
    const ascending = resolveOwnership([...items].reverse(), []);

    expect(descending.claims.map((c) => c.terminalId)).toEqual(["tc"]);
    expect(ascending.claims.map((c) => c.terminalId)).toEqual(["tc"]);
    expect(pairs(descending)).toEqual(pairs(ascending));
    expect(pairs(descending)).toEqual(["ta->tc", "tb->tc"]);
  });
});
