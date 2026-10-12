import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { usExportInputV1Schema } from "./export-core.js";
import {
  usTraceRequestCloseBodySchema,
  usTraceRequestCreateBodySchema,
  usTraceRequestPrepareBodySchema,
  usTraceRequestScopeV1Schema,
} from "./requests.js";

const editable = usTraceRequestCreateBodySchema.shape;
const positive = z.number().int().positive();
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.string().min(1);
const instant = editable.receivedAt;
const status = z.enum(["open", "closed"]);
const reason = z
  .string()
  .min(3)
  .max(2000)
  .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value));
const canonicalUuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const snapshotLimit = 16 * 1024 * 1024;
// Existing export findings retain their exact fields. Bound serialized evidence, not an
// invented count that could discard findings from an otherwise valid saved snapshot.
const findings = usExportInputV1Schema.shape.findings.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= snapshotLimit,
);
const numericQuery = (minimum: number, maximum: number, fallback: number) =>
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .refine(
      (value) =>
        value.length <= String(maximum).length &&
        Number(value) >= minimum &&
        Number(value) <= maximum,
    )
    .transform(Number)
    .default(fallback);
const paginationQuery = { limit: numericQuery(1, 50, 25), offset: numericQuery(0, 10000, 0) };
const paginationResponse = {
  limit: positive.max(50),
  offset: count.max(10000),
  hasMore: z.boolean(),
};

export const usRequestListQuerySchema = z
  .object({
    requestNumber: editable.requestNumber.optional(),
    status: status.optional(),
    ...paginationQuery,
  })
  .strict();
export const usRequestHistoryQuerySchema = z.object(paginationQuery).strict();
export const usRequestValidateHttpBodySchema = usTraceRequestCloseBodySchema;
export const usRequestWarningAckHttpBodySchema = usTraceRequestCloseBodySchema
  .extend({ digest, reason })
  .strict();
export const usRequestPrepareHttpBodySchema = usTraceRequestPrepareBodySchema
  .extend({ expectedRevision: positive, validationDigest: digest })
  .strict();
// Preserve the worker parser's existing reason and lowercase UUID semantics.
export const usRequestRetryHttpBodySchema = z
  .object({
    expectedLifecycleVersion: positive,
    reason: z
      .string()
      .min(3)
      .max(2000)
      .refine((value) => value.trim().length >= 3),
    idempotencyKey: canonicalUuid,
  })
  .strict();
export const usRequestArtifactKindSchema = z.enum([
  "xlsx",
  "plan_pdf",
  "validation_report",
  "request_report",
  "manifest",
  "package_zip",
]);
/** Configuration is descriptive; configured storage is not a network-health claim. */
export const usRequestAvailabilitySchema = z
  .object({
    build: z.enum(["available", "unavailable", "unknown"]),
    packageStorage: z.enum(["configured", "unconfigured", "invalid"]),
  })
  .strict();

export const usRequestSummarySchema = z
  .object({
    id: platformUuidSchema,
    requestNumber: editable.requestNumber,
    revision: positive,
    status,
    receivedAt: instant,
    dueAt: instant,
    createdBy: actor,
    createdAt: instant,
    updatedAt: instant,
    closedAt: instant.nullable(),
    lastValidatedAt: instant.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "closed") !== (value.closedAt !== null))
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Closure time must match request status",
      });
    if (Date.parse(value.dueAt) <= Date.parse(value.receivedAt))
      context.addIssue({
        code: "custom",
        path: ["dueAt"],
        message: "Deadline must follow receipt",
      });
  });

