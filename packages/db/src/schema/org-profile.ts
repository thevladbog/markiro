import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Single-tenant-row table: one org profile per organization, keyed directly
 * on tenant_id (no synthetic id, no composite FK needed -- unlike the
 * multi-row platform tables in platform.ts, there's nothing else that could
 * reference a specific org_profiles row).
 */
export const orgProfiles = pgTable("org_profiles", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  gln: text("gln"),
  gs1Prefixes: text("gs1_prefixes").array().notNull().default([]),
  inn: text("inn"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
