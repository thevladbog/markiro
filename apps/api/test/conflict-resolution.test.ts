import { describe, expect, it } from "vitest";
import {
  collapseClaims,
  conflictsAgainstOwner,
  displacedIncumbents,
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

describe("collapseClaims", () => {
  it("passes through a single unowned code untouched", () => {
    const claims = collapseClaims([item(HASH, "t1", "2026-07-28T10:00:00.000Z")]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.terminalId).toBe("t1");
  });

  it("collapses a code appearing twice in one batch, keeping the earliest", () => {
    const claims = collapseClaims([
      item(HASH, "t1", "2026-07-28T10:00:05.000Z"),
      item(HASH, "t1", "2026-07-28T10:00:00.000Z"),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
  });

  it("handles several codes independently", () => {
    const claims = collapseClaims([
      item(HASH, "t2", "2026-07-28T10:00:05.000Z"),
      item(OTHER, "t2", "2026-07-28T10:00:06.000Z"),
    ]);
    expect(claims.map((c) => c.codeHash).sort()).toEqual([HASH, OTHER].sort());
  });

  it("collapses three in-batch duplicates, keeping the true earliest regardless of position", () => {
    // Regression for a pairwise fold: comparing each item only against the
    // current running winner can make an early loser lose to an
    // intermediate value that a still-earlier duplicate later beats.
    const claims = collapseClaims([
      item(HASH, "ta", "2026-07-28T10:00:05.000Z"),
      item(HASH, "tb", "2026-07-28T10:00:03.000Z"),
      item(HASH, "tc", "2026-07-28T10:00:00.000Z"),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.terminalId).toBe("tc");
    expect(claims[0]!.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
  });

  it("produces the same claim regardless of batch array order", () => {
    const items = [
      item(HASH, "ta", "2026-07-28T10:00:05.000Z"),
      item(HASH, "tb", "2026-07-28T10:00:03.000Z"),
      item(HASH, "tc", "2026-07-28T10:00:00.000Z"),
    ];
    const descending = collapseClaims(items);
    const ascending = collapseClaims([...items].reverse());
    expect(descending.map((c) => c.terminalId)).toEqual(["tc"]);
    expect(ascending.map((c) => c.terminalId)).toEqual(["tc"]);
  });

  it("keeps the first item in array order on an exact tie", () => {
    const claims = collapseClaims([
      item(HASH, "ta", "2026-07-28T10:00:00.000Z"),
      item(HASH, "tb", "2026-07-28T10:00:00.000Z"),
    ]);
    expect(claims[0]!.terminalId).toBe("ta");
  });
});

describe("conflictsAgainstOwner", () => {
  it("reports no conflict for a scan that IS the owner", () => {
    const ownerByHash = new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")]]);
    const rows = conflictsAgainstOwner([item(HASH, "t1", "2026-07-28T10:00:00.000Z")], ownerByHash);
    expect(rows).toEqual([]);
  });

  it("reports a conflict for a scan that lost to the current owner", () => {
    const ownerByHash = new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")]]);
    const rows = conflictsAgainstOwner([item(HASH, "t2", "2026-07-28T10:00:05.000Z")], ownerByHash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.losing.terminalId).toBe("t2");
    expect(rows[0]!.winning.terminalId).toBe("t1");
  });

  it("pairs every non-owner scan in the batch against the SAME true owner", () => {
    // Three items for one code; only "tc" (the true owner, e.g. because it
    // won the upsert) matches ownerByHash -- the other two must both be
    // reported as losses to "tc", never to each other.
    const ownerByHash = new Map([[HASH, owner(HASH, "tc", "2026-07-28T10:00:00.000Z")]]);
    const rows = conflictsAgainstOwner(
      [
        item(HASH, "ta", "2026-07-28T10:00:05.000Z"),
        item(HASH, "tb", "2026-07-28T10:00:03.000Z"),
        item(HASH, "tc", "2026-07-28T10:00:00.000Z"),
      ],
      ownerByHash,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.winning.terminalId).toBe("tc");
    }
    expect(rows.map((r) => r.losing.terminalId).sort()).toEqual(["ta", "tb"]);
  });

  it("handles several codes independently", () => {
    const ownerByHash = new Map([
      [HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
      [OTHER, owner(OTHER, "t2", "2026-07-28T10:00:06.000Z")],
    ]);
    const rows = conflictsAgainstOwner(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z"), item(OTHER, "t2", "2026-07-28T10:00:06.000Z")],
      ownerByHash,
    );
    expect(rows.map((c) => c.codeHash)).toEqual([HASH]);
  });

  it("reports a conflict when the same shift and terminal rescans a code at a different instant", () => {
    // Regression for `sameScan` dropping `scannedAt` from its comparison:
    // every OTHER case here matches shift, terminal, AND time simultaneously
    // when asserting "is the owner", so a mutant that compares only shift and
    // terminal would still pass all of them. Same (shiftId, terminalId) as
    // the owner, but a genuinely different scannedAt, must still be reported
    // as a loss -- it is a distinct scan, not the owner's own claim echoed
    // back.
    const ownerByHash = new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")]]);
    const rows = conflictsAgainstOwner([item(HASH, "t1", "2026-07-28T10:00:05.000Z")], ownerByHash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.losing.terminalId).toBe("t1");
    expect(rows[0]!.losing.scannedAt.toISOString()).toBe("2026-07-28T10:00:05.000Z");
    expect(rows[0]!.winning.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
  });
});

describe("displacedIncumbents", () => {
  it("reports nothing for a code this batch did not win", () => {
    const rows = displacedIncumbents(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z")],
      new Set(),
      new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")]]),
    );
    expect(rows).toEqual([]);
  });

  it("reports nothing for a fresh claim with no prior incumbent", () => {
    const rows = displacedIncumbents(
      [item(HASH, "t1", "2026-07-28T10:00:00.000Z")],
      new Set([HASH]),
      new Map(),
    );
    expect(rows).toEqual([]);
  });

  it("reports the displaced incumbent for a code this batch won away from it", () => {
    const claim = item(HASH, "t2", "2026-07-28T10:00:00.000Z");
    const rows = displacedIncumbents(
      [claim],
      new Set([HASH]),
      new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:05.000Z")]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.losing.terminalId).toBe("t1");
    expect(rows[0]!.winning.terminalId).toBe("t2");
  });

  it("reports nothing when the prior incumbent IS this batch's own claim", () => {
    // Defensive: should not arise in practice (a code whose incumbent is
    // already exactly this claim would never pass setWhere's strict "<"),
    // but must not fabricate a self-displacement if it ever did.
    const claim = item(HASH, "t1", "2026-07-28T10:00:00.000Z");
    const rows = displacedIncumbents(
      [claim],
      new Set([HASH]),
      new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:00.000Z")]]),
    );
    expect(rows).toEqual([]);
  });

  it("reports a displacement when the winning claim shares the incumbent's shift and terminal but not its instant", () => {
    // Same `sameScan` regression as conflictsAgainstOwner's analogous case,
    // for the other direction: a claim from the SAME (shiftId, terminalId)
    // as the prior incumbent, but at a genuinely different scannedAt, is a
    // distinct scan and must still be recorded as a displacement -- dropping
    // `scannedAt` from the comparison would wrongly treat this as "the
    // incumbent is this batch's own claim" and swallow it.
    const claim = item(HASH, "t1", "2026-07-28T10:00:00.000Z");
    const rows = displacedIncumbents(
      [claim],
      new Set([HASH]),
      new Map([[HASH, owner(HASH, "t1", "2026-07-28T10:00:05.000Z")]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.losing.scannedAt.toISOString()).toBe("2026-07-28T10:00:05.000Z");
    expect(rows[0]!.winning.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
  });
});
