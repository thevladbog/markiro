import { createHash } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  type ExportFinding,
} from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { assertUsRequestReportModel } from "./us-request-package-inputs";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
  type UsRequestFileDescriptor,
  type UsRequestMissingFile,
  type UsRequestPackageByteFile,
  type UsRequestPackageInputs,
  type UsRequestReportModel,
} from "./us-request-package-types";
import { parseUsRequestFrozenRun } from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";
import { usRequestTenantOriginSchema } from "./us-request-tenant-origin";

export interface UsRequestManifestV1 extends Pick<
  UsRequestReportModel,
  | "identity"
  | "timing"
  | "tenantOrigin"
  | "stamps"
  | "selectionSummary"
  | "findingsSummary"
  | "renderFindings"
  | "plan"
  | "digests"
  | "warningAcknowledgement"
> {
  schemaVersion: 1;
  packageVersion: typeof US_REQUEST_PACKAGE_VERSION;
  reportRendererVersion: typeof US_REQUEST_REPORT_PDF_VERSION;
  files: readonly UsRequestFileDescriptor[];
  missingFiles: readonly UsRequestMissingFile[];
}
export interface UsRequestManifestBundle {
  model: UsRequestManifestV1;
  payloadFiles: readonly UsRequestPackageByteFile[];
  manifest: UsRequestPackageByteFile<"manifest.json">;
  sums: UsRequestPackageByteFile<"SHA256SUMS">;
}

const invalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_manifest_invalid" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_package_size_limit" });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const integer = z.number().refine(Number.isSafeInteger).nonnegative();
const positive = integer.refine((value) => value > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && new Date(time).toISOString() === value;
});
const counts = z
  .object({ error: integer, warning: integer, info: integer })
  .strict()
  .refine((value) => Number.isSafeInteger(value.error + value.warning + value.info));
const metadata = usExportInputV1Schema.shape.metadata.shape;
const mediaTypes = {
  "records.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "plan.pdf": "application/pdf",
  "validation.json": "application/json",
  "request-report.pdf": "application/pdf",
} as const;
const fileLimits = {
  "records.xlsx": limits.workbook,
  "plan.pdf": limits.plan,
  "validation.json": limits.validation,
  "request-report.pdf": limits.report,
} as const;
const descriptorSchema = z
  .object({
    name: z.enum(["records.xlsx", "plan.pdf", "validation.json", "request-report.pdf"]),
    mediaType: z.string(),
    byteSize: positive,
    sha256: digest,
  })
  .strict();
const byteFileSchema = descriptorSchema.extend({ bytes: z.instanceof(Buffer) }).strict();
const missingFileSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("records.xlsx"),
      code: z.enum(["empty_selection", "workbook_unrepresentable", "workbook_writer_failed"]),
    })
    .strict(),
  z.object({ name: z.literal("plan.pdf"), code: z.literal("plan_absent") }).strict(),
]);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageVersion: z.literal(US_REQUEST_PACKAGE_VERSION),
    reportRendererVersion: z.literal(US_REQUEST_REPORT_PDF_VERSION),
    identity: z
      .object({
        tenantId: usExportInputV1Schema.shape.tenantId,
        requestId: platformUuidSchema,
        requestRevision: positive,
        runId: platformUuidSchema,
        runRevision: positive,
        mode: z.enum(["export_ready", "available_records_incomplete"]),
        preparedBy: z.string().min(1),
      })
      .strict(),
    timing: z
      .object({
        schemaVersion: z.literal(1),
        workerStartedAt: instant.nullable(),
        reportDataPreparedAt: instant,
        preparationStartedAt: instant,
        elapsedToReportDataPreparationMs: integer,
      })
      .strict(),
    tenantOrigin: usRequestTenantOriginSchema,
    stamps: z
      .object({
        profile: metadata.profile,
        timeZone: metadata.timeZone,
        baselineId: metadata.baselineId,
        registryId: metadata.registryId,
        registryVersion: metadata.registryVersion,
        registryHash: metadata.registryHash,
        build: metadata.build,
      })
      .strict(),
    selectionSummary: z
      .object({
        capturedRevisionCount: integer.max(500),
        workbookEventCount: integer.max(500),
        byType: z
          .object({ receiving: integer, transformation: integer, shipping: integer })
          .strict(),
        byLifecycle: z
          .object({
            current_finalized: integer,
            historical_finalized: integer,
            draft: integer,
            void: integer,
          })
          .strict(),
      })
      .strict(),
    findingsSummary: z.object({ validation: counts, render: counts }).strict(),
    renderFindings: usExportInputV1Schema.shape.findings,
    warningAcknowledgement: z
      .object({
        digest,
        reason: z.string().min(3).max(2000),
        actorId: z.string().min(1),
        acknowledgedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    plan: z.object({ id: platformUuidSchema, pdfSha256: digest }).strict().nullable(),
    digests: z.object({ scopedContentDigest: digest, inputDigest: digest.nullable() }).strict(),
    files: z.array(descriptorSchema).min(2).max(4),
    missingFiles: z.array(missingFileSchema).max(2),
  })
  .strict();

