import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

export const platformReportStatus = pgEnum("platform_report_status", [
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
]);

export const platformReports = pgTable(
  "platform_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdByPlatformUserId: text("created_by_platform_user_id").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    status: platformReportStatus("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    artifactObjectKey: text("artifact_object_key"),
    artifactChecksum: text("artifact_checksum"),
    artifactByteSize: bigint("artifact_byte_size", { mode: "number" }),
    artifactFilename: text("artifact_filename"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    errorCode: text("error_code"),
    rowCount: bigint("row_count", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_reports_creator_idempotency_uq").on(
      table.createdByPlatformUserId,
      table.idempotencyKey,
    ),
    index("platform_reports_creator_created_idx").on(
      table.createdByPlatformUserId,
      table.createdAt,
    ),
    index("platform_reports_queued_created_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    index("platform_reports_expiry_idx").on(table.expiresAt),
    foreignKey({
      name: "platform_reports_creator_fk",
      columns: [table.createdByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }).onDelete("restrict"),
    check("platform_reports_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "platform_reports_artifact_consistency",
      sql`(${table.status} = 'ready' and ${table.artifactObjectKey} is not null and ${table.artifactChecksum} is not null and ${table.artifactByteSize} is not null and ${table.artifactFilename} is not null) or (${table.status} <> 'ready' and ${table.artifactObjectKey} is null and ${table.artifactChecksum} is null and ${table.artifactByteSize} is null and ${table.artifactFilename} is null)`,
    ),
    check(
      "platform_reports_completion_consistency",
      sql`(${table.status} in ('ready', 'failed', 'expired') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'processing') and ${table.completedAt} is null)`,
    ),
    check(
      "platform_reports_checksum_format",
      sql`${table.artifactChecksum} is null or ${table.artifactChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "platform_reports_counts_nonnegative",
      sql`(${table.rowCount} is null or ${table.rowCount} >= 0) and (${table.artifactByteSize} is null or ${table.artifactByteSize} >= 0)`,
    ),
    check(
      "platform_reports_error_consistency",
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null)`,
    ),
    check(
      "platform_reports_error_code_vocabulary",
      sql`${table.errorCode} is null or ${table.errorCode} in ('REPORT_LIMIT_EXCEEDED', 'REPORT_INVALID_PARAMETERS', 'REPORT_PERMISSION_REVOKED', 'REPORT_SOURCE_FAILED', 'REPORT_SOURCE_TIMEOUT', 'REPORT_STORAGE_FAILED', 'REPORT_RETRY_EXHAUSTED', 'REPORT_GENERATION_FAILED')`,
    ),
    check(
      "platform_reports_lease_consistency",
      sql`(${table.status} = 'processing') = (${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

export const platformReportTenants = pgTable(
  "platform_report_tenants",
  {
    reportId: uuid("report_id")
      .notNull()
      .references(() => platformReports.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.reportId, table.tenantId] })],
);
