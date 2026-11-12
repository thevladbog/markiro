import { describe, expect, it } from "vitest";

import { formatOffers } from "../src/office/exports/export-checks.js";
import { runExport } from "../src/office/exports/run-export.js";
import { exportRows } from "./support/export-rows.js";

const formedAt = "2026-10-08T15:30:00.123Z";
const documentId = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const header = "Штрихкод или код маркировки;Код упаковки\r\n";
const box1 = "00046006820000015000";
const box2 = "00046006820000015017";
const pallet = "00146006820000000409";

const run = (
  rows: ReturnType<typeof exportRows>,
  formatId: string,
  maxLines: number | null = null,
) =>
  runExport(rows, { formatId, formatVersion: 1, maxLines, palletId: null, documentId, formedAt });

function productLines(rows: ReturnType<typeof exportRows>) {
  return rows.codes.map(({ canonical }, index) => `${canonical};${index < 2 ? box1 : box2}\r\n`);
}

describe("CSV для 1С:УНФ", () => {
  it("writes live product and pallet edges into one file and retains the full marking bytes", () => {
    const rows = exportRows();
    const result = run(rows, "shift_csv_unf_all");
    expect(result).toMatchObject({
      ok: true,
      parts: [
        {
          filename: "OCT26-004_1C_csv_Общая_выгрузка.csv",
          codeCount: 3,
          boxCount: 2,
          palletCount: 1,
          physicalLineCount: 5,
        },
      ],
    });
    if (!result.ok) throw new Error(result.failure);
    expect(new TextDecoder().decode(result.parts[0]?.bytes)).toBe(
      header + productLines(rows).join("") + `${box1};${pallet}\r\n`,
    );
  });

  it("offers and renders the combined format in a shift with boxes only", () => {
    const rows = exportRows();
    rows.shift.palletsEnabled = false;
    rows.pallets = [];
    expect(formatOffers(rows, formedAt, "aggregation", true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          format: expect.objectContaining({ id: "shift_csv_unf_all" }),
          refusal: null,
        }),
      ]),
    );
    const result = run(rows, "shift_csv_unf_all");
    if (!result.ok) throw new Error(result.failure);
    expect(new TextDecoder().decode(result.parts[0]?.bytes)).toBe(
      header + productLines(rows).join(""),
    );
  });

  it("suppresses links to disassembled pallets and rejects a split request", () => {
    const rows = exportRows();
    rows.pallets = rows.pallets.map((entry) => ({ ...entry, disassembledAt: formedAt }));
    const result = run(rows, "shift_csv_unf_all");
    if (!result.ok) throw new Error(result.failure);
    expect(new TextDecoder().decode(result.parts[0]?.bytes)).toBe(
      header + productLines(rows).join(""),
    );
    expect(run(rows, "shift_csv_unf_all", 2)).toMatchObject({
      ok: false,
      failure: "INVALID_LINE_LIMIT",
    });
  });

  it("writes pallet-box relationships independently from the code snapshot", () => {
    const rows = exportRows();
    rows.codes = [];
    rows.items = [];
    const result = run(rows, "shift_csv_unf_pallet_boxes");
    expect(result).toMatchObject({
      ok: true,
      parts: [{ codeCount: 0, boxCount: 1, palletCount: 1, physicalLineCount: 2 }],
    });
    if (!result.ok) throw new Error(result.failure);
    expect(new TextDecoder().decode(result.parts[0]?.bytes)).toBe(header + `${box1};${pallet}\r\n`);
  });

  it("writes closed boxes without their pallet rows in the box-only format", () => {
    const rows = exportRows();
    const result = run(rows, "shift_csv_unf_box_codes");
    if (!result.ok) throw new Error(result.failure);
    expect(new TextDecoder().decode(result.parts[0]?.bytes)).toBe(
      header + productLines(rows).join(""),
    );
  });

  it("refuses both set formats if any assembly conflicts", () => {
    const rows = exportRows();
    const run = {
      formatVersion: 1,
      maxLines: null,
      palletId: null,
      documentId,
      formedAt,
    };
    const accepted = {
      outcome: "accepted",
      setCode: { canonical: "010460712345678121S1\u001d93Ab12" },
      items: [{ canonical: "010460712345680421A&Z\u001d93Cd34" }],
    } as const;
    const conflict = { ...accepted, outcome: "conflict" } as const;
    for (const formatId of ["shift_csv_unf_set_items", "shift_xlsx_chz_set_registry"]) {
      expect(runExport(rows, { ...run, formatId }, [accepted, conflict])).toEqual({
        ok: false,
        failure: "SET_EXPORT_CONFLICT",
      });
      expect(runExport(rows, { ...run, formatId }, [accepted])).toMatchObject({
        ok: true,
        parts: [{ codeCount: 1, boxCount: 0, palletCount: 0 }],
      });
    }
  });
});
