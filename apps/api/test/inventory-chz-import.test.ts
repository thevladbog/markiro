import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { INVENTORY_CHZ_STATUSES, kmHash, type InventoryChzStatus } from "@markiro/domain";

import { ChzImportError, parseChzImport } from "../src/modules/inventories/chz-import-parser";

const GTIN = "04680089900383";
const OTHER_GTIN = "04600682000013";
const GS = "\u001d";
const MIME_CSV = "text/csv";
const MIME_ZIP = "application/zip";
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const HEADER = [
  "Код",
  "GTIN",
  "Код ТН ВЭД",
  "Группа ТН ВЭД",
  "Максимальная розничная цена",
  "Родительская упаковка",
  "Производитель / Импортер",
  "Владелец",
  "Идентификатор ВСД",
  "Наименование товара",
  "Бренд",
  "Наименование собственника товара",
  "Наименование производителя",
  "Дата ввода в оборот",
  "Дата вывода из оборота",
  "Статус кода",
  "Состояние кода",
  "Способ ввода в оборот",
  "Причина вывода из оборота",
  "Тип упаковки",
  "Товарная группа",
  "Дата нанесения",
  "Дата эмиссии",
  "Срок годности",
  "Список дочерних КМ",
  "Список gtin, входящих в справочный состав набора",
  "Текстовое описание состава набора",
  "Дата производства",
  "Тип агрегации",
  "Номер заказа в СУЗ",
  "Вид оборота",
  "КПП Места осуществления деятельности",
  "ФИАС Места осуществления деятельности",
  "Декларация на товары",
  "Разрешительные документы",
] as const;

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/inventory", name));

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function filter(status: InventoryChzStatus, gtin = GTIN, packaging = "UNIT"): string {
  return [
    'Фильтр("Владелец"=0000000000',
    '"Код товарной группы"=BEER',
    `"Типы упаковок"=[${packaging}]`,
    `"Статусы кодов"=${status}`,
    '"Состояние кода"=[]',
    `"Включая коды товаров"=[${gtin}]`,
    '"Исключая коды товаров"=[]',
    '"Способ ввода в оборот"=[]',
    '"Вид оборота"=[]',
    '"Производитель/Импортер"=[]',
    '"Причина вывода из оборота"=[]',
    '"Номер заказа в СУЗ"=[]',
    '"Декларация на товары"=[]',
    '"Индексы разрешительных документов"=[])',
  ].join(",");
}

function dataRow(
  status: InventoryChzStatus,
  options: {
    rawKm?: string;
    gtin?: string;
    parentSscc?: string;
    state?: string;
    packaging?: string;
    productionDate?: string;
  } = {},
): string[] {
  const row = Array<string>(HEADER.length).fill("");
  row[0] = options.rawKm ?? `01${GTIN}21SYNTHETIC-${status}`;
  row[1] = options.gtin ?? GTIN;
  row[5] = options.parentSscc ?? "";
  row[15] = status;
  row[16] = options.state ?? "";
  row[19] = options.packaging ?? "UNIT";
  row[27] = options.productionDate ?? "";
  return row;
}

function csvBytes(
  status: InventoryChzStatus,
  rows: string[][],
  options: { gtin?: string; packaging?: string; bom?: boolean; newline?: "\n" | "\r\n" } = {},
): Uint8Array {
  const newline = options.newline ?? "\n";
  const text = [[filter(status, options.gtin, options.packaging)], [...HEADER], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join(newline);
  return strToU8(`${options.bom ? "\ufeff" : ""}${text}`);
}

function parse(
  bytes: Uint8Array,
  options: {
    filename?: string;
    mimeType?: string;
    expectedStatus?: InventoryChzStatus;
    expectedGtin14?: string;
  } = {},
) {
  return parseChzImport({
    filename: options.filename ?? "status.csv",
    mimeType: options.mimeType ?? MIME_CSV,
    bytes,
    expectedStatus: options.expectedStatus ?? "INTRODUCED",
    expectedGtin14: options.expectedGtin14 ?? GTIN,
  });
}

function expectImportError(
  action: () => unknown,
  code: string,
  rowNumber?: number,
  forbiddenRaw?: string,
): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ChzImportError);
    expect(error).toMatchObject({ code, rowNumber });
    if (forbiddenRaw !== undefined) {
      expect(JSON.stringify(error)).not.toContain(forbiddenRaw);
      expect((error as Error).message).not.toContain(forbiddenRaw);
    }
  }
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function inlineRow(rowNumber: number, values: readonly string[]): string {
  const cells = values
    .map(
      (value, index) =>
        `<c r="${columnName(index)}${rowNumber}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`,
    )
    .join("");
  return `<row r="${rowNumber}">${cells}</row>`;
}

