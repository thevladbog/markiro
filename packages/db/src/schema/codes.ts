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