// A shared public allowlist duplicates no API dependency or private worker state.
const failureCode = z.enum([
  "insufficient_permission",
  "traceability_profile_required",
  "traceability_profile_invalid",
  "us_request_profile_unsupported",
  "us_request_run_stored_invalid",
  "us_request_package_refreeze_required",
  "us_request_payload_evidence_mismatch",
  "us_request_payload_size_limit",
  "us_request_payload_workbook_unavailable",
  "us_request_payload_render_failed",
  "us_request_plan_read_failed",
  "us_request_package_inputs_invalid",
  "us_request_package_context_invalid",
  "us_request_package_model_invalid",
  "us_request_package_size_limit",
  "us_request_package_manifest_invalid",
  "us_request_package_archive_invalid",
  "us_request_report_render_failed",
  "us_request_worker_lease_lost",
  "us_request_worker_deadline_exceeded",
  "us_request_worker_retry_limit",
  "us_request_worker_checkpoint_mismatch",
  "us_request_worker_execution_invalid",
  "us_request_worker_stored_invalid",
  "us_request_worker_retry_conflict",
  "us_request_worker_unknown_failure",
  "us_request_worker_database_unavailable",
  "us_request_worker_database_retryable",
  "us_request_package_storage_configuration_invalid",
  "us_request_package_storage_operational_verification_required",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_timeout",
  "us_request_package_storage_evidence_invalid",
  "us_request_package_storage_scope_invalid",
  "us_request_package_storage_collision",
  "us_request_package_storage_checksum_mismatch",
  "us_request_package_storage_read_failed",
  "us_request_package_storage_delete_failed",
]);
const transient = new Set([
  "us_request_worker_database_unavailable",
  "us_request_worker_database_retryable",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_timeout",
]);
export const usRequestRunSummarySchema = z
  .object({
    runId: platformUuidSchema,
    requestId: platformUuidSchema,
    requestRevision: positive,
    runRevision: positive,
    mode: usTraceRequestPrepareBodySchema.shape.mode,
    status: z.enum(["queued", "processing", "failed", "ready"]),
    exportReady: z.boolean(),
    createdBy: actor,
    commandDigest: digest,
    scopedContentDigest: digest,
    inputDigest: digest.nullable(),
    lifecycleVersion: count,
    retryCycle: positive,
    attemptCount: count,
    cycleAttemptCount: count.max(3),
    failureCode: failureCode.nullable(),
    startedAt: instant,
    generationStartedAt: instant.nullable(),
    reportRenderedAt: instant.nullable(),
    completedAt: instant.nullable(),
    nextAttemptAt: instant.nullable(),
    provenance: z.enum(["trusted_synthetic", "not_verified"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cycleAttemptCount > value.attemptCount)
      context.addIssue({
        code: "custom",
        path: ["cycleAttemptCount"],
        message: "Cycle count exceeds total attempts",
      });
    if ((value.status === "ready" || value.status === "failed") !== (value.completedAt !== null))
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion time must match terminal state",
      });
    if ((value.status === "failed") !== (value.failureCode !== null))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Failure code must match failed state",
      });
    if (value.exportReady && (value.mode !== "export_ready" || value.status !== "ready"))
      context.addIssue({
        code: "custom",
        path: ["exportReady"],
        message: "Only a ready complete run can be export ready",
      });
    if (value.nextAttemptAt !== null && value.status !== "queued")
      context.addIssue({
        code: "custom",
        path: ["nextAttemptAt"],
        message: "Only a queued run can schedule another attempt",
      });
    if (
      value.completedAt !== null &&
      value.generationStartedAt !== null &&
      Date.parse(value.completedAt) < Date.parse(value.generationStartedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion precedes worker start",
      });
    for (const field of [
      "generationStartedAt",
      "reportRenderedAt",
      "completedAt",
      "nextAttemptAt",
    ] as const) {
      const time = value[field];
      if (time !== null && Date.parse(time) < Date.parse(value.startedAt))
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Run time precedes preparation",
        });
    }
    if (
      value.reportRenderedAt !== null &&
      value.generationStartedAt !== null &&
      Date.parse(value.reportRenderedAt) < Date.parse(value.generationStartedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["reportRenderedAt"],
        message: "Rendering precedes worker start",
      });
    if (
      value.completedAt !== null &&
      value.reportRenderedAt !== null &&
      Date.parse(value.completedAt) < Date.parse(value.reportRenderedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion precedes rendering",
      });
  });
const attemptSummary = z
  .object({
    id: platformUuidSchema,
    attemptNumber: positive,
    cycle: positive,
    status: z.enum(["active", "failed", "abandoned", "succeeded"]),
    startedAt: instant,
    finishedAt: instant.nullable(),
    reportRenderedAt: instant.nullable(),
    failureCode: failureCode.nullable(),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "active") !== (value.finishedAt === null))
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Finish time must match attempt status",
      });
    const failed = value.status === "failed" || value.status === "abandoned";
    if (failed !== (value.failureCode !== null))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Failure must match attempt status",
      });
    const retryable =
      value.status === "abandoned"
        ? value.failureCode === "us_request_worker_lease_lost" ||
          value.failureCode === "us_request_worker_deadline_exceeded"
        : value.status === "failed" &&
          value.failureCode !== null &&
          transient.has(value.failureCode);
    if (value.retryable !== retryable || (value.status === "abandoned" && !retryable))
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "Retryability must match the recognized failure",
      });
    for (const field of ["finishedAt", "reportRenderedAt"] as const) {
      const time = value[field];
      if (time !== null && Date.parse(time) < Date.parse(value.startedAt))
        context.addIssue({ code: "custom", path: [field], message: "Attempt time precedes start" });
    }
  });
