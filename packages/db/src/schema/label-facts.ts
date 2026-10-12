import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  char,
  timestamp,
  jsonb,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { shifts, stationDevices } from "./platform.js";
export const unitLabelFacts = pgTable(
  "unit_label_facts",
  {
    tenantId: text("tenant_id").notNull(),
    shiftId: uuid("shift_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    fact: jsonb("fact").$type<Record<string, unknown>>().notNull(),
    digest: char("digest", { length: 64 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.shiftId, t.codeHash, t.acceptedAt] }),
    foreignKey({ columns: [t.tenantId, t.shiftId], foreignColumns: [shifts.tenantId, shifts.id] }),
    foreignKey({
      columns: [t.tenantId, t.sourceDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check("unit_label_facts_json_check", sql`jsonb_typeof(${t.fact})='object'`),
    check("unit_label_facts_digest_check", sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
  ],
);
