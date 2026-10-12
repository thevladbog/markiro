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

/** Durable synthetic scenario identity; actor evidence outlives cabinet accounts. */
export const traceabilityDemoSeeds = pgTable(
  "traceability_demo_seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    scenarioVersion: text("scenario_version").notNull(),
    definitionDigest: text("definition_digest").notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("traceability_demo_seeds_scope_uq").on(t.tenantId, t.id),
    unique("traceability_demo_seeds_scenario_uq").on(t.tenantId, t.scenarioVersion),
    check("traceability_demo_seeds_revision_positive", sql`${t.revision} > 0`),
    check("traceability_demo_seeds_digest_valid", sql`${t.definitionDigest} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Intent precedes business work; a nullable receipt records one stage's result. */
export const traceabilityDemoSeedStages = pgTable(
  "traceability_demo_seed_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    seedId: uuid("seed_id").notNull(),
    stage: text("stage").notNull(),
    revision: integer("revision").notNull().default(1),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    receipt: jsonb("receipt").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("traceability_demo_seed_stages_stage_uq").on(t.tenantId, t.seedId, t.stage),
    unique("traceability_demo_seed_stages_operation_uq").on(t.tenantId, t.seedId, t.operationKey),
    foreignKey({
      name: "traceability_demo_seed_stages_seed_fk",
      columns: [t.tenantId, t.seedId],
      foreignColumns: [traceabilityDemoSeeds.tenantId, traceabilityDemoSeeds.id],
    }),
    check("traceability_demo_seed_stages_revision_positive", sql`${t.revision} > 0`),
    check("traceability_demo_seed_stages_digest_valid", sql`${t.inputDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      "traceability_demo_seed_stages_stage_valid",
      sql`${t.stage} IN ('references','receiving','transformation','cases','shipping','trace_readiness','plan','request','package')`,
    ),
    // Storage ceilings allow JSONB finite-number decimal expansion, whitespace
    // and receipt envelope (64 times the compact input/result codec ceiling).
    // The API codec separately bounds each compact input/result to 256 KiB.
    check(
      "traceability_demo_seed_stages_input_valid",
      sql`jsonb_typeof(${t.input}) = 'object' AND octet_length(${t.input}::text) <= 16777216`,
    ),
    check(
      "traceability_demo_seed_stages_receipt_valid",
      sql`${t.receipt} IS NULL OR (jsonb_typeof(${t.receipt}) = 'object' AND octet_length(${t.receipt}::text) <= 16777216)`,
    ),
  ],
);
