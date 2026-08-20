import { describe, expect, it } from "vitest";
import {
  getShiftExportFormat,
  renderShiftExport,
  sanitizeShiftExportFilenameSegment,
  SHIFT_EXPORT_FORMATS,
  ShiftExportDomainError,
  type ShiftExportSource,
} from "../src/shift-exports.js";

const decoder = new TextDecoder();

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

function render(
  formatId: "shift_txt_flat" | "shift_txt_boxes" | "shift_csv_flat" | "shift_csv_boxes",
  source: ShiftExportSource,
) {
  const [part] = renderParts(formatId, source);

  if (!part) {
    throw new Error("Expected export part");
  }

  return part;
}

function renderParts(
  formatId: "shift_txt_flat" | "shift_txt_boxes" | "shift_csv_flat" | "shift_csv_boxes",
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
        "<unit_pack>",
        "    <Document>",
        "        <organisation>",
        "            <id_info>",
        '                <LP_info LP_TIN="9705119097" />',
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

  it("escapes XML-reserved characters in cis serials and the LP_TIN attribute", () => {
    const [part] = renderXml(
      {
        mode: "boxes",
        boxes: [{ sscc: "046800899000256001", codes: [km("hPdPG&"), km("Ia>3<Y")] }],
      },
      null,
      'IN"N&1',
    );
    const body = decode(part!.bytes);

    expect(body).toContain('<LP_info LP_TIN="IN&quot;N&amp;1" />');
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
