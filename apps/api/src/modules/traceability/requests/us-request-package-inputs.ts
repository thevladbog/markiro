import { createHash } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  usTraceRequestCreateBodySchema,
  usTraceRequestScopeV1Schema,
  type ExportFinding,
} from "@markiro/platform-contracts";
import { z } from "zod";
import {
  requireUsRequestPackageEvidence,
  type UsTraceExportRunRow,
} from "./us-request-run-evidence";
import type { UsRequestPayloadResult } from "./us-request-payloads";
import type { UsRequestPinnedPlanResult } from "./us-request-plan-reader";
import { stableStringify } from "./us-request-snapshot";
import { usRequestTenantOriginSchema } from "./us-request-tenant-origin";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  type UsRequestFileDescriptor,
  type UsRequestMissingFile,
  type UsRequestPackageByteFile,
  type UsRequestPackageInputs,
  type UsRequestReportContext,
  type UsRequestReportModel,
} from "./us-request-package-types";

const inputsInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_inputs_invalid" });
const contextInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_context_invalid" });
const modelInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_model_invalid" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_package_size_limit" });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().refine(Number.isSafeInteger).nonnegative();
const positive = integer.refine((value) => value > 0);
const mode = z.enum(["export_ready", "available_records_incomplete"]);
const instant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && new Date(time).toISOString() === value;
});
const contextSchema = z
  .object({
    schemaVersion: z.literal(1),
    workerStartedAt: instant.nullable(),
    reportDataPreparedAt: instant,
  })
  .strict();
const metadata = usExportInputV1Schema.shape.metadata.shape;
const editable = usTraceRequestCreateBodySchema.shape;
const counts = z
  .object({ error: integer, warning: integer, info: integer })
  .strict()
  .refine((value) => Number.isSafeInteger(value.error + value.warning + value.info));
const missingWorkbookSchema = z
  .object({
    code: z.enum(["empty_selection", "workbook_unrepresentable", "workbook_writer_failed"]),
  })
  .strict();
const missingFileSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("records.xlsx"), code: missingWorkbookSchema.shape.code }).strict(),
  z.object({ name: z.literal("plan.pdf"), code: z.literal("plan_absent") }).strict(),
]);
const descriptorSchema = z
  .object({
    name: z.enum(["records.xlsx", "plan.pdf", "validation.json"]),
    mediaType: z.string(),
    byteSize: positive,
    sha256: digest,
  })
  .strict();
const modelSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: z
      .object({
        tenantId: usExportInputV1Schema.shape.tenantId,
        requestId: platformUuidSchema,
        requestRevision: positive,
        runId: platformUuidSchema,
        runRevision: positive,
        mode,
        preparedBy: z.string().min(1),
      })
      .strict(),
    request: z
      .object({
        id: platformUuidSchema,
        revision: positive,
        requestNumber: editable.requestNumber,
        requesterName: editable.requesterName,
        requesterOrganization: editable.requesterOrganization,
        requesterContact: editable.requesterContact,
        receivedAt: editable.receivedAt,
        dueAt: z.iso.datetime(),
        alternateDeadlineReason: editable.alternateDeadlineReason.unwrap(),
      })
      .strict(),
    scope: usTraceRequestScopeV1Schema,
    timing: contextSchema
      .extend({ preparationStartedAt: instant, elapsedToReportDataPreparationMs: integer })
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
    preReportFiles: z.array(descriptorSchema).max(3),
    missingFiles: z.array(missingFileSchema).max(2),
  })
  .strict();
const bytePayloadSchema = z
  .object({
    name: z.enum(["validation.json", "records.xlsx"]),
    contentType: z.string(),
    bytes: z.instanceof(Uint8Array),
    sha256: digest,
    byteSize: positive,
  })
  .strict();
const payloadSchema = z
  .object({
    runId: platformUuidSchema,
    revision: positive,
    mode,
    scopedContentDigest: digest,
    inputDigest: digest.nullable(),
    validation: bytePayloadSchema,
    workbook: bytePayloadSchema.nullable(),
    missingWorkbook: missingWorkbookSchema.nullable(),
    renderFindings: usExportInputV1Schema.shape.findings,
  })
  .strict();
const planSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), code: z.literal("plan_absent") }).strict(),
  z
    .object({
      kind: z.literal("pdf"),
      planVersionId: platformUuidSchema,
      sha256: digest,
      byteSize: positive,
      bytes: z.instanceof(Buffer),
    })
    .strict(),
]);
const mediaTypes = {
  "records.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "plan.pdf": "application/pdf",
  "validation.json": "application/json",
} as const;
const fileLimits = {
  "records.xlsx": limits.workbook,
  "plan.pdf": limits.plan,
  "validation.json": limits.validation,
} as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const summarize = (findings: readonly ExportFinding[]) => {
  const result = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) result[finding.severity] += 1;
  return result;
};
function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try {
    return schema.parse(value);
  } catch {
    throw inputsInvalid();
  }
}
function elapsed(context: UsRequestReportContext, preparation: string): number {
  const start = Date.parse(preparation),
    end = Date.parse(context.reportDataPreparedAt);
  const duration = end - start;
  const worker = context.workerStartedAt === null ? null : Date.parse(context.workerStartedAt);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    (worker !== null && (worker < start || worker > end))
  )
    throw contextInvalid();
  return duration;
}
function supportedText(value: unknown): boolean {
  if (typeof value === "string")
    return !/[\p{Cc}\p{Cs}]/u.test(value.replaceAll("\n", "").replaceAll("\r", ""));
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(supportedText);
}

