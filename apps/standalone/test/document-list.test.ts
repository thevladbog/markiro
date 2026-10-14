import { describe, expect, it } from "vitest";

import {
  dayStartInstant,
  documentFilter,
  type DocumentFilterState,
} from "../src/office/disaggregation/document-list.js";

const REASON = "d15a0000-0000-4000-8000-000000000003";
const EMPTY: DocumentFilterState = { status: "all", reasonId: "", docNo: "", from: "", to: "" };

describe("the start of a civil day as the host's instant", () => {
  it("is the zone's midnight in UTC", () => {
    expect(dayStartInstant("2026-10-13", "Europe/Moscow")).toBe("2026-10-12T21:00:00Z");
    expect(dayStartInstant("2026-10-13", "UTC")).toBe("2026-10-13T00:00:00Z");
  });

  it("survives the day the zone changes its clock", () => {
    expect(dayStartInstant("2026-03-29", "Europe/Berlin")).toBe("2026-03-28T23:00:00Z");
    expect(dayStartInstant("2026-03-30", "Europe/Berlin")).toBe("2026-03-29T22:00:00Z");
  });

  it("refuses what is not a civil date", () => {
    expect(() => dayStartInstant("13.10.2026", "UTC")).toThrow(RangeError);
  });
});

describe("the host's list filter", () => {
  it("turns the days into the zone's instants and trims the number", () => {
    expect(
      documentFilter(
        {
          status: "applied",
          reasonId: REASON,
          docNo: " 0007 ",
          from: "2026-10-13",
          to: "2026-10-13",
        },
        "Europe/Moscow",
      ),
    ).toEqual({
      status: "applied",
      reasonId: REASON,
      q: "0007",
      from: "2026-10-12T21:00:00Z",
      to: "2026-10-13T20:59:59Z",
    });
  });

  it("keeps out «all», empty strings and a blank number", () => {
    expect(documentFilter(EMPTY, "UTC")).toEqual({});
    expect(documentFilter({ ...EMPTY, docNo: "   " }, "UTC")).toEqual({});
  });

  it("ignores a period end that is no civil date instead of throwing", () => {
    expect(documentFilter({ ...EMPTY, from: "13.10.20", to: "2026-1" }, "UTC")).toEqual({});
  });

  it("ends the last day on its last second in the zone of a clock change", () => {
    expect(documentFilter({ ...EMPTY, to: "2026-03-29" }, "Europe/Berlin")).toEqual({
      to: "2026-03-29T21:59:59Z",
    });
  });
});
