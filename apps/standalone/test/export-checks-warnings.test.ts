import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getShiftExportFormat } from "@markiro/domain";

import {
  officePalletSchema,
  shiftExportRowsSchema,
  type OfficePallet,
  type ShiftExportRows,
} from "../src/host/protocol.js";
import {
  conflictWarnings,
  exportWarnings,
  palletWarnings,
  reportedCountWarnings,
} from "../src/office/exports/export-checks.js";

const testModuleUrl = import.meta.url;
const FORMED_AT = "2026-10-08T15:30:00.123Z";
const PALLET_1 = "a0000000-0000-4000-8000-000000000001";
const PALLET_CLOSED_AT = "2026-10-08T06:20:44.650Z";
const HASH_D = "d1d2d3d4d5d6d7d8d9dadbdcdddedfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfd0";
const BOXES_FORMAT = getShiftExportFormat("shift_txt_boxes", 2);
const PALLETS_FORMAT = getShiftExportFormat("shift_txt_pallets", 1);

function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

/**
 * The fixture plus box 4 on `palletId`, closed at `closedAt`; with `withCode`
 * it holds one more code of the shift, so every box format still covers the
 * shift exactly (an empty box is not part of a shift export's boxes).
 */
function withBox(
  closedAt: string,
  options: { palletId?: string; withCode?: boolean; disassembledAt?: string | null } = {},
): ShiftExportRows {
  const shift = rows();
  const id = "b0000000-0000-4000-8000-000000000004";
  shift.boxes.push({
    id,
    sscc: "046006820000015024",
    openedAt: "2026-10-08T06:10:00.000Z",
    closedAt,
    disassembledAt: options.disassembledAt ?? null,
    palletId: options.palletId ?? PALLET_1,
  });
  if (options.withCode === true) {
    shift.codes.push({
      codeHash: HASH_D,
      scannedAt: "2026-10-08T06:10:30.000Z",
      canonical: "010460068200001321Zx4cV6bNm2Qa\u001d93Gh4W",
    });
    shift.items.push({ boxId: id, codeHash: HASH_D });
  }
  return shift;
}

function pallet(overrides: Partial<OfficePallet> = {}): OfficePallet {
  return officePalletSchema.parse({
    id: "a0000000-0000-4000-8000-000000000001",
    deviceId: "d0000000-0000-4000-8000-000000000001",
    sscc: "146006820000000409",
    openedAt: "2026-10-08T06:06:01.118Z",
    closedAt: PALLET_CLOSED_AT,
    disassembledAt: null,
    boxes: 1,
    units: 2,
    boxCountReported: 1,
    printVerifiedAt: null,
    printSkippedAt: null,
    ...overrides,
  });
}

describe("a box that joined a pallet after the pallet closed (plan ЧЗ, minors item 8)", () => {
  it("is counted for a pallets format, however little later than the close it closed", () => {
    expect(exportWarnings(rows(), PALLETS_FORMAT, FORMED_AT)).toEqual([]);
    // 100 ms after the pallet: the instant, not the second, decides.
    expect(
      exportWarnings(
        withBox("2026-10-08T06:20:44.750Z", { withCode: true }),
        PALLETS_FORMAT,
        FORMED_AT,
      ),
    ).toEqual([{ kind: "late_boxes", boxes: 1 }]);
    expect(
      exportWarnings(
        withBox("2026-10-08T06:25:00.000Z", { withCode: true }),
        PALLETS_FORMAT,
        FORMED_AT,
      ),
    ).toEqual([{ kind: "late_boxes", boxes: 1 }]);
  });

  it("is not counted when the box closed at the pallet's own instant or before it", () => {
    expect(
      exportWarnings(withBox(PALLET_CLOSED_AT, { withCode: true }), PALLETS_FORMAT, FORMED_AT),
    ).toEqual([]);
    expect(
      exportWarnings(
        withBox("2026-10-08T06:20:44.549Z", { withCode: true }),
        PALLETS_FORMAT,
        FORMED_AT,
      ),
    ).toEqual([]);
  });

  it("is a warning of the pallets formats only, and sits after the other warnings", () => {
    const late = withBox("2026-10-08T06:25:00.000Z", { withCode: true });
    expect(exportWarnings(late, BOXES_FORMAT, FORMED_AT)).toEqual([]);
    late.shift.lateDataAt = "2026-10-08T16:00:00Z";
    const [first] = late.pallets;
    if (first === undefined) throw new Error("the fixture has a pallet");
    first.disassembledAt = "2026-10-08T07:00:00.000Z";
    expect(exportWarnings(late, PALLETS_FORMAT, FORMED_AT)).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
      { kind: "disassembled_pallets", pallets: 1 },
      { kind: "late_boxes", boxes: 1 },
    ]);
  });

  it("leaves out a box the shift formats do not write: one with no code", () => {
    // An empty closed box is no part of a shift export (the box formats list boxes with codes).
    expect(exportWarnings(withBox("2026-10-08T06:25:00.000Z"), PALLETS_FORMAT, FORMED_AT)).toEqual(
      [],
    );
  });

  it("is not counted for a box on a pallet that has no SSCC yet or is not in the rows", () => {
    // The pallet has a close but no SSCC: its box is written loose (and counted as suppressed).
    const unlabelled = withBox("2026-10-08T06:25:00.000Z", {
      palletId: "a0000000-0000-4000-8000-000000000002",
      withCode: true,
    });
    unlabelled.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: null,
      openedAt: "2026-10-08T06:09:00.000Z",
      closedAt: "2026-10-08T06:11:00.000Z",
      disassembledAt: null,
    });
    expect(exportWarnings(unlabelled, PALLETS_FORMAT, FORMED_AT)).toEqual([
      { kind: "open_pallets", boxes: 1 },
    ]);
    // The pallet is not among the rows at all: the box is written loose, with no word about it.
    expect(
      exportWarnings(
        withBox("2026-10-08T06:25:00.000Z", {
          palletId: "a0000000-0000-4000-8000-0000000000ee",
          withCode: true,
        }),
        PALLETS_FORMAT,
        FORMED_AT,
      ),
    ).toEqual([]);
  });

  it("is counted by box, not once for the shift", () => {
    const shift = withBox("2026-10-08T06:25:00.000Z", { withCode: true });
    shift.boxes.push({
      id: "b0000000-0000-4000-8000-000000000005",
      sscc: "046006820000015031",
      openedAt: "2026-10-08T06:11:00.000Z",
      closedAt: "2026-10-08T06:26:00.000Z",
      disassembledAt: null,
      palletId: PALLET_1,
    });
    shift.codes.push({
      codeHash: "e1e2e3e4e5e6e7e8e9eaebecedeeefe0e1e2e3e4e5e6e7e8e9eaebecedeeefe0",
      scannedAt: "2026-10-08T06:11:30.000Z",
      canonical: "010460068200001321Yu7iO9pLk3Jh\u001d93Ij5V",
    });
    shift.items.push({
      boxId: "b0000000-0000-4000-8000-000000000005",
      codeHash: "e1e2e3e4e5e6e7e8e9eaebecedeeefe0e1e2e3e4e5e6e7e8e9eaebecedeeefe0",
    });
    expect(exportWarnings(shift, PALLETS_FORMAT, FORMED_AT)).toEqual([
      { kind: "late_boxes", boxes: 2 },
    ]);
  });
});

