import { describe, expect, it } from "vitest";
import {
  getShiftExportFormat,
  renderShiftExport,
  sanitizeShiftExportFilenameSegment,
  SHIFT_EXPORT_FORMATS,
  ShiftExportDomainError,
  shiftExportFormatRequiresPallets,
  type ShiftExportSource,
} from "../src/shift-exports.js";

const decoder = new TextDecoder();

/** The document attributes every GISMT aggregation XML must carry. */
const shiftDocumentFixture = {
  documentId: "11a0e30d-7cf6-4134-9ce5-68a3792ae8b1",
  documentNumber: "AUG26-007",
  fileDateTime: "2026-08-20T10:00:00.000Z",
  operationDateTime: "2026-08-19T18:00:00.000Z",
};

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function stripBom(bytes: Uint8Array): string {
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return decode(bytes.slice(3));
}

const flat: ShiftExportSource = { mode: "flat", codes: ["KM-1", "KM-2"] };
const boxes: ShiftExportSource = {
  mode: "boxes",
  boxes: [
    { sscc: "001234567890123456", codes: ["KM-1", "KM-2"] },
    { sscc: "009876543210123456", codes: ["KM-3"] },
  ],
};

type TextualShiftExportFormatId =
  | "shift_txt_flat"
  | "shift_txt_boxes"
  | "shift_csv_flat"
  | "shift_csv_boxes"
  | "shift_txt_pallets"
  | "shift_csv_pallets";

function render(formatId: TextualShiftExportFormatId, source: ShiftExportSource) {
  const [part] = renderParts(formatId, source);

  if (!part) {
    throw new Error("Expected export part");
  }

  return part;
}

function renderParts(
  formatId: TextualShiftExportFormatId,
  source: ShiftExportSource,
  maxLines: number | null = null,
) {
  return renderShiftExport({
    formatId,
    formatVersion: 1,
    productName: "Вода",
    shiftDate: "2026-08-13",
    maxLines,
    source,
  });
}

