import { describe, expect, it, vi } from "vitest";
import {
  displacedMemberships,
  insertFreshDisplacedMemberships,
} from "../src/modules/station-scans/box-membership.js";

describe("fresh losing box memberships", () => {
  it("returns only freshly inserted inactive box ids and exact conflicts return none", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ boxId: "box-new" }])
      .mockResolvedValueOnce([]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const rows = [
      {
        boxId: "box-new",
        codeHash: "hash",
        addedAt: new Date("2026-08-13T10:00:00.000Z"),
        ownerIsThisScan: false,
      },
    ];

    expect(await insertFreshDisplacedMemberships({ insert } as never, "tenant-a", rows)).toEqual([
      "box-new",
    ]);
    expect(await insertFreshDisplacedMemberships({ insert } as never, "tenant-a", rows)).toEqual(
      [],
    );
    expect(returning).toHaveBeenCalledWith(expect.objectContaining({ boxId: expect.anything() }));
  });
});

const at = new Date("2026-07-29T10:00:00.000Z");

describe("displacedMemberships", () => {
  it("is empty when every item's code is owned by its own scan", () => {
    expect(
      displacedMemberships([{ boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: true }]),
    ).toEqual([]);
  });

  it("names an item whose code is owned elsewhere", () => {
    expect(
      displacedMemberships([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b1", codeHash: "bb", addedAt: at, ownerIsThisScan: true },
      ]),
    ).toEqual([{ boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false }]);
  });

  it("keeps exact rows when the same hash appears in two boxes", () => {
    expect(
      displacedMemberships([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b2", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
      ]),
    ).toEqual([
      { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
      { boxId: "b2", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
    ]);
  });
});
