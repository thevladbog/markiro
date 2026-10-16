import { boxLabelFields } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  filterJobs,
  groupSscc,
  isPrinterSetupFailure,
  jobCode,
  jobFacts,
  jobKindView,
  jobRowParts,
  jobTag,
  jobTime,
  printerView,
  resultView,
  summaryRows,
} from "../src/floor/warehouse/warehouse-view.js";
import type { WarehouseJob } from "../src/floor/warehouse/warehouse-store.js";
import { OPERATOR_ID } from "./support/floor-work.js";
import { HP_A4, TSC, ZEBRA } from "./support/printing.js";
import { BOX_SSCC, KM, PALLET_SSCC } from "./support/warehouse.js";

const FIELDS = boxLabelFields({
  sscc: BOX_SSCC,
  itemCount: 12,
  productName: "Молоко 3,2% 0,9 л",
  productPrintName: "Молоко 3,2%",
  gtin14: "04600682000013",
  egaisCode: null,
  shelfLifeDays: 10,
  operatorName: "Анна Кузнецова",
  counterpartyName: "ООО Ромашка",
  closedAt: "2026-10-08T06:10:00.000Z",
  productionDate: "2026-10-08",
  shiftNumber: "OCT26-003",
});

function job(overrides: Partial<WarehouseJob> = {}): WarehouseJob {
  return {
    id: "job-1",
    sessionId: "s",
    kind: "box",
    subjectId: "subject",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "sent",
    templateId: "t",
    templateRev: 1,
    templateSpec: "{}",
    fields: FIELDS,
    printer: ZEBRA,
    bytesBase64: "XlhB",
    errorCode: null,
    attempts: 1,
    operatorId: OPERATOR_ID,
    createdAt: "2026-10-09T07:00:00.000Z",
    updatedAt: "2026-10-09T07:02:00.000Z",
    ...overrides,
  };
}

const unitJob = (overrides: Partial<WarehouseJob> = {}) =>
  job({
    kind: "unit",
    identity: "hash",
    fields: { ...FIELDS, "km.code": KM, qty: "1", sscc: "" },
    printer: TSC,
    ...overrides,
  });
const palletJob = (overrides: Partial<WarehouseJob> = {}) =>
  job({
    kind: "pallet",
    identity: PALLET_SSCC,
    fields: { ...FIELDS, sscc: PALLET_SSCC, "qty.boxes": "18", qty: "216" },
    ...overrides,
  });
const sheetJob = (overrides: Partial<WarehouseJob> = {}) =>
  palletJob({ printer: HP_A4, ...overrides });

