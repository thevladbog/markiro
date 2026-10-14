import { describe, expect, it } from "vitest";

import {
  conflictQuery,
  loserBoxLink,
  readPage,
  readReviewed,
} from "../src/office/conflicts/conflict-list.js";
import type { OfficeConflictScan } from "../src/host/review.js";

const SCAN: OfficeConflictScan = {
  shiftId: "shift-1",
  shiftNumber: "OCT26-004",
  deviceId: "d-1",
  deviceName: "Станция А",
  operatorName: null,
  scannedAt: "2026-10-08T06:01:40.000Z",
  boxId: "box-1",
  boxSscc: "046006820000015001",
};

describe("the conflicts' filters and links (plan КНФ)", () => {
  it("asks the unreviewed ones by default and leaves out what is not narrowed", () => {
    expect(readReviewed(null)).toBe("unreviewed");
    expect(readReviewed("all")).toBe("all");
    expect(readReviewed("nonsense")).toBe("unreviewed");
    expect(conflictQuery("", "unreviewed", 1)).toEqual({ reviewed: false, page: 1 });
    expect(conflictQuery("s-1", "all", 2)).toEqual({ shiftId: "s-1", page: 2 });
    expect(conflictQuery("", "reviewed", 1)).toEqual({ reviewed: true, page: 1 });
  });

  it("reads a page as a positive whole number, the first otherwise", () => {
    expect([readPage(null), readPage("3"), readPage("0"), readPage("x"), readPage("2.5")]).toEqual([
      1, 3, 1, 1, 1,
    ]);
    // The host answers pages 1 to 200 only.
    expect([readPage("200"), readPage("201"), readPage("99999999999999999999")]).toEqual([
      200, 1, 1,
    ]);
  });

  it("opens the loser's box in its card (plan КРТ), a scan with no box in its shift's card", () => {
    expect(loserBoxLink(SCAN)).toBe("/codes/box/box-1");
    expect(loserBoxLink({ ...SCAN, boxSscc: null })).toBe("/codes/box/box-1");
    expect(loserBoxLink({ ...SCAN, boxId: null, boxSscc: null })).toBe("/shifts/shift-1");
  });
});
