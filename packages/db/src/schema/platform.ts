import {
  boolean,
  char,
  date,
  foreignKey,
  index,
  integer,
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
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    egaisCode: text("egais_code"),
    externalRef: text("external_ref"),
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
    /**
     * When scans first arrived for this shift AFTER it was closed. Set once
     * and never overwritten, so it marks the shift rather than tracking the
     * most recent straggler. The cabinet shows it, because a manager who has
     * already reported on a closed shift must find out that its totals moved.
     */
    lateDataAt: timestamp("late_data_at", { withTimezone: true }),
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

/**
 * Idempotency keys for station sync batches. A batch is applied and its key
 * recorded in ONE transaction, so a retried batch is a no-op in its entirety.
 */
export const syncBatches = pgTable(
  "sync_batches",
  {
    tenantId: tenantId(),
    batchId: text("batch_id").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.batchId] })],
);

/**
 * The scan that currently OWNS each code, across every terminal. Deliberately
 * unpartitioned and keyed by the code alone: `codes` cannot enforce one row
 * per code, because a unique index on a partitioned table must include the
 * partition key and `scanned_at` is it. This table is the authority, probed
 * by primary key so the ingest hot path never scans a partitioned table.
 *
 * Tenant-wide rather than shift-scoped, matching the device mirror: a KM
 * identifies one physical item, so the same code in two shifts is also an
 * error worth catching.
 */
export const codeRegistry = pgTable(
  "code_registry",
  {
    tenantId: tenantId(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    shiftId: uuid("shift_id").notNull(),
    terminalId: text("terminal_id"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.codeHash] }),
    // Composite FK: shift_id must belong to the same tenant as the
    // registry row referencing it — same shape as shifts' own FKs to
    // products/lines/counterparties above.
    foreignKey({
      name: "code_registry_tenant_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
  ],
);

/** One row per losing scan, in both directions — see conflict-resolution.ts. */
export const codeConflicts = pgTable(
  "code_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    losingShiftId: uuid("losing_shift_id").notNull(),
    losingTerminalId: text("losing_terminal_id"),
    losingScannedAt: timestamp("losing_scanned_at", { withTimezone: true }).notNull(),
    winningShiftId: uuid("winning_shift_id").notNull(),
    winningTerminalId: text("winning_terminal_id"),
    winningScannedAt: timestamp("winning_scanned_at", { withTimezone: true }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    index("code_conflicts_shift_idx").on(t.tenantId, t.losingShiftId),
    // Composite FKs: both the losing and winning shift must belong to the
    // same tenant as the conflict row itself — same shape as shifts' own
    // FKs to products/lines/counterparties above.
    foreignKey({
      name: "code_conflicts_tenant_losing_shift_fk",
      columns: [t.tenantId, t.losingShiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    foreignKey({
      name: "code_conflicts_tenant_winning_shift_fk",
      columns: [t.tenantId, t.winningShiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
  ],
);

export const stationDevices = pgTable(
  "station_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    // References better-auth's apikey.id (text). Not a composite tenant FK:
    // apikey is a Better Auth-managed table without a (tenant_id, id) unique.
    apiKeyId: text("api_key_id").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [unique("station_devices_tenant_id_uq").on(t.tenantId, t.id)],
);