const savedValidation = z
  .object({
    digest,
    validatedAt: instant,
    matchedRevisionCount: count.max(500),
    findings,
    freshness: z.literal("not_rechecked"),
  })
  .strict();
const warningAcknowledgement = z
  .object({ digest, reason, actorId: actor, acknowledgedAt: instant })
  .strict();
export const usRequestDetailResponseSchema = usRequestSummarySchema
  .safeExtend({
    requesterName: editable.requesterName,
    requesterOrganization: editable.requesterOrganization,
    requesterContact: editable.requesterContact,
    alternateDeadlineReason: editable.alternateDeadlineReason.unwrap(),
    scope: usTraceRequestScopeV1Schema.nullable(),
    savedValidation: savedValidation.nullable(),
    warningAcknowledgement: warningAcknowledgement.nullable(),
    latestRun: usRequestRunSummarySchema.nullable(),
    availability: usRequestAvailabilitySchema,
  })
  .superRefine((value, context) => {
    if (
      (value.savedValidation === null) !== (value.lastValidatedAt === null) ||
      (value.savedValidation !== null &&
        value.lastValidatedAt !== null &&
        Date.parse(value.savedValidation.validatedAt) !== Date.parse(value.lastValidatedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["savedValidation"],
        message: "Saved validation time must match request metadata",
      });
    if (
      value.warningAcknowledgement !== null &&
      (value.savedValidation === null ||
        value.warningAcknowledgement.digest !== value.savedValidation.digest ||
        Date.parse(value.warningAcknowledgement.acknowledgedAt) <
          Date.parse(value.savedValidation.validatedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["warningAcknowledgement"],
        message: "Acknowledgement must reference saved validation",
      });
    if (value.latestRun !== null && value.latestRun.requestId !== value.id)
      context.addIssue({
        code: "custom",
        path: ["latestRun"],
        message: "Latest run must belong to this request",
      });
  });

const artifact = <K extends UsRequestArtifactKind, N extends string, M extends string>(
  kind: K,
  name: N,
  mediaType: M,
  maximum: number,
) =>
  z
    .object({
      kind: z.literal(kind),
      name: z.literal(name),
      mediaType: z.literal(mediaType),
      byteSize: positive.max(maximum),
      sha256: digest,
    })
    .strict();
const artifactDescriptor = z.discriminatedUnion("kind", [
  artifact(
    "xlsx",
    "records.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    16 * 1024 * 1024,
  ),
  artifact("plan_pdf", "plan.pdf", "application/pdf", 8_000_000),
  artifact("validation_report", "validation.json", "application/json", 16 * 1024 * 1024),
  artifact("request_report", "request-report.pdf", "application/pdf", 4 * 1024 * 1024),
  artifact("manifest", "manifest.json", "application/json", 1024 * 1024),
  artifact("package_zip", "package.zip", "application/zip", 64 * 1024 * 1024),
]);
const missingFile = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("records.xlsx"),
      code: z.enum(["empty_selection", "workbook_unrepresentable", "workbook_writer_failed"]),
    })
    .strict(),
  z.object({ name: z.literal("plan.pdf"), code: z.literal("plan_absent") }).strict(),
]);
const frozenRequest = z
  .object({
    id: platformUuidSchema,
    revision: positive,
    requestNumber: editable.requestNumber,
    requesterName: editable.requesterName,
    requesterOrganization: editable.requesterOrganization,
    requesterContact: editable.requesterContact,
    receivedAt: instant,
    dueAt: instant,
    alternateDeadlineReason: editable.alternateDeadlineReason.unwrap(),
  })
  .strict();
