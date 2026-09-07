import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { products } from "./platform.js";
import { traceabilityLocations } from "./traceability-master-data.js";

export const tlcAssignmentBasis = pgEnum("tlc_assignment_basis", [
  "transformation",
  "initial_packing",
  "first_land_receiving",
  "exempt_supplier_receipt",
  "imported",
]);
export const traceabilityLotStatus = pgEnum("traceability_lot_status", [
  "active",
  "consumed",
  "shipped",
  "quarantined",
  "recalled",
  "archived",
]);
export const traceabilityLots = pgTable(
  "traceability_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    productId: uuid("product_id").notNull(),
    tlc: text("tlc").notNull(),
    assignmentBasis: tlcAssignmentBasis("assignment_basis").notNull(),
    sourceLocationId: uuid("source_location_id"),
    sourceReferenceKind: text("source_reference_kind"),
    sourceReferenceValue: text("source_reference_value"),
    sourceReferenceLocationId: uuid("source_reference_location_id"),
    status: traceabilityLotStatus("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    // Internal MVCC coordination token, not a support count or a business revision.
    receivingBasisVersion: integer("receiving_basis_version").notNull().default(1),
    lastStatusReason: text("last_status_reason"),
    lastSourceReason: text("last_source_reason"),
    // Finalizers set this in their transaction; the database trigger prevents reversal.
    sourceLockedAt: timestamp("source_locked_at", { withTimezone: true }),
    // Opaque historical actors are retained independently of cabinet account lifecycle.
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("traceability_lots_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      name: "traceability_lots_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "traceability_lots_source_location_fk",
      columns: [table.tenantId, table.sourceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    foreignKey({
      name: "traceability_lots_reference_location_fk",
      columns: [table.tenantId, table.sourceReferenceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    uniqueIndex("traceability_lots_location_tlc_uq")
      .on(table.tenantId, table.sourceLocationId, table.tlc)
      .where(sql`${table.sourceLocationId} IS NOT NULL`),
    uniqueIndex("traceability_lots_reference_tlc_uq")
      .on(table.tenantId, table.sourceReferenceKind, table.sourceReferenceValue, table.tlc)
      .where(sql`${table.sourceReferenceKind} IS NOT NULL`),
    uniqueIndex("traceability_lots_missing_source_tlc_uq")
      .on(table.tenantId, table.tlc)
      .where(sql`${table.sourceLocationId} IS NULL AND ${table.sourceReferenceKind} IS NULL`),
    index("traceability_lots_tenant_product_idx").on(table.tenantId, table.productId),
    index("traceability_lots_tenant_status_idx").on(table.tenantId, table.status),
    index("traceability_lots_tenant_tlc_idx").on(table.tenantId, table.tlc),
    check(
      "traceability_lots_tlc_valid",
      sql`length(${table.tlc}) BETWEEN 1 AND 120 AND ${table.tlc} = btrim(${table.tlc}) AND ${table.tlc} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    check("traceability_lots_revision_positive", sql`${table.revision} > 0`),
    check(
      "traceability_lots_receiving_basis_version_positive",
      sql`${table.receivingBasisVersion} > 0`,
    ),
    check(
      "traceability_lots_source_shape",
      sql`(${table.sourceReferenceKind} IS NULL AND ${table.sourceReferenceValue} IS NULL AND ${table.sourceReferenceLocationId} IS NULL) OR (${table.sourceLocationId} IS NULL AND ${table.sourceReferenceKind} IS NOT NULL AND ${table.sourceReferenceKind} = 'web_url' AND ${table.sourceReferenceValue} IS NOT NULL AND ${table.sourceReferenceLocationId} IS NOT NULL)`,
    ),
    check(
      "traceability_lots_reference_length",
      sql`octet_length(${table.sourceReferenceValue}) BETWEEN 1 AND 1024`,
    ),
    check(
      "traceability_lots_actor_shape",
      sql`length(btrim(${table.createdBy})) BETWEEN 1 AND 128 AND length(btrim(${table.updatedBy})) BETWEEN 1 AND 128`,
    ),
    check(
      "traceability_lots_reason_length",
      sql`length(btrim(${table.lastStatusReason})) BETWEEN 3 AND 2000`,
    ),
    check(
      "traceability_lots_source_reason_length",
      sql`length(btrim(${table.lastSourceReason})) BETWEEN 3 AND 2000`,
    ),
  ],
);