describe("shift export formats", () => {
  it("keeps the format registry in its canonical order", () => {
    expect(SHIFT_EXPORT_FORMATS).toEqual([
      {
        id: "shift_txt_flat",
        version: 1,
        label: "[TXT][Без коробов] Отчет смены",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        boxMode: "flat",
      },
      {
        id: "shift_txt_boxes",
        version: 2,
        label: "[TXT][С коробами] Отчет смены",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        boxMode: "boxes",
      },
      {
        id: "shift_csv_flat",
        version: 1,
        label: "[CSV][Без коробов] Отчет смены",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        boxMode: "flat",
      },
      {
        id: "shift_csv_boxes",
        version: 2,
        label: "[CSV][С коробами] Отчет смены",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        boxMode: "boxes",
      },
      {
        id: "shift_xml_gismt_aggregation",
        version: 1,
        label: "[XML][ГИСМТ] Отчет об агрегации",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        boxMode: "boxes",
      },
      {
        id: "shift_txt_pallets",
        version: 1,
        label: "[TXT][Паллеты] Отчет смены",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        boxMode: "pallets",
      },
      {
        id: "shift_csv_pallets",
        version: 1,
        label: "[CSV][Паллеты] Отчет смены",
        extension: "csv",
        mimeType: "text/csv; charset=utf-8",
        boxMode: "pallets",
      },
      {
        id: "shift_xml_gismt_aggregation_pallets",
        version: 1,
        label: "[XML][ГИСМТ] Паллетная агрегация",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        boxMode: "pallets",
      },
      {
        id: "shift_txt_pallet_boxes",
        version: 1,
        label: "[TXT][Паллеты → короба] Отчет смены",
        extension: "txt",
        mimeType: "text/plain; charset=utf-8",
        boxMode: "pallet_boxes",
      },
      {
        id: "shift_xml_gismt_pallet_boxes",
        version: 1,
        label: "[XML][ГИСМТ] Агрегация паллет без кодов",
        extension: "xml",
        mimeType: "application/xml; charset=utf-8",
        boxMode: "pallet_boxes",
      },
    ]);
    expect(getShiftExportFormat("shift_txt_flat", 1)).toBe(SHIFT_EXPORT_FORMATS[0]);
    expect(SHIFT_EXPORT_FORMATS.every(Object.isFrozen)).toBe(true);
  });

  it("renders each format with its exact bytes", () => {
    expect(decode(render("shift_txt_flat", flat).bytes)).toBe("KM-1\nKM-2\n");
    expect(decode(render("shift_txt_boxes", boxes).bytes)).toBe(
      "001234567890123456\nKM-1\nKM-2\n\n009876543210123456\nKM-3\n\n",
    );
    expect(stripBom(render("shift_csv_flat", flat).bytes)).toBe("code\r\nKM-1\r\nKM-2\r\n");
    expect(stripBom(render("shift_csv_boxes", boxes).bytes)).toBe(
      "box_sscc;code\r\n001234567890123456;KM-1\r\n001234567890123456;KM-2\r\n009876543210123456;KM-3\r\n",
    );
  });

  it("preserves GS separators, escapes CSV fields, and leaves TXT unprefixed", () => {
    expect(render("shift_txt_flat", { mode: "flat", codes: ["A\u001dB"] }).bytes[1]).toBe(0x1d);
    expect([...render("shift_txt_flat", flat).bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(
      stripBom(
        render("shift_csv_flat", { mode: "flat", codes: ["a;b", 'a"b', "a\rb", "a\nb"] }).bytes,
      ),
    ).toBe('code\r\n"a;b"\r\n"a""b"\r\n"a\rb"\r\n"a\nb"\r\n');
  });
});

describe("shift export splitting", () => {
  it("fills flat TXT parts through their physical-line limit", () => {
    const codes: ShiftExportSource = { mode: "flat", codes: ["KM-1", "KM-2", "KM-3", "KM-4"] };

    expect(
      renderParts("shift_txt_flat", codes, 2).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: decode(part.bytes),
      })),
    ).toEqual([
      { physicalLineCount: 2, codeCount: 2, boxCount: 0, body: "KM-1\nKM-2\n" },
      { physicalLineCount: 2, codeCount: 2, boxCount: 0, body: "KM-3\nKM-4\n" },
    ]);
    expect(
      renderParts("shift_txt_flat", codes, 3).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: decode(part.bytes),
      })),
    ).toEqual([
      { physicalLineCount: 3, codeCount: 3, boxCount: 0, body: "KM-1\nKM-2\nKM-3\n" },
      { physicalLineCount: 1, codeCount: 1, boxCount: 0, body: "KM-4\n" },
    ]);
  });

  it("reserves a CSV header in every split part", () => {
    expect(
      renderParts("shift_csv_flat", flat, 2).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: stripBom(part.bytes),
      })),
    ).toEqual([
      { physicalLineCount: 2, codeCount: 1, boxCount: 0, body: "code\r\nKM-1\r\n" },
      { physicalLineCount: 2, codeCount: 1, boxCount: 0, body: "code\r\nKM-2\r\n" },
    ]);
  });

  it("counts embedded CSV line breaks before splitting flat records", () => {
    expect(
      renderParts("shift_csv_flat", { mode: "flat", codes: ["A\r\nB", "KM-2"] }, 3).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        body: stripBom(part.bytes),
      })),
    ).toEqual([
      { physicalLineCount: 3, codeCount: 1, body: 'code\r\n"A\r\nB"\r\n' },
      { physicalLineCount: 2, codeCount: 1, body: "code\r\nKM-2\r\n" },
    ]);
    expect(() => renderParts("shift_csv_flat", { mode: "flat", codes: ["A\r\nB"] }, 2)).toThrow(
      new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT"),
    );
  });

  it("counts embedded CSV line breaks in indivisible box blocks", () => {
    const multilineBoxes: ShiftExportSource = {
      mode: "boxes",
      boxes: [
        { sscc: "001234567890123456", codes: ["A\nB"] },
        { sscc: "009876543210123456", codes: ["KM-2"] },
      ],
    };

    expect(
      renderParts("shift_csv_boxes", multilineBoxes, 3).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: stripBom(part.bytes),
      })),
    ).toEqual([
      {
        physicalLineCount: 3,
        codeCount: 1,
        boxCount: 1,
        body: 'box_sscc;code\r\n001234567890123456;"A\nB"\r\n',
      },
      {
        physicalLineCount: 2,
        codeCount: 1,
        boxCount: 1,
        body: "box_sscc;code\r\n009876543210123456;KM-2\r\n",
      },
    ]);
  });

  it("counts escaped v1 CSV box SSCC line breaks before splitting", () => {
    const multilineSsccBoxes: ShiftExportSource = {
      mode: "boxes",
      boxes: [
        { sscc: "box\r\none", codes: ["KM-1"] },
        { sscc: "second-box", codes: ["KM-2"] },
      ],
    };

    expect(
      renderParts("shift_csv_boxes", multilineSsccBoxes, 3).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: stripBom(part.bytes),
      })),
    ).toEqual([
      {
        physicalLineCount: 3,
        codeCount: 1,
        boxCount: 1,
        body: 'box_sscc;code\r\n"box\r\none";KM-1\r\n',
      },
      {
        physicalLineCount: 2,
        codeCount: 1,
        boxCount: 1,
        body: "box_sscc;code\r\nsecond-box;KM-2\r\n",
      },
    ]);
  });

  it("keeps TXT boxes indivisible and starts the next box in a new part", () => {
    expect(
      renderParts("shift_txt_boxes", boxes, 5).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: decode(part.bytes),
      })),
    ).toEqual([
      {
        physicalLineCount: 4,
        codeCount: 2,
        boxCount: 1,
        body: "001234567890123456\nKM-1\nKM-2\n\n",
      },
      {
        physicalLineCount: 3,
        codeCount: 1,
        boxCount: 1,
        body: "009876543210123456\nKM-3\n\n",
      },
    ]);
  });

  it("counts a CSV box as its item records plus its part header", () => {
    expect(
      renderParts("shift_csv_boxes", boxes, 3).map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        body: stripBom(part.bytes),
      })),
    ).toEqual([
      {
        physicalLineCount: 3,
        codeCount: 2,
        boxCount: 1,
        body: "box_sscc;code\r\n001234567890123456;KM-1\r\n001234567890123456;KM-2\r\n",
      },
      {
        physicalLineCount: 2,
        codeCount: 1,
        boxCount: 1,
        body: "box_sscc;code\r\n009876543210123456;KM-3\r\n",
      },
    ]);
  });

  it("rejects an indivisible box that cannot fit in an empty part", () => {
    expect(() => renderParts("shift_txt_boxes", boxes, 3)).toThrow(
      new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT"),
    );
    expect(() => renderParts("shift_csv_boxes", boxes, 2)).toThrow(
      new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT"),
    );
  });

  it("keeps an unsplit result as one ordinary part", () => {
    const [part] = renderParts("shift_txt_flat", flat, 3);

    expect(part).toMatchObject({
      partNumber: 1,
      physicalLineCount: 2,
      codeCount: 2,
      boxCount: 0,
      filename: "Вода_2pcs_2026-08-13.txt",
    });
  });

  it("rejects invalid limits and incompatible or empty sources", () => {
    expect(() => renderParts("shift_txt_flat", flat, 1)).toThrow(
      new ShiftExportDomainError("INVALID_LINE_LIMIT"),
    );
    expect(() => renderParts("shift_txt_flat", flat, 1_000_001)).toThrow(
      new ShiftExportDomainError("INVALID_LINE_LIMIT"),
    );
    expect(() => renderParts("shift_txt_flat", flat, 2.5)).toThrow(
      new ShiftExportDomainError("INVALID_LINE_LIMIT"),
    );
    expect(() => renderParts("shift_txt_flat", boxes)).toThrow(
      new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH"),
    );
    expect(() => renderParts("shift_txt_flat", { mode: "flat", codes: [] })).toThrow(
      new ShiftExportDomainError("EMPTY_SOURCE"),
    );
    expect(() => getShiftExportFormat("missing", 1)).toThrow(
      new ShiftExportDomainError("FORMAT_NOT_FOUND"),
    );
  });
});

