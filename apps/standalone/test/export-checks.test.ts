import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getShiftExportFormat } from "@markiro/domain";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  exportCounts,
  exportFolder,
  exportWarnings,
  formatOffers,
  palletOffers,
} from "../src/office/exports/export-checks.js";

const testModuleUrl = import.meta.url;
const FORMED_AT = "2026-10-08T15:30:00.123Z";
const HASH_C = "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";

/** `shift-export-rows.json`: pallet 1 (box 1, codes A and B) closed, box 2 (code C) on no pallet, box 3 open and empty. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

/** The fixture with code C moved from box 2 into the open box 3: no box format can cover it. */
function uncovered(): ShiftExportRows {
  const moved = rows();
  moved.items = moved.items.map((item) =>
    item.codeHash === HASH_C ? { ...item, boxId: "b0000000-0000-4000-8000-000000000003" } : item,
  );
  return moved;
}

describe("the formats the dialog offers (plan ЧЗ)", () => {
  it("are every format for a shift with pallets, the five without pallets for one without", () => {
    expect(formatOffers(rows(), FORMED_AT).map((offer) => offer.format.id)).toEqual([
      "shift_txt_flat",
      "shift_txt_boxes",
      "shift_csv_flat",
      "shift_csv_boxes",
      "shift_xml_gismt_aggregation",
      "shift_txt_pallets",
      "shift_csv_pallets",
      "shift_xml_gismt_aggregation_pallets",
      "shift_txt_pallet_boxes",
      "shift_xml_gismt_pallet_boxes",
    ]);
    const without = { ...rows(), shift: { ...rows().shift, palletsEnabled: false } };
    expect(formatOffers(without, FORMED_AT).map((offer) => offer.format.id)).toEqual([
      "shift_txt_flat",
      "shift_txt_boxes",
      "shift_csv_flat",
      "shift_csv_boxes",
      "shift_xml_gismt_aggregation",
    ]);
  });

  it("carry each format's refusal now: a code outside a closed box blocks every box format", () => {
    expect(formatOffers(rows(), FORMED_AT).every((offer) => offer.refusal === null)).toBe(true);
    expect(
      formatOffers(uncovered(), FORMED_AT).map((offer) => [offer.format.id, offer.refusal]),
    ).toEqual([
      ["shift_txt_flat", null],
      ["shift_txt_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_csv_flat", null],
      ["shift_csv_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_aggregation", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_txt_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_csv_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_aggregation_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_txt_pallet_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_pallet_boxes", "BOX_COVERAGE_INCOMPLETE"],
    ]);
  });

  it("refuse the ЧЗ documents without an INN, and everything for a shift not closed", () => {
    const noInn = { ...rows(), organization: { name: "ООО «Атолл»", inn: null } };
    expect(
      formatOffers(noInn, FORMED_AT)
        .filter((offer) => offer.refusal !== null)
        .map((offer) => [offer.format.id, offer.refusal]),
    ).toEqual([
      ["shift_xml_gismt_aggregation", "ORG_INN_MISSING"],
      ["shift_xml_gismt_aggregation_pallets", "ORG_INN_MISSING"],
      ["shift_xml_gismt_pallet_boxes", "ORG_INN_MISSING"],
    ]);
    const active = { ...rows(), shift: { ...rows().shift, status: "active" as const } };
    expect(new Set(formatOffers(active, FORMED_AT).map((offer) => offer.refusal))).toEqual(
      new Set(["SHIFT_NOT_CLOSED"]),
    );
  });
});

describe("the pallets the dialog offers (plan ЧЗ)", () => {
  it("are closed ones by their close and SSCC, open ones last, each with its boxes and refusal", () => {
    const shift = rows();
    shift.pallets.push(
      {
        id: "a0000000-0000-4000-8000-000000000002",
        sscc: null,
        openedAt: "2026-10-08T06:21:00.000Z",
        closedAt: null,
        disassembledAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000003",
        sscc: "146006820000000416",
        openedAt: "2026-10-08T06:00:00.000Z",
        closedAt: "2026-10-08T06:20:44.650Z",
        disassembledAt: "2026-10-08T06:30:00.000Z",
      },
    );
    shift.boxes.push({
      id: "b0000000-0000-4000-8000-000000000004",
      sscc: "046006820000015024",
      openedAt: "2026-10-08T06:21:00.000Z",
      closedAt: "2026-10-08T06:22:00.000Z",
      disassembledAt: null,
      palletId: "a0000000-0000-4000-8000-000000000002",
    });
    expect(palletOffers(shift)).toEqual([
      {
        palletId: "a0000000-0000-4000-8000-000000000001",
        sscc: "146006820000000409",
        closedAt: "2026-10-08T06:20:44.650Z",
        boxes: 1,
        refusal: null,
      },
      {
        palletId: "a0000000-0000-4000-8000-000000000003",
        sscc: "146006820000000416",
        closedAt: "2026-10-08T06:20:44.650Z",
        boxes: 0,
        refusal: "PALLET_DISASSEMBLED",
      },
      {
        palletId: "a0000000-0000-4000-8000-000000000002",
        sscc: null,
        closedAt: null,
        boxes: 1,
        refusal: "PALLET_NOT_CLOSED",
      },
    ]);
  });
});

describe("the shift's counts and warnings in the dialog (plan ЧЗ)", () => {
  it("count the codes, those in closed boxes, the closed boxes and the closed pallets", () => {
    expect(exportCounts(rows())).toEqual({
      codes: 3,
      codesInClosedBoxes: 3,
      closedBoxes: 2,
      closedPallets: 1,
    });
    expect(exportCounts(uncovered())).toMatchObject({ codes: 3, codesInClosedBoxes: 2 });
    const taken = rows();
    taken.pallets.push({
      id: "a0000000-0000-4000-8000-000000000003",
      sscc: "146006820000000416",
      openedAt: "2026-10-08T06:00:00.000Z",
      closedAt: "2026-10-08T06:20:44.650Z",
      disassembledAt: "2026-10-08T06:30:00.000Z",
    });
    expect(exportCounts(taken).closedPallets).toBe(1);
  });

  it("leave a closed box that was taken apart out of the closed boxes and of their codes", () => {
    const shift = rows();
    const box2 = shift.boxes[1];
    if (box2 === undefined) throw new Error("the fixture has box 2");
    box2.disassembledAt = "2026-10-08T07:00:00.000Z";
    // Box 2 still has its SSCC and its close, and its item is still in the rows: only the
    // taken-apart stamp tells it from the closed box 2 above.
    expect(exportCounts(shift)).toEqual({
      codes: 3,
      codesInClosedBoxes: 2,
      closedBoxes: 1,
      closedPallets: 1,
    });
  });

  it("warn of late data for every format, and of open and taken-apart pallets for the pallets formats", () => {
    const shift = rows();
    shift.shift.lateDataAt = "2026-10-08T16:00:00Z";
    const [pallet] = shift.pallets;
    if (pallet === undefined) throw new Error("the fixture has a pallet");
    pallet.disassembledAt = "2026-10-08T07:00:00.000Z";
    shift.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: null,
      openedAt: "2026-10-08T06:07:15.902Z",
      closedAt: null,
      disassembledAt: null,
    });
    const box2 = shift.boxes[1];
    if (box2 === undefined) throw new Error("the fixture has box 2");
    box2.palletId = "a0000000-0000-4000-8000-000000000002";
    expect(exportWarnings(shift, getShiftExportFormat("shift_txt_boxes", 2), FORMED_AT)).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
    ]);
    expect(
      exportWarnings(
        shift,
        getShiftExportFormat("shift_xml_gismt_aggregation_pallets", 1),
        FORMED_AT,
      ),
    ).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
      { kind: "open_pallets", boxes: 1 },
      { kind: "disassembled_pallets", pallets: 1 },
    ]);
    expect(exportWarnings(rows(), getShiftExportFormat("shift_txt_pallets", 1), FORMED_AT)).toEqual(
      [],
    );
  });
});

describe("the folder of an export (plan ЧЗ)", () => {
  it("is the shift's number as a file name's segment and the moment in the organization's zone", () => {
    expect(
      exportFolder("OCT26-004", "shift_xml_gismt_aggregation", FORMED_AT, "Europe/Moscow"),
    ).toEqual(["Выгрузки", "OCT26-004", "2026-10-08_18-30-00_shift_xml_gismt_aggregation"]);
    expect(
      exportFolder("OCT26-005/S", "shift_txt_flat", "2026-10-08T21:00:05.000Z", "Europe/Moscow"),
    ).toEqual(["Выгрузки", "OCT26-005_S", "2026-10-09_00-00-05_shift_txt_flat"]);
  });
});
