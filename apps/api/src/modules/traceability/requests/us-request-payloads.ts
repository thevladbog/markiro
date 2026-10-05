import { createHash } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ExportFinding } from "@markiro/platform-contracts";
import { renderUsExportCore, type UsExportCoreResult } from "../export/adapter";
import { verifyUsRequestRunEvidence, type UsTraceExportRunRow } from "./us-request-run-evidence";
import { stableStringify, US_REQUEST_SNAPSHOT_LIMIT } from "./us-request-snapshot";

export interface UsRequestBytePayload {
  readonly name: "validation.json" | "records.xlsx";
  readonly contentType:
    "application/json" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteSize: number;
}

export type UsRequestMissingWorkbook =
  | { readonly code: "empty_selection" }
  | { readonly code: "workbook_unrepresentable" }
  | { readonly code: "workbook_writer_failed" };

export interface UsRequestPayloadResult {
  readonly runId: string;
  readonly revision: number;
  readonly mode: "export_ready" | "available_records_incomplete";
  readonly scopedContentDigest: string;
  readonly inputDigest: string | null;
  readonly validation: UsRequestBytePayload;
  readonly workbook: UsRequestBytePayload | null;
  readonly missingWorkbook: UsRequestMissingWorkbook | null;
  readonly renderFindings: readonly ExportFinding[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const technical = () =>
  new ServiceUnavailableException({ code: "us_request_payload_evidence_mismatch" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_payload_size_limit" });
const unavailable = () =>
  new ServiceUnavailableException({ code: "us_request_payload_workbook_unavailable" });

/** Internal two-payload composition only. The caller supplies a trusted tenant;
 * verification is not authorization and this result is not a published package. */
export async function renderUsRequestPayloads(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): Promise<UsRequestPayloadResult> {
  const frozen = verifyUsRequestRunEvidence(run, expectedTenantId);
  const validationBytes = Buffer.from(stableStringify(frozen), "utf8");
  if (validationBytes.length > US_REQUEST_SNAPSHOT_LIMIT) throw sizeLimit();
  const base = {
    runId: run.id,
    revision: run.revision,
    mode: frozen.mode,
    scopedContentDigest: run.scopedContentDigest,
    inputDigest: run.inputDigest,
    validation: {
      name: "validation.json" as const,
      contentType: "application/json" as const,
      bytes: validationBytes,
      sha256: sha256(validationBytes),
      byteSize: validationBytes.length,
    },
  };
  if (frozen.exportInput === null) {
    return {
      ...base,
      workbook: null,
      missingWorkbook: { code: "empty_selection" },
      renderFindings: [],
    };
  }
  let rendered: UsExportCoreResult;
  try {
    rendered = await renderUsExportCore(frozen.exportInput);
  } catch {
    throw new ServiceUnavailableException({ code: "us_request_payload_render_failed" });
  }
  if (
    rendered.inputDigest !== run.inputDigest ||
    rendered.registryVersion !== run.registryVersion ||
    rendered.registryHash !== run.registryHash
  )
    throw technical();
  if (rendered.workbook === null) {
    if (rendered.workbookSha256 !== null || rendered.failure === null) throw technical();
    const code = rendered.failure?.code;
    const missingWorkbook: UsRequestMissingWorkbook =
      code === "CELL_LIMIT_EXCEEDED" || code === "CELL_VALUE_UNREPRESENTABLE"
        ? { code: "workbook_unrepresentable" }
        : code === "XLSX_RENDER_FAILED"
          ? { code: "workbook_writer_failed" }
          : (() => {
              throw technical();
            })();
    if (frozen.mode === "export_ready") throw unavailable();
    return { ...base, workbook: null, missingWorkbook, renderFindings: rendered.findings };
  }
  if (rendered.failure !== null || !(rendered.workbook instanceof Uint8Array)) throw technical();
  if (rendered.workbook.byteLength === 0) throw technical();
  if (rendered.workbook.byteLength > US_REQUEST_SNAPSHOT_LIMIT) throw sizeLimit();
  const bytes = Buffer.from(rendered.workbook);
  const hash = sha256(bytes);
  if (hash !== rendered.workbookSha256) throw technical();
  if (frozen.mode === "export_ready" && rendered.findings.some((f) => f.severity === "error"))
    throw unavailable();
  return {
    ...base,
    workbook: {
      name: "records.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes,
      sha256: hash,
      byteSize: bytes.length,
    },
    missingWorkbook: null,
    renderFindings: rendered.findings,
  };
}
