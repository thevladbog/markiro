import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  shiftExportSnapshot,
  shiftOperationDateTime,
} from "../src/office/exports/export-source.js";
import { runExport } from "../src/office/exports/run-export.js";

const testModuleUrl = import.meta.url;

/** `shift-export-rows.json`: a closed shift with pallet 1 (box 1), box 2 on no pallet, box 3 open and empty. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

const FORMED_AT = "2026-10-08T15:30:00.123Z";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const PALLETS_TXT = { boxMode: "pallets", extension: "txt" } as const;

describe("the operation instant of a shift's document (plan ЧЗ)", () => {
  it("is the station's own instant when a station closed the shift", () => {
    expect(shiftOperationDateTime(rows().shift, FORMED_AT)).toBe("2026-10-08T14:00:07.412Z");
  });

  it("is the host's instant, in canonical ISO, when the office closed it", () => {
    const shift = { ...rows().shift, stationClosedAt: null };
    expect(shiftOperationDateTime(shift, FORMED_AT)).toBe("2026-10-08T14:00:07.000Z");
  });

  it("is the moment of forming for a closed shift without either, as the cloud's snapshot", () => {
    const shift = { ...rows().shift, closedAt: null, stationClosedAt: null };
    expect(shiftOperationDateTime(shift, FORMED_AT)).toBe(FORMED_AT);
  });
});

describe("pallets taken apart in a shift's export (plan ЧЗ)", () => {
  it("stay pallets, as in the cloud, and are counted for the office's warning", () => {
    const taken = rows();
    const [pallet] = taken.pallets;
    if (pallet === undefined) throw new Error("the fixture has a pallet");
    pallet.disassembledAt = "2026-10-08T07:00:00.000Z";
    const snapshot = shiftExportSnapshot(taken, PALLETS_TXT, FORMED_AT);
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.disassembledPalletCount).toBe(1);
    expect(snapshot.value.source).toMatchObject({
      mode: "pallets",
      pallets: [{ sscc: "146006820000000409" }],
    });
    const whole = shiftExportSnapshot(rows(), PALLETS_TXT, FORMED_AT);
    if (!whole.ok) throw new Error(whole.refusal);
    expect(whole.value.disassembledPalletCount).toBe(0);
  });

  it("are no reason to refuse a box format", () => {
    const snapshot = shiftExportSnapshot(rows(), { boxMode: "boxes", extension: "xml" }, FORMED_AT);
    expect(snapshot.ok && snapshot.value.disassembledPalletCount).toBe(0);
  });
});

describe("an export run (plan ЧЗ)", () => {
  const run = {
    maxLines: null,
    documentId: DOCUMENT,
    formedAt: FORMED_AT,
  };

  it("names a pallet's export by its pallet and a shift's by none, as the cloud's runner", () => {
    expect(
      runExport(rows(), {
        ...run,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        palletId: null,
      }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
    expect(
      runExport(rows(), {
        ...run,
        formatId: "shift_txt_flat",
        formatVersion: 1,
        palletId: "a0000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
  });

  it("exports a closed pallet of a shift that is still active", () => {
    const active = { ...rows(), shift: { ...rows().shift, status: "active" as const } };
    const result = runExport(active, {
      ...run,
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      palletId: "a0000000-0000-4000-8000-000000000001",
    });
    if (!result.ok) throw new Error(result.failure);
    expect(result.parts.map((part) => [part.filename, part.boxCount, part.palletCount])).toEqual([
      ["Молоко_3_2_0_9_л_2026-10-08_паллета_00146006820000000409_1_коробов.xml", 1, 1],
    ]);
    expect(
      runExport(active, { ...run, formatId: "shift_txt_flat", formatVersion: 1, palletId: null }),
    ).toEqual({ ok: false, failure: "SHIFT_NOT_CLOSED" });
  });

  it("refuses a format version the domain does not know", () => {
    expect(
      runExport(rows(), { ...run, formatId: "shift_txt_boxes", formatVersion: 3, palletId: null }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
  });
});
