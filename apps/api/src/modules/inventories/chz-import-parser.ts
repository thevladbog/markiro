import { createHash } from "node:crypto";

import {
  canonicalizeKm,
  kmHash,
  normalizeToGtin14,
  parseScannedSscc,
  type InventoryChzStatus,
} from "@markiro/domain";

import { parseChzFilter, type ChzFilter } from "./chz-filter";
import {
  ChzImportError,
  readChzTabular,
  type ChzImportErrorCode,
  type ChzTabularRecord,
} from "./chz-tabular-reader";

export { ChzImportError } from "./chz-tabular-reader";
export type { ChzImportErrorCode } from "./chz-tabular-reader";

const CHZ_HEADER = [
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

const DISPENSER_HEADER = [
  "requestedCis",
  "gtin",
  "tnVedEaes",
  "tnVedEaesGroup",
  "maxRetailPrice",
  "parent",
  "producerInn",
  "ownerInn",
  "prVetDocument",
  "productName",
  "brand",
  "ownerName",
  "producerName",
  "introducedDate",
  "receiptDate",
  "status",
  "statusEx",
  "emissionType",
  "withdrawReason",
  "packageType",
  "productGroup",
  "applicationDate",
  "emissionDate",
  "expirationDate",
  "child",
  "setGtin",
  "setDescription",
  "productionDate",
  "aggregationType",
  "orderId",
  "turnoverType",
  "kpp",
  "fiasId",
  "declarationRegistrationNumbers",
  "permitDocs",
] as const;

const APPROVED_EMPTY_RESULT_MARKERS = new Set([
  "5: Коды маркировки не найдены",
  "5: Коды маркировки по критериям отбора не найдены",
]);

export interface ChzImportInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  expectedStatus: InventoryChzStatus;
  expectedGtin14: string;
}

export interface ChzImportRow {
  canonicalKm: string;
  codeHash: string;
  gtin14: string;
  serial: string;
  parentSscc: string | null;
  sourceStatus: InventoryChzStatus;
  sourceState: string | null;
  sourceProductionDate: string | null;
}

export interface ChzImportDiagnostic {
  code: ChzImportErrorCode;
  rowNumber?: number;
}

export interface ChzImportResult {
  filter: ChzFilter;
  rows: ChzImportRow[];
  emptyResult: boolean;
  diagnostics: ChzImportDiagnostic[];
  sha256: string;
}

function expectedGtin14(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeToGtin14(value);
  } catch {
    throw new ChzImportError("CHZ_EXPECTED_GTIN_INVALID");
  }
  if (normalized !== value) throw new ChzImportError("CHZ_EXPECTED_GTIN_INVALID");
  return normalized;
}

function assertHeader(record: ChzTabularRecord | undefined): void {
  if (record === undefined || record.rowNumber !== 2 || record.cells.length !== CHZ_HEADER.length) {
    throw new ChzImportError("CHZ_HEADER_MISMATCH", record?.rowNumber ?? 2);
  }
  const matchesCabinet = record.cells.every((cell, index) => cell === CHZ_HEADER[index]);
  const matchesDispenser = record.cells.every((cell, index) => cell === DISPENSER_HEADER[index]);
  if (!matchesCabinet && !matchesDispenser) {
    throw new ChzImportError("CHZ_HEADER_MISMATCH", 2);
  }
}

