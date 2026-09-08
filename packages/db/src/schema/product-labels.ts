import { sql } from "drizzle-orm";
import {
  bigint,
  char,
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
import { employees } from "./pickup.js";
import { shifts, stationDevices } from "./platform.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);
const digest = (name: string) => char(name, { length: 64 }).notNull();

/** Print history carries hashes and the validated projection, never printer bytes or raw KM. */
export const productLabelJobs = pgTable(
  "product_label_jobs",
  {
    tenantId: tenantId(),
    deviceId: uuid("device_id").notNull(),
    jobId: uuid("job_id").notNull(),
    shiftId: uuid("shift_id").notNull(),
    codeHash: digest("code_hash"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    policyRevision: uuid("policy_revision").notNull(),
    templateDigest: digest("template_digest"),
    payloadDigest: digest("payload_digest"),
    latestSequence: bigint("latest_sequence", { mode: "number" }).notNull(),
    projection: jsonb("projection").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.jobId] }),
    index("product_label_jobs_history_idx").on(t.tenantId, t.shiftId, t.acceptedAt, t.jobId),
    foreignKey({
      name: "product_label_jobs_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "product_label_jobs_tenant_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
    check(
      "product_label_jobs_sequence_check",
      sql`${t.latestSequence} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "product_label_jobs_digests_check",
      sql`${t.codeHash} ~ '^[0-9a-f]{64}$' AND ${t.templateDigest} ~ '^[0-9a-f]{64}$' AND ${t.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("product_label_jobs_projection_check", sql`jsonb_typeof(${t.projection}) = 'object'`),
  ],
);

/** Append-only facts; service updates only the job projection after validating transitions. */
export const productLabelEvents = pgTable(
  "product_label_events",
  {
    tenantId: tenantId(),
    deviceId: uuid("device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    jobId: uuid("job_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    operatorId: uuid("operator_id").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    payloadDigest: digest("payload_digest"),
    receiveStatus: text("receive_status").$type<"accepted" | "conflict" | "rejected">().notNull(),
    reasonCode: text("reason_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.eventId] }),
    unique("product_label_events_job_sequence_uq").on(t.tenantId, t.deviceId, t.jobId, t.sequence),
    foreignKey({
      name: "product_label_events_tenant_job_fk",
      columns: [t.tenantId, t.deviceId, t.jobId],
      foreignColumns: [
        productLabelJobs.tenantId,
        productLabelJobs.deviceId,
        productLabelJobs.jobId,
      ],
    }),
    foreignKey({
      name: "product_label_events_tenant_operator_fk",
      columns: [t.tenantId, t.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check("product_label_events_sequence_check", sql`${t.sequence} BETWEEN 1 AND 9007199254740991`),
    check("product_label_events_digest_check", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check("product_label_events_event_check", sql`jsonb_typeof(${t.event}) = 'object'`),
    check(
      "product_label_events_receive_status_check",
      sql`
    (${t.receiveStatus} = 'accepted' AND ${t.reasonCode} IS NULL)
    OR (${t.receiveStatus} IN ('conflict', 'rejected') AND ${t.reasonCode} IS NOT NULL AND char_length(${t.reasonCode}) BETWEEN 1 AND 64)`,
    ),
  ],
);

/** Stable replay verdict also exists for quarantined facts whose claimed parent is untrusted. */
export const productLabelEventReceipts = pgTable(
  "product_label_event_receipts",
  {
    tenantId: tenantId(),
    deviceId: uuid("device_id").notNull(),
    eventId: uuid("event_id").notNull(),
    payloadDigest: digest("payload_digest"),
    outcome: text("outcome").$type<"accepted" | "quarantined">().notNull(),
    rejectionCode: text("rejection_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.eventId] }),
    foreignKey({
      name: "product_label_receipts_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check("product_label_receipts_digest_check", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "product_label_receipts_outcome_check",
      sql`
    (${t.outcome} = 'accepted' AND ${t.rejectionCode} IS NULL)
    OR (${t.outcome} = 'quarantined' AND ${t.rejectionCode} IS NOT NULL AND ${t.rejectionCode} IN
      ('parent_missing', 'policy_mismatch', 'ownership_conflict', 'invalid_transition', 'sequence_gap', 'subscription_read_only'))`,
    ),
  ],
);
