import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./platform.js";

export const traceabilityCoverageStatus = pgEnum("traceability_coverage_status", [
  "covered",
  "contains_ftl_same_form",
  "not_covered",
  "unknown",
  "exemption_review_required",
]);

export const productTraceabilityProfiles = pgTable(
  "product_traceability_profiles",
  {
    tenantId: text("tenant_id").notNull(),
    productId: uuid("product_id").notNull(),
    revision: integer("revision").notNull().default(1),
    productName: text("product_name").notNull(),
    brandName: text("brand_name"),
    commodity: text("commodity"),
    variety: text("variety"),
    packagingSizeValue: numeric("packaging_size_value", { precision: 12, scale: 3 }),
    packagingSizeUom: text("packaging_size_uom"),
    packagingStyle: text("packaging_style"),
    defaultQuantityUom: text("default_quantity_uom"),
    coverageStatus: traceabilityCoverageStatus("coverage_status").notNull().default("unknown"),
    coverageRationale: text("coverage_rationale"),
    ftlCategory: text("ftl_category"),
    ftlSourceUrl: text("ftl_source_url"),
    ftlSourceVersion: text("ftl_source_version"),
    // Historical opaque actor snapshot, intentionally not a mutable/deletable identity FK.
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId] }),
    foreignKey({
      name: "product_traceability_profiles_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    check("product_traceability_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "product_traceability_profiles_name_nonempty",
      sql`length(btrim(${table.productName})) BETWEEN 1 AND 200`,
    ),
    check(
      "product_traceability_profiles_size_pair",
      sql`(${table.packagingSizeValue} IS NULL) = (${table.packagingSizeUom} IS NULL)`,
    ),
    check(
      "product_traceability_profiles_size_positive",
      sql`${table.packagingSizeValue} > 0 AND ${table.packagingSizeValue} <= 999999999.999`,
    ),
    check(
      "product_traceability_profiles_size_uom",
      sql`${table.packagingSizeUom} IN ('lb', 'oz', 'kg', 'g', 'each', 'case', 'bag', 'cup', 'gal', 'l')`,
    ),
    check(
      "product_traceability_profiles_default_uom",
      sql`${table.defaultQuantityUom} IN ('lb', 'oz', 'kg', 'g', 'each', 'case', 'bag', 'cup', 'gal', 'l')`,
    ),
    check(
      "product_traceability_profiles_review_pair",
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`,
    ),
    check(
      "product_traceability_profiles_reviewer_nonempty",
      sql`length(btrim(${table.reviewedBy})) BETWEEN 1 AND 128`,
    ),
    check(
      "product_traceability_profiles_review_required",
      sql`${table.coverageStatus} = 'unknown' OR ${table.reviewedBy} IS NOT NULL`,
    ),
  ],
);