function bounded(size: number, limit: number): void {
  if (size > limit) throw sizeLimit();
}
function summarize(findings: readonly ExportFinding[]) {
  const result = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) result[finding.severity] += 1;
  return result;
}
function supportedText(value: unknown): boolean {
  if (typeof value === "string")
    return !/[\p{Cc}\p{Cs}]/u.test(value.replaceAll("\n", "").replaceAll("\r", ""));
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(supportedText);
}
function sanitized(error: unknown): never {
  if (
    error instanceof ServiceUnavailableException &&
    equal(error.getResponse(), { code: "us_request_package_size_limit" })
  )
    throw sizeLimit();
  throw invalid();
}

/** Strict shape and internal consistency only; checksums do not authenticate source authority. */
export function parseUsRequestManifest(value: unknown): UsRequestManifestV1 {
  try {
    const serialized = stableStringify(value);
    bounded(Buffer.byteLength(serialized, "utf8"), limits.manifest);
    const m = manifestSchema.parse(value);
    if (!equal(m, value) || !supportedText(m)) throw invalid();
    const summary = m.selectionSummary;
    const names = m.files.map((file) => file.name);
    const missing = m.missingFiles.map((file) => file.name);
    const workbook = m.files.find((file) => file.name === "records.xlsx");
    const plan = m.files.find((file) => file.name === "plan.pdf");
    const workbookMissing = m.missingFiles.find((file) => file.name === "records.xlsx");
    const start = Date.parse(m.timing.preparationStartedAt);
    const end = Date.parse(m.timing.reportDataPreparedAt);
    const worker = m.timing.workerStartedAt === null ? null : Date.parse(m.timing.workerStartedAt);
    const duration = end - start;
    if (
      !Number.isSafeInteger(duration) ||
      duration < 0 ||
      duration !== m.timing.elapsedToReportDataPreparationMs ||
      (worker !== null && (worker < start || worker > end)) ||
      Object.values(summary.byType).reduce((a, b) => a + b, 0) !== summary.capturedRevisionCount ||
      Object.values(summary.byLifecycle).reduce((a, b) => a + b, 0) !==
        summary.capturedRevisionCount ||
      summary.workbookEventCount > summary.capturedRevisionCount ||
      !equal(summarize(m.renderFindings), m.findingsSummary.render) ||
      (m.tenantOrigin.result === "trusted_synthetic" &&
        m.tenantOrigin.trustedSeed.seedId !== m.identity.tenantId) ||
      (m.warningAcknowledgement !== null &&
        m.warningAcknowledgement.digest !== m.digests.scopedContentDigest) ||
      new Set(names).size !== names.length ||
      new Set(missing).size !== missing.length ||
      !equal(names, [
        ...(workbook ? ["records.xlsx"] : []),
        ...(plan ? ["plan.pdf"] : []),
        "validation.json",
        "request-report.pdf",
      ]) ||
      !equal(missing, [...(workbook ? [] : ["records.xlsx"]), ...(plan ? [] : ["plan.pdf"])]) ||
      (m.plan === null) !== (plan === undefined) ||
      (plan && plan.sha256 !== m.plan?.pdfSha256) ||
      (summary.workbookEventCount === 0) !== (m.digests.inputDigest === null) ||
      (workbookMissing?.code === "empty_selection") !== (summary.workbookEventCount === 0) ||
      (m.identity.mode === "available_records_incomplete" &&
        summary.workbookEventCount !== summary.capturedRevisionCount) ||
      (m.identity.mode === "export_ready" &&
        (!workbook ||
          !plan ||
          summary.workbookEventCount === 0 ||
          summary.workbookEventCount > summary.byLifecycle.current_finalized ||
          m.findingsSummary.render.error !== 0))
    )
      throw invalid();
    for (const file of m.files) {
      if (file.mediaType !== mediaTypes[file.name]) throw invalid();
      bounded(file.byteSize, fileLimits[file.name]);
    }
    return m;
  } catch (error) {
    return sanitized(error);
  }
}

function copyFile(value: unknown) {
  const file = byteFileSchema.parse(value);
  if (file.mediaType !== mediaTypes[file.name] || file.byteSize !== file.bytes.length)
    throw invalid();
  bounded(file.bytes.length, fileLimits[file.name]);
  const bytes = Buffer.from(file.bytes);
  if (hash(bytes) !== file.sha256) throw invalid();
  return { ...file, bytes };
}

