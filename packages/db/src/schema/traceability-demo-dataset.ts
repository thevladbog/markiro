import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** One immutable large synthetic dataset per tenant, independent of compact seeds. */
export const traceabilityDemoDatasets = pgTable(
  "traceability_demo_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    version: text("version").notNull(),
    definitionDigest: text("definition_digest").notNull(),
    manifest: jsonb("manifest").$type<Readonly<Record<string, unknown>>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("traceability_demo_datasets_scope_uq").on(t.tenantId, t.id),
    unique("traceability_demo_datasets_tenant_uq").on(t.tenantId),
    check(
      "traceability_demo_datasets_version_valid",
      sql`${t.version} = 'us-processor-six-month-v1'`,
    ),
    check("traceability_demo_datasets_digest_valid", sql`${t.definitionDigest} ~ '^[a-f0-9]{64}$'`),
    // Storage expansion allowance only; application evidence stays within 256 KiB.
    check(
      "traceability_demo_datasets_manifest_valid",
      sql`jsonb_typeof(${t.manifest}) = 'object' AND octet_length(${t.manifest}::text) <= 16777216`,
    ),
  ],
);

/** Bounded unit-stage intent and its single completion receipt. */
export const traceabilityDemoDatasetStages = pgTable(
  "traceability_demo_dataset_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    datasetId: uuid("dataset_id").notNull(),
    unitKey: text("unit_key").notNull(),
    stage: text("stage").notNull(),
    revision: integer("revision").notNull().default(1),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    input: jsonb("input").$type<Readonly<Record<string, unknown>>>().notNull(),
    receipt: jsonb("receipt").$type<Readonly<Record<string, unknown>>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("traceability_demo_dataset_stages_stage_uq").on(
      t.tenantId,
      t.datasetId,
      t.unitKey,
      t.stage,
    ),
    unique("traceability_demo_dataset_stages_operation_uq").on(
      t.tenantId,
      t.datasetId,
      t.operationKey,
    ),
    foreignKey({
      name: "traceability_demo_dataset_stages_dataset_fk",
      columns: [t.tenantId, t.datasetId],
      foreignColumns: [traceabilityDemoDatasets.tenantId, traceabilityDemoDatasets.id],
    }),
    check("traceability_demo_dataset_stages_revision_valid", sql`${t.revision} BETWEEN 1 AND 2`),
    check(
      "traceability_demo_dataset_stages_completion_valid",
      sql`(${t.revision} = 1 AND ${t.receipt} IS NULL) OR (${t.revision} = 2 AND ${t.receipt} IS NOT NULL)`,
    ),
    check(
      "traceability_demo_dataset_stages_digest_valid",
      sql`${t.inputDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "traceability_demo_dataset_stages_unit_valid",
      sql`${t.unitKey} ~ '^[a-z][a-z0-9_-]{0,63}$'`,
    ),
    check(
      "traceability_demo_dataset_stages_stage_valid",
      sql`${t.stage} IN ('references','receiving','amend_receiving','void_receiving','transformation','cases','shipping','trace_readiness','plan','request','package')`,
    ),
    // PostgreSQL JSONB representation can expand bounded API evidence.
    check(
      "traceability_demo_dataset_stages_input_valid",
      sql`jsonb_typeof(${t.input}) = 'object' AND octet_length(${t.input}::text) <= 16777216`,
    ),
    check(
      "traceability_demo_dataset_stages_receipt_valid",
      sql`${t.receipt} IS NULL OR (jsonb_typeof(${t.receipt}) = 'object' AND octet_length(${t.receipt}::text) <= 16777216)`,
    ),
  ],
);
