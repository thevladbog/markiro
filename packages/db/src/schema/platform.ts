import {
  boolean,
  char,
  date,
  foreignKey,
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
import { labelTemplates } from "./labels.js";

export const productStatus = pgEnum("product_status", ["draft", "active"]);
export const shiftStatus = pgEnum("shift_status", ["planned", "active", "closed"]);
export const shiftMode = pgEnum("shift_mode", ["validation", "aggregation"]);
export const shiftOrigin = pgEnum("shift_origin", ["admin", "station"]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    gln: text("gln").notNull(),
    inn: text("inn"),
    gs1Prefixes: text("gs1_prefixes").array().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // (tenant_id, id) UNIQUE lets other tenants' tables target a
  // same-tenant row via a composite FK — see products/shifts below.
  (t) => [unique("counterparties_tenant_id_uq").on(t.tenantId, t.id)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    gtin14: char("gtin14", { length: 14 }).notNull(),
    name: text("name").notNull(),
    productGroup: text("product_group"),
    boxCapacity: integer("box_capacity"),
    palletCapacity: integer("pallet_capacity"),
    status: productStatus("status").notNull().default("draft"),
    defaultCounterpartyId: uuid("default_counterparty_id"),
    defaultLabelTemplateId: uuid("default_label_template_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_tenant_gtin_uq").on(t.tenantId, t.gtin14),
    unique("products_tenant_id_uq").on(t.tenantId, t.id),
    // Composite FK: default_counterparty_id must belong to the same
    // tenant as the product referencing it.
    foreignKey({
      name: "products_tenant_default_counterparty_fk",
      columns: [t.tenantId, t.defaultCounterpartyId],
      foreignColumns: [counterparties.tenantId, counterparties.id],
    }),
    // Composite FK: default_label_template_id must belong to the same
    // tenant as the product referencing it (plan-04 Task 7).
    foreignKey({
      name: "products_tenant_default_label_template_fk",
      columns: [t.tenantId, t.defaultLabelTemplateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
  ],
);

export const lines = pgTable(
  "lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("lines_tenant_id_uq").on(t.tenantId, t.id)],
);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    lineId: uuid("line_id"),
    counterpartyId: uuid("counterparty_id"),
    labelTemplateId: uuid("label_template_id"),
    status: shiftStatus("status").notNull().default("planned"),
    mode: shiftMode("mode").notNull(),
    plannedQty: integer("planned_qty"),
    boxCapacity: integer("box_capacity"),
    palletCapacity: integer("pallet_capacity"),
    palletsEnabled: boolean("pallets_enabled").notNull().default(false),
    createdFrom: shiftOrigin("created_from").notNull().default("admin"),
    plannedDate: date("planned_date"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("shifts_tenant_id_uq").on(t.tenantId, t.id),
    // Composite FKs: product/line/counterparty must belong to the same
    // tenant as the shift referencing them. line_id/counterparty_id are
    // nullable — MATCH SIMPLE (the default) means a NULL skips the check.
    foreignKey({
      name: "shifts_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "shifts_tenant_line_fk",
      columns: [t.tenantId, t.lineId],
      foreignColumns: [lines.tenantId, lines.id],
    }),
    foreignKey({
      name: "shifts_tenant_counterparty_fk",
      columns: [t.tenantId, t.counterpartyId],
      foreignColumns: [counterparties.tenantId, counterparties.id],
    }),
    // label_template_id is nullable — MATCH SIMPLE means a NULL skips the
    // check; a shift may have no effective label template (plan-04 Task 7).
    foreignKey({
      name: "shifts_tenant_label_template_fk",
      columns: [t.tenantId, t.labelTemplateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
  ],
);
