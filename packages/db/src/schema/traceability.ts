import { sql } from "drizzle-orm";
import { check, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";

export const traceabilityProfileCode = pgEnum("traceability_profile_code", [
  "RU_CHZ",
  "US_FSMA204_PROCESSOR",
  "US_GENERIC_LOT_TRACEABILITY",
]);

export const traceabilityProfiles = pgTable(
  "traceability_profiles",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    code: traceabilityProfileCode("code").notNull(),
    baselineVersion: text("baseline_version"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    retentionYears: integer("retention_years").notNull().default(5),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "traceability_profiles_baseline_for_us",
      sql`${table.code} = 'RU_CHZ' OR (${table.baselineVersion} IS NOT NULL AND length(btrim(${table.baselineVersion})) > 0)`,
    ),
    check("traceability_profiles_retention_min", sql`${table.retentionYears} >= 2`),
  ],
);