describe("the journal's kinds and filters", () => {
  it("tells a pallet's A4 sheet from a pallet's label by the printer it was made for", () => {
    expect(jobKindView(job())).toBe("box");
    expect(jobKindView(unitJob())).toBe("unit");
    expect(jobKindView(palletJob())).toBe("pallet");
    expect(jobKindView(sheetJob())).toBe("sheet");
    // A sheet that never got a printer is still a sheet when the printer it met was a label one.
    expect(jobKindView(palletJob({ printer: null, errorCode: "printer_not_a4" }))).toBe("sheet");
    expect(jobKindView(palletJob({ printer: null, errorCode: "printer_unconfigured" }))).toBe(
      "pallet",
    );
  });

  it("filters a list by kind and keeps its order", () => {
    const all = [unitJob({ id: "a" }), job({ id: "b" }), palletJob({ id: "c" }), sheetJob({ id: "d" })];
    expect(filterJobs(all, "all").map((one) => one.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterJobs(all, "box").map((one) => one.id)).toEqual(["b"]);
    expect(filterJobs(all, "pallet").map((one) => one.id)).toEqual(["c"]);
    expect(filterJobs(all, "unit").map((one) => one.id)).toEqual(["a"]);
    expect(filterJobs(all, "sheet").map((one) => one.id)).toEqual(["d"]);
  });
});

describe("the code of a row", () => {
  it("groups an SSCC as the label prints it, and leaves anything else alone", () => {
    expect(groupSscc("046070123400004821")).toBe("04 6070 1234 0000 4821");
    expect(groupSscc("12345")).toBe("12345");
  });

  it("shows a box's and a pallet's SSCC grouped, a unit's serial first with the GTIN beside it", () => {
    expect(jobCode(job())).toEqual({ kind: "sscc", main: groupSscc(BOX_SSCC), gtin: null });
    expect(jobCode(palletJob())).toEqual({ kind: "sscc", main: groupSscc(PALLET_SSCC), gtin: null });
    expect(jobCode(unitJob())).toEqual({ kind: "serial", main: "S000001", gtin: "04600682000013" });
  });

  it("says nothing of a unit whose code cannot be read, instead of guessing one", () => {
    expect(jobCode(unitJob({ fields: { ...FIELDS, "km.code": "garbage" } }))).toEqual({
      kind: "unreadable",
      main: "",
      gtin: null,
    });
  });
});

describe("a row's words", () => {
  it("names the product by its print name and counts what the label counts", () => {
    expect(jobRowParts(job())).toEqual({
      kind: "box",
      title: "Молоко 3,2%",
      count: { unit: "items", n: 12 },
    });
    expect(jobRowParts(palletJob())).toMatchObject({ kind: "pallet", count: { unit: "boxes", n: 18 } });
    expect(jobRowParts(unitJob())).toMatchObject({ kind: "unit", count: null });
    expect(jobRowParts(sheetJob())).toMatchObject({ kind: "sheet", count: null });
  });

  it("falls back to the full name when the print name is blank", () => {
    const fields = { ...FIELDS, "product.printName": "  " };
    expect(jobRowParts(job({ fields })).title).toBe("Молоко 3,2% 0,9 л");
  });

  it("gives the minute of the last move on this PC's clock", () => {
    const instant = "2026-10-09T07:02:00.000Z";
    const date = new Date(instant);
    const expected = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    expect(jobTime(instant)).toBe(expected);
    expect(jobTime("not an instant")).toBe("");
  });
});

describe("a job's tag", () => {
  it.each([
    ["sent", "ok", "check-circle", "sent"],
    ["verified", "neutral", "check-circle", "verified"],
    ["unknown", "warn", "question-circle", "unknown"],
    ["failed", "error", "x-circle", "failed"],
    ["prepared", "info", "printer", "prepared"],
    ["sending", "info", "circle-notch", "sending"],
    ["cancelled", "neutral", "x-circle", "cancelled"],
  ] as const)("%s", (state, tone, glyph, key) => {
    expect(jobTag(job({ state }))).toEqual({ tone, glyph, key });
  });
});

describe("what a job tells of its printing", () => {
  it("lists three facts of a box, with the box's count first", () => {
    expect(jobFacts(job())).toEqual([
      { key: "quantity", value: "12" },
      { key: "productionDate", value: FIELDS.date },
      { key: "shift", value: "OCT26-003" },
      { key: "counterparty", value: "ООО Ромашка" },
    ]);
  });

  it("shows four facts at most, the counterparty giving way on a pallet", () => {
    const keys = jobFacts(palletJob()).map((fact) => fact.key);
    expect(keys).toEqual(["boxes", "quantity", "productionDate", "shift"]);
  });

  it("starts a pallet's with its boxes, and a unit's with its date, leaving out what the label lacks", () => {
    expect(jobFacts(palletJob())[0]).toEqual({ key: "boxes", value: "18" });
    expect(jobFacts(palletJob())[1]).toEqual({ key: "quantity", value: "216" });
    expect(jobFacts(unitJob({ fields: { ...FIELDS, "shift.no": "", "counterparty.name": "" } }))).toEqual([
      { key: "productionDate", value: FIELDS.date },
    ]);
  });

  it("says each state in its own words and tone, and a check of the label in a state of its own", () => {
    expect(resultView(job({ state: "sending" }), false)).toMatchObject({ tone: "info", title: "sending" });
    expect(resultView(job({ state: "sent" }), false)).toMatchObject({
      tone: "ok",
      title: "sent",
      body: { kind: "hint", key: "sent" },
    });
    expect(resultView(job({ state: "unknown", errorCode: "outcome_unknown" }), false)).toMatchObject({
      tone: "warn",
      title: "unknown",
      body: { kind: "hint", key: "unknown" },
    });
    expect(resultView(job({ state: "unknown" }), true)).toMatchObject({
      tone: "info",
      title: "verify",
      body: { kind: "hint", key: "verify" },
    });
    expect(resultView(job({ state: "verified" }), false)).toMatchObject({ tone: "ok", title: "verified" });
    expect(resultView(job({ state: "cancelled" }), false)).toMatchObject({ tone: "neutral", title: "cancelled" });
    expect(resultView(job({ state: "prepared" }), false)).toMatchObject({ tone: "info", title: "prepared" });
  });

  it("keeps a failed print's own code as its words, a printer setup one as a warning of its own", () => {
    expect(resultView(job({ state: "failed", errorCode: "not_sent" }), false)).toEqual({
      tone: "error",
      glyph: "x-circle",
      title: "failed",
      body: { kind: "code", code: "not_sent" },
    });
    for (const [code, title] of [
      ["printer_unconfigured", "printerUnconfigured"],
      ["printer_a4", "printerA4"],
      ["printer_not_a4", "printerNotA4"],
    ] as const) {
      expect(resultView(job({ state: "failed", errorCode: code }), false)).toMatchObject({
        tone: "warn",
        glyph: "warning",
        title,
        body: { kind: "code", code },
      });
      expect(isPrinterSetupFailure(code)).toBe(true);
    }
    expect(isPrinterSetupFailure("render_failed")).toBe(false);
    expect(isPrinterSetupFailure(null)).toBe(false);
  });

  it("names the printer the job was made for and its state", () => {
    expect(printerView(job())).toEqual({ name: ZEBRA.name, tag: "ready" });
    expect(printerView(job({ state: "sending" }))).toEqual({ name: ZEBRA.name, tag: "accepting" });
    expect(printerView(job({ state: "failed", errorCode: "not_sent" }))).toEqual({ name: ZEBRA.name, tag: "error" });
    expect(printerView(job({ state: "failed", errorCode: "printer_unconfigured", printer: null }))).toEqual({
      name: null,
      tag: "unassigned",
    });
  });
});

describe("the summary of what prints on what", () => {
  const settings = (assignments: Record<string, string | null>, printers = [ZEBRA, TSC, HP_A4]) => ({
    printers,
    assignments: { box: null, pallet: null, duplicate: null, ...assignments },
  });

  it("has a row for boxes, pallets, units and A4 sheets, in that order", () => {
    const rows = summaryRows(settings({ box: ZEBRA.id, pallet: ZEBRA.id, duplicate: TSC.id }));
    expect(rows.map((row) => [row.kind, row.state, row.printer?.name ?? null])).toEqual([
      ["box", "ready", ZEBRA.name],
      ["pallet", "ready", ZEBRA.name],
      ["unit", "ready", TSC.name],
      ["sheet", "unassigned", null],
    ]);
  });

  it("gives the pallet's printer of sheets to the sheets, and says the pallet labels have none", () => {
    const rows = summaryRows(settings({ box: ZEBRA.id, pallet: HP_A4.id, duplicate: TSC.id }));
    expect(rows.map((row) => [row.kind, row.state])).toEqual([
      ["box", "ready"],
      ["pallet", "sheets_only"],
      ["unit", "ready"],
      ["sheet", "ready"],
    ]);
    expect(rows[3]?.printer?.name).toBe(HP_A4.name);
  });

  it("marks every kind with no printer", () => {
    const rows = summaryRows(settings({}));
    expect(rows.map((row) => row.state)).toEqual(["unassigned", "unassigned", "unassigned", "unassigned"]);
  });
});
