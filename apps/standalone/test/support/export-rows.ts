import { readFileSync } from "node:fs";

import { shiftExportRowsSchema, type ShiftExportRows } from "../../src/host/protocol.js";

const supportModuleUrl = import.meta.url;
export const PALLET_1 = "a0000000-0000-4000-8000-000000000001";
export const PALLET_2 = "a0000000-0000-4000-8000-000000000002";
export const PALLET_3 = "a0000000-0000-4000-8000-000000000003";

/** `shift-export-rows.json`: OCT26-004 closed, pallet 1 (box 1, codes A and B) closed, box 2 (code C) on no pallet. */
export function exportRows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../proto/fixtures/shift-export-rows.json", supportModuleUrl),
        "utf8",
      ),
    ),
  );
}

/**
 * Every warning at once: late data; box 2 on pallet 3, taken apart; box 5 on pallet 2, never
 * closed; box 4 on pallet 1, closed after the pallet did.
 */
export function warnedExportRows(): ShiftExportRows {
  const shift = exportRows();
  shift.shift.lateDataAt = "2026-10-08T16:00:00Z";
  shift.pallets.push(
    {
      id: PALLET_2,
      sscc: null,
      openedAt: "2026-10-08T06:07:15.902Z",
      closedAt: null,
      disassembledAt: null,
    },
    {
      id: PALLET_3,
      sscc: "146006820000000416",
      openedAt: "2026-10-08T06:00:00.000Z",
      closedAt: "2026-10-08T06:25:00.000Z",
      disassembledAt: "2026-10-08T07:00:00.000Z",
    },
  );
  const box2 = shift.boxes[1];
  if (box2 === undefined) throw new Error("the fixture has box 2");
  box2.palletId = PALLET_3;
  for (const [number, palletId, closedAt] of [
    [4, PALLET_1, "2026-10-08T06:30:00.000Z"],
    [5, PALLET_2, "2026-10-08T06:31:00.000Z"],
  ] as const) {
    const hash = `d${number}`.repeat(32);
    shift.boxes.push({
      id: `b0000000-0000-4000-8000-00000000000${number}`,
      sscc: `04600682000001502${number}`,
      openedAt: "2026-10-08T06:10:00.000Z",
      closedAt,
      disassembledAt: null,
      palletId,
    });
    shift.codes.push({
      codeHash: hash,
      scannedAt: "2026-10-08T06:10:30.000Z",
      canonical: `010460068200001321Zx4cV6bNm2Q${number}\u001d93Gh4W`,
    });
    shift.items.push({ boxId: `b0000000-0000-4000-8000-00000000000${number}`, codeHash: hash });
  }
  return shift;
}
