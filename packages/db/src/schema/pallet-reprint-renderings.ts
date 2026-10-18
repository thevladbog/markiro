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
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { stationDevices } from "./platform.js";
import { palletLabelSources } from "./pallet-label-sources.js";
export const palletReprintRenderings = pgTable(
  "pallet_reprint_renderings",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    deviceId: uuid("device_id").notNull(),
    jobId: uuid("job_id").notNull(),
    sscc: char("sscc", { length: 18 }).notNull(),
    sourceRevision: char("source_revision", { length: 64 }).notNull(),
    renderingRevision: char("rendering_revision", { length: 64 }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.jobId] }),
    foreignKey({
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.sscc],
      foreignColumns: [palletLabelSources.tenantId, palletLabelSources.sscc],
    }),
    index("pallet_reprint_renderings_source_idx").on(t.tenantId, t.sscc),
    check(
      "pallet_reprint_renderings_digests_check",
      sql`${t.sourceRevision} ~ '^[a-f0-9]{64}$' AND ${t.renderingRevision} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "pallet_reprint_renderings_value_check",
      sql`jsonb_typeof(${t.value})='object' AND octet_length(${t.value}::text)<1000000`,
    ),
  ],
);