describe("shift export filenames", () => {
  it("sanitizes the product segment without losing Cyrillic", () => {
    expect(sanitizeShiftExportFilenameSegment('  Вода / "газ"  ')).toBe("Вода_газ");
    expect(sanitizeShiftExportFilenameSegment("\u0000///:::***")).toBe("продукция");
  });

  it("uses per-part counts, box counts, and part suffixes only for multipart exports", () => {
    const parts = renderParts("shift_csv_boxes", boxes, 3);

    expect(parts.map((part) => part.filename)).toEqual([
      "Вода_2pcs_1box_2026-08-13_часть_1.csv",
      "Вода_1pcs_1box_2026-08-13_часть_2.csv",
    ]);
    expect(render("shift_csv_flat", flat).filename).toBe("Вода_2pcs_2026-08-13.csv");
    // Boxes-only and flat documents cover no pallets and keep their names.
    expect(parts.map((part) => part.palletCount)).toEqual([0, 0]);
    expect(render("shift_csv_flat", flat).palletCount).toBe(0);
  });
});

describe("boxes format version 2 (00-prefixed SSCC)", () => {
  it("advertises version 2 for boxes formats and version 1 for flat", () => {
    const byId = new Map(SHIFT_EXPORT_FORMATS.map((f) => [f.id, f.version]));
    expect(byId.get("shift_txt_boxes")).toBe(2);
    expect(byId.get("shift_csv_boxes")).toBe(2);
    expect(byId.get("shift_txt_flat")).toBe(1);
    expect(byId.get("shift_csv_flat")).toBe(1);
  });

  it("still resolves the frozen v1 boxes formats for old artifacts/retries", () => {
    expect(getShiftExportFormat("shift_txt_boxes", 1).version).toBe(1);
    expect(getShiftExportFormat("shift_csv_boxes", 1).version).toBe(1);
  });

  it("renders TXT v2 box headers as 20-digit 00-prefixed SSCC", () => {
    const parts = renderShiftExport({
      formatId: "shift_txt_boxes",
      formatVersion: 2,
      productName: "Товар",
      shiftDate: "2026-08-19",
      maxLines: null,
      source: {
        mode: "boxes",
        boxes: [{ sscc: "001234567890123456", codes: ["KM-1", "KM-2"] }],
      },
    });
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("00001234567890123456\nKM-1\nKM-2\n\n");
  });

  it("renders CSV v2 box_sscc column as 20-digit 00-prefixed SSCC", () => {
    const parts = renderShiftExport({
      formatId: "shift_csv_boxes",
      formatVersion: 2,
      productName: "Товар",
      shiftDate: "2026-08-19",
      maxLines: null,
      source: {
        mode: "boxes",
        boxes: [{ sscc: "001234567890123456", codes: ["KM-1"] }],
      },
    });
    const body = new TextDecoder().decode(parts[0]!.bytes.slice(3)); // strip BOM
    expect(body).toBe("box_sscc;code\r\n00001234567890123456;KM-1\r\n");
  });

  it("keeps v1 boxes rendering frozen at bare 18 digits", () => {
    const parts = renderShiftExport({
      formatId: "shift_txt_boxes",
      formatVersion: 1,
      productName: "Товар",
      shiftDate: "2026-08-19",
      maxLines: null,
      source: {
        mode: "boxes",
        boxes: [{ sscc: "001234567890123456", codes: ["KM-1"] }],
      },
    });
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("001234567890123456\nKM-1\n\n");
  });

  it("rejects a malformed box SSCC in v2 as ShiftExportDomainError, not a plain DomainError", () => {
    expect(() =>
      renderShiftExport({
        formatId: "shift_txt_boxes",
        formatVersion: 2,
        productName: "Товар",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: {
          mode: "boxes",
          boxes: [{ sscc: "0012345678901234", codes: ["KM-1"] }], // 16 digits, not 18
        },
      }),
    ).toThrow(new ShiftExportDomainError("INVALID_BOX_SSCC"));

    expect(() =>
      renderShiftExport({
        formatId: "shift_csv_boxes",
        formatVersion: 2,
        productName: "Товар",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: {
          mode: "boxes",
          boxes: [{ sscc: "not-a-number-18c", codes: ["KM-1"] }],
        },
      }),
    ).toThrow(new ShiftExportDomainError("INVALID_BOX_SSCC"));
  });

  it("does not validate box SSCC shape in frozen v1 rendering", () => {
    const parts = renderShiftExport({
      formatId: "shift_txt_boxes",
      formatVersion: 1,
      productName: "Товар",
      shiftDate: "2026-08-19",
      maxLines: null,
      source: {
        mode: "boxes",
        boxes: [{ sscc: "0012345678901234", codes: ["KM-1"] }], // malformed, but v1 never validates
      },
    });
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("0012345678901234\nKM-1\n\n");
  });
});

