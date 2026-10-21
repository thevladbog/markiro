import { describe, expect, it } from "vitest";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  shiftExportSnapshot,
  shiftOperationDateTime,
} from "../src/office/exports/export-source.js";

/**
 * A shift two stations worked (plan 2b, spec §7 «Экспорты … проверить формат при нескольких
 * устройствах»): the rows carry no device, codes of both stations interleave by their scan instants, each
 * station's boxes are its own, and the document's operation time is the latest device close the host
 * reports (host D16 as implemented: the MAX of the accepted close instants), never an early part's.
 */

const FORMED_AT = "2026-10-08T15:30:00.123Z";
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const FLAT_TXT = { boxMode: "flat", extension: "txt" } as const;
const BOXES_TXT = { boxMode: "boxes", extension: "txt" } as const;
const day = (time: string): string => `2026-10-08T${time}Z`;
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const sscc = (n: number): string => `04600682000001${String(n).padStart(4, "0")}`;
const boxId = (n: number): string => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Station A scanned KM-1 and KM-3 into box 1, station B KM-2 and KM-4 into box 2, one second apart in turn;
 * the latest device close is station B's, at 14:10:00.250 by its own clock (the host's whole second is
 * 14:10:07), which the host reports whichever close reached it last.
 */
function sharedRows(shift: Partial<ShiftExportRows["shift"]> = {}): ShiftExportRows {
  const scanned = ["06:00:00.000", "06:00:01.000", "06:00:02.000", "06:00:03.000"];
  return shiftExportRowsSchema.parse({
    shift: {
      id: SHIFT_ID,
      number: "OCT26-004",
      status: "closed",
      productionDate: "2026-10-08",
      productName: "Молоко",
      palletsEnabled: false,
      closedAt: day("14:10:07"),
      stationClosedAt: "2026-10-08T14:10:00.250Z",
      lateDataAt: null,
      ...shift,
    },
    organization: { name: "ООО «Атолл»", inn: "7701234567" },
    // Deliberately NOT in scan order: the host lists rows by whatever it stored, and the two devices'
    // parts arrive interleaved, so only the office's own sort can restore the order.
    codes: [3, 0, 2, 1].map((index) => ({
      codeHash: hash(index + 1),
      scannedAt: day(scanned[index] ?? ""),
      canonical: `KM-${String(index + 1)}`,
    })),
    boxes: [2, 1].map((n) => ({
      id: boxId(n),
      sscc: sscc(n),
      openedAt: day("06:00:00.000"),
      closedAt: day(`06:0${String(n)}:00.000`),
      disassembledAt: null,
      palletId: null,
    })),
    items: [
      { boxId: boxId(2), codeHash: hash(4) },
      { boxId: boxId(1), codeHash: hash(3) },
      { boxId: boxId(2), codeHash: hash(2) },
      { boxId: boxId(1), codeHash: hash(1) },
    ],
    pallets: [],
  });
}

function snapshotOf(rows: ShiftExportRows, format: typeof FLAT_TXT | typeof BOXES_TXT) {
  const snapshot = shiftExportSnapshot(rows, format, FORMED_AT);
  if (!snapshot.ok) throw new Error(snapshot.refusal);
  return snapshot.value;
}

describe("the export of a shift two devices worked (plan 2b)", () => {
  it("orders the codes of both devices by their scan instants in the flat formats", () => {
    expect(snapshotOf(sharedRows(), FLAT_TXT).source).toEqual({
      mode: "flat",
      codes: ["KM-1", "KM-2", "KM-3", "KM-4"],
    });
  });

  it("lists each device's boxes by SSCC, each with its own codes in scan order", () => {
    expect(snapshotOf(sharedRows(), BOXES_TXT).source).toEqual({
      mode: "boxes",
      boxes: [
        { sscc: sscc(1), codes: ["KM-1", "KM-3"] },
        { sscc: sscc(2), codes: ["KM-2", "KM-4"] },
      ],
    });
  });

  it("takes the operation time from the latest device close the host reports", () => {
    expect(snapshotOf(sharedRows(), FLAT_TXT).operationDateTime).toBe("2026-10-08T14:10:00.250Z");
  });

  it("takes the host's own instant for a shift the office closed whole, which has no device close", () => {
    const rows = sharedRows({ stationClosedAt: null });
    expect(shiftOperationDateTime(rows.shift, FORMED_AT)).toBe("2026-10-08T14:10:07.000Z");
    expect(snapshotOf(rows, FLAT_TXT).operationDateTime).toBe("2026-10-08T14:10:07.000Z");
  });

  it("refuses a shift that is not closed, as before", () => {
    const snapshot = shiftExportSnapshot(
      sharedRows({ status: "active", closedAt: null }),
      FLAT_TXT,
      FORMED_AT,
    );
    expect(snapshot).toEqual({ ok: false, refusal: "SHIFT_NOT_CLOSED" });
  });
});