function xlsxBytes(
  options: {
    formulaCell?: "missing-cache" | "empty-v" | "empty-is";
    sparseDataRow?: boolean;
  } = {},
): Uint8Array {
  const rawKm = `01${GTIN}21SYNTHETIC-XLSX${GS}93tail,"punctuation"`;
  const row = dataRow("INTRODUCED", {
    rawKm,
    state: "MOVING_BY_UD",
    productionDate: "2026-08-19T00:00:00Z",
  });
  const row3Cells = row
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !options.sparseDataRow || value !== "")
    .map(({ value, index }) => {
      const ref = `${columnName(index)}3`;
      if (index === 0 && options.formulaCell === "missing-cache") {
        return `<c r="${ref}" t="str"><f>1+1</f></c>`;
      }
      if (index === 0 && options.formulaCell === "empty-v") {
        return `<c r="${ref}" t="str"><f>1+1</f><v/></c>`;
      }
      if (index === 0 && options.formulaCell === "empty-is") {
        return `<c r="${ref}" t="inlineStr"><f>1+1</f><is/></c>`;
      }
      if (index === 0) return `<c r="${ref}" t="s"><v>0</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
    })
    .join("");
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    inlineRow(1, [filter("INTRODUCED")]),
    inlineRow(2, HEADER),
    `<row r="3">${row3Cells}</row>`,
    "</sheetData></worksheet>",
  ].join("");
  const workbook = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets><sheet name="Hidden" sheetId="1" state="hidden" r:id="rId1"/>',
    '<sheet name="Visible" sheetId="2" r:id="rId2"/></sheets></workbook>',
  ].join("");
  const relationships = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Target="worksheets/hidden.xml" ',
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>',
    '<Relationship Id="rId2" Target="worksheets/sheet1.xml" ',
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>',
    "</Relationships>",
  ].join("");
  const sharedStrings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">',
    `<si><t>${xml(rawKm)}</t></si></sst>`,
  ].join("");
  return zipSync({
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(relationships),
    "xl/worksheets/hidden.xml": strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(worksheet),
    "xl/sharedStrings.xml": strToU8(sharedStrings),
  });
}

function markZipEncrypted(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  for (let offset = 0; offset <= result.length - 10; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50)
      view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
    if (signature === 0x02014b50)
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
  }
  return result;
}

function findZipSignature(bytes: Uint8Array, signature: number, fromEnd = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fromEnd) {
    for (let offset = bytes.length - 4; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  } else {
    for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  }
  throw new Error(`ZIP test fixture missing signature ${signature.toString(16)}`);
}

function mutateLocalName(bytes: Uint8Array, replacement: string): Uint8Array {
  const result = bytes.slice();
  const local = findZipSignature(result, 0x04034b50);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const nameLength = view.getUint16(local + 26, true);
  const replacementBytes = strToU8(replacement);
  if (replacementBytes.length !== nameLength) throw new Error("replacement name must be same size");
  result.set(replacementBytes, local + 30);
  return result;
}

function mutateLocalUint16(
  bytes: Uint8Array,
  fieldOffset: number,
  mutate: (value: number) => number,
): Uint8Array {
  const result = bytes.slice();
  const local = findZipSignature(result, 0x04034b50);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint16(local + fieldOffset, mutate(view.getUint16(local + fieldOffset, true)), true);
  return result;
}

function mutateLocalUint32(bytes: Uint8Array, fieldOffset: number): Uint8Array {
  const result = bytes.slice();
  const local = findZipSignature(result, 0x04034b50);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(local + fieldOffset, view.getUint32(local + fieldOffset, true) + 1, true);
  return result;
}

function markUnsupportedCompression(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const local = findZipSignature(result, 0x04034b50);
  const central = findZipSignature(result, 0x02014b50);
  view.setUint16(local + 8, 99, true);
  view.setUint16(central + 10, 99, true);
  return result;
}

function withDataDescriptor(
  bytes: Uint8Array,
  options: { corrupt?: boolean; wideSizes?: boolean } = {},
): Uint8Array {
  const centralBefore = findZipSignature(bytes, 0x02014b50);
  const eocdBefore = findZipSignature(bytes, 0x06054b50, true);
  const sourceView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const crc32 = sourceView.getUint32(centralBefore + 16, true);
  const compressedSize = sourceView.getUint32(centralBefore + 20, true);
  const uncompressedSize = sourceView.getUint32(centralBefore + 24, true);
  const descriptor = new Uint8Array(options.wideSizes ? 24 : 16);
  const descriptorView = new DataView(descriptor.buffer);
  descriptorView.setUint32(0, 0x08074b50, true);
  descriptorView.setUint32(4, crc32, true);
  if (options.wideSizes) {
    descriptorView.setBigUint64(
      8,
      BigInt(options.corrupt ? compressedSize + 1 : compressedSize),
      true,
    );
    descriptorView.setBigUint64(16, BigInt(uncompressedSize), true);
  } else {
    descriptorView.setUint32(8, options.corrupt ? compressedSize + 1 : compressedSize, true);
    descriptorView.setUint32(12, uncompressedSize, true);
  }

  const result = new Uint8Array(bytes.length + descriptor.length);
  result.set(bytes.subarray(0, centralBefore), 0);
  result.set(descriptor, centralBefore);
  result.set(bytes.subarray(centralBefore), centralBefore + descriptor.length);
  const view = new DataView(result.buffer);
  const local = findZipSignature(result, 0x04034b50);
  const central = centralBefore + descriptor.length;
  const eocd = eocdBefore + descriptor.length;
  view.setUint16(local + 6, view.getUint16(local + 6, true) | 0x0008, true);
  view.setUint32(local + 14, 0, true);
  view.setUint32(local + 18, 0, true);
  view.setUint32(local + 22, 0, true);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 0x0008, true);
  view.setUint32(eocd + 16, central, true);
  return result;
}

describe("Chestny ZNAK inventory import parser", () => {
  it("reads the physical filter row before the exact 35-column header", () => {
    const bytes = fixture("chz-introduced.csv");
    const result = parse(bytes);

    expect(result.filter).toEqual({
      status: "INTRODUCED",
      packagingType: "UNIT",
      includedGtin14: GTIN,
    });
    expect(result.rows).toEqual([
      {
        canonicalKm: `01${GTIN}21SYNTHETIC-001`,
        codeHash: "65e3d1b2487beb87a4d78a2c43413610b17e61aa4480e4c92b82aeb7c29e052e",
        gtin14: GTIN,
        serial: "SYNTHETIC-001",
        parentSscc: "046006820000000006",
        sourceStatus: "INTRODUCED",
        sourceState: "MOVING_BY_UD",
        sourceProductionDate: "2026-08-19",
      },
    ]);
    expect(result.emptyResult).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("preserves quoted comma, quote punctuation, and the GS crypto separator through canonicalization", () => {
    const rawKm = `01${GTIN}21SER,IAL"Q${GS}93tail,"punctuation"`;
    const result = parse(
      csvBytes("INTRODUCED", [dataRow("INTRODUCED", { rawKm })], { bom: true, newline: "\r\n" }),
    );

    expect(result.rows[0]!.canonicalKm).toBe(rawKm);
    expect(result.rows[0]!.serial).toBe('SER,IAL"Q');
    expect(result.rows[0]!.codeHash).toBe(
      kmHash({
        raw: rawKm,
        gtin14: GTIN,
        serial: 'SER,IAL"Q',
        ais: { "93": 'tail,"punctuation"' },
      }),
    );
  });

  it.each(INVENTORY_CHZ_STATUSES)("accepts a matching successful %s result", (status) => {
    const result = parse(csvBytes(status, [dataRow(status)]), { expectedStatus: status });
    expect(result.filter.status).toBe(status);
    expect(result.rows[0]!.sourceStatus).toBe(status);
  });

  it.each(["5: Коды маркировки не найдены", "5: Коды маркировки по критериям отбора не найдены"])(
    "accepts the approved zero-row marker: %s",
    (marker) => {
      const text = [
        csvCell(filter("APPLIED")),
        HEADER.map(csvCell).join(","),
        "errors",
        marker,
      ].join("\n");
      const result = parse(strToU8(text), { expectedStatus: "APPLIED" });
      expect(result.rows).toEqual([]);
      expect(result.emptyResult).toBe(true);
    },
  );

  it("accepts the committed synthetic empty-result fixture", () => {
    const result = parse(fixture("chz-empty-applied.csv"), { expectedStatus: "APPLIED" });
    expect(result.emptyResult).toBe(true);
  });

  it("rejects a near-match errors marker fail-closed", () => {
    const text = [
      csvCell(filter("APPLIED")),
      HEADER.map(csvCell).join(","),
      "errors",
      "5: Коды маркировки временно не найдены",
    ].join("\n");
    expectImportError(
      () => parse(strToU8(text), { expectedStatus: "APPLIED" }),
      "CHZ_EMPTY_RESULT_INVALID",
      4,
    );
  });

  it("reads a ZIP with exactly one non-directory CSV member", () => {
    const csv = csvBytes("INTRODUCED", [dataRow("INTRODUCED")]);
    const result = parse(zipSync({ "nested/status.csv": csv }), {
      filename: "status.zip",
      mimeType: MIME_ZIP,
    });
    expect(result.rows).toHaveLength(1);
  });

  it("rejects a ZIP whose sole non-directory member is not CSV", () => {
    const zip = zipSync({ "status.txt": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () => parse(zip, { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_MEMBER_TYPE",
    );
  });

  it("rejects an unsafe local ZIP name even when the central name is safe and same-length", () => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () =>
        parse(mutateLocalName(zip, "../bad.csv"), { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_TRAVERSAL",
    );
  });

  it.each([
    ["flags", (zip: Uint8Array) => mutateLocalUint16(zip, 6, (value) => value ^ 0x0800)],
    [
      "compression method",
      (zip: Uint8Array) => mutateLocalUint16(zip, 8, (value) => (value === 0 ? 8 : 0)),
    ],
    ["compressed size", (zip: Uint8Array) => mutateLocalUint32(zip, 18)],
    ["uncompressed size", (zip: Uint8Array) => mutateLocalUint32(zip, 22)],
  ] as const)("rejects a central/local ZIP %s mismatch", (_case, mutate) => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () => parse(mutate(zip), { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_INVALID",
    );
  });

  it("supports a valid ZIP data descriptor and rejects descriptor sizes that disagree with central metadata", () => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    const result = parse(withDataDescriptor(zip), { filename: "status.zip", mimeType: MIME_ZIP });
    expect(result.rows).toHaveLength(1);
    expectImportError(
      () =>
        parse(withDataDescriptor(zip, { corrupt: true }), {
          filename: "status.zip",
          mimeType: MIME_ZIP,
        }),
      "CHZ_ZIP_INVALID",
    );
  });

  it("supports a signed ZIP data descriptor with 64-bit sizes and rejects a mismatched size", () => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    const result = parse(withDataDescriptor(zip, { wideSizes: true }), {
      filename: "status.zip",
      mimeType: MIME_ZIP,
    });
    expect(result.rows).toHaveLength(1);
    expectImportError(
      () =>
        parse(withDataDescriptor(zip, { corrupt: true, wideSizes: true }), {
          filename: "status.zip",
          mimeType: MIME_ZIP,
        }),
      "CHZ_ZIP_INVALID",
    );
  });

  it("rejects a ZIP using an unsupported compression method", () => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () => parse(markUnsupportedCompression(zip), { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_UNSUPPORTED_COMPRESSION",
    );
  });

  it("rejects ZIP path traversal before extracting", () => {
    const zip = zipSync({ "../status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () => parse(zip, { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_TRAVERSAL",
    );
  });

  it("rejects ZIPs with multiple non-directory members", () => {
    const csv = csvBytes("INTRODUCED", [dataRow("INTRODUCED")]);
    const zip = zipSync({ "one.csv": csv, "two.csv": csv });
    expectImportError(
      () => parse(zip, { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_MEMBER_COUNT",
    );
  });

  it("rejects an encrypted ZIP from its general-purpose flag", () => {
    const zip = zipSync({ "status.csv": csvBytes("INTRODUCED", [dataRow("INTRODUCED")]) });
    expectImportError(
      () => parse(markZipEncrypted(zip), { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_ENCRYPTED",
    );
  });

  it("rejects a ZIP whose declared expansion exceeds the fixed limit", () => {
    const atLimit = zipSync({ "status.csv": new Uint8Array(16 * 1024 * 1024) });
    expectImportError(
      () => parse(atLimit, { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_CELL_TOO_LARGE",
      1,
    );
    const overLimit = zipSync({ "status.csv": new Uint8Array(16 * 1024 * 1024 + 1) });
    expectImportError(
      () => parse(overLimit, { filename: "status.zip", mimeType: MIME_ZIP }),
      "CHZ_ZIP_EXPANSION_LIMIT",
    );
  });

  it("reads shared-string and inline-string XLSX cells from the first visible worksheet", () => {
    const result = parse(xlsxBytes(), { filename: "status.xlsx", mimeType: MIME_XLSX });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      gtin14: GTIN,
      serial: "SYNTHETIC-XLSX",
      sourceState: "MOVING_BY_UD",
      sourceProductionDate: "2026-08-19",
    });
    expect(result.rows[0]!.canonicalKm).toContain(GS);
  });

  it("reconstructs a genuinely sparse XLSX data row from cell references", () => {
    const result = parse(xlsxBytes({ sparseDataRow: true }), {
      filename: "status.xlsx",
      mimeType: MIME_XLSX,
    });
    expect(result.rows[0]).toMatchObject({
      gtin14: GTIN,
      sourceStatus: "INTRODUCED",
      sourceState: "MOVING_BY_UD",
      sourceProductionDate: "2026-08-19",
    });
  });

  it.each(["missing-cache", "empty-v", "empty-is"] as const)(
    "rejects a formula-only XLSX cell with %s and a sanitized row number",
    (formulaCell) => {
      expectImportError(
        () => parse(xlsxBytes({ formulaCell }), { filename: "status.xlsx", mimeType: MIME_XLSX }),
        "CHZ_XLSX_FORMULA_ONLY",
        3,
      );
    },
  );

  it("rejects slot/filter, filter/GTIN, row/status, row/GTIN, and packaging mismatches", () => {
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED")]), { expectedStatus: "APPLIED" }),
      "CHZ_FILTER_STATUS_MISMATCH",
      1,
    );
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED")], { gtin: OTHER_GTIN })),
      "CHZ_FILTER_GTIN_MISMATCH",
      1,
    );
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("APPLIED")])),
      "CHZ_ROW_STATUS_MISMATCH",
      3,
    );
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED", { gtin: OTHER_GTIN })])),
      "CHZ_ROW_GTIN_MISMATCH",
      3,
    );
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED")], { packaging: "GROUP" })),
      "CHZ_FILTER_PACKAGING_MISMATCH",
      1,
    );
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED", { packaging: "GROUP" })])),
      "CHZ_ROW_PACKAGING_MISMATCH",
      3,
    );
  });

  it("rejects a KM GTIN mismatch when the row GTIN column remains correct", () => {
    expectImportError(
      () =>
        parse(
          csvBytes("INTRODUCED", [
            dataRow("INTRODUCED", { rawKm: `01${OTHER_GTIN}21SYNTHETIC-WRONG-KM-GTIN` }),
          ]),
        ),
      "CHZ_ROW_GTIN_MISMATCH",
      3,
    );
  });

  it("rejects an inconsistent data-row width at its physical row", () => {
    const shortRow = dataRow("INTRODUCED").slice(0, HEADER.length - 1);
    expectImportError(() => parse(csvBytes("INTRODUCED", [shortRow])), "CHZ_ROW_WIDTH", 3);
  });

  it("sanitizes KM errors instead of echoing the raw code", () => {
    const rawKm = "not-a-km-private-value";
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED", { rawKm })])),
      "CHZ_ROW_KM_INVALID",
      3,
      rawKm,
    );
  });

  it("enforces the domain KM-byte limit without echoing the oversized KM", () => {
    const rawKm = `01${GTIN}21${"X".repeat(1_025)}`;
    expectImportError(
      () => parse(csvBytes("INTRODUCED", [dataRow("INTRODUCED", { rawKm })])),
      "CHZ_ROW_KM_INVALID",
      3,
      rawKm,
    );
  });

  it("rejects oversized cells and impossible source production dates at the data row", () => {
    const oversized = dataRow("INTRODUCED");
    oversized[9] = "X".repeat(64 * 1024 + 1);
    expectImportError(() => parse(csvBytes("INTRODUCED", [oversized])), "CHZ_CELL_TOO_LARGE", 3);
    expectImportError(
      () =>
        parse(
          csvBytes("INTRODUCED", [
            dataRow("INTRODUCED", { productionDate: "2026-02-30T00:00:00Z" }),
          ]),
        ),
      "CHZ_ROW_PRODUCTION_DATE_INVALID",
      3,
    );
  });

  it("rejects an unsupported or ambiguous filename/MIME combination", () => {
    const csv = csvBytes("INTRODUCED", [dataRow("INTRODUCED")]);
    expectImportError(
      () => parse(csv, { filename: "status.bin", mimeType: "application/octet-stream" }),
      "CHZ_UNSUPPORTED_CONTAINER",
    );
    expectImportError(
      () => parse(csv, { filename: "status.zip", mimeType: MIME_CSV }),
      "CHZ_CONTAINER_MISMATCH",
    );
  });
});