describe("GISMT aggregation XML format", () => {
  const GTIN = "04680089900017";
  const km = (serial: string) => `01${GTIN}21${serial}\u001d93dGVz`;

  function renderXml(
    source: ShiftExportSource,
    maxLines: number | null = null,
    organizationInn: string | null = "9705119097",
  ) {
    return renderShiftExport({
      formatId: "shift_xml_gismt_aggregation",
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines,
      source,
      organizationInn,
      organizationName: "ООО «Пивоварня»",
      document: shiftDocumentFixture,
    });
  }

  it("renders the GISMT aggregation XML with 00-prefixed pack codes and crypto tails stripped", () => {
    const [part, ...rest] = renderXml({
      mode: "boxes",
      boxes: [
        {
          sscc: "046800899000256001",
          codes: [km("5XW?TIF"), km('c"B6UA')],
        },
      ],
    });

    expect(rest).toEqual([]);
    expect(part).toMatchObject({
      partNumber: 1,
      physicalLineCount: 15,
      codeCount: 2,
      boxCount: 1,
      filename: "Сидр_2pcs_1box_2026-08-19.xml",
      mimeType: "application/xml; charset=utf-8",
    });
    expect(decode(part!.bytes)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<unit_pack document_id="11a0e30d-7cf6-4134-9ce5-68a3792ae8b1" VerForm="1.03"' +
          ' file_date_time="2026-08-20T10:00:00.000Z" action_id="30" version="1">',
        '    <Document operation_date_time="2026-08-19T18:00:00.000Z" document_number="AUG26-007">',
        "        <organisation>",
        "            <id_info>",
        '                <LP_info org_name="ООО «Пивоварня»" LP_TIN="9705119097" />',
        "            </id_info>",
        "        </organisation>",
        "        <pack_content>",
        "            <pack_code>00046800899000256001</pack_code>",
        "            <cis>0104680089900017215XW?TIF</cis>",
        '            <cis>010468008990001721c"B6UA</cis>',
        "        </pack_content>",
        "    </Document>",
        "</unit_pack>",
        "",
      ].join("\n"),
    );
  });

  it("renders identical XML bytes for identical input", () => {
    const source: ShiftExportSource = {
      mode: "boxes",
      boxes: [{ sscc: "046800899000256001", codes: [km("A")] }],
    };

    expect(renderXml(source)[0]!.bytes).toEqual(renderXml(source)[0]!.bytes);
  });

  it("escapes XML-reserved characters in cis serials and the org_name attribute", () => {
    const [part] = renderShiftExport({
      formatId: "shift_xml_gismt_aggregation",
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines: null,
      source: {
        mode: "boxes",
        boxes: [{ sscc: "046800899000256001", codes: [km("hPdPG&"), km("Ia>3<Y")] }],
      },
      organizationInn: "9705119097",
      organizationName: 'ООО "Ф&Б" <1>',
      document: shiftDocumentFixture,
    });
    const body = decode(part!.bytes);

    expect(body).toContain('org_name="ООО &quot;Ф&amp;Б&quot; &lt;1&gt;"');
    expect(body).toContain("<cis>010468008990001721hPdPG&amp;</cis>");
    expect(body).toContain("<cis>010468008990001721Ia&gt;3&lt;Y</cis>");
    expect(body).not.toContain("\u001d");
  });

  it("splits into self-contained XML documents counting the header and footer overhead", () => {
    const parts = renderXml(
      {
        mode: "boxes",
        boxes: [
          { sscc: "046800899000256001", codes: [km("A")] },
          { sscc: "046800899000256018", codes: [km("B")] },
        ],
      },
      14,
    );

    expect(
      parts.map((part) => ({
        physicalLineCount: part.physicalLineCount,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        filename: part.filename,
      })),
    ).toEqual([
      {
        physicalLineCount: 14,
        codeCount: 1,
        boxCount: 1,
        filename: "Сидр_1pcs_1box_2026-08-19_часть_1.xml",
      },
      {
        physicalLineCount: 14,
        codeCount: 1,
        boxCount: 1,
        filename: "Сидр_1pcs_1box_2026-08-19_часть_2.xml",
      },
    ]);
    for (const part of parts) {
      const body = decode(part.bytes);
      expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(body.endsWith("</unit_pack>\n")).toBe(true);
    }
    // Each part is uploaded to ЧЗ as its own document, so the file identifier
    // and the document number must not repeat between them.
    expect(decode(parts[0]!.bytes)).toContain(`document_id="${shiftDocumentFixture.documentId}-1"`);
    expect(decode(parts[0]!.bytes)).toContain('document_number="AUG26-007-1"');
    expect(decode(parts[1]!.bytes)).toContain(`document_id="${shiftDocumentFixture.documentId}-2"`);
    expect(decode(parts[1]!.bytes)).toContain('document_number="AUG26-007-2"');
  });

  it("keeps the base document id and number when the export is a single file", () => {
    const [part, ...rest] = renderXml({
      mode: "boxes",
      boxes: [{ sscc: "046800899000256001", codes: [km("A")] }],
    });

    expect(rest).toEqual([]);
    const body = decode(part!.bytes);
    expect(body).toContain(`document_id="${shiftDocumentFixture.documentId}"`);
    expect(body).toContain('document_number="AUG26-007"');
  });

  it("rejects a missing INN, an unparseable code, and a malformed SSCC", () => {
    const boxesSource: ShiftExportSource = {
      mode: "boxes",
      boxes: [{ sscc: "046800899000256001", codes: [km("A")] }],
    };

    expect(() => renderXml(boxesSource, null, null)).toThrow(
      new ShiftExportDomainError("ORG_INN_MISSING"),
    );
    expect(() => renderXml(boxesSource, null, "   ")).toThrow(
      new ShiftExportDomainError("ORG_INN_MISSING"),
    );
    expect(() =>
      renderXml({ mode: "boxes", boxes: [{ sscc: "046800899000256001", codes: ["KM-1"] }] }),
    ).toThrow(new ShiftExportDomainError("INVALID_CIS"));
    expect(() =>
      renderXml({ mode: "boxes", boxes: [{ sscc: "not-an-sscc", codes: [km("A")] }] }),
    ).toThrow(new ShiftExportDomainError("INVALID_BOX_SSCC"));
    expect(() => renderXml({ mode: "flat", codes: [km("A")] })).toThrow(
      new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH"),
    );
  });

  it("validates XML boxes before empty-source and line-limit decisions", () => {
    expect(() => renderXml({ mode: "boxes", boxes: [{ sscc: "not-an-sscc", codes: [] }] })).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
    expect(() =>
      renderXml({ mode: "boxes", boxes: [{ sscc: "not-an-sscc", codes: [km("A")] }] }, 10),
    ).toThrow(new ShiftExportDomainError("INVALID_BOX_SSCC"));
    expect(() =>
      renderXml({ mode: "boxes", boxes: [{ sscc: "046800899000256001", codes: ["KM-1"] }] }, 10),
    ).toThrow(new ShiftExportDomainError("INVALID_CIS"));
  });

  it.each([
    ["U+0000", "A\u0000B"],
    ["line feed", "A\nB"],
    ["carriage return", "A\rB"],
    ["DEL", "A\u007fB"],
    ["lone surrogate", "A\ud800B"],
  ])("rejects a cis serial carrying %s as INVALID_CIS", (_case, serial) => {
    expect(() =>
      renderXml({ mode: "boxes", boxes: [{ sscc: "046800899000256001", codes: [km(serial)] }] }),
    ).toThrow(new ShiftExportDomainError("INVALID_CIS"));
  });
});

