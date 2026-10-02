import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** Drafts and retained immutable approval evidence; actors outlive cabinet accounts. */
export const traceabilityPlanVersions = pgTable(
  "traceability_plan_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    draftRevision: integer("draft_revision").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(1),
    sections: jsonb("sections").$type<unknown>().notNull(),
    changeSummary: text("change_summary").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    configSnapshot: jsonb("config_snapshot").$type<unknown>(),
    configDigest: text("config_digest"),
    pdfObjectKey: text("pdf_object_key"),
    pdfSha256: text("pdf_sha256"),
    pdfByteSize: integer("pdf_byte_size"),
    rendererVersion: text("renderer_version"),
    supersededById: uuid("superseded_by_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    retainThrough: date("retain_through", { mode: "string" }),
  },
  (t) => [
    unique("traceability_plan_tenant_id_uq").on(t.tenantId, t.id),
    unique("traceability_plan_tenant_version_uq").on(t.tenantId, t.versionNumber),
    uniqueIndex("traceability_plan_one_draft_uq")
      .on(t.tenantId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex("traceability_plan_one_effective_uq")
      .on(t.tenantId)
      .where(sql`${t.status} = 'effective'`),
    foreignKey({
      name: "traceability_plan_superseded_by_fk",
      columns: [t.tenantId, t.supersededById],
      foreignColumns: [t.tenantId, t.id],
    }),
    check("traceability_plan_status_valid", sql`${t.status} IN ('draft','effective','superseded')`),
    check(
      "traceability_plan_versions_positive",
      sql`${t.versionNumber} > 0 AND ${t.draftRevision} > 0 AND ${t.schemaVersion} > 0`,
    ),
    check("traceability_plan_sections_object", sql`jsonb_typeof(${t.sections}) = 'object'`),
    check("traceability_plan_snapshot_object", sql`jsonb_typeof(${t.configSnapshot}) = 'object'`),
    check(
      "traceability_plan_actor_valid",
      sql`${t.createdBy} ~ '[^[:space:]]' AND ${t.approvedBy} ~ '[^[:space:]]'`,
    ),
    check(
      "traceability_plan_artifact_valid",
      sql`${t.configDigest} ~ '^[a-fA-F0-9]{64}$' AND ${t.pdfSha256} ~ '^[a-fA-F0-9]{64}$' AND ${t.pdfByteSize} > 0 AND ${t.pdfObjectKey} ~ '[^[:space:]]' AND ${t.rendererVersion} ~ '[^[:space:]]'`,
    ),
    check(
      "traceability_plan_change_summary_required",
      sql`${t.status} = 'draft' OR ${t.versionNumber} = 1 OR ${t.changeSummary} ~ '[^[:space:]]'`,
    ),
    check(
      "traceability_plan_approval_shape",
      sql`
      (${t.status} = 'draft' AND ${t.approvedBy} IS NULL AND ${t.approvedAt} IS NULL AND ${t.configSnapshot} IS NULL AND ${t.configDigest} IS NULL AND ${t.pdfObjectKey} IS NULL AND ${t.pdfSha256} IS NULL AND ${t.pdfByteSize} IS NULL AND ${t.rendererVersion} IS NULL)
      OR (${t.status} IN ('effective','superseded') AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.configSnapshot} IS NOT NULL AND ${t.configDigest} IS NOT NULL AND ${t.pdfObjectKey} IS NOT NULL AND ${t.pdfSha256} IS NOT NULL AND ${t.pdfByteSize} IS NOT NULL AND ${t.rendererVersion} IS NOT NULL)
    `,
    ),
    check(
      "traceability_plan_supersession_shape",
      sql`
      (${t.status} IN ('draft','effective') AND ${t.supersededById} IS NULL AND ${t.supersededAt} IS NULL AND ${t.retainThrough} IS NULL)
      OR (${t.status} = 'superseded' AND ${t.supersededById} IS NOT NULL AND ${t.supersededAt} IS NOT NULL AND ${t.retainThrough} IS NOT NULL)
    `,
    ),
  ],
);