function checkFrozenMetadata(model: UsRequestReportModel, validationBytes: Buffer): void {
  const frozen = parseUsRequestFrozenRun(JSON.parse(validationBytes.toString("utf8")));
  if (
    !frozen ||
    frozen.schemaVersion !== 2 ||
    !validationBytes.equals(Buffer.from(stableStringify(frozen), "utf8"))
  )
    throw invalid();
  const snapshot = frozen.validationSnapshot;
  const byType = { receiving: 0, transformation: 0, shipping: 0 };
  const byLifecycle = { current_finalized: 0, historical_finalized: 0, draft: 0, void: 0 };
  for (const source of snapshot.sources) {
    byType[source.type] += 1;
    byLifecycle[source.lifecycle] += 1;
  }
  if (
    snapshot.tenantId !== model.identity.tenantId ||
    snapshot.request.id !== model.identity.requestId ||
    snapshot.request.revision !== model.identity.requestRevision ||
    frozen.mode !== model.identity.mode ||
    frozen.preparedBy !== model.identity.preparedBy ||
    frozen.generatedAt !== model.timing.preparationStartedAt ||
    !equal(snapshot.request, model.request) ||
    !equal(snapshot.selection.scope, model.scope) ||
    !equal(snapshot.tenantOrigin, model.tenantOrigin) ||
    !equal(snapshot.plan, model.plan) ||
    !equal(frozen.warningAcknowledgement, model.warningAcknowledgement) ||
    !equal(model.stamps, {
      profile: snapshot.profile,
      timeZone: snapshot.timeZone,
      baselineId: snapshot.baselineId,
      registryId: snapshot.registryId,
      registryVersion: snapshot.registryVersion,
      registryHash: snapshot.registryHash,
      build: snapshot.build,
    }) ||
    !equal(model.selectionSummary, {
      capturedRevisionCount: snapshot.sources.length,
      workbookEventCount: frozen.exportInput?.events.length ?? 0,
      byType,
      byLifecycle,
    }) ||
    !equal(summarize(snapshot.findings), model.findingsSummary.validation) ||
    canonicalExportDigest(snapshot) !== model.digests.scopedContentDigest ||
    (frozen.exportInput === null ? null : canonicalExportDigest(frozen.exportInput)) !==
      model.digests.inputDigest ||
    (model.identity.mode === "export_ready" &&
      frozen.exportInput?.findings.some((finding) => finding.severity === "error"))
  )
    throw invalid();
}

function generatedFile<N extends "manifest.json" | "SHA256SUMS">(
  name: N,
  mediaType: string,
  text: string,
  limit: number,
): UsRequestPackageByteFile<N> {
  bounded(Buffer.byteLength(text, "utf8"), limit);
  const bytes = Buffer.from(text, "utf8");
  bounded(bytes.length, limit);
  return { name, mediaType, byteSize: bytes.length, sha256: hash(bytes), bytes };
}

/** Already-bound internal inputs and trusted renderer output; grants no authorization.
 * Run ID/revision and PDF content authority remain the upstream caller's responsibility. */
export function buildUsRequestManifest(
  inputs: UsRequestPackageInputs,
  report: UsRequestPackageByteFile<"request-report.pdf">,
): UsRequestManifestBundle {
  try {
    const parsed = z
      .object({ model: z.unknown(), preReportFiles: z.array(byteFileSchema).max(3) })
      .strict()
      .parse(inputs);
    const inputModel = inputs.model;
    if (parsed.model !== inputModel) throw invalid();
    assertUsRequestReportModel(inputModel);
    const m = structuredClone(inputModel);
    const payloadFiles = parsed.preReportFiles.map(copyFile);
    const pdf = copyFile(report);
    if (pdf.name !== "request-report.pdf") throw invalid();
    if (
      !equal(
        payloadFiles.map(({ bytes, ...descriptor }) => {
          void bytes;
          return descriptor;
        }),
        m.preReportFiles,
      )
    )
      throw invalid();
    const validation = payloadFiles.find((file) => file.name === "validation.json");
    if (!validation) throw invalid();
    checkFrozenMetadata(m, validation.bytes);
    payloadFiles.push(pdf);
    const manifestModel = parseUsRequestManifest({
      schemaVersion: 1,
      packageVersion: US_REQUEST_PACKAGE_VERSION,
      reportRendererVersion: US_REQUEST_REPORT_PDF_VERSION,
      identity: m.identity,
      timing: m.timing,
      tenantOrigin: m.tenantOrigin,
      stamps: m.stamps,
      selectionSummary: m.selectionSummary,
      findingsSummary: m.findingsSummary,
      renderFindings: m.renderFindings,
      plan: m.plan,
      digests: m.digests,
      warningAcknowledgement: m.warningAcknowledgement,
      missingFiles: m.missingFiles,
      files: payloadFiles.map(({ bytes, ...descriptor }) => {
        void bytes;
        return descriptor;
      }),
    });
    const manifestFile = generatedFile(
      "manifest.json",
      "application/json",
      stableStringify(manifestModel),
      limits.manifest,
    );
    const sumsText = [...payloadFiles, manifestFile]
      .map((file) => `${file.sha256}  ${file.name}\n`)
      .join("");
    const sums = generatedFile("SHA256SUMS", "text/plain", sumsText, limits.sums);
    return { model: manifestModel, payloadFiles, manifest: manifestFile, sums };
  } catch (error) {
    return sanitized(error);
  }
}
