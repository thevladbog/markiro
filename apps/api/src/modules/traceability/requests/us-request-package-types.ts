import type { ExportFinding, ExportSourceRecord } from "@markiro/platform-contracts";
import type { UsRequestMissingWorkbook, UsRequestPayloadResult } from "./us-request-payloads";
import type { UsRequestFrozenRunV2 } from "./us-request-run-evidence";
import type { UsRequestSnapshotV2 } from "./us-request-snapshot";

export const US_REQUEST_PACKAGE_VERSION = "us-request-package-v1";
export const US_REQUEST_REPORT_PDF_VERSION = "us-request-report-pdf-v1";
export const US_REQUEST_PACKAGE_LIMITS = {
  validation: 16 * 1024 * 1024,
  workbook: 16 * 1024 * 1024,
  plan: 8_000_000,
  reportModel: 1024 * 1024,
  report: 4 * 1024 * 1024,
  manifest: 1024 * 1024,
  sums: 16 * 1024,
  entriesTotal: 48 * 1024 * 1024,
  zip: 64 * 1024 * 1024,
  entries: 6,
} as const;
export type UsRequestPackageName =
  | "records.xlsx"
  | "plan.pdf"
  | "validation.json"
  | "request-report.pdf"
  | "manifest.json"
  | "SHA256SUMS"
  | "package.zip";
export interface UsRequestFileDescriptor<N extends UsRequestPackageName = UsRequestPackageName> {
  name: N;
  mediaType: string;
  byteSize: number;
  sha256: string;
}
export interface UsRequestPackageByteFile<
  N extends UsRequestPackageName = UsRequestPackageName,
> extends UsRequestFileDescriptor<N> {
  bytes: Buffer;
}
export type UsRequestMissingFile =
  | { name: "records.xlsx"; code: UsRequestMissingWorkbook["code"] }
  | { name: "plan.pdf"; code: "plan_absent" };
export interface UsRequestReportContext {
  schemaVersion: 1;
  workerStartedAt: string | null;
  reportDataPreparedAt: string;
}
export interface UsRequestReportModel {
  schemaVersion: 1;
  identity: {
    tenantId: string;
    requestId: string;
    requestRevision: number;
    runId: string;
    runRevision: number;
    mode: UsRequestPayloadResult["mode"];
    preparedBy: string;
  };
  request: UsRequestFrozenRunV2["validationSnapshot"]["request"];
  scope: UsRequestFrozenRunV2["validationSnapshot"]["selection"]["scope"];
  timing: UsRequestReportContext & {
    preparationStartedAt: string;
    elapsedToReportDataPreparationMs: number;
  };
  tenantOrigin: UsRequestFrozenRunV2["validationSnapshot"]["tenantOrigin"];
  stamps: Pick<
    UsRequestSnapshotV2,
    | "profile"
    | "timeZone"
    | "baselineId"
    | "registryId"
    | "registryVersion"
    | "registryHash"
    | "build"
  >;
  selectionSummary: {
    capturedRevisionCount: number;
    workbookEventCount: number;
    byType: Record<ExportSourceRecord["type"], number>;
    byLifecycle: Record<ExportSourceRecord["lifecycle"], number>;
  };
  findingsSummary: {
    validation: Record<ExportFinding["severity"], number>;
    render: Record<ExportFinding["severity"], number>;
  };
  renderFindings: readonly ExportFinding[];
  warningAcknowledgement: UsRequestFrozenRunV2["warningAcknowledgement"];
  plan: UsRequestFrozenRunV2["validationSnapshot"]["plan"];
  digests: { scopedContentDigest: string; inputDigest: string | null };
  preReportFiles: readonly UsRequestFileDescriptor[];
  missingFiles: readonly UsRequestMissingFile[];
}
export interface UsRequestPackageInputs {
  model: UsRequestReportModel;
  preReportFiles: readonly UsRequestPackageByteFile[];
}
