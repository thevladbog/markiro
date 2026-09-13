import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { employees } from "./pickup.js";
import { shifts, stationDevices } from "./platform.js";

/** Historical ordinary acceptance identity; release affects only code_registry ownership. */
export const validationCodeAcceptances = pgTable(
  "validation_code_acceptances",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    shiftId: uuid("shift_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    terminalId: text("terminal_id"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.shiftId, t.codeHash] }),
    foreignKey({
      name: "validation_acceptance_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    check("validation_acceptance_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Accepted occurrences only. Competing losing scans stay in scan_events/code_conflicts. */
export const validationCodeReprocessings = pgTable(
  "validation_code_reprocessings",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    shiftId: uuid("shift_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    sourceShiftId: uuid("source_shift_id").notNull(),
    terminalId: uuid("terminal_id").notNull(),
    operatorId: uuid("operator_id"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    canonicalRaw: text("canonical_raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.shiftId, t.codeHash] }),
    index("validation_reprocessing_hash_idx").on(t.tenantId, t.codeHash),
    foreignKey({
      name: "validation_reprocessing_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    foreignKey({
      name: "validation_reprocessing_source_fk",
      columns: [t.tenantId, t.sourceShiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    foreignKey({
      name: "validation_reprocessing_device_fk",
      columns: [t.tenantId, t.terminalId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "validation_reprocessing_operator_fk",
      columns: [t.tenantId, t.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check("validation_reprocessing_distinct_shift", sql`${t.shiftId} <> ${t.sourceShiftId}`),
    check("validation_reprocessing_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Immutable, expiring device history publication; incomplete downloads never advance client cache. */
export const validationHistorySnapshots = pgTable(
  "validation_history_snapshots",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    snapshotId: char("snapshot_id", { length: 64 }).notNull(),
    shiftId: uuid("shift_id").notNull(),
    productId: uuid("product_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.snapshotId] }),
    index("validation_history_expiry_idx").on(t.tenantId, t.expiresAt),
    foreignKey({
      name: "validation_history_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    foreignKey({
      name: "validation_history_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
  ],
);

export const validationHistorySnapshotEntries = pgTable(
  "validation_history_snapshot_entries",
  {
    tenantId: text("tenant_id").notNull(),
    snapshotId: char("snapshot_id", { length: 64 }).notNull(),
    cursor: text("cursor").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    kind: text("kind").$type<"original" | "reprocessing">().notNull(),
    shiftId: uuid("shift_id").notNull(),
    shiftNumber: text("shift_number").notNull(),
    shiftStatus: text("shift_status").$type<"planned" | "active" | "closed">().notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.snapshotId, t.cursor] }),
    foreignKey({
      name: "validation_history_entry_snapshot_fk",
      columns: [t.tenantId, t.snapshotId],
      foreignColumns: [validationHistorySnapshots.tenantId, validationHistorySnapshots.snapshotId],
    }).onDelete("cascade"),
    check("validation_history_kind_check", sql`${t.kind} IN ('original', 'reprocessing')`),
    check(
      "validation_history_status_check",
      sql`${t.shiftStatus} IN ('planned', 'active', 'closed')`,
    ),
  ],
);
