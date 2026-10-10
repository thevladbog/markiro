import {
  getPalletExportFormat,
  getShiftExportFormat,
  renderPalletAggregationExport,
  renderShiftExport,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "@markiro/domain";

import type { ShiftExportRows } from "../../host/protocol.js";
import {
  palletExportSnapshot,
  shiftExportSnapshot,
  type ExportSourceRefusal,
} from "./export-source.js";

/**
 * What an export in the office can end with: the cloud's
 * `SHIFT_EXPORT_SAFE_ERROR_CODES` (`shift-export-runner.service.ts`) less
 * the queue's, the storage's and `SHIFT_DATE_MISSING`.
 */
export type ExportFailure =
  | ExportSourceRefusal
  | "FORMAT_NOT_FOUND"
  | "INVALID_ORG_INN"
  | "INVALID_LINE_LIMIT"
  | "BOX_EXCEEDS_LINE_LIMIT"
  | "PALLET_EXCEEDS_LINE_LIMIT"
  | "INVALID_BOX_SSCC"
  | "INVALID_CIS"
  | "GENERATION_FAILED";

/**
 * One export: the format, the line limit (`null`: one part), the pallet of a
 * pallet's export (`null`: the shift's), the base `document_id` its files
 * carry (a new UUID each time, as the cloud's export row id) and the instant
 * it is formed (`file_date_time`, canonical ISO).
 */
export interface ExportRun {
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  palletId: string | null;
  documentId: string;
  formedAt: string;
}

export type ExportResult =
  | {
      ok: true;
      parts: ShiftExportPart[];
      openPalletSuppressedBoxCount: number;
      disassembledPalletCount: number;
    }
  | { ok: false; failure: ExportFailure };

/** The domain's codes the cloud's runner records as they are (`safeDomainErrorCode`). */
const SAFE_DOMAIN_CODES = new Set<string>([
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "PALLET_EXCEEDS_LINE_LIMIT",
  "INVALID_BOX_SSCC",
  "INVALID_CIS",
  "ORG_INN_MISSING",
  "ORG_NAME_MISSING",
  "INVALID_ORG_INN",
]);

function isFailure(code: string): code is ExportFailure {
  return SAFE_DOMAIN_CODES.has(code);
}

/**
 * The cloud runner's `renderForShift` and `renderForPallet` over the host's
 * rows: the format is looked up first, then the source, then the domain
 * renders. A domain refusal the runner records as it is stays as it is; any
 * other failure — `EMPTY_SOURCE`, bad metadata, a malformed date — is
 * `GENERATION_FAILED`, where the cloud ends after its retries.
 */
export function runExport(rows: ShiftExportRows, run: ExportRun): ExportResult {
  try {
    return run.palletId === null
      ? renderForShift(rows, run)
      : renderForPallet(rows, run, run.palletId);
  } catch (error) {
    if (error instanceof ShiftExportDomainError && isFailure(error.code)) {
      return { ok: false, failure: error.code };
    }
    return { ok: false, failure: "GENERATION_FAILED" };
  }
}

function renderForShift(rows: ShiftExportRows, run: ExportRun): ExportResult {
  const format = getShiftExportFormat(run.formatId, run.formatVersion);
  const snapshot = shiftExportSnapshot(rows, format, run.formedAt);
  if (!snapshot.ok) return { ok: false, failure: snapshot.refusal };
  const parts = renderShiftExport({
    formatId: format.id,
    formatVersion: format.version,
    productName: snapshot.value.productName,
    shiftDate: snapshot.value.shiftDate,
    maxLines: run.maxLines,
    source: snapshot.value.source,
    organizationInn: snapshot.value.organizationInn,
    organizationName: snapshot.value.organizationName,
    document: {
      documentId: run.documentId,
      documentNumber: snapshot.value.shiftNumber,
      fileDateTime: run.formedAt,
      operationDateTime: snapshot.value.operationDateTime,
    },
  });
  return {
    ok: true,
    parts,
    openPalletSuppressedBoxCount: snapshot.value.openPalletSuppressedBoxCount,
    disassembledPalletCount: snapshot.value.disassembledPalletCount,
  };
}

function renderForPallet(rows: ShiftExportRows, run: ExportRun, palletId: string): ExportResult {
  const format = getPalletExportFormat(run.formatId, run.formatVersion);
  const snapshot = palletExportSnapshot(rows, palletId);
  if (!snapshot.ok) return { ok: false, failure: snapshot.refusal };
  const part = renderPalletAggregationExport({
    formatId: format.id,
    formatVersion: format.version,
    organizationInn: snapshot.value.organizationInn,
    organizationName: snapshot.value.organizationName,
    productName: snapshot.value.productName,
    closedDate: snapshot.value.closedDate,
    documentId: run.documentId,
    fileDateTime: run.formedAt,
    operationDateTime: snapshot.value.operationDateTime,
    pallet: snapshot.value.pallet,
  });
  return { ok: true, parts: [part], openPalletSuppressedBoxCount: 0, disassembledPalletCount: 0 };
}
