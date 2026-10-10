import { describe, expect, it } from "vitest";

import { officeKeys } from "../src/office/office-query.js";
import {
  civilDateLabel,
  findShifts,
  MAX_PERIOD_DAYS,
  openBlocker,
  periodState,
  SHIFT_PAGE_SIZE,
} from "../src/office/shifts/shift-list.js";
import {
  ACTIVE,
  AYRAN_ARCHIVED,
  BOX_58,
  CLOSED,
  KEFIR_DRAFT,
  LINE_10,
  MILK,
  MILK_BOX,
  OLD_BOX,
  PALLET,
  PLANNED,
  WATER,
} from "./support/shifts.js";

describe("the shifts list's rules", () => {
  it("writes a civil date as day, month and year", () => {
    expect(civilDateLabel("2026-10-08")).toBe("08.10.2026");
    expect(civilDateLabel("0024-02-29")).toBe("29.02.0024");
  });

  it("reads the two date fields as no period, half a period, a wrong one or one to ask for", () => {
    expect(periodState("", "")).toEqual({ kind: "none" });
    expect(periodState("2026-10-01", "")).toEqual({ kind: "partial" });
    expect(periodState("", "2026-10-01")).toEqual({ kind: "partial" });
    expect(periodState("2026-10-02", "2026-10-01")).toEqual({ kind: "reversed" });
    expect(periodState("2026-10-01", "2026-10-01")).toEqual({
      kind: "ready",
      from: "2026-10-01",
      to: "2026-10-01",
    });
    expect(MAX_PERIOD_DAYS).toBe(366);
    // 366 days with both ends, across the leap day of 2028.
    expect(periodState("2028-01-01", "2028-12-31")).toEqual({
      kind: "ready",
      from: "2028-01-01",
      to: "2028-12-31",
    });
    expect(periodState("2028-01-01", "2029-01-01")).toEqual({ kind: "too_long" });
  });

  it("claims nothing for a shift that is not planned, or whose product or template the lists lack", () => {
    const products = [MILK, WATER, KEFIR_DRAFT];
    const templates = [BOX_58, MILK_BOX, OLD_BOX];
    const unfit = { ...PLANNED, boxTemplateId: OLD_BOX.id };
    expect(openBlocker(unfit, products, templates)).toBe("template_unfit");
    expect(openBlocker({ ...unfit, status: "active" }, products, templates)).toBeNull();
    expect(openBlocker({ ...unfit, status: "closed" }, products, templates)).toBeNull();
    expect(openBlocker(unfit, undefined, templates)).toBeNull();
    expect(openBlocker(unfit, [MILK], templates)).toBeNull();
    expect(openBlocker(unfit, products, undefined)).toBeNull();
    expect(openBlocker(unfit, products, [BOX_58])).toBeNull();
    // A draft is named before the template is looked at.
    expect(openBlocker({ ...unfit, productId: KEFIR_DRAFT.id }, products, undefined)).toBe(
      "product_draft",
    );
  });

  // Added by the task 3 implementer: the plan's tests leave these boundaries unpinned.
  it("pages by 25 and sends a period of at most 366 days with both ends", () => {
    expect(SHIFT_PAGE_SIZE).toBe(25);
    // 2026 is not a leap year: 365 days, then 366, then 367 with both ends.
    expect(periodState("2026-01-01", "2026-12-31").kind).toBe("ready");
    expect(periodState("2026-01-01", "2027-01-01").kind).toBe("ready");
    expect(periodState("2026-01-01", "2027-01-02")).toEqual({ kind: "too_long" });
    // A reversed period is named before its length is looked at.
    expect(periodState("2027-01-02", "2026-01-01")).toEqual({ kind: "reversed" });
  });

  it("takes a date that is not a civil date for a half period", () => {
    expect(periodState("2026-13-01", "2026-10-01")).toEqual({ kind: "partial" });
    expect(periodState("2026-10-01", "2026-02-30")).toEqual({ kind: "partial" });
    expect(periodState("2026-10-1", "2026-10-02")).toEqual({ kind: "partial" });
  });

  it("names the archived product before its status, and a pallet template does not fit a box", () => {
    const products = [MILK, WATER, { ...KEFIR_DRAFT, archived: true }, AYRAN_ARCHIVED];
    const templates = [BOX_58, MILK_BOX, PALLET];
    expect(openBlocker({ ...PLANNED, productId: KEFIR_DRAFT.id }, products, templates)).toBe(
      "product_archived",
    );
    expect(openBlocker({ ...PLANNED, productId: AYRAN_ARCHIVED.id }, products, templates)).toBe(
      "product_archived",
    );
    expect(openBlocker({ ...PLANNED, boxTemplateId: PALLET.id }, products, templates)).toBe(
      "template_unfit",
    );
    expect(openBlocker(PLANNED, products, templates)).toBeNull();
    expect(
      openBlocker(
        { ...PLANNED, productId: MILK.id, boxTemplateId: MILK_BOX.id },
        products,
        templates,
      ),
    ).toBeNull();
  });

  it("keeps a shift only when the status, the line and the search all keep it, in the host's order", () => {
    const shifts = [CLOSED, PLANNED, ACTIVE];
    const name = (shift: { productId: string }) =>
      shift.productId === MILK.id ? "Молоко" : "Вода";
    const all = { status: "all", lineId: "", search: "" } as const;
    expect(findShifts(shifts, all, name)).toEqual([CLOSED, PLANNED, ACTIVE]);
    expect(findShifts(shifts, { ...all, status: "closed", search: "молоко" }, name)).toEqual([
      CLOSED,
    ]);
    expect(findShifts(shifts, { ...all, status: "closed", lineId: LINE_10.id }, name)).toEqual([]);
    expect(findShifts(shifts, { ...all, lineId: LINE_10.id, search: "вода" }, name)).toEqual([
      PLANNED,
    ]);
    expect(findShifts(shifts, { ...all, search: "oct26-005" }, name)).toEqual([PLANNED]);
    expect(findShifts(shifts, { ...all, search: "   " }, name)).toEqual(shifts);
  });

  it("keys every list of shifts under the one prefix a write reads again", () => {
    expect(officeKeys.shifts).toEqual(["office", "shifts"]);
    expect(officeKeys.shiftList(null).slice(0, 2)).toEqual(officeKeys.shifts);
    expect(officeKeys.shiftList({ from: "2026-09-01", to: "2026-10-08" })).toEqual([
      "office",
      "shifts",
      "2026-09-01",
      "2026-10-08",
    ]);
    expect(officeKeys.shiftList({ from: "2026-09-01", to: "2026-10-08" })).not.toEqual(
      officeKeys.shiftList({ from: "2026-09-02", to: "2026-10-08" }),
    );
    expect(officeKeys.shiftList({ from: "2026-09-01", to: "2026-10-08" })).not.toEqual(
      officeKeys.shiftList(null),
    );
  });
});
