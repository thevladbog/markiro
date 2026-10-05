import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { traceabilityPlanVersions } from "./traceability-plans.js";
import { traceExportAttempts } from "./traceability-request-worker.js";

function leaseColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [
    traceExportAttempts.tenantId,
    traceExportAttempts.runId,
    traceExportAttempts.id,
    traceExportAttempts.token,
  ];
}

export const traceRequests = pgTable(
  "trace_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    requestNumber: text("request_number").notNull(),
    requesterName: text("requester_name").notNull(),
    requesterOrganization: text("requester_organization"),
    requesterContact: text("requester_contact"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    alternateDeadlineReason: text("alternate_deadline_reason"),
    scope: jsonb("scope").$type<unknown>(),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("open"),
    lastValidation: jsonb("last_validation").$type<unknown>(),
    lastValidationDigest: text("last_validation_digest"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    warningAckDigest: text("warning_ack_digest"),
    warningAckReason: text("warning_ack_reason"),
    warningAckAt: timestamp("warning_ack_at", { withTimezone: true }),
    warningAckBy: text("warning_ack_by"),
    createdBy: text("created_by").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("trace_requests_tenant_id_uq").on(t.tenantId, t.id),
    unique("trace_requests_number_uq").on(t.tenantId, t.requestNumber),
    index("trace_requests_due_idx").on(t.tenantId, t.status, t.dueAt),
    check("trace_requests_due_valid", sql`${t.dueAt} > ${t.receivedAt}`),
    check(
      "trace_requests_deadline_reason",
      sql`(${t.dueAt} = ${t.receivedAt} + interval '24 hours' AND ${t.alternateDeadlineReason} IS NULL) OR (${t.dueAt} <> ${t.receivedAt} + interval '24 hours' AND ${t.alternateDeadlineReason} IS NOT NULL AND char_length(btrim(${t.alternateDeadlineReason})) BETWEEN 3 AND 2000 AND ${t.alternateDeadlineReason} ~ '[^[:space:]]')`,
    ),
    check("trace_requests_scope_object", sql`jsonb_typeof(${t.scope}) = 'object'`),
    check("trace_requests_validation_object", sql`jsonb_typeof(${t.lastValidation}) = 'object'`),
    check("trace_requests_revision_positive", sql`${t.revision} > 0`),
    check(
      "trace_requests_status_valid",
      sql`(${t.status} = 'open' AND ${t.closedAt} IS NULL) OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL)`,
    ),
    check(
      "trace_requests_validation_shape",
      sql`(${t.lastValidation} IS NULL AND ${t.lastValidationDigest} IS NULL AND ${t.lastValidatedAt} IS NULL) OR (${t.lastValidation} IS NOT NULL AND ${t.lastValidationDigest} IS NOT NULL AND ${t.lastValidatedAt} IS NOT NULL)`,
    ),
    check(
      "trace_requests_ack_shape",
      sql`(${t.warningAckDigest} IS NULL AND ${t.warningAckReason} IS NULL AND ${t.warningAckAt} IS NULL AND ${t.warningAckBy} IS NULL) OR (${t.warningAckDigest} IS NOT NULL AND ${t.warningAckReason} IS NOT NULL AND ${t.warningAckAt} IS NOT NULL AND ${t.warningAckBy} IS NOT NULL)`,
    ),
    check(
      "trace_requests_digests_valid",
      sql`${t.lastValidationDigest} ~ '^[a-f0-9]{64}$' AND ${t.warningAckDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const traceExportRuns = pgTable(
  "trace_export_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    requestId: uuid("request_id").notNull(),
    revision: integer("revision").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    commandDigest: text("command_digest").notNull(),
    scopedContentDigest: text("scoped_content_digest").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<unknown>().notNull(),
    inputDigest: text("input_digest"),
    planVersionId: uuid("plan_version_id"),
    planPdfSha256: text("plan_pdf_sha256"),
    registryVersion: integer("registry_version"),
    registryHash: text("registry_hash"),
    exportReady: boolean("export_ready").notNull().default(false),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    generationStartedAt: timestamp("generation_started_at", { withTimezone: true }),
    reportRenderedAt: timestamp("report_rendered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    retryCycle: integer("retry_cycle").notNull().default(1),
    cycleAttemptCount: integer("cycle_attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseAttemptId: uuid("lease_attempt_id"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptDeadlineAt: timestamp("attempt_deadline_at", { withTimezone: true }),
  },
  (t) => [
    unique("trace_export_runs_tenant_id_uq").on(t.tenantId, t.id),
    unique("trace_export_runs_revision_uq").on(t.tenantId, t.requestId, t.revision),
    unique("trace_export_runs_idempotency_uq").on(t.tenantId, t.createdBy, t.idempotencyKey),
    foreignKey({
      name: "trace_export_runs_lease_fk",
      columns: [t.tenantId, t.id, t.leaseAttemptId, t.leaseToken],
      foreignColumns: leaseColumns(),
    }),
    check(
      "trace_export_runs_worker_counts_valid",
      sql`${t.attemptCount} >= 0 AND ${t.lifecycleVersion} >= 0 AND ${t.retryCycle} > 0 AND ${t.cycleAttemptCount} BETWEEN 0 AND 3 AND ${t.cycleAttemptCount} <= ${t.attemptCount}`,
    ),
    check(
      "trace_export_runs_worker_lease_valid",
      sql`(${t.leaseAttemptId} IS NULL AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL AND ${t.attemptDeadlineAt} IS NULL) OR (${t.status} = 'processing' AND ${t.leaseAttemptId} IS NOT NULL AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL AND ${t.attemptDeadlineAt} IS NOT NULL AND ${t.leaseExpiresAt} <= ${t.attemptDeadlineAt} AND ${t.cycleAttemptCount} > 0)`,
    ),
    foreignKey({
      name: "trace_export_runs_request_fk",
      columns: [t.tenantId, t.requestId],
      foreignColumns: [traceRequests.tenantId, traceRequests.id],
    }),
    foreignKey({
      name: "trace_export_runs_plan_fk",
      columns: [t.tenantId, t.planVersionId],
      foreignColumns: [traceabilityPlanVersions.tenantId, traceabilityPlanVersions.id],
    }),
    index("trace_export_runs_queue_idx").on(t.status, t.startedAt, t.tenantId),
    check(
      "trace_export_runs_mode_valid",
      sql`${t.mode} IN ('export_ready','available_records_incomplete')`,
    ),
    check(
      "trace_export_runs_status_valid",
      sql`(${t.status} IN ('queued','processing') AND ${t.completedAt} IS NULL AND ${t.failureCode} IS NULL) OR (${t.status} = 'ready' AND ${t.completedAt} IS NOT NULL AND ${t.failureCode} IS NULL) OR (${t.status} = 'failed' AND ${t.completedAt} IS NOT NULL AND ${t.failureCode} IS NOT NULL)`,
    ),
    check(
      "trace_export_runs_ready_valid",
      sql`NOT ${t.exportReady} OR (${t.mode} = 'export_ready' AND ${t.status} = 'ready')`,
    ),
    check("trace_export_runs_snapshot_object", sql`jsonb_typeof(${t.inputSnapshot}) = 'object'`),
    check(
      "trace_export_runs_input_binding",
      sql`(${t.inputDigest} IS NULL) = COALESCE(${t.inputSnapshot}->>'selectionKind' = 'empty', false)`,
    ),
    check(
      "trace_export_runs_plan_binding",
      sql`(${t.planVersionId} IS NULL) = (${t.planPdfSha256} IS NULL)`,
    ),
    check(
      "trace_export_runs_digests_valid",
      sql`${t.commandDigest} ~ '^[a-f0-9]{64}$' AND ${t.scopedContentDigest} ~ '^[a-f0-9]{64}$' AND ${t.inputDigest} ~ '^[a-f0-9]{64}$' AND ${t.planPdfSha256} ~ '^[a-f0-9]{64}$' AND ${t.registryHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const traceExportArtifacts = pgTable(
  "trace_export_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    runId: uuid("run_id").notNull(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("trace_export_artifacts_tenant_id_uq").on(t.tenantId, t.id),
    unique("trace_export_artifacts_kind_uq").on(t.tenantId, t.runId, t.kind),
    unique("trace_export_artifacts_filename_uq").on(t.tenantId, t.runId, t.filename),
    foreignKey({
      name: "trace_export_artifacts_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [traceExportRuns.tenantId, traceExportRuns.id],
    }),
    index("trace_export_artifacts_run_idx").on(t.tenantId, t.runId),
    check(
      "trace_export_artifacts_kind_valid",
      sql`${t.kind} IN ('xlsx','plan_pdf','validation_report','request_report','manifest','package_zip')`,
    ),
    check("trace_export_artifacts_size_positive", sql`${t.byteSize} > 0`),
    check("trace_export_artifacts_digest_valid", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
