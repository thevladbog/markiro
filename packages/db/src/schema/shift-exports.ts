import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { shifts } from "./platform.js";

export const SHIFT_EXPORT_STATUSES = ["queued", "processing", "ready", "failed"] as const;
export type ShiftExportStatus = (typeof SHIFT_EXPORT_STATUSES)[number];

export const shiftExportStatusEnum = pgEnum("shift_export_status", SHIFT_EXPORT_STATUSES);

export const shiftExports = pgTable(
  "shift_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    shiftId: uuid("shift_id").notNull(),
    formatId: text("format_id").notNull(),
    formatVersion: integer("format_version").notNull(),
    maxLines: integer("max_lines"),
    status: shiftExportStatusEnum("status").notNull().default("queued"),
    errorCode: text("error_code"),
    productNameSnapshot: text("product_name_snapshot"),
    shiftDateSnapshot: date("shift_date_snapshot"),
    totalCodeCount: integer("total_code_count"),
    totalBoxCount: integer("total_box_count"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    sourceSnapshotStartedAt: timestamp("source_snapshot_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("shift_exports_tenant_id_uq").on(table.tenantId, table.id),
    unique("shift_exports_tenant_idempotency_uq").on(
      table.tenantId,
      table.createdByUserId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "shift_exports_tenant_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    index("shift_exports_tenant_shift_created_idx").on(
      table.tenantId,
      table.shiftId,
      table.createdAt,
    ),
    index("shift_exports_queued_created_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    check("shift_exports_format_version_positive", sql`${table.formatVersion} > 0`),
    check(
      "shift_exports_max_lines_range",
      sql`${table.maxLines} is null or ${table.maxLines} between 2 and 1000000`,
    ),
    check(
      "shift_exports_total_code_count_positive",
      sql`${table.totalCodeCount} is null or ${table.totalCodeCount} > 0`,
    ),
    check(
      "shift_exports_total_box_count_nonnegative",
      sql`${table.totalBoxCount} is null or ${table.totalBoxCount} >= 0`,
    ),
    check("shift_exports_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "shift_exports_status_consistency",
      sql`(${table.status} = 'ready' and ${table.completedAt} is not null and ${table.errorCode} is null)
        or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.errorCode} is not null)
        or (${table.status} in ('queued', 'processing') and ${table.completedAt} is null and ${table.errorCode} is null)`,
    ),
  ],
);

export const shiftExportArtifacts = pgTable(
  "shift_export_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    exportId: uuid("export_id").notNull(),
    partNumber: integer("part_number").notNull(),
    physicalLineCount: integer("physical_line_count").notNull(),
    codeCount: integer("code_count").notNull(),
    boxCount: integer("box_count").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("shift_export_artifacts_tenant_id_uq").on(table.tenantId, table.id),
    unique("shift_export_artifacts_tenant_export_part_uq").on(
      table.tenantId,
      table.exportId,
      table.partNumber,
    ),
    foreignKey({
      name: "shift_export_artifacts_tenant_export_fk",
      columns: [table.tenantId, table.exportId],
      foreignColumns: [shiftExports.tenantId, shiftExports.id],
    }),
    check("shift_export_artifacts_part_number_positive", sql`${table.partNumber} > 0`),
    check(
      "shift_export_artifacts_physical_line_count_positive",
      sql`${table.physicalLineCount} > 0`,
    ),
    check("shift_export_artifacts_code_count_positive", sql`${table.codeCount} > 0`),
    check("shift_export_artifacts_box_count_nonnegative", sql`${table.boxCount} >= 0`),
    check("shift_export_artifacts_byte_size_positive", sql`${table.byteSize} > 0`),
    check("shift_export_artifacts_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type ShiftExport = typeof shiftExports.$inferSelect;
export type NewShiftExport = typeof shiftExports.$inferInsert;
export type ShiftExportArtifact = typeof shiftExportArtifacts.$inferSelect;
export type NewShiftExportArtifact = typeof shiftExportArtifacts.$inferInsert;
