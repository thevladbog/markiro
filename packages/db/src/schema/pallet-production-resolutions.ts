import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  char,
  jsonb,
  primaryKey,
  foreignKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { stationDevices } from "./platform.js";
import { palletLabelSources } from "./pallet-label-sources.js";
export const palletProductionResolutions = pgTable(
  "pallet_production_resolutions",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    sourceDeviceId: uuid("source_device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    sscc: char("sscc", { length: 18 }).notNull(),
    sourceRevision: char("source_revision", { length: 64 }).notNull(),
    attemptId: text("attempt_id").notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sourceDeviceId, t.eventId] }),
    foreignKey({
      columns: [t.tenantId, t.sourceDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.sscc],
      foreignColumns: [palletLabelSources.tenantId, palletLabelSources.sscc],
    }),
    uniqueIndex("pallet_production_resolution_attempt_idx").on(
      t.tenantId,
      t.sourceDeviceId,
      t.sscc,
      t.sourceRevision,
      t.attemptId,
    ),
    check(
      "pallet_production_resolutions_digest_check",
      sql`${t.digest} ~ '^[a-f0-9]{64}$' AND ${t.sourceRevision} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "pallet_production_resolutions_value_check",
      sql`jsonb_typeof(${t.value})='object' AND octet_length(${t.value}::text)<8192`,
    ),
  ],
);