export const usRequestRunDetailSchema = usRequestRunSummarySchema
  .safeExtend({
    request: frozenRequest,
    scope: usTraceRequestScopeV1Schema,
    findings,
    latestAttempt: attemptSummary.nullable(),
    artifacts: z.array(artifactDescriptor).max(6),
    missingFiles: z.array(missingFile).max(2).nullable(),
  })
  .superRefine((value, context) => {
    if (value.request.id !== value.requestId || value.request.revision !== value.requestRevision)
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "Frozen request must match run identity",
      });
    if (
      new Set(value.artifacts.map((file) => file.kind)).size !== value.artifacts.length ||
      (value.artifacts.length > 0 && value.status !== "ready")
    )
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Published artifacts require a ready run and unique kinds",
      });
    if (
      value.missingFiles !== null &&
      (new Set(value.missingFiles.map((file) => file.name)).size !== value.missingFiles.length ||
        value.missingFiles.some((missing) =>
          value.artifacts.some((file) => file.name === missing.name),
        ))
    )
      context.addIssue({
        code: "custom",
        path: ["missingFiles"],
        message: "Missing files must be unique and absent from published artifacts",
      });
    if (
      value.latestAttempt !== null &&
      (value.latestAttempt.attemptNumber !== value.attemptCount ||
        value.latestAttempt.cycle > value.retryCycle)
    )
      context.addIssue({
        code: "custom",
        path: ["latestAttempt"],
        message: "Latest attempt must match run counts",
      });
  });
const page = <T extends z.ZodType>(item: T) =>
  z
    .object({ items: z.array(item).max(50), ...paginationResponse })
    .strict()
    .refine((value) => value.items.length <= value.limit, {
      path: ["items"],
      message: "Item count exceeds response limit",
    });
export const usRequestListResponseSchema = page(usRequestSummarySchema);
export const usRequestRunListResponseSchema = page(usRequestRunSummarySchema);
export const usRequestAttemptListResponseSchema = page(attemptSummary);
/** An accepted revision is a receipt, never a promise about subsequent live state. */
export const usRequestCommandResponseSchema = z
  .object({
    httpRequestId: platformUuidSchema,
    requestId: platformUuidSchema,
    revision: positive,
    status,
  })
  .strict();
export const usRequestValidationHttpResponseSchema = z
  .object({
    httpRequestId: platformUuidSchema,
    requestId: platformUuidSchema,
    revision: positive,
    digest,
    byteSize: positive.max(snapshotLimit),
    matchedRevisionCount: count.max(500),
    findings,
    validatedAt: instant,
  })
  .strict();
export const usRequestPrepareResponseSchema = z
  .object({
    httpRequestId: platformUuidSchema,
    requestId: platformUuidSchema,
    requestRevision: positive,
    runId: platformUuidSchema,
    runRevision: positive,
    mode: usTraceRequestPrepareBodySchema.shape.mode,
    idempotencyKey: platformUuidSchema,
    scopedContentDigest: digest,
  })
  .strict();
export const usRequestRetryResponseSchema = z
  .object({
    httpRequestId: platformUuidSchema,
    runId: canonicalUuid,
    cycle: positive.min(2),
    lifecycleVersion: positive,
    requestedBy: actor,
    idempotencyKey: canonicalUuid,
  })
  .strict();

export type UsRequestListQuery = z.infer<typeof usRequestListQuerySchema>;
export type UsRequestHistoryQuery = z.infer<typeof usRequestHistoryQuerySchema>;
export type UsRequestValidateHttpBody = z.infer<typeof usRequestValidateHttpBodySchema>;
export type UsRequestWarningAckHttpBody = z.infer<typeof usRequestWarningAckHttpBodySchema>;
export type UsRequestPrepareHttpBody = z.infer<typeof usRequestPrepareHttpBodySchema>;
export type UsRequestRetryHttpBody = z.infer<typeof usRequestRetryHttpBodySchema>;
export type UsRequestArtifactKind = z.infer<typeof usRequestArtifactKindSchema>;
export type UsRequestAvailability = z.infer<typeof usRequestAvailabilitySchema>;
export type UsRequestSummary = z.infer<typeof usRequestSummarySchema>;
export type UsRequestDetailResponse = z.infer<typeof usRequestDetailResponseSchema>;
export type UsRequestDetailData = Omit<UsRequestDetailResponse, "availability">;
export type UsRequestListResponse = z.infer<typeof usRequestListResponseSchema>;
export type UsRequestRunSummary = z.infer<typeof usRequestRunSummarySchema>;
export type UsRequestRunDetail = z.infer<typeof usRequestRunDetailSchema>;
export type UsRequestRunListResponse = z.infer<typeof usRequestRunListResponseSchema>;
export type UsRequestAttemptListResponse = z.infer<typeof usRequestAttemptListResponseSchema>;
export type UsRequestCommandResponse = z.infer<typeof usRequestCommandResponseSchema>;
export type UsRequestValidationHttpResponse = z.infer<typeof usRequestValidationHttpResponseSchema>;
export type UsRequestPrepareResponse = z.infer<typeof usRequestPrepareResponseSchema>;
export type UsRequestRetryResponse = z.infer<typeof usRequestRetryResponseSchema>;
