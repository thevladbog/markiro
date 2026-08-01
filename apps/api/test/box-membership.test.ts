import { describe, expect, it } from "vitest";
import { displacedMemberships } from "../src/modules/station-scans/box-membership.js";

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
