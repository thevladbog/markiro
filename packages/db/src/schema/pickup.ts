import {
  boolean, foreignKey, integer, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth.js";
import { products } from "./platform.js";

export const employeeStatus = pgEnum("employee_status", ["active", "archived"]);
export const kioskStatus = pgEnum("kiosk_status", ["active", "archived"]);
export const pickupReason = pgEnum("pickup_reason", ["buy", "writeoff"]);
export const pickupOrderStatus = pgEnum("pickup_order_status", [
  "pending", "punched", "writtenoff", "cancelled",
]);

const tenantId = () =>
  text("tenant_id").notNull().references(() => organization.id);

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    fullName: text("full_name").notNull(),
    role: text("role"),
    status: employeeStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("employees_tenant_id_uq").on(t.tenantId, t.id)],
);

export const employeeBadges = pgTable(
  "employee_badges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    employeeId: uuid("employee_id").notNull(),
    badgeCode: text("badge_code").notNull(),
    label: text("label"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "employee_badges_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    // One active badge code per tenant (revoked codes may be reissued).
    uniqueIndex("employee_badges_tenant_code_active_uq")
      .on(t.tenantId, t.badgeCode)
      .where(sql`revoked_at is null`),
  ],
);

export const kiosks = pgTable(
  "kiosks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    location: text("location"),
    deviceTokenHash: text("device_token_hash"),
    dayLimitPerEmployee: integer("day_limit_per_employee").notNull().default(5),
    showPrices: boolean("show_prices").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    status: kioskStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosks_tenant_id_uq").on(t.tenantId, t.id),
    // device_token_hash is a deterministic sha256, unique when present.
    uniqueIndex("kiosks_device_token_uq").on(t.deviceTokenHash).where(sql`device_token_hash is not null`),
  ],
);

export const kioskProducts = pgTable(
  "kiosk_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kioskId: uuid("kiosk_id").notNull(),
    productId: uuid("product_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosk_products_uq").on(t.tenantId, t.kioskId, t.productId),
    foreignKey({
      name: "kiosk_products_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    foreignKey({
      name: "kiosk_products_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);

export const pickupOrderReasons = pgTable(
  "pickup_order_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("pickup_order_reasons_tenant_id_uq").on(t.tenantId, t.id)],
);

// Per-tenant monotonic counter for ORD-ГГ-НННН. One row per tenant, created
// lazily on first order (INSERT ... ON CONFLICT DO UPDATE ... RETURNING seq).
export const pickupOrderCounters = pgTable("pickup_order_counters", {
  tenantId: text("tenant_id").primaryKey().references(() => organization.id),
  seq: integer("seq").notNull().default(0),
});

export const pickupOrders = pgTable(
  "pickup_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderNo: text("order_no").notNull(),
    kioskId: uuid("kiosk_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    reason: pickupReason("reason").notNull(),
    writeoffReasonId: uuid("writeoff_reason_id"),
    status: pickupOrderStatus("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull(),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }),
    receiptNo: text("receipt_no"),
    actNo: text("act_no"),
    deviceSeq: integer("device_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
  },
  (t) => [
    unique("pickup_orders_tenant_id_uq").on(t.tenantId, t.id),
    unique("pickup_orders_tenant_order_no_uq").on(t.tenantId, t.orderNo),
    // Idempotent sync: a (kiosk, deviceSeq) pair maps to one order. NULL
    // deviceSeq rows (admin-created, if ever) are exempt (MATCH SIMPLE).
    unique("pickup_orders_kiosk_device_seq_uq").on(t.tenantId, t.kioskId, t.deviceSeq),
    foreignKey({
      name: "pickup_orders_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    foreignKey({
      name: "pickup_orders_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "pickup_orders_tenant_reason_fk",
      columns: [t.tenantId, t.writeoffReasonId],
      foreignColumns: [pickupOrderReasons.tenantId, pickupOrderReasons.id],
    }),
  ],
);

export const pickupOrderItems = pgTable(
  "pickup_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    productId: uuid("product_id").notNull(),
    gtin14: text("gtin14").notNull(),
    serial: text("serial").notNull(),
    rawKm: text("raw_km").notNull(),
    kmKey: text("km_key").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    voided: boolean("voided").notNull().default(false),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("pickup_order_items_order_kmkey_uq").on(t.tenantId, t.orderId, t.kmKey),
    // A physical unit can be in only ONE non-cancelled order at a time.
    uniqueIndex("pickup_order_items_tenant_kmkey_open_uq")
      .on(t.tenantId, t.kmKey)
      .where(sql`voided = false`),
    foreignKey({
      name: "pickup_order_items_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [pickupOrders.tenantId, pickupOrders.id],
    }),
    foreignKey({
      name: "pickup_order_items_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);
