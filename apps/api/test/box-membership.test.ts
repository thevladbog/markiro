import { describe, expect, it } from "vitest";
import { displacedHashes } from "../src/modules/station-scans/box-membership.js";

const at = new Date("2026-07-29T10:00:00.000Z");

describe("displacedHashes", () => {
  it("is empty when every item's code is owned by its own scan", () => {
    expect(
      displacedHashes([{ boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: true }]),
    ).toEqual([]);
  });

  it("names an item whose code is owned elsewhere", () => {
    expect(
      displacedHashes([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b1", codeHash: "bb", addedAt: at, ownerIsThisScan: true },
      ]),
    ).toEqual(["aa"]);
  });

  it("names the same hash once when it appears in two boxes", () => {
    expect(
      displacedHashes([
        { boxId: "b1", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
        { boxId: "b2", codeHash: "aa", addedAt: at, ownerIsThisScan: false },
      ]),
    ).toEqual(["aa"]);
  });
});