function parseSourceProductionDate(value: string, rowNumber: number): string | null {
  if (value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(value);
  if (match === null) throw new ChzImportError("CHZ_ROW_PRODUCTION_DATE_INVALID", rowNumber);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ChzImportError("CHZ_ROW_PRODUCTION_DATE_INVALID", rowNumber);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseDataRow(
  record: ChzTabularRecord,
  filter: ChzFilter,
  expectedGtin: string,
  padSparseXlsx: boolean,
): ChzImportRow {
  const cells = [...record.cells];
  if (padSparseXlsx && cells.length < CHZ_HEADER.length) {
    while (cells.length < CHZ_HEADER.length) cells.push("");
  }
  if (cells.length !== CHZ_HEADER.length) {
    throw new ChzImportError("CHZ_ROW_WIDTH", record.rowNumber);
  }
  if (cells[15] !== filter.status) {
    throw new ChzImportError("CHZ_ROW_STATUS_MISMATCH", record.rowNumber);
  }
  if (cells[19] !== "UNIT") {
    throw new ChzImportError("CHZ_ROW_PACKAGING_MISMATCH", record.rowNumber);
  }
  let rowGtin: string;
  try {
    rowGtin = normalizeToGtin14(cells[1]!);
  } catch {
    throw new ChzImportError("CHZ_ROW_GTIN_MISMATCH", record.rowNumber);
  }
  if (rowGtin !== expectedGtin || rowGtin !== filter.includedGtin14) {
    throw new ChzImportError("CHZ_ROW_GTIN_MISMATCH", record.rowNumber);
  }
  let km: ReturnType<typeof canonicalizeKm>;
  try {
    km = canonicalizeKm(cells[0]!);
  } catch {
    throw new ChzImportError("CHZ_ROW_KM_INVALID", record.rowNumber);
  }
  if (km.gtin14 !== expectedGtin) {
    throw new ChzImportError("CHZ_ROW_GTIN_MISMATCH", record.rowNumber);
  }
  const rawParent = cells[5]!;
  const parentSscc = rawParent === "" ? null : parseScannedSscc(rawParent);
  if (rawParent !== "" && parentSscc === null) {
    throw new ChzImportError("CHZ_ROW_PARENT_SSCC_INVALID", record.rowNumber);
  }
  return {
    canonicalKm: km.raw,
    codeHash: kmHash(km),
    gtin14: km.gtin14,
    serial: km.serial,
    parentSscc,
    sourceStatus: filter.status,
    sourceState: cells[16] === "" ? null : cells[16]!,
    sourceProductionDate: parseSourceProductionDate(cells[27]!, record.rowNumber),
  };
}

function isEmptyResult(records: readonly ChzTabularRecord[]): boolean {
  return records[2]?.cells.length === 1 && records[2]?.cells[0] === "errors";
}

export function parseChzImport(input: ChzImportInput): ChzImportResult {
  const expectedGtin = expectedGtin14(input.expectedGtin14);
  const document = readChzTabular(input);
  const filterRecord = document.records[0];
  if (
    filterRecord === undefined ||
    filterRecord.rowNumber !== 1 ||
    filterRecord.cells.length !== 1
  ) {
    throw new ChzImportError("CHZ_FILTER_INVALID", filterRecord?.rowNumber ?? 1);
  }
  const filter = parseChzFilter(filterRecord.cells[0]!);
  try {
    if (filter.status !== input.expectedStatus) {
      throw new ChzImportError("CHZ_FILTER_STATUS_MISMATCH", 1);
    }
    if (filter.includedGtin14 !== expectedGtin) {
      throw new ChzImportError("CHZ_FILTER_GTIN_MISMATCH", 1);
    }
    assertHeader(document.records[1]);

    if (isEmptyResult(document.records)) {
      const marker = document.records[3];
      if (
        document.records.length !== 4 ||
        marker === undefined ||
        marker.cells.length !== 1 ||
        !APPROVED_EMPTY_RESULT_MARKERS.has(marker.cells[0]!)
      ) {
        throw new ChzImportError("CHZ_EMPTY_RESULT_INVALID", marker?.rowNumber ?? 4);
      }
      return {
        filter,
        rows: [],
        emptyResult: true,
        diagnostics: [],
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
    }
    if (document.records.length === 2) {
      throw new ChzImportError("CHZ_EMPTY_RESULT_INVALID", 3);
    }
    const rows = document.records
      .slice(2)
      .map((record) =>
        parseDataRow(record, filter, expectedGtin, document.containerKind === "xlsx"),
      );
    return {
      filter,
      rows,
      emptyResult: false,
      diagnostics: [],
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ChzImportError) {
      throw error.withFilterFacts({
        parsedStatus: filter.status,
        includedGtin14: filter.includedGtin14,
      });
    }
    throw error;
  }
}