/** Shape/consistency only: this neither attests origin nor verifies saved evidence. */
export function assertUsRequestReportModel(model: UsRequestReportModel): void;
export function assertUsRequestReportModel(model: unknown): asserts model is UsRequestReportModel;
export function assertUsRequestReportModel(model: unknown): void {
  let serialized: string;
  try {
    serialized = stableStringify(model);
  } catch {
    throw modelInvalid();
  }
  if (Buffer.byteLength(serialized, "utf8") > limits.reportModel) throw sizeLimit();
  const parsed = modelSchema.safeParse(model);
  if (!parsed.success || stableStringify(parsed.data) !== serialized || !supportedText(parsed.data))
    throw modelInvalid();
  const m = parsed.data,
    summary = m.selectionSummary;
  let duration: number;
  try {
    duration = elapsed(m.timing, m.timing.preparationStartedAt);
  } catch {
    throw modelInvalid();
  }
  if (
    duration !== m.timing.elapsedToReportDataPreparationMs ||
    m.request.id !== m.identity.requestId ||
    m.request.revision !== m.identity.requestRevision ||
    Object.values(summary.byType).reduce((a, b) => a + b, 0) !== summary.capturedRevisionCount ||
    Object.values(summary.byLifecycle).reduce((a, b) => a + b, 0) !==
      summary.capturedRevisionCount ||
    summary.workbookEventCount > summary.capturedRevisionCount ||
    stableStringify(summarize(m.renderFindings)) !== stableStringify(m.findingsSummary.render) ||
    (m.tenantOrigin.result === "trusted_synthetic" &&
      m.tenantOrigin.trustedSeed.seedId !== m.identity.tenantId) ||
    (m.warningAcknowledgement !== null &&
      m.warningAcknowledgement.digest !== m.digests.scopedContentDigest)
  )
    throw modelInvalid();
  const names = m.preReportFiles.map((file) => file.name),
    missing = m.missingFiles.map((file) => file.name);
  const workbook = m.preReportFiles.find((file) => file.name === "records.xlsx");
  const plan = m.preReportFiles.find((file) => file.name === "plan.pdf");
  const workbookMissing = m.missingFiles.find((file) => file.name === "records.xlsx");
  if (
    new Set(names).size !== names.length ||
    new Set(missing).size !== missing.length ||
    !names.includes("validation.json") ||
    stableStringify(names) !==
      stableStringify([
        ...(workbook ? ["records.xlsx"] : []),
        ...(plan ? ["plan.pdf"] : []),
        "validation.json",
      ]) ||
    stableStringify(missing) !==
      stableStringify([...(workbook ? [] : ["records.xlsx"]), ...(plan ? [] : ["plan.pdf"])]) ||
    (m.plan === null) !== (plan === undefined) ||
    (plan && plan.sha256 !== m.plan?.pdfSha256) ||
    (summary.workbookEventCount === 0) !== (m.digests.inputDigest === null) ||
    (summary.capturedRevisionCount === 0 && summary.workbookEventCount !== 0) ||
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
    throw modelInvalid();
  for (const file of m.preReportFiles) {
    if (file.mediaType !== mediaTypes[file.name]) throw modelInvalid();
    if (file.byteSize > fileLimits[file.name]) throw sizeLimit();
  }
}

/** Trusted internal upstream outputs only. Copies finish synchronously before any renderer awaits. */
export function bindUsRequestPackageInputs(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
  payloads: UsRequestPayloadResult,
  plan: UsRequestPinnedPlanResult,
  context: UsRequestReportContext,
): UsRequestPackageInputs {
  const frozen = requireUsRequestPackageEvidence(run, expectedTenantId);
  let timing: UsRequestReportContext;
  let duration: number;
  try {
    timing = contextSchema.parse(context);
    duration = elapsed(timing, frozen.generatedAt);
  } catch {
    throw contextInvalid();
  }
  const p = parseInput(payloadSchema, payloads),
    pinned = parseInput(planSchema, plan);
  const pin = frozen.validationSnapshot.plan;
  if (
    p.runId !== run.id ||
    p.revision !== run.revision ||
    p.mode !== frozen.mode ||
    p.scopedContentDigest !== run.scopedContentDigest ||
    p.inputDigest !== run.inputDigest ||
    (p.workbook === null) !== (p.missingWorkbook !== null) ||
    (p.missingWorkbook?.code === "empty_selection") !== (frozen.exportInput === null) ||
    (pin === null) !== (pinned.kind === "absent") ||
    (frozen.mode === "export_ready" &&
      (p.workbook === null ||
        pinned.kind !== "pdf" ||
        frozen.exportInput?.findings.some((finding) => finding.severity === "error") ||
        p.renderFindings.some((finding) => finding.severity === "error")))
  )
    throw inputsInvalid();
  const files: UsRequestPackageByteFile[] = [];
  const missingFiles: UsRequestMissingFile[] = [];
  const copy = (
    name: keyof typeof mediaTypes,
    bytes: Uint8Array,
    byteSize: number,
    sha256: string,
    mediaType: string,
  ): UsRequestPackageByteFile => {
    if (mediaType !== mediaTypes[name] || bytes.byteLength !== byteSize || bytes.byteLength === 0)
      throw inputsInvalid();
    if (bytes.byteLength > fileLimits[name]) throw sizeLimit();
    const owned = Buffer.from(bytes);
    if (hash(owned) !== sha256) throw inputsInvalid();
    return { name, mediaType, byteSize: owned.length, sha256, bytes: owned };
  };
  if (p.workbook) {
    if (p.workbook.name !== "records.xlsx") throw inputsInvalid();
    files.push(
      copy(
        "records.xlsx",
        p.workbook.bytes,
        p.workbook.byteSize,
        p.workbook.sha256,
        p.workbook.contentType,
      ),
    );
  } else if (p.missingWorkbook)
    missingFiles.push({ name: "records.xlsx", code: p.missingWorkbook.code });
  if (pinned.kind === "pdf") {
    const pdf = pinned;
    if (pdf.planVersionId !== pin?.id || pdf.sha256 !== pin.pdfSha256) throw inputsInvalid();
    files.push(copy("plan.pdf", pdf.bytes, pdf.byteSize, pdf.sha256, "application/pdf"));
  } else missingFiles.push({ name: "plan.pdf", code: "plan_absent" });
  if (p.validation.name !== "validation.json") throw inputsInvalid();
  const validation = copy(
    "validation.json",
    p.validation.bytes,
    p.validation.byteSize,
    p.validation.sha256,
    p.validation.contentType,
  );
  if (!validation.bytes.equals(Buffer.from(stableStringify(frozen), "utf8"))) throw inputsInvalid();
  files.push(validation);
  const snapshot = frozen.validationSnapshot;
  const byType = { receiving: 0, transformation: 0, shipping: 0 };
  const byLifecycle = { current_finalized: 0, historical_finalized: 0, draft: 0, void: 0 };
  for (const source of snapshot.sources) {
    byType[source.type] += 1;
    byLifecycle[source.lifecycle] += 1;
  }
  const descriptors: UsRequestFileDescriptor[] = files.map(({ bytes, ...descriptor }) => {
    void bytes;
    return descriptor;
  });
  const model: UsRequestReportModel = {
    schemaVersion: 1,
    identity: {
      tenantId: expectedTenantId,
      requestId: run.requestId,
      requestRevision: snapshot.request.revision,
      runId: run.id,
      runRevision: run.revision,
      mode: frozen.mode,
      preparedBy: frozen.preparedBy,
    },
    request: snapshot.request,
    scope: snapshot.selection.scope,
    timing: {
      ...timing,
      preparationStartedAt: frozen.generatedAt,
      elapsedToReportDataPreparationMs: duration,
    },
    tenantOrigin: snapshot.tenantOrigin,
    stamps: {
      profile: snapshot.profile,
      timeZone: snapshot.timeZone,
      baselineId: snapshot.baselineId,
      registryId: snapshot.registryId,
      registryVersion: snapshot.registryVersion,
      registryHash: snapshot.registryHash,
      build: snapshot.build,
    },
    selectionSummary: {
      capturedRevisionCount: snapshot.sources.length,
      workbookEventCount: frozen.exportInput?.events.length ?? 0,
      byType,
      byLifecycle,
    },
    findingsSummary: {
      validation: summarize(snapshot.findings),
      render: summarize(p.renderFindings),
    },
    renderFindings: p.renderFindings,
    warningAcknowledgement: frozen.warningAcknowledgement,
    plan: snapshot.plan,
    digests: { scopedContentDigest: run.scopedContentDigest, inputDigest: run.inputDigest },
    preReportFiles: descriptors,
    missingFiles,
  };
  assertUsRequestReportModel(model);
  return { model: structuredClone(model), preReportFiles: files };
}
