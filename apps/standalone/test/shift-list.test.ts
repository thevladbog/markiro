import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { officeKeys } from "../src/office/office-query.js";
import {
  civilDateLabel,
  findShifts,
  MAX_PERIOD_DAYS,
  openBlocker,
  periodState,
  recordLabel,
  sortShifts,
  totalShifts,
} from "../src/office/shifts/shift-list.js";
import {
  ACTIVE,
  AYRAN_ARCHIVED,
  BOX_58,
  CLOSED,
  DUPLICATE_58,
  KEFIR_DRAFT,
  LINE_10,
  MILK,
  MILK_BOX,
  MILK_DUPLICATE,
  OLD_BOX,
  OLD_DUPLICATE,
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
    // A pallet template switched off, or not of the pallet purpose, keeps the shift closed too.
    const palletUnfit = { ...PLANNED, palletTemplateId: OLD_BOX.id };
    expect(openBlocker(palletUnfit, products, [...templates, PALLET])).toBe(
      "pallet_template_unfit",
    );
    expect(
      openBlocker({ ...PLANNED, palletTemplateId: PALLET.id }, products, [...templates, PALLET]),
    ).toBeNull();
    // A draft is named before the template is looked at.
    expect(openBlocker({ ...unfit, productId: KEFIR_DRAFT.id }, products, undefined)).toBe(
      "product_draft",
    );
  });

  it("marks a shift that prints a duplicate whose template is off or not of the product's group, after the box template (plan РЕЖ, B7)", () => {
    const products = [MILK, WATER];
    const templates = [BOX_58, MILK_BOX, DUPLICATE_58, MILK_DUPLICATE, OLD_DUPLICATE];
    const printing = (templateId: string) => ({
      ...PLANNED,
      mode: "validation" as const,
      validationPrint: { mode: "duplicate_dm" as const, templateId, verification: "none" as const },
    });
    expect(openBlocker(printing(DUPLICATE_58.id), products, templates)).toBeNull();
    expect(openBlocker(printing(OLD_DUPLICATE.id), products, templates)).toBe(
      "duplicate_template_unfit",
    );
    // Water is of group 13: a duplicate for milk does not fit it; a box template is no duplicate.
    expect(openBlocker(printing(MILK_DUPLICATE.id), products, templates)).toBe(
      "duplicate_template_unfit",
    );
    expect(openBlocker(printing(BOX_58.id), products, templates)).toBe("duplicate_template_unfit");
    // Unknown to the list, or the shift no longer planned: nothing claimed.
    expect(openBlocker(printing(OLD_DUPLICATE.id), products, [BOX_58])).toBeNull();
    expect(
      openBlocker({ ...printing(OLD_DUPLICATE.id), status: "active" }, products, templates),
    ).toBeNull();
    // The box template is named first, as the host checks it first.
    expect(
      openBlocker({ ...printing(OLD_DUPLICATE.id), boxTemplateId: OLD_BOX.id }, products, [
        ...templates,
        OLD_BOX,
      ]),
    ).toBe("template_unfit");
    expect(
      openBlocker({ ...PLANNED, validationPrint: { mode: "none" } }, products, templates),
    ).toBeNull();
  });

  // Added by the task 8 implementer: the pallet template is judged by purpose, switch and group.
  it("judges a pallet template by its purpose, its switch and the product's group, after the box template", () => {
    const products = [MILK, WATER];
    const templates = [BOX_58, MILK_BOX, PALLET];
    const scoped = {
      ...PALLET,
      id: "8f7e6d5c-4b3a-4291-8a0b-9c8d7e6f5a4b",
      chzProductGroupCodes: [8],
    };
    const off = { ...PALLET, id: "7e6d5c4b-3a29-4180-8b9c-8d7e6f5a4b3c", enabled: false };
    const all = [...templates, scoped, off];
    // Water is of group 13: a pallet template scoped to milk's group does not fit it.
    expect(openBlocker({ ...PLANNED, palletTemplateId: scoped.id }, products, all)).toBe(
      "pallet_template_unfit",
    );
    expect(
      openBlocker(
        { ...PLANNED, productId: MILK.id, boxTemplateId: MILK_BOX.id, palletTemplateId: scoped.id },
        products,
        all,
      ),
    ).toBeNull();
    expect(openBlocker({ ...PLANNED, palletTemplateId: off.id }, products, all)).toBe(
      "pallet_template_unfit",
    );
    // An enabled template of the box purpose is no pallet template.
    expect(openBlocker({ ...PLANNED, palletTemplateId: BOX_58.id }, products, all)).toBe(
      "pallet_template_unfit",
    );
    // A pallet template the list lacks is not claimed unfit; no pallets claim nothing.
    expect(
      openBlocker(
        { ...PLANNED, palletTemplateId: "6d5c4b3a-2918-4070-8a8b-7d6e5f4a3b2c" },
        products,
        all,
      ),
    ).toBeNull();
    expect(openBlocker({ ...PLANNED, palletTemplateId: null }, products, all)).toBeNull();
    // The box template is named first when both do not fit.
    expect(
      openBlocker(
        { ...PLANNED, boxTemplateId: MILK_BOX.id, palletTemplateId: off.id },
        products,
        all,
      ),
    ).toBe("template_unfit");
    // An open or closed shift keeps its snapshot: no claim about its pallet template.
    expect(openBlocker({ ...ACTIVE, palletTemplateId: off.id }, products, all)).toBeNull();
  });

  // Added by the task 3 implementer: the plan's tests leave these boundaries unpinned.
  it("sends a period of at most 366 days with both ends", () => {
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

describe("the shifts list's order and totals", () => {
  const names = {
    line: (shift: { lineId: string }) => (shift.lineId === LINE_10.id ? "Линия 10" : "Линия 2"),
    product: () => "",
  };
  const two = { ...ACTIVE, number: "OCT26-002" };
  const ten = { ...ACTIVE, number: "OCT26-010", plannedQty: null };

  it("compares numbers as numbers and keeps the host's order between equal keys", () => {
    expect(sortShifts([ten, two], "number", "asc", names).map((s) => s.number)).toEqual([
      "OCT26-002",
      "OCT26-010",
    ]);
    expect(sortShifts([ten, two], "number", "desc", names).map((s) => s.number)).toEqual([
      "OCT26-010",
      "OCT26-002",
    ]);
    // Equal keys: the host's order, both ways.
    const a = { ...ACTIVE, number: "A" };
    const b = { ...ACTIVE, number: "B" };
    expect(sortShifts([a, b], "productionDate", "desc", names)).toEqual([a, b]);
    expect(sortShifts([b, a], "status", "asc", names)).toEqual([b, a]);
  });

  it("sorts by the shift date («Дата смены», beta 3) apart from the production date", () => {
    const early = {
      ...ACTIVE,
      number: "E",
      productionDate: "2026-10-20",
      plannedDate: "2026-10-01",
    };
    const late = {
      ...ACTIVE,
      number: "L",
      productionDate: "2026-10-01",
      plannedDate: "2026-10-20",
    };
    expect(sortShifts([late, early], "plannedDate", "asc", names).map((s) => s.number)).toEqual([
      "E",
      "L",
    ]);
    expect(sortShifts([early, late], "plannedDate", "desc", names).map((s) => s.number)).toEqual([
      "L",
      "E",
    ]);
    // The production date orders the other way round for the same two shifts.
    expect(sortShifts([early, late], "productionDate", "asc", names).map((s) => s.number)).toEqual([
      "L",
      "E",
    ]);
  });

  it("puts a shift without a plan last whichever way the plan runs, and sorts by the line's name", () => {
    expect(sortShifts([ten, two], "plannedQty", "asc", names)[1]).toBe(ten);
    expect(sortShifts([ten, two], "plannedQty", "desc", names)[1]).toBe(ten);
    const onTen = { ...two, lineId: LINE_10.id };
    expect(sortShifts([onTen, two], "line", "asc", names)).toEqual([two, onTen]);
    expect(sortShifts([PLANNED, CLOSED, ACTIVE], "status", "desc", names)).toEqual([
      CLOSED,
      ACTIVE,
      PLANNED,
    ]);
  });

  it("sums the output, the closed boxes and the closed pallets, a validation shift by its accepted codes, a planned one by nothing", () => {
    const validation = {
      ...ACTIVE,
      mode: "validation" as const,
      totals: { ...ACTIVE.totals, acceptedUnits: 100, unitsInClosedBoxes: 0, closedBoxes: 0 },
    };
    const withPallets = { ...ACTIVE, totals: { ...ACTIVE.totals, closedPallets: 2 } };
    expect(totalShifts([PLANNED, ACTIVE, validation, withPallets])).toEqual({
      shifts: 4,
      units: ACTIVE.totals.unitsInClosedBoxes * 2 + 100,
      boxes: ACTIVE.totals.closedBoxes * 2,
      pallets: 2,
    });
    expect(totalShifts([])).toEqual({ shifts: 0, units: 0, boxes: 0, pallets: 0 });
  });
});

describe("how the list names a shift's product", () => {
  // The key and the name it was given, so a test sees which name reached the screen.
  const t = ((key: string, options?: { name?: string; id?: string }) =>
    `${key}|${options?.name ?? options?.id ?? ""}`) as unknown as TFunction;

  it("is the print name, and the full name when the print name is blank", () => {
    const printed = { ...MILK, name: "Молоко питьевое 3,2 %", printName: "Молоко" };
    expect(recordLabel("product", [printed], MILK.id, t)).toBe("Молоко");
    for (const blank of [null, "", "  "]) {
      expect(recordLabel("product", [{ ...printed, printName: blank }], MILK.id, t)).toBe(
        "Молоко питьевое 3,2 %",
      );
    }
  });

  it("marks an archived product by its print name, and names a missing one by its id", () => {
    const archived = { ...MILK, name: "Молоко питьевое", printName: "Молоко", archived: true };
    expect(recordLabel("product", [archived], MILK.id, t)).toBe(
      "office.common.archivedName|Молоко",
    );
    expect(recordLabel("product", [], MILK.id, t)).toBe(
      `office.shifts.unknown.product|${MILK.id.slice(0, 8)}`,
    );
  });

  it("leaves a line's name alone", () => {
    expect(recordLabel("line", [LINE_10], LINE_10.id, t)).toBe(LINE_10.name);
  });
});
