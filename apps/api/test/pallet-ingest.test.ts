import { describe, expect, it } from "vitest";
import { assembleMembershipOutcomes, palletKey } from "../src/modules/station-scans/pallet-ingest";
import type {
  PalletMembershipDto,
  PalletMembershipOutcomeDto,
} from "../src/modules/station-scans/dto";

const membership = (palletId: string, boxSscc: string): PalletMembershipDto => ({
  palletId,
  boxSscc,
  addedAt: "2026-09-17T09:00:00.000Z",
  operatorId: null,
});

describe("assembleMembershipOutcomes", () => {
  const all = [
    membership("w1", "003460682000000101"),
    membership("w1", "003460682000000102"),
    membership("w1", "003460682000000103"),
  ];

  it("keeps a denied membership at its submitted index and walks the applied list around it", () => {
    // Only the MIDDLE record was refused, so the third submitted membership
    // must take the SECOND applied outcome -- the case a naive index-for-index
    // mapping gets wrong and the handheld cannot detect.
    const applied: PalletMembershipOutcomeDto[] = [
      { palletId: "w1", boxSscc: "003460682000000101", status: "accepted" },
      {
        palletId: "w1",
        boxSscc: "003460682000000103",
        status: "already_on_pallet",
        winningPalletSscc: "00103460682000000109",
      },
    ];
    expect(assembleMembershipOutcomes(all, new Set([1]), applied)).toEqual([
      { palletId: "w1", boxSscc: "003460682000000101", status: "accepted" },
      { palletId: "w1", boxSscc: "003460682000000102", status: "subscription_read_only" },
      {
        palletId: "w1",
        boxSscc: "003460682000000103",
        status: "already_on_pallet",
        winningPalletSscc: "00103460682000000109",
      },
    ]);
  });

  it("reports every membership as refused when the whole batch was denied", () => {
    expect(assembleMembershipOutcomes(all, new Set([0, 1, 2]), [])).toEqual([
      { palletId: "w1", boxSscc: "003460682000000101", status: "subscription_read_only" },
      { palletId: "w1", boxSscc: "003460682000000102", status: "subscription_read_only" },
      { palletId: "w1", boxSscc: "003460682000000103", status: "subscription_read_only" },
    ]);
  });

  it("refuses to answer when the two lists disagree about what was applied", () => {
    // Too few outcomes: silently substituting `not_found` would attribute a
    // real refusal to the wrong box.
    expect(() =>
      assembleMembershipOutcomes(all, new Set([1]), [
        { palletId: "w1", boxSscc: "003460682000000101", status: "accepted" },
      ]),
    ).toThrow("membership outcome cursor desynchronised");
    // Too many: the surplus outcome would never be reported at all.
    expect(() =>
      assembleMembershipOutcomes(all, new Set([0, 1, 2]), [
        { palletId: "w1", boxSscc: "003460682000000101", status: "accepted" },
      ]),
    ).toThrow("membership outcome cursor desynchronised");
  });
});

describe("palletKey", () => {
  it("renders a warehouse pallet under a literal that no shift uuid can produce", () => {
    expect(palletKey(null, "device-1", "w1")).toEqual("warehouse|device-1|w1");
  });
});
