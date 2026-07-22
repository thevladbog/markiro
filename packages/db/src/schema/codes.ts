// Query-only defs; DDL lives in migrations/0002_partitioned_codes.sql and
// migrations/0003_tenant_composite_fks.sql — do NOT let drizzle-kit
// generate these. This file is excluded from drizzle.config.ts's `schema`
// list, so drizzle can't express the composite tenant FK here; codes.tenant_id
// + shift_id and scan_events.tenant_id + shift_id both carry a
// DB-authoritative composite FK to shifts(tenant_id, id)
// (codes_tenant_shift_fk / scan_events_tenant_shift_fk) enforcing that a
// shift_id belongs to the same tenant as the code/scan event referencing it.
import { char, pgTable, text, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";

export const codes = pgTable(
  "codes",
  {
    tenantId: text("tenant_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    shiftId: uuid("shift_id").notNull(),
    gtin14: char("gtin14", { length: 14 }).notNull(),
    serial: text("serial").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.codeHash, t.scannedAt] })],
);

export const scanEvents = pgTable("scan_events", {
  tenantId: text("tenant_id").notNull(),
  shiftId: uuid("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
});
