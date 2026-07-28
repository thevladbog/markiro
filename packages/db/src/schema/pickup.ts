import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth.js";
import { products } from "./platform.js";

export const employeeStatus = pgEnum("employee_status", ["active", "archived"]);
export const kioskStatus = pgEnum("kiosk_status", ["active", "archived"]);
export const pickupReason = pgEnum("pickup_reason", ["buy", "writeoff"]);
export const pickupOrderStatus = pgEnum("pickup_order_status", [
  "pending",
  "punched",
  "writtenoff",
  "cancelled",
]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

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
    badgeHash: text("badge_hash"),
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

/**
 * Station access for an employee (1:1). An operator is NOT a separate person
 * record: `employees` stays the single people registry and `employee_badges`
 * the single badge registry (badge codes are shared identifiers used by the
 * pickup kiosk and external systems). Only employees WITH a row here appear in
 * the line station's roster. `pinHash` is a PBKDF2 PHC verifier byte-compatible
 * with apps/station/src/lib/crypto.ts — plaintext PINs are never stored.
 */
export const operatorCredentials = pgTable(
  "operator_credentials",
  {
    tenantId: tenantId(),
    employeeId: uuid("employee_id").notNull(),
    login: text("login").notNull(),
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employeeId] }),
    foreignKey({
      name: "operator_credentials_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    // The personnel number the operator types on the station keypad.
    unique("operator_credentials_tenant_login_uq").on(t.tenantId, t.login),
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
    uniqueIndex("kiosks_device_token_uq")
      .on(t.deviceTokenHash)
      .where(sql`device_token_hash is not null`),
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
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
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
    // Items the server refused at sync time (OrderConflict[]). An offline
    // order can arrive hours late, so the admin must be able to see what was
    // dropped; without this the conflicts only ever existed in the HTTP
    // response the kiosk got.
    syncConflicts: jsonb("sync_conflicts").$type<{ rawKm: string; reason: string }[]>(),
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

/**
 * One badge salt per tenant. Badge verifiers deliberately share a salt within
 * a tenant so a kiosk can derive ONCE per scan and look the digest up in a
 * map, instead of running PBKDF2 against every employee (that would take
 * seconds on a full staff roster). PIN verifiers keep their per-row salt —
 * a 4-digit PIN needs it.
 */
export const employeeBadgeSalts = pgTable("employee_badge_salts", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  salt: text("salt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-use device pairing codes. Only the hash is stored; the plaintext is
 * revealed once in the cabinet. `attempts` drives the per-code lockout.
 */
export const kioskPairingCodes = pgTable(
  "kiosk_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kioskId: uuid("kiosk_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosk_pairing_codes_tenant_id_uq").on(t.tenantId, t.id),
    // Lookup path for the unauthenticated exchange: the device presents only
    // a code, so this index is what makes that a single hash probe.
    index("kiosk_pairing_codes_hash_idx").on(t.codeHash),
    foreignKey({
      name: "kiosk_pairing_codes_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    // At most one live code per kiosk. The retire-then-insert in
    // PairingService is two statements, so without this a double-submit
    // could leave two codes redeemable at once — the invariant has to be
    // enforced by the database, not by statement ordering.
    uniqueIndex("kiosk_pairing_codes_one_live_uq")
      .on(t.tenantId, t.kioskId)
      .where(sql`used_at is null`),
    // At most one LIVE row per code_hash, across every tenant. The exchange
    // (`attemptRedeem`) looks a device up by hash alone with no tenant
    // context yet, so two simultaneously-live codes sharing a hash would be
    // ambiguous — today it refuses both rather than guess, which would
    // permanently 401 a legitimately issued code with no diagnosable cause.
    // `issueCode`'s SELECT-then-INSERT clash check races on this same
    // invariant; this is the DB-enforced backstop that actually closes it.
    // Partial (`WHERE used_at is null`) so a hash CAN be reused once its
    // live code is spent/retired — a full unique index would permanently
    // block ever reissuing that hash again.
    uniqueIndex("kiosk_pairing_codes_code_hash_live_uq")
      .on(t.codeHash)
      .where(sql`used_at is null`),
  ],
);

/**
 * `POST /kiosk/pair` attempts per source, in fixed windows. The per-code
 * attempt counter cannot bound guessing (a wrong guess matches no code row,
 * so there is nothing to count against), and this route is unauthenticated
 * by design — so this table is the only workable limiter.
 *
 * One row per `(source, windowStartedAt)`. `source` is either the caller's
 * resolved address (an IPv6 address normalised to its /64 prefix -- see
 * `normalizePairSource` in the API) or the reserved literal `"*"` for the
 * global backstop bucket that every attempt also counts toward, so it can
 * never grow past the number of distinct sources seen in a window plus one.
 *
 * `failures` is written by an atomic `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` (record-then-check, not check-then-record — the column is kept
 * under its original name to avoid another migration, but it counts every
 * attempt through the route up front, successes included, not only failed
 * ones). A successful redemption then issues a compensating atomic
 * decrement (floored at zero), so the column's steady-state value bounds
 * net failures again rather than capping legitimate high-volume
 * provisioning -- see `PairingService.redeem`/`refundPairAttempt` in the
 * API.
 */
export const kioskPairAttempts = pgTable(
  "kiosk_pair_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    failures: integer("failures").notNull().default(0),
  },
  (t) => [unique("kiosk_pair_attempts_source_window_uq").on(t.source, t.windowStartedAt)],
);