describe("the warnings of one pallet's document (plan ЧЗ, minors item 8)", () => {
  it("count the boxes the document names that closed after the pallet, empty ones too", () => {
    expect(palletWarnings(rows(), PALLET_1)).toEqual([]);
    expect(palletWarnings(withBox("2026-10-08T06:20:44.750Z"), PALLET_1)).toEqual([
      { kind: "late_boxes", boxes: 1 },
    ]);
    expect(palletWarnings(withBox(PALLET_CLOSED_AT), PALLET_1)).toEqual([]);
  });

  it("count each late box", () => {
    const shift = withBox("2026-10-08T06:25:00.000Z");
    shift.boxes.push({
      id: "b0000000-0000-4000-8000-000000000005",
      sscc: "046006820000015031",
      openedAt: "2026-10-08T06:11:00.000Z",
      closedAt: "2026-10-08T06:26:00.000Z",
      disassembledAt: null,
      palletId: PALLET_1,
    });
    expect(palletWarnings(shift, PALLET_1)).toEqual([{ kind: "late_boxes", boxes: 2 }]);
  });

  it("leave out the boxes of another pallet and a box taken apart", () => {
    const other = withBox("2026-10-08T06:25:00.000Z", {
      palletId: "a0000000-0000-4000-8000-000000000002",
    });
    other.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: "146006820000000416",
      openedAt: "2026-10-08T06:09:00.000Z",
      closedAt: "2026-10-08T06:21:00.000Z",
      disassembledAt: null,
    });
    expect(palletWarnings(other, PALLET_1)).toEqual([]);
    expect(palletWarnings(other, "a0000000-0000-4000-8000-000000000002")).toEqual([
      { kind: "late_boxes", boxes: 1 },
    ]);
    const taken = withBox("2026-10-08T06:25:00.000Z", {
      disassembledAt: "2026-10-08T06:40:00.000Z",
    });
    expect(palletWarnings(taken, PALLET_1)).toEqual([]);
  });

  it("are none for a pallet whose document cannot be formed", () => {
    const shift = withBox("2026-10-08T06:25:00.000Z");
    const [first] = shift.pallets;
    if (first === undefined) throw new Error("the fixture has a pallet");
    first.disassembledAt = "2026-10-08T07:00:00.000Z";
    expect(palletWarnings(shift, PALLET_1)).toEqual([]);
    expect(palletWarnings(shift, "a0000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });
});

describe("the pallets whose box count differs from the station's report (plan ЧЗ, minors item 8)", () => {
  it("are counted once each when the live boxes differ from what the station counted at the close", () => {
    expect(reportedCountWarnings([pallet()])).toEqual([]);
    expect(reportedCountWarnings([pallet({ boxes: 2 })])).toEqual([
      { kind: "pallet_count_mismatch", pallets: 1 },
    ]);
    expect(
      reportedCountWarnings([
        pallet({ boxes: 0 }),
        pallet({ id: "a0000000-0000-4000-8000-000000000002", boxes: 3, boxCountReported: 2 }),
        pallet({ id: "a0000000-0000-4000-8000-000000000003" }),
      ]),
    ).toEqual([{ kind: "pallet_count_mismatch", pallets: 2 }]);
  });

  it("ignore a pallet the station reported no count for and one taken apart", () => {
    expect(reportedCountWarnings([pallet({ boxes: 4, boxCountReported: null })])).toEqual([]);
    expect(
      reportedCountWarnings([pallet({ boxes: 0, disassembledAt: "2026-10-08T07:00:00.000Z" })]),
    ).toEqual([]);
    expect(reportedCountWarnings([])).toEqual([]);
  });
});

describe("unreviewed conflicts (plan КНФ, ПР-12)", () => {
  it("warn with their number and never refuse", () => {
    expect(conflictWarnings(0)).toEqual([]);
    expect(conflictWarnings(3)).toEqual([{ kind: "unreviewed_conflicts", conflicts: 3 }]);
  });
});
