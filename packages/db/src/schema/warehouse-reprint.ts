import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { stationDevices } from "./platform.js";
import { employees } from "./pickup.js";

const tenant = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);
export const warehouseReprintJobs = pgTable(
  "warehouse_reprint_jobs",
  {
    tenantId: tenant(),
    deviceId: uuid("device_id").notNull(),
    jobId: uuid("job_id").notNull(),
    prepared: jsonb("prepared").$type<Record<string, unknown>>().notNull(),
    projection: jsonb("projection").$type<Record<string, unknown>>().notNull(),
    latestSequence: bigint("latest_sequence", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.jobId] }),
    foreignKey({
      name: "warehouse_reprint_jobs_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check(
      "warehouse_reprint_jobs_sequence_check",
      sql`${t.latestSequence} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "warehouse_reprint_jobs_json_check",
      sql`jsonb_typeof(${t.prepared})='object' AND jsonb_typeof(${t.projection})='object'`,
    ),
    index("warehouse_reprint_jobs_history_idx").on(t.tenantId, t.deviceId, t.createdAt, t.jobId),
  ],
);
export const warehouseReprintEvents = pgTable(
  "warehouse_reprint_events",
  {
    tenantId: tenant(),
    deviceId: uuid("device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    jobId: uuid("job_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    operatorId: uuid("operator_id").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.eventId] }),
    unique("warehouse_reprint_events_job_sequence_uq").on(
      t.tenantId,
      t.deviceId,
      t.jobId,
      t.sequence,
    ),
    foreignKey({
      name: "warehouse_reprint_events_tenant_job_fk",
      columns: [t.tenantId, t.deviceId, t.jobId],
      foreignColumns: [
        warehouseReprintJobs.tenantId,
        warehouseReprintJobs.deviceId,
        warehouseReprintJobs.jobId,
      ],
    }),
    foreignKey({
      name: "warehouse_reprint_events_tenant_actor_fk",
      columns: [t.tenantId, t.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "warehouse_reprint_events_sequence_check",
      sql`${t.sequence} BETWEEN 1 AND 9007199254740991`,
    ),
    check("warehouse_reprint_events_digest_check", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check("warehouse_reprint_events_json_check", sql`jsonb_typeof(${t.event})='object'`),
  ],
);
/** Rejected parents cannot be trusted as foreign keys. Their receipt is still durable. */
export const warehouseReprintReceipts = pgTable(
  "warehouse_reprint_receipts",
  {
    tenantId: tenant(),
    deviceId: uuid("device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    rejectionCode: text("rejection_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.eventId] }),
    foreignKey({
      name: "warehouse_reprint_receipts_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check("warehouse_reprint_receipts_digest_check", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "warehouse_reprint_receipts_rejection_check",
      sql`${t.rejectionCode} IS NULL OR ${t.rejectionCode} IN ('parent_missing','source_not_printable','ownership_conflict','invalid_transition','sequence_gap','invalid_operator','template_mismatch')`,
    ),
  ],
);
