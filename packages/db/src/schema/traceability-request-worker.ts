import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { traceExportRuns } from "./traceability-requests.js";

function runColumns(): [AnyPgColumn, AnyPgColumn] {
  return [traceExportRuns.tenantId, traceExportRuns.id];
}
const instant = (name: string) => timestamp(name, { withTimezone: true });
export const traceExportAttempts = pgTable(
  "trace_export_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    cycle: integer("cycle").notNull(),
    token: uuid("token").notNull(),
    status: text("status").notNull(),
    startedAt: instant("started_at").notNull(),
    leaseExpiresAt: instant("lease_expires_at").notNull(),
    deadlineAt: instant("deadline_at").notNull(),
    finishedAt: instant("finished_at"),
    reportRenderedAt: instant("report_rendered_at"),
    failureCode: text("failure_code"),
    retryable: boolean("retryable").notNull().default(false),
  },
  (t) => [
    unique("trace_export_attempts_scope_uq").on(t.tenantId, t.runId, t.id),
    unique("trace_export_attempts_fence_uq").on(t.tenantId, t.runId, t.id, t.token),
    unique("trace_export_attempts_number_uq").on(t.tenantId, t.runId, t.attemptNumber),
    unique("trace_export_attempts_token_uq").on(t.token),
    foreignKey({
      name: "trace_export_attempts_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: runColumns(),
    }),
    check("trace_export_attempts_counts_valid", sql`${t.attemptNumber} > 0 AND ${t.cycle} > 0`),
    check(
      "trace_export_attempts_times_valid",
      sql`${t.leaseExpiresAt} > ${t.startedAt} AND ${t.leaseExpiresAt} <= ${t.deadlineAt} AND ${t.deadlineAt} = ${t.startedAt} + interval '300 seconds' AND (${t.finishedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}) AND (${t.reportRenderedAt} IS NULL OR ${t.reportRenderedAt} >= ${t.startedAt})`,
    ),
    check(
      "trace_export_attempts_status_valid",
      sql`(${t.status} = 'active' AND ${t.finishedAt} IS NULL AND ${t.failureCode} IS NULL AND NOT ${t.retryable}) OR (${t.status} = 'succeeded' AND ${t.finishedAt} IS NOT NULL AND ${t.failureCode} IS NULL AND NOT ${t.retryable}) OR (${t.status} IN ('failed','abandoned') AND ${t.finishedAt} IS NOT NULL AND ${t.failureCode} IS NOT NULL)`,
    ),
  ],
);

