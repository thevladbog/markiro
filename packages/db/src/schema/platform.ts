import {
  boolean,
  char,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

export const productStatus = pgEnum("product_status", ["draft", "active"]);
export const shiftStatus = pgEnum("shift_status", ["planned", "active", "closed"]);
export const shiftMode = pgEnum("shift_mode", ["validation", "aggregation"]);
export const shiftOrigin = pgEnum("shift_origin", ["admin", "station"]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

export const counterparties = pgTable("counterparties", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  gln: text("gln").notNull(),
  inn: text("inn"),
  gs1Prefixes: text("gs1_prefixes").array().notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    defaultCounterpartyId: uuid("default_counterparty_id").references(() => counterparties.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("products_tenant_gtin_uq").on(t.tenantId, t.gtin14)],
);

export const lines = pgTable("lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shifts = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  lineId: uuid("line_id").references(() => lines.id),
  counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
