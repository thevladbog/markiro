import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  char,
  jsonb,
  primaryKey,
  foreignKey,
  check,
  index,
  bigint,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { pallets, stationDevices } from "./platform.js";
export const palletLabelSources = pgTable(
  "pallet_label_sources",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    sscc: char("sscc", { length: 18 }).notNull(),
    palletId: uuid("pallet_id").notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    revision: char("revision", { length: 64 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sscc] }),
    foreignKey({
      columns: [t.tenantId, t.palletId],
      foreignColumns: [pallets.tenantId, pallets.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.sourceDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check("pallet_label_sources_revision_check", sql`${t.revision} ~ '^[a-f0-9]{64}$'`),
    check("pallet_label_sources_value_check", sql`jsonb_typeof(${t.value})='object'`),
  ],
);
export const palletReprintEvents = pgTable(
  "pallet_reprint_events",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    deviceId: uuid("device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    jobId: uuid("job_id").notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    status: text("status").$type<"accepted" | "conflict">().notNull().default("accepted"),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.eventId] }),
    foreignKey({
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    index("pallet_reprint_events_job_idx").on(t.tenantId, t.deviceId, t.jobId),
    check("pallet_reprint_events_status_check", sql`${t.status} IN ('accepted','conflict')`),
    check("pallet_reprint_events_digest_check", sql`${t.digest} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Device transport claims, separate from immutable source bytes and physical verification. */
export const palletProductionDeliveries = pgTable(
  "pallet_production_deliveries",
  {
    tenantId: text("tenant_id").notNull(),
    sscc: char("sscc", { length: 18 }).notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    digest: char("digest", { length: 64 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sscc, t.sequence] }),
    foreignKey({
      columns: [t.tenantId, t.sscc],
      foreignColumns: [palletLabelSources.tenantId, palletLabelSources.sscc],
    }),
    foreignKey({
      columns: [t.tenantId, t.sourceDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check(
      "pallet_production_deliveries_sequence_check",
      sql`${t.sequence} > 0 AND ${t.sequence} <= 9007199254740991`,
    ),
    check("pallet_production_deliveries_digest_check", sql`${t.digest} ~ '^[a-f0-9]{64}$'`),
    check("pallet_production_deliveries_value_check", sql`jsonb_typeof(${t.value}) = 'object'`),
  ],
);