export const traceExportRenderCheckpoints = pgTable(
  "trace_export_render_checkpoints",
  {
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").primaryKey(),
    attemptId: uuid("attempt_id").notNull(),
    model: jsonb("model").$type<unknown>().notNull(),
    modelDigest: text("model_digest").notNull(),
    executionDigest: text("execution_digest").notNull(),
    packageVersion: text("package_version").notNull(),
    reportVersion: text("report_version").notNull(),
    packageExpectation: jsonb("package_expectation").$type<unknown>(),
  },
  (t) => [
    unique("trace_export_render_checkpoints_scope_uq").on(t.tenantId, t.runId),
    foreignKey({
      name: "trace_export_render_checkpoints_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: runColumns(),
    }),
    foreignKey({
      name: "trace_export_render_checkpoints_attempt_fk",
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        traceExportAttempts.tenantId,
        traceExportAttempts.runId,
        traceExportAttempts.id,
      ],
    }),
    check(
      "trace_export_render_checkpoints_body_valid",
      sql`jsonb_typeof(${t.model}) = 'object' AND octet_length(${t.model}::text) <= 1048576 AND (${t.packageExpectation} IS NULL OR (jsonb_typeof(${t.packageExpectation}) = 'object' AND octet_length(${t.packageExpectation}::text) <= 1048576))`,
    ),
    check(
      "trace_export_render_checkpoints_digest_valid",
      sql`${t.modelDigest} ~ '^[a-f0-9]{64}$' AND ${t.executionDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "trace_export_render_checkpoints_versions_valid",
      sql`${t.packageVersion} = 'us-request-package-v1' AND ${t.reportVersion} = 'us-request-report-pdf-v1'`,
    ),
  ],
);

export const traceExportObjectIntents = pgTable(
  "trace_export_object_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
    sha256: text("sha256").notNull(),
    state: text("state").notNull().default("allocated"),
    allocatedAt: instant("allocated_at").notNull().defaultNow(),
    verifiedAt: instant("verified_at"),
    fencedAt: instant("fenced_at"),
    deletedAt: instant("deleted_at"),
    referencedAt: instant("referenced_at"),
  },
  (t) => [
    unique("trace_export_object_intents_key_uq").on(t.objectKey),
    unique("trace_export_object_intents_name_uq").on(t.tenantId, t.runId, t.attemptId, t.name),
    foreignKey({
      name: "trace_export_object_intents_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: runColumns(),
    }),
    foreignKey({
      name: "trace_export_object_intents_attempt_fk",
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        traceExportAttempts.tenantId,
        traceExportAttempts.runId,
        traceExportAttempts.id,
      ],
    }),
    check(
      "trace_export_object_intents_file_valid",
      sql`(${t.name} = 'records.xlsx' AND ${t.kind} = 'xlsx' AND ${t.mediaType} = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' AND ${t.byteSize} <= 16777216) OR (${t.name} = 'plan.pdf' AND ${t.kind} = 'plan_pdf' AND ${t.mediaType} = 'application/pdf' AND ${t.byteSize} <= 8000000) OR (${t.name} = 'validation.json' AND ${t.kind} = 'validation_report' AND ${t.mediaType} = 'application/json' AND ${t.byteSize} <= 16777216) OR (${t.name} = 'request-report.pdf' AND ${t.kind} = 'request_report' AND ${t.mediaType} = 'application/pdf' AND ${t.byteSize} <= 4194304) OR (${t.name} = 'manifest.json' AND ${t.kind} = 'manifest' AND ${t.mediaType} = 'application/json' AND ${t.byteSize} <= 1048576) OR (${t.name} = 'package.zip' AND ${t.kind} = 'package_zip' AND ${t.mediaType} = 'application/zip' AND ${t.byteSize} <= 67108864)`,
    ),
    check(
      "trace_export_object_intents_evidence_valid",
      sql`${t.byteSize} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.objectKey} = 'us/requests/' || ${t.tenantId} || '/' || ${t.runId}::text || '/' || ${t.attemptId}::text || '/' || ${t.name}`,
    ),
    check(
      "trace_export_object_intents_state_valid",
      sql`(${t.state} IN ('allocated','unresolved') AND ${t.verifiedAt} IS NULL AND ${t.fencedAt} IS NULL AND ${t.deletedAt} IS NULL AND ${t.referencedAt} IS NULL) OR (${t.state} = 'verified' AND ${t.verifiedAt} IS NOT NULL AND ${t.fencedAt} IS NULL AND ${t.deletedAt} IS NULL AND ${t.referencedAt} IS NULL) OR (${t.state} = 'fenced' AND ${t.fencedAt} IS NOT NULL AND ${t.deletedAt} IS NULL AND ${t.referencedAt} IS NULL) OR (${t.state} = 'deleted' AND ${t.fencedAt} IS NOT NULL AND ${t.deletedAt} IS NOT NULL AND ${t.referencedAt} IS NULL) OR (${t.state} = 'referenced' AND ${t.verifiedAt} IS NOT NULL AND ${t.referencedAt} IS NOT NULL AND ${t.fencedAt} IS NULL AND ${t.deletedAt} IS NULL)`,
    ),
  ],
);

export const traceExportRetryReceipts = pgTable(
  "trace_export_retry_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    commandDigest: text("command_digest").notNull(),
    reason: text("reason").notNull(),
    expectedLifecycleVersion: integer("expected_lifecycle_version").notNull(),
    cycle: integer("cycle").notNull(),
    lifecycleVersion: integer("lifecycle_version").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    unique("trace_export_retry_receipts_command_uq").on(t.tenantId, t.actorId, t.idempotencyKey),
    unique("trace_export_retry_receipts_cycle_uq").on(t.tenantId, t.runId, t.cycle),
    foreignKey({
      name: "trace_export_retry_receipts_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: runColumns(),
    }),
    check(
      "trace_export_retry_receipts_valid",
      sql`${t.expectedLifecycleVersion} >= 0 AND ${t.lifecycleVersion} > ${t.expectedLifecycleVersion} AND ${t.cycle} > 1 AND ${t.commandDigest} ~ '^[a-f0-9]{64}$' AND char_length(btrim(${t.reason})) BETWEEN 3 AND 2000 AND ${t.reason} ~ '[^[:space:]]' AND char_length(${t.actorId}) > 0`,
    ),
  ],
);