describe("pallets shift export formats", () => {
  const boxA = "046800899000256001";
  const boxB = "046800899000256018";
  const looseBox = "046800899000256032";
  const palletSscc = "046800899000256025";
  const PALLETS_GTIN = "04680089900017";
  const palletsKm = (serial: string) => `01${PALLETS_GTIN}21${serial}`;

  /** One pallet stacking two boxes, plus one box that stands on no pallet. */
  const palletsSource: ShiftExportSource = {
    mode: "pallets",
    pallets: [
      {
        sscc: palletSscc,
        boxes: [
          { sscc: boxA, codes: ["KM-1", "KM-2"] },
          { sscc: boxB, codes: ["KM-3"] },
        ],
      },
    ],
    looseBoxes: [{ sscc: looseBox, codes: ["KM-4"] }],
  };

  /** Same box/pallet layout, but with real, parseable KM codes for the XML format. */
  const xmlPalletsSource: ShiftExportSource = {
    mode: "pallets",
    pallets: [
      {
        sscc: palletSscc,
        boxes: [
          { sscc: boxA, codes: [palletsKm("SERIAL-A"), palletsKm("SERIAL-B")] },
          { sscc: boxB, codes: [palletsKm("SERIAL-C")] },
        ],
      },
    ],
    looseBoxes: [{ sscc: looseBox, codes: [palletsKm("SERIAL-D")] }],
  };

  function renderPalletParts(
    formatId: "shift_txt_pallets" | "shift_csv_pallets",
    source: ShiftExportSource,
    maxLines: number | null = null,
  ) {
    return renderShiftExport({
      formatId,
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines,
      source,
    });
  }

  function renderXmlPallets(
    source: ShiftExportSource,
    maxLines: number | null = null,
    organizationInn: string | null = "9705119097",
  ) {
    return renderShiftExport({
      formatId: "shift_xml_gismt_aggregation_pallets",
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines,
      source,
      organizationInn,
      organizationName: "ООО «Пивоварня»",
      document: shiftDocumentFixture,
    });
  }

  it("renders the TXT pallet format with the pallet SSCC ahead of its boxes, loose boxes after", () => {
    const [part, ...rest] = renderPalletParts("shift_txt_pallets", palletsSource);

    expect(rest).toEqual([]);
    expect(decode(part!.bytes)).toBe(
      [
        `00${palletSscc}`,
        `00${boxA}`,
        "KM-1",
        "KM-2",
        "",
        `00${boxB}`,
        "KM-3",
        "",
        `00${looseBox}`,
        "KM-4",
        "",
        "",
      ].join("\n"),
    );
    // Owner report 2026-09-19: the file name and the part's counters must
    // say how many pallets the document covers, not only boxes.
    expect(part).toMatchObject({
      codeCount: 4,
      boxCount: 3,
      palletCount: 1,
      filename: "Сидр_4pcs_3box_1pallet_2026-08-19.txt",
    });
  });

  it("renders the CSV pallet format with pallet_sscc, box_sscc, code and an empty pallet column for a loose box", () => {
    const [part] = renderPalletParts("shift_csv_pallets", palletsSource);

    expect(stripBom(part!.bytes)).toBe(
      "pallet_sscc;box_sscc;code\r\n" +
        `00${palletSscc};00${boxA};KM-1\r\n` +
        `00${palletSscc};00${boxA};KM-2\r\n` +
        `00${palletSscc};00${boxB};KM-3\r\n` +
        `;00${looseBox};KM-4\r\n`,
    );
  });

  it("renders the XML pallet aggregation with every box before the pallet that names it", () => {
    const [part] = renderXmlPallets(xmlPalletsSource);
    const xml = decode(part!.bytes);

    expect(xml.indexOf(`<pack_code>00${palletSscc}</pack_code>`)).toBeGreaterThan(
      xml.indexOf(`<pack_code>00${boxB}</pack_code>`),
    );
    expect(xml).toContain(`<cis>00${boxA}</cis>`);
    expect(xml).toContain(`<cis>00${boxB}</cis>`);
    // The portal rejects `<sscc>` members outright; see the note on
    // `renderGismtAggregationXml`.
    expect(xml).not.toContain("<sscc>");
  });

  it("emits unpalletized boxes with the others and in no pallet", () => {
    const [part] = renderXmlPallets(xmlPalletsSource);
    const xml = decode(part!.bytes);

    expect(xml).toContain(`<pack_code>00${looseBox}</pack_code>`);
    // Exactly the two member boxes of the single pallet; the loose box gets
    // its own pack_content and is nested under nothing.
    expect(xml.match(/<cis>00\d{18}<\/cis>/g) ?? []).toHaveLength(2);
  });

  it("keeps a pallet block whole when splitting by line limit", () => {
    // Header (10) + the pallet block (boxA:5 + boxB:4 + wrapper:5 = 14) = 24,
    // which fits in one part at this limit; the loose box (4 lines) does not
    // also fit alongside it (24 + 4 = 28 > 26), so it starts a second part.
    const parts = renderXmlPallets(xmlPalletsSource, 26);

    expect(parts).toHaveLength(2);
    const palletParts = parts.filter((p) => decode(p.bytes).includes(`<pack_code>00${palletSscc}`));
    expect(palletParts).toHaveLength(1);
  });

  it("names a whole pallet group's own line-limit overflow distinctly from a single box's", () => {
    // The pallet block is 1 (pallet line) + boxA (4 lines) + boxB (3 lines) =
    // 8 physical lines; a limit of 7 cannot fit it even alone in an empty
    // part, and TXT has no header overhead to blame instead.
    expect(() => renderPalletParts("shift_txt_pallets", palletsSource, 7)).toThrow(
      new ShiftExportDomainError("PALLET_EXCEEDS_LINE_LIMIT"),
    );
    // A lone box (not in a pallet group) hitting the same kind of overflow
    // still reports the box-shaped code, proving the two paths stay distinct.
    const looseOnly: ShiftExportSource = {
      mode: "pallets",
      pallets: [],
      looseBoxes: [{ sscc: boxA, codes: ["KM-1", "KM-2"] }],
    };
    expect(() => renderPalletParts("shift_txt_pallets", looseOnly, 3)).toThrow(
      new ShiftExportDomainError("BOX_EXCEEDS_LINE_LIMIT"),
    );
  });

  it("rejects a flat or boxes source for a pallets-mode format, and vice versa", () => {
    expect(() =>
      renderShiftExport({
        formatId: "shift_txt_pallets",
        formatVersion: 1,
        productName: "Сидр",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: flat,
      }),
    ).toThrow(new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH"));
    expect(() =>
      renderShiftExport({
        formatId: "shift_txt_boxes",
        formatVersion: 2,
        productName: "Сидр",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: palletsSource,
      }),
    ).toThrow(new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH"));
  });

  it("rejects a malformed pallet SSCC as INVALID_BOX_SSCC across every pallet format", () => {
    const malformedPallet: ShiftExportSource = {
      mode: "pallets",
      pallets: [{ sscc: "not-an-sscc", boxes: [{ sscc: boxA, codes: ["KM-1"] }] }],
      looseBoxes: [],
    };
    const malformedPalletXml: ShiftExportSource = {
      mode: "pallets",
      pallets: [{ sscc: "not-an-sscc", boxes: [{ sscc: boxA, codes: [palletsKm("SERIAL-A")] }] }],
      looseBoxes: [],
    };

    expect(() => renderPalletParts("shift_txt_pallets", malformedPallet)).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
    expect(() => renderPalletParts("shift_csv_pallets", malformedPallet)).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
    expect(() => renderXmlPallets(malformedPalletXml)).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
  });

  it("rejects a malformed member box SSCC inside a pallet", () => {
    const malformedBox: ShiftExportSource = {
      mode: "pallets",
      pallets: [{ sscc: palletSscc, boxes: [{ sscc: "not-an-sscc", codes: ["KM-1"] }] }],
      looseBoxes: [],
    };

    expect(() => renderPalletParts("shift_txt_pallets", malformedBox)).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
    expect(() => renderXmlPallets(malformedBox)).toThrow(
      new ShiftExportDomainError("INVALID_BOX_SSCC"),
    );
  });

  it("rejects an empty pallets source as EMPTY_SOURCE", () => {
    const empty: ShiftExportSource = { mode: "pallets", pallets: [], looseBoxes: [] };

    expect(() => renderPalletParts("shift_txt_pallets", empty)).toThrow(
      new ShiftExportDomainError("EMPTY_SOURCE"),
    );
  });
});

describe("pallet → boxes shift export formats (no codes)", () => {
  const boxA = "046800899000256001";
  const boxB = "046800899000256018";
  const looseBox = "046800899000256032";
  const palletOne = "046800899000256025";
  const palletTwo = "046800899000256049";

  /** Two pallets (2 boxes + 1 box) and one loose box that must NOT be written. */
  const source: ShiftExportSource = {
    mode: "pallets",
    pallets: [
      {
        sscc: palletOne,
        boxes: [
          { sscc: boxA, codes: ["KM-1", "KM-2"] },
          { sscc: boxB, codes: ["KM-3"] },
        ],
      },
      { sscc: palletTwo, boxes: [{ sscc: looseBox.slice(0, 17) + "6", codes: ["KM-5"] }] },
    ],
    looseBoxes: [{ sscc: looseBox, codes: ["KM-4"] }],
  };
  const palletTwoBox = source.mode === "pallets" ? source.pallets[1]!.boxes[0]!.sscc : "";

  function renderTxt(maxLines: number | null = null) {
    return renderShiftExport({
      formatId: "shift_txt_pallet_boxes",
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines,
      source,
    });
  }

  function renderXml(
    maxLines: number | null = null,
    organizationInn: string | null = "9705119097",
  ) {
    return renderShiftExport({
      formatId: "shift_xml_gismt_pallet_boxes",
      formatVersion: 1,
      productName: "Сидр",
      shiftDate: "2026-08-19",
      maxLines,
      source,
      organizationInn,
      organizationName: "ООО «Пивоварня»",
      document: shiftDocumentFixture,
    });
  }

  it("marks both new formats as pallet-gated alongside the code-bearing pallet formats", () => {
    expect(
      SHIFT_EXPORT_FORMATS.filter(shiftExportFormatRequiresPallets).map((format) => format.id),
    ).toEqual([
      "shift_txt_pallets",
      "shift_csv_pallets",
      "shift_xml_gismt_aggregation_pallets",
      "shift_txt_pallet_boxes",
      "shift_xml_gismt_pallet_boxes",
    ]);
  });

  it("renders TXT as one block per pallet: pallet SSCC, its box SSCCs, a blank line; loose boxes omitted", () => {
    const [part, ...rest] = renderTxt();

    expect(rest).toEqual([]);
    expect(decode(part!.bytes)).toBe(
      [
        `00${palletOne}`,
        `00${boxA}`,
        `00${boxB}`,
        "",
        `00${palletTwo}`,
        `00${palletTwoBox}`,
        "",
        "",
      ].join("\n"),
    );
    expect(decode(part!.bytes)).not.toContain("KM-");
    expect(decode(part!.bytes)).not.toContain(looseBox);
    expect(part).toMatchObject({
      partNumber: 1,
      physicalLineCount: 7,
      codeCount: 4,
      boxCount: 3,
      palletCount: 2,
      filename: "Сидр_4pcs_3box_2pallet_2026-08-19.txt",
      mimeType: "text/plain; charset=utf-8",
    });
  });

  it("renders XML with only pallet pack_content naming its boxes, and no box pack_content", () => {
    const [part, ...rest] = renderXml();
    const xml = decode(part!.bytes);

    expect(rest).toEqual([]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<unit_pack document_id="11a0e30d-7cf6-4134-9ce5-68a3792ae8b1" VerForm="1.03"' +
          ' file_date_time="2026-08-20T10:00:00.000Z" action_id="30" version="1">',
        '    <Document operation_date_time="2026-08-19T18:00:00.000Z" document_number="AUG26-007">',
        "        <organisation>",
        "            <id_info>",
        '                <LP_info org_name="ООО «Пивоварня»" LP_TIN="9705119097" />',
        "            </id_info>",
        "        </organisation>",
        "        <pack_content>",
        `            <pack_code>00${palletOne}</pack_code>`,
        `            <cis>00${boxA}</cis>`,
        `            <cis>00${boxB}</cis>`,
        "        </pack_content>",
        "        <pack_content>",
        `            <pack_code>00${palletTwo}</pack_code>`,
        `            <cis>00${palletTwoBox}</cis>`,
        "        </pack_content>",
        "    </Document>",
        "</unit_pack>",
        "",
      ].join("\n"),
    );
    // The `<cis>` entries above are box SSCCs, never the units' own KM
    // codes: this format reports pallet membership and nothing else.
    expect(xml).not.toContain("KM-");
    expect(xml).not.toContain("<sscc>");
    expect(xml).not.toContain(looseBox);
    expect(part).toMatchObject({
      physicalLineCount: 19,
      codeCount: 4,
      boxCount: 3,
      palletCount: 2,
      filename: "Сидр_4pcs_3box_2pallet_2026-08-19.xml",
      mimeType: "application/xml; charset=utf-8",
    });
  });

  it("requires the organisation INN for the XML variant", () => {
    expect(() => renderXml(null, null)).toThrow(new ShiftExportDomainError("ORG_INN_MISSING"));
  });

  it("splits by pallet, keeping each pallet block whole, and counts per part", () => {
    // Pallet one block = 4 lines, pallet two block = 3 lines; limit 5 fits one each.
    const parts = renderTxt(5);

    expect(parts.map((part) => decode(part.bytes))).toEqual([
      `00${palletOne}\n00${boxA}\n00${boxB}\n\n`,
      `00${palletTwo}\n00${palletTwoBox}\n\n`,
    ]);
    expect(
      parts.map((part) => [part.codeCount, part.boxCount, part.palletCount, part.filename]),
    ).toEqual([
      [3, 2, 1, "Сидр_3pcs_2box_1pallet_2026-08-19_часть_1.txt"],
      [1, 1, 1, "Сидр_1pcs_1box_1pallet_2026-08-19_часть_2.txt"],
    ]);

    // XML: overhead 10 + pallet one (5) = 15; pallet two (4) does not fit in 16 alongside.
    const xmlParts = renderXml(16);
    expect(xmlParts).toHaveLength(2);
    expect(decode(xmlParts[0]!.bytes)).toContain(`<pack_code>00${palletOne}</pack_code>`);
    expect(decode(xmlParts[0]!.bytes)).not.toContain(`<pack_code>00${palletTwo}</pack_code>`);
    expect(decode(xmlParts[1]!.bytes)).toContain(`<pack_code>00${palletTwo}</pack_code>`);
  });

  it("reports a pallet that cannot fit the line limit as PALLET_EXCEEDS_LINE_LIMIT", () => {
    expect(() => renderTxt(3)).toThrow(new ShiftExportDomainError("PALLET_EXCEEDS_LINE_LIMIT"));
  });

  it("treats a source with no pallet group as empty", () => {
    expect(() =>
      renderShiftExport({
        formatId: "shift_txt_pallet_boxes",
        formatVersion: 1,
        productName: "Сидр",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: { mode: "pallets", pallets: [], looseBoxes: [{ sscc: boxA, codes: ["KM-1"] }] },
      }),
    ).toThrow(new ShiftExportDomainError("EMPTY_SOURCE"));
  });

  it("rejects a boxes source for a pallet → boxes format", () => {
    expect(() =>
      renderShiftExport({
        formatId: "shift_txt_pallet_boxes",
        formatVersion: 1,
        productName: "Сидр",
        shiftDate: "2026-08-19",
        maxLines: null,
        source: { mode: "boxes", boxes: [{ sscc: boxA, codes: ["KM-1"] }] },
      }),
    ).toThrow(new ShiftExportDomainError("FORMAT_SOURCE_MISMATCH"));
  });
});
