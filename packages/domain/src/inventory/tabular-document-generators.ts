import { z } from "zod";

import {
  createUtf8ByteComparator,
  encodeLfText,
  encodeSemicolonCsv,
} from "../document-text-encoding.js";
import { DomainError } from "../errors.js";
import { formatSsccWithAi } from "../gs1/sscc.js";
import {
  InventoryDocumentGenerationError,
  inventoryDocumentFilenamePrefix,
  type InventoryDocumentGeneratedPart,
  type InventoryDocumentGenerationMetadata,
  type InventoryDocumentGenerationSource,
} from "./document-generators.js";
import { selectEligibleInventoryFinalBoxes } from "./document-selection.js";

const CSV_MIME_TYPE = "text/csv; charset=utf-8" as const;
const TXT_MIME_TYPE = "text/plain; charset=utf-8" as const;
const civilDateSchema = z.iso.date();

export function generateInventoryWriteOffTxt(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const codes = writeOffCodes(source);
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-write-off.txt`,
      TXT_MIME_TYPE,
      encodeLfText(codes),
      codes.length,
      codes.length,
      0,
    ),
  ];
}

export function generateInventoryWriteOffCsv(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const codes = writeOffCodes(source);
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-write-off.csv`,
      CSV_MIME_TYPE,
      encodeSemicolonCsv(
        ["code"],
        codes.map((code) => [code]),
      ),
      1 + codes.length,
      codes.length,
      0,
    ),
  ];
}

export function generateInventoryCurrentStockCsv(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const codes = verifiedCodes(source);
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-current-stock.csv`,
      CSV_MIME_TYPE,
      encodeSemicolonCsv(
        ["code"],
        codes.map((code) => [code]),
      ),
      1 + codes.length,
      codes.length,
      0,
    ),
  ];
}

export function generateInventoryFinalBoxContentsCsv(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const boxes = selectEligibleInventoryFinalBoxes(source);
  const rows = boxes.flatMap((box) =>
    box.codes.map((code) => [formatOutputSscc(box.sscc), code.canonicalRaw]),
  );
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-final-box-contents.csv`,
      CSV_MIME_TYPE,
      encodeSemicolonCsv(["box_sscc", "code"], rows),
      1 + rows.length,
      rows.length,
      boxes.length,
    ),
  ];
}

export function generateInventoryFinalBoxesTxt(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const boxes = selectEligibleInventoryFinalBoxes(source);
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-final-boxes.txt`,
      TXT_MIME_TYPE,
      encodeLfText(boxes.map((box) => formatOutputSscc(box.sscc))),
      boxes.length,
      0,
      boxes.length,
    ),
  ];
}

export function generateInventoryBalancesByProductionDateCsv(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  const counts = new Map<string, { codeCount: number; boxCount: number }>();
  for (const code of verifiedEntries(source)) {
    const date = code.observedProductionDate;
    if (date === null || !civilDateSchema.safeParse(date).success) {
      throw new InventoryDocumentGenerationError("VERIFIED_PRODUCTION_DATE_MISSING");
    }
    const entry = counts.get(date) ?? { codeCount: 0, boxCount: 0 };
    entry.codeCount += 1;
    counts.set(date, entry);
  }

  for (const box of selectEligibleInventoryFinalBoxes(source)) {
    const entry = counts.get(box.productionDate) ?? { codeCount: 0, boxCount: 0 };
    entry.boxCount += 1;
    counts.set(box.productionDate, entry);
  }

  const rows = [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([date, value]) => [date, String(value.codeCount), String(value.boxCount)]);
  const codeCount = [...counts.values()].reduce((sum, value) => sum + value.codeCount, 0);
  const boxCount = [...counts.values()].reduce((sum, value) => sum + value.boxCount, 0);
  return [
    generatedPart(
      `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-balances-by-production-date.csv`,
      CSV_MIME_TYPE,
      encodeSemicolonCsv(["production_date", "code_count", "box_count"], rows),
      1 + rows.length,
      codeCount,
      boxCount,
    ),
  ];
}

function writeOffCodes(source: InventoryDocumentGenerationSource): string[] {
  const protectedHashes = new Set(source.protected.map((code) => code.codeHash));
  return source.writeOffCandidates
    .filter((code) => !protectedHashes.has(code.codeHash))
    .map((code) => code.canonicalRaw)
    .sort(createUtf8ByteComparator((code) => code));
}

function verifiedEntries(source: InventoryDocumentGenerationSource) {
  const protectedHashes = new Set(source.protected.map((code) => code.codeHash));
  return source.verified.filter((code) => !protectedHashes.has(code.codeHash));
}

function verifiedCodes(source: InventoryDocumentGenerationSource): string[] {
  return verifiedEntries(source)
    .map((code) => code.canonicalRaw)
    .sort(createUtf8ByteComparator((code) => code));
}

function formatOutputSscc(sscc: string): string {
  try {
    return formatSsccWithAi(sscc);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new InventoryDocumentGenerationError("INVALID_SSCC");
    }
    throw error;
  }
}

function generatedPart(
  filename: string,
  mimeType: InventoryDocumentGeneratedPart["mimeType"],
  bytes: Uint8Array,
  rowCount: number,
  codeCount: number,
  boxCount: number,
): InventoryDocumentGeneratedPart {
  return { partNumber: 1, filename, mimeType, bytes, rowCount, codeCount, boxCount };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
