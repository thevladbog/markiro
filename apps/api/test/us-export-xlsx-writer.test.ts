import { describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { WorkbookModel } from "@markiro/domain";
import { renderUsExportXlsx } from "../src/modules/traceability/export/xlsx-writer.js";
import type { UsExportXlsxError } from "../src/modules/traceability/export/xlsx-writer.js";
import { verifyUsExportXlsx } from "../src/modules/traceability/export/xlsx-verify.js";

const decoder = new TextDecoder();
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

const goldenModel: WorkbookModel = {
  mode: "export_ready_candidate",
  sheets: [
    {
      name: "Metadata",
      columns: [
        { key: "field", header: "Field" },
        { key: "value", header: "Value" },
      ],
      rows: [
        {
          sourceRecord: "metadata",
          cells: [
            { kind: "text", value: "scope_label" },
            { kind: "text", value: "=unsafe" },
          ],
        },
      ],
      freezeHeader: true,
      autoFilter: false,
    },
    {
      name: "Receiving",
      columns: [
        { key: "source_record", header: "Source record" },
        { key: "event_date", header: "Event date" },
        { key: "quantity", header: "Quantity" },
        { key: "tlc", header: "Traceability lot code" },
      ],
      rows: [
        {
          sourceRecord: "receiving:event-1:r1:line-1",
          cells: [
            { kind: "text", value: "receiving:event-1:r1:line-1" },
            { kind: "date", value: "2026-10-02" },
            { kind: "number", value: 5, sourceValue: "5.00" },
            { kind: "text", value: "=1+2" },
          ],
        },
      ],
      freezeHeader: true,
      autoFilter: true,
    },
  ],
};

function withQuantity(quantity: {
  kind: "number";
  value: number;
  sourceValue: string;
}): WorkbookModel {
  const receiving = goldenModel.sheets.find((sheet) => sheet.name === "Receiving");
  const row = receiving?.rows[0];
  if (!receiving || !row) throw new Error("Invalid test fixture");
  return {
    ...goldenModel,
    sheets: goldenModel.sheets.map((sheet) =>
      sheet.name === "Receiving"
        ? {
            ...receiving,
            rows: [
              { ...row, cells: row.cells.map((cell, index) => (index === 2 ? quantity : cell)) },
            ],
          }
        : sheet,
    ),
  };
}

describe("US export XLSX writer", () => {
  it("renders deterministic safe bytes and verifies exact source cells", async () => {
    const first = await renderUsExportXlsx(goldenModel);
    const second = await renderUsExportXlsx(goldenModel);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toEqual(second.bytes);
    expect(() => verifyUsExportXlsx(first.bytes, goldenModel)).not.toThrow();

    const parts = unzipSync(first.bytes);
    expect(Object.keys(parts)).toContain("xl/worksheets/sheet2.xml");
    const sheetXml = decoder.decode(parts["xl/worksheets/sheet2.xml"]);
    expect(sheetXml).not.toMatch(/<f(?:\s|>)/);
    expect(sheetXml).toMatch(/<autoFilter ref="A1:D2"\s*\/>/);
    expect(sheetXml).toMatch(/<pane\s[^>]*state="frozen"/);
    const shared = parser.parse(decoder.decode(parts["xl/sharedStrings.xml"])) as {
      sst: { si: { t: string }[] };
    };
    const cells = parser.parse(sheetXml) as {
      worksheet: { sheetData: { row: { c: { "@_r": string; "@_t"?: string; v: string }[] }[] } };
    };
    const dataRow = cells.worksheet.sheetData.row[1];
    const quantity = dataRow?.c.find((cell) => cell["@_r"] === "C2");
    expect(quantity?.["@_t"]).toBe("s");
    expect(shared.sst.si[Number(quantity?.v ?? -1)]?.t).toBe("5.00");
    const tlc = dataRow?.c.find((cell) => cell["@_r"] === "D2");
    expect(tlc?.["@_t"]).toBe("s");
    expect(shared.sst.si[Number(tlc?.v ?? -1)]?.t).toBe("=1+2");
    expect(Object.keys(parts)).not.toEqual(expect.arrayContaining(["xl/vbaProject.bin"]));
  });

  it("keeps byte identity across ZIP timestamp intervals", async () => {
    const first = await renderUsExportXlsx(goldenModel);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await renderUsExportXlsx(goldenModel);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toEqual(first.bytes);
  });

  it("rejects a changed cell, missing row, formula or external ZIP part", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const parts = unzipSync(bytes);
    const sheetPath = "xl/worksheets/sheet2.xml";
    const sheetXml = decoder.decode(parts[sheetPath]);
    const changedCell = {
      ...parts,
      "xl/sharedStrings.xml": new TextEncoder().encode(
        decoder.decode(parts["xl/sharedStrings.xml"]).replace("<t>5.00</t>", "<t>6.00</t>"),
      ),
    };
    expect(() => verifyUsExportXlsx(zipSync(changedCell), goldenModel)).toThrow();
    const formula = {
      ...parts,
      [sheetPath]: new TextEncoder().encode(
        sheetXml.replace("</sheetData>", "<f>1+2</f></sheetData>"),
      ),
    };
    expect(() => verifyUsExportXlsx(zipSync(formula), goldenModel)).toThrow();
    const external = {
      ...parts,
      "xl/externalLinks/externalLink1.xml": new TextEncoder().encode("<x/>"),
    };
    expect(() => verifyUsExportXlsx(zipSync(external), goldenModel)).toThrow();
    const traversal = { ...parts, "../outside.xml": new TextEncoder().encode("<x/>") };
    expect(() => verifyUsExportXlsx(zipSync(traversal), goldenModel)).toThrow();
    const macro = { ...parts, "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) };
    expect(() => verifyUsExportXlsx(zipSync(macro), goldenModel)).toThrow();
    const externalRelationship = {
      ...parts,
      "_rels/.rels": new TextEncoder().encode(
        decoder
          .decode(parts["_rels/.rels"])
          .replace('Target="xl/workbook.xml"', 'Target="https://example.invalid/workbook.xml"'),
      ),
    };
    expect(() => verifyUsExportXlsx(zipSync(externalRelationship), goldenModel)).toThrow();
    const missingRow = {
      ...parts,
      [sheetPath]: new TextEncoder().encode(sheetXml.replace(/<row r="2"[\s\S]*?<\/row>/, "")),
    };
    expect(() => verifyUsExportXlsx(zipSync(missingRow), goldenModel)).toThrow();
  });

  it("rejects injected inline text where the model has a blank cell", async () => {
    const blankModel: WorkbookModel = {
      ...goldenModel,
      sheets: goldenModel.sheets.map((sheet) =>
        sheet.name === "Receiving"
          ? {
              ...sheet,
              rows: sheet.rows.map((row) => ({
                ...row,
                cells: row.cells.map((cell, index) =>
                  index === 3 ? { kind: "blank" as const, value: null } : cell,
                ),
              })),
            }
          : sheet,
      ),
    };
    const { bytes } = await renderUsExportXlsx(blankModel);
    const parts = unzipSync(bytes);
    const path = "xl/worksheets/sheet2.xml";
    const original = decoder.decode(parts[path]);
    const injected = '<c r="D2" t="inlineStr"><is><t>injected</t></is></c>';
    const blankCell = original.match(/<c r="D2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/)?.[0];
    expect(blankCell).toBeUndefined();
    const changed = original.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/, `$1${injected}$2`);
    expect(changed).not.toBe(original);
    expect(() =>
      verifyUsExportXlsx(
        zipSync({ ...parts, [path]: new TextEncoder().encode(changed) }),
        blankModel,
      ),
    ).toThrow(/blank|cell|value/i);
  });

  it("rejects duplicate ZIP entry names before part lookup can hide one", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    let central = -1;
    for (let offset = 0; offset <= damaged.length - 46; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(offset + 28, true);
      const name = decoder.decode(damaged.subarray(offset + 46, offset + 46 + nameLength));
      if (name === "xl/worksheets/sheet2.xml") {
        central = offset;
        break;
      }
    }
    if (central < 0) throw new Error("Missing ZIP test fixture part");
    const local = view.getUint32(central + 42, true);
    const duplicateName = new TextEncoder().encode("xl/worksheets/sheet1.xml");
    damaged.set(duplicateName, central + 46);
    damaged.set(duplicateName, local + 30);
    expect(() => verifyUsExportXlsx(damaged, goldenModel)).toThrow(/duplicate entry/);
  });

  it("rejects swapped internal worksheet relationships even when every sheet XML is unchanged", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const parts = unzipSync(bytes);
    const path = "xl/_rels/workbook.xml.rels";
    const relationXml = decoder.decode(parts[path]);
    const swapped = relationXml
      .replace('Target="worksheets/sheet1.xml"', 'Target="worksheets/sheet0.xml"')
      .replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet1.xml"')
      .replace('Target="worksheets/sheet0.xml"', 'Target="worksheets/sheet2.xml"');
    expect(swapped).not.toBe(relationXml);
    expect(() =>
      verifyUsExportXlsx(
        zipSync({ ...parts, [path]: new TextEncoder().encode(swapped) }),
        goldenModel,
      ),
    ).toThrow(/relationship|sheet/i);
  });

  it("rejects a local ZIP header name that disagrees with its central directory entry", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    let central = -1;
    for (let offset = 0; offset <= damaged.length - 46; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(offset + 28, true);
      const name = decoder.decode(damaged.subarray(offset + 46, offset + 46 + nameLength));
      if (name === "xl/styles.xml") {
        central = offset;
        break;
      }
    }
    if (central < 0) throw new Error("Missing ZIP test fixture part");
    const local = view.getUint32(central + 42, true);
    const original = decoder.decode(damaged.subarray(local + 30, local + 43));
    expect(original).toBe("xl/styles.xml");
    damaged.set(new TextEncoder().encode("xl/stylas.xml"), local + 30);
    expect(() => verifyUsExportXlsx(damaged, goldenModel)).toThrow(/ZIP|header|entry/);

    for (const [fieldOffset, width] of [
      [6, 2], // General-purpose flags.
      [8, 2], // Compression method.
      [14, 4], // CRC-32.
      [18, 4], // Compressed size.
      [22, 4], // Uncompressed size.
    ] as const) {
      const mismatch = bytes.slice();
      const fields = new DataView(mismatch.buffer, mismatch.byteOffset, mismatch.byteLength);
      const position = local + fieldOffset;
      if (width === 2) fields.setUint16(position, fields.getUint16(position, true) ^ 1, true);
      else fields.setUint32(position, fields.getUint32(position, true) ^ 1, true);
      expect(() => verifyUsExportXlsx(mismatch, goldenModel)).toThrow(/ZIP|header|entry/);
    }
  });

  it("rejects a data-descriptor flag without a descriptor even when central sizes are valid", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    let central = -1;
    for (let offset = 0; offset <= damaged.length - 46; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const length = view.getUint16(offset + 28, true);
      if (decoder.decode(damaged.subarray(offset + 46, offset + 46 + length)) === "xl/styles.xml") {
        central = offset;
        break;
      }
    }
    if (central < 0) throw new Error("Missing ZIP test fixture part");
    const local = view.getUint32(central + 42, true);
    expect(view.getUint16(central + 8, true) & 8).toBe(0);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 8, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) | 8, true);
    view.setUint32(local + 14, 0, true);
    view.setUint32(local + 18, 0, true);
    view.setUint32(local + 22, 0, true);
    expect(() => verifyUsExportXlsx(damaged, goldenModel)).toThrow(/ZIP|descriptor/);
  });

  it("rejects matching but false CRC values in central and local ZIP headers", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    let central = -1;
    for (let offset = 0; offset <= damaged.length - 46; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const length = view.getUint16(offset + 28, true);
      if (decoder.decode(damaged.subarray(offset + 46, offset + 46 + length)) === "xl/styles.xml") {
        central = offset;
        break;
      }
    }
    if (central < 0) throw new Error("Missing ZIP test fixture part");
    const local = view.getUint32(central + 42, true);
    const wrongCrc = view.getUint32(central + 16, true) ^ 1;
    view.setUint32(central + 16, wrongCrc, true);
    view.setUint32(local + 14, wrongCrc, true);
    expect(() => verifyUsExportXlsx(damaged, goldenModel)).toThrow(/ZIP|CRC|checksum/);
  });

  it("rejects a date style changed to General even when its serial number is unchanged", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const parts = unzipSync(bytes);
    const path = "xl/styles.xml";
    const styles = decoder.decode(parts[path]);
    const changed = styles.replace('formatCode="yyyy-mm-dd"', 'formatCode="General"');
    expect(changed).not.toBe(styles);
    expect(() =>
      verifyUsExportXlsx(
        zipSync({ ...parts, [path]: new TextEncoder().encode(changed) }),
        goldenModel,
      ),
    ).toThrow(/date|format|style/i);
  });

  it("rejects an overstated decompressed part size before unzip", async () => {
    const { bytes } = await renderUsExportXlsx(goldenModel);
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    let directoryEntry = -1;
    for (let offset = 0; offset <= damaged.length - 46; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        directoryEntry = offset;
        break;
      }
    }
    if (directoryEntry < 0) throw new Error("Invalid ZIP test fixture");
    view.setUint32(directoryEntry + 24, 128 * 1024 * 1024 + 1, true);
    expect(() => verifyUsExportXlsx(damaged, goldenModel)).toThrow(/unsafe or unsupported/);
  });

  it("retains numeric sortability for a canonical safe number and a typed civil date", async () => {
    const model = withQuantity({ kind: "number", value: 5, sourceValue: "5" });
    const { bytes } = await renderUsExportXlsx(model);
    const sheetXml = decoder.decode(unzipSync(bytes)["xl/worksheets/sheet2.xml"]);
    expect(sheetXml).toMatch(/<c r="C2"><v>5<\/v><\/c>/);
    expect(sheetXml).toMatch(/<c r="B2" s="\d+"><v>46297<\/v><\/c>/);
    expect(() => verifyUsExportXlsx(bytes, model)).not.toThrow();
  });

  it("defensively uses text for a 16-significant-digit number even when the model says number", async () => {
    const model = withQuantity({
      kind: "number",
      value: 1234567890123456,
      sourceValue: "1234567890123456",
    });
    const { bytes } = await renderUsExportXlsx(model);
    const parts = unzipSync(bytes);
    const sheetXml = decoder.decode(parts["xl/worksheets/sheet2.xml"]);
    expect(sheetXml).toMatch(/<c r="C2" t="s"><v>\d+<\/v><\/c>/);
    expect(decoder.decode(parts["xl/sharedStrings.xml"])).toContain("1234567890123456");
  });

  it("rejects an invalid cell with the exact source and field", async () => {
    const invalid = withQuantity({ kind: "number", value: 5, sourceValue: "6" });
    await expect(renderUsExportXlsx(invalid)).rejects.toMatchObject({
      failure: {
        code: "XLSX_RENDER_FAILED",
        sourceRecord: "receiving:event-1:r1:line-1",
        fieldKey: "quantity",
      },
    } satisfies Partial<UsExportXlsxError>);
  });

  it("fails explicitly on a civil date the writer's 1900 date system cannot encode exactly", async () => {
    const receiving = goldenModel.sheets.find((sheet) => sheet.name === "Receiving");
    const row = receiving?.rows[0];
    if (!receiving || !row) throw new Error("Invalid test fixture");
    const earlyDate: WorkbookModel = {
      ...goldenModel,
      sheets: goldenModel.sheets.map((sheet) =>
        sheet.name === "Receiving"
          ? {
              ...receiving,
              rows: [
                {
                  ...row,
                  cells: row.cells.map((cell, index) =>
                    index === 1 ? { kind: "date", value: "1900-02-28" } : cell,
                  ),
                },
              ],
            }
          : sheet,
      ),
    };
    await expect(renderUsExportXlsx(earlyDate)).rejects.toMatchObject({
      failure: {
        code: "XLSX_RENDER_FAILED",
        sourceRecord: row.sourceRecord,
        fieldKey: "event_date",
      },
    });
  });

  it("rejects a row whose displayed source ID disagrees with its frozen provenance", async () => {
    const receiving = goldenModel.sheets.find((sheet) => sheet.name === "Receiving");
    const row = receiving?.rows[0];
    if (!receiving || !row) throw new Error("Invalid test fixture");
    const mismatched: WorkbookModel = {
      ...goldenModel,
      sheets: goldenModel.sheets.map((sheet) =>
        sheet.name === "Receiving"
          ? {
              ...receiving,
              rows: [
                {
                  ...row,
                  cells: [{ kind: "text", value: "another-record" }, ...row.cells.slice(1)],
                },
              ],
            }
          : sheet,
      ),
    };
    await expect(renderUsExportXlsx(mismatched)).rejects.toMatchObject({
      failure: { sourceRecord: row.sourceRecord, fieldKey: "source_record" },
    });
  });
});
