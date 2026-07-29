import {
  bigint,
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
import { employees } from "./pickup.js";

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
    /**
     * Whose numbers this shift's boxes carry. Null means the tenant's own
     * organisation. Deliberately NOT inferred from `counterpartyId`: that
     * field answers "who is this for", this one answers "whose numbers".
     * Packing for a client under one's own SSCCs is legal and common, and
     * inferring one from the other would silently produce a wrong number,
     * discovered at the recipient's goods-in.
     */
    ssccIssuerCounterpartyId: uuid("sscc_issuer_counterparty_id"),
    boxLabelTemplateId: uuid("box_label_template_id"),
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
    foreignKey({
      name: "shifts_tenant_sscc_issuer_fk",
      columns: [t.tenantId, t.ssccIssuerCounterpartyId],
      foreignColumns: [counterparties.tenantId, counterparties.id],
    }),
    foreignKey({
      name: "shifts_tenant_box_label_template_fk",
      columns: [t.tenantId, t.boxLabelTemplateId],
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

/**
 * One serial counter per (tenant, issuer prefix, extension digit).
 *
 * Keyed by the 9-digit issuer PREFIX, not the full 13-digit GLN, because the
 * prefix — not the GLN — is the number space's identity: an SSCC's serial is
 * unique only within (extension digit, issuer prefix), and one GS1 member
 * commonly holds several GLNs (one per location) that share the same first 9
 * digits and differ only in the location digits after it. Keying on the full
 * GLN would give each of those GLNs its own counter, and two counters both
 * handing out serial 100 under the same prefix produces the exact same
 * SSCC — the collision this slice's one-statement allocation exists to
 * prevent. `nextSerial` is what an administrator seeds when migrating off
 * another system that issued SSCCs under the same prefix. Allocation is one
 * statement; see SsccService.
 */
export const ssccCounters = pgTable(
  "sscc_counters",
  {
    tenantId: tenantId(),
    issuerPrefix: char("issuer_prefix", { length: 9 }).notNull(),
    extensionDigit: integer("extension_digit").notNull(),
    nextSerial: bigint("next_serial", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.issuerPrefix, t.extensionDigit] })],
);

/**
 * Which device received which serial range. Not bookkeeping for its own sake:
 * a ten-million space per extension digit runs low only slowly, and when it
 * does the only way to find out where it went is to have written it down.
 *
 * Keyed by the same 9-digit issuer prefix as `ssccCounters` above, for the
 * same reason: the prefix, not the GLN, identifies the number space a block
 * was cut from, and several GLNs can share one prefix.
 */
export const ssccBlocks = pgTable(
  "sscc_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    issuerPrefix: char("issuer_prefix", { length: 9 }).notNull(),
    extensionDigit: integer("extension_digit").notNull(),
    deviceId: uuid("device_id").notNull(),
    fromSerial: bigint("from_serial", { mode: "number" }).notNull(),
    toSerial: bigint("to_serial", { mode: "number" }).notNull(),
    /**
     * The highest serial in this range known to have been used, or null
     * before any is. Set by `SsccService.recordConsumedSerial`, the moment a
     * box closure at ingest names a real SSCC -- the only point the server
     * ever learns a serial actually got printed rather than merely handed
     * out. Without this, a device that loses its local database re-provisions
     * from scratch, receives this same range back from the bundle, and
     * restarts its cursor at `fromSerial`, reprinting serials already on
     * boxes (caught only later, and only at ingest, by
     * `boxes_tenant_sscc_uq`). The bundle uses it to hand back the
     * unconsumed remainder instead of the whole range -- see
     * `SsccService.allocateForBundle`.
     */
    consumedThroughSerial: bigint("consumed_through_serial", { mode: "number" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FK: device_id must belong to the same tenant as the sscc
    // block referencing it — same shape as shifts' own FKs above. Unlike
    // those, device_id is NOT NULL: a block always records the device that
    // received it, so MATCH SIMPLE's null-skip never applies here.
    foreignKey({
      name: "sscc_blocks_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
  ],
);

/**
 * A transport box. The row is created when its FIRST ITEM arrives, not when
 * the closure event does: items are queued before the closure and the drain
 * is sequential, so this needs no buffering and no out-of-order handling.
 * A box with a null `sscc` is one whose closure has not arrived yet — which
 * is also exactly what an open box on the device looks like.
 */
export const boxes = pgTable(
  "boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    shiftId: uuid("shift_id").notNull(),
    terminalId: text("terminal_id"),
    deviceBoxId: text("device_box_id").notNull(),
    sscc: char("sscc", { length: 18 }),
    operatorId: uuid("operator_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    printVerifiedAt: timestamp("print_verified_at", { withTimezone: true }),
    printSkippedAt: timestamp("print_skipped_at", { withTimezone: true }),
  },
  (t) => [
    unique("boxes_tenant_id_uq").on(t.tenantId, t.id),
    // Two devices holding overlapping pools is precisely the situation
    // nothing else would reveal. An index, not a check in code.
    unique("boxes_tenant_sscc_uq").on(t.tenantId, t.sscc),
    // A device's own id for the box, unique within its shift and terminal:
    // this is what an arriving scan carries instead of a server id.
    //
    // `.nullsNotDistinct()` is load-bearing, not cosmetic: `terminalId` is
    // nullable (a device that has no notion of "terminal" sends `null`), and
    // a PLAIN unique index treats every NULL as distinct from every other,
    // so `ON CONFLICT (tenant_id, shift_id, terminal_id, device_box_id)`
    // would never fire for a null-terminal device -- each batch would insert
    // a NEW box row instead of resolving to the one already open, scattering
    // one box's items across several rows, and a later closure naming that
    // device_box_id would then match all of them and try to write the same
    // sscc to each, raising boxes_tenant_sscc_uq's 23505. `NULLS NOT
    // DISTINCT` (Postgres 15+; this project runs 17) makes two null-terminal
    // rows for the same (tenant, shift, device_box_id) collide exactly like
    // two non-null ones would, so the upsert's conflict arbiter fires either
    // way.
    //
    // drizzle-kit 0.31.10 CAN regenerate this correctly from
    // `.nullsNotDistinct()` (it understands the flag when diffing/rendering
    // `UNIQUE` constraints), but regenerating migration 0018 here was
    // avoided anyway: each prior regeneration of this same migration has
    // cost a dev-database recreate. `boxes` (and this constraint) are
    // themselves created BY migration 0018, so the fix is a direct hand-edit
    // of that CREATE TABLE statement's own inline constraint clause --
    // `UNIQUE NULLS NOT DISTINCT(...)` in place of `UNIQUE(...)` -- in
    // migrations/0018_gigantic_texas_twister.sql, not a separate appended
    // statement (unlike scan_events' hand-migrated ALTERs further down that
    // same file, which target a table that migration doesn't create). THAT
    // hand-edited DDL is authoritative for what actually exists in the
    // database; the `.nullsNotDistinct()` call here exists so drizzle-kit's
    // introspection of a live database (and any future `db:generate` diff)
    // agrees with the schema instead of proposing to "fix" it back to a
    // plain UNIQUE.
    unique("boxes_device_box_uq")
      .on(t.tenantId, t.shiftId, t.terminalId, t.deviceBoxId)
      .nullsNotDistinct(),
    foreignKey({
      name: "boxes_tenant_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    // operator_id is nullable — MATCH SIMPLE (the default) means a NULL
    // skips the check; a box may close before an operator is attributed.
    foreignKey({
      name: "boxes_tenant_operator_fk",
      columns: [t.tenantId, t.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
  ],
);

/**
 * A code's membership of a box. `displacedAt` marks an item whose code is
 * owned by another scan (06b's rule: the earlier scannedAt wins). It is
 * marked, never deleted — the row is the only evidence of what happened,
 * and it does not count towards the box's contents.
 */
export const boxItems = pgTable(
  "box_items",
  {
    tenantId: tenantId(),
    boxId: uuid("box_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    displacedAt: timestamp("displaced_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.boxId, t.codeHash] }),
    index("box_items_tenant_code_idx").on(t.tenantId, t.codeHash),
    foreignKey({
      name: "box_items_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
  ],
);
