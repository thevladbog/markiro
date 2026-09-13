import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  index,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type PgColumn,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { stationDevices } from "./platform.js";
import { kiosks } from "./pickup.js";
import { entitlementLifecyclePolicies } from "./entitlements.js";

const ownerColumns = () => ({
  tenantId: text("tenant_id")
    .notNull()
    .references(() => organization.id),
  ownerKind: text("owner_kind").$type<"station" | "handheld" | "kiosk">().notNull(),
  stationDeviceId: uuid("station_device_id"),
  kioskId: uuid("kiosk_id"),
  credentialEpoch: integer("credential_epoch").notNull(),
});
function ownerConstraints(
  name: string,
  t: {
    tenantId: PgColumn;
    ownerKind: PgColumn;
    stationDeviceId: PgColumn;
    kioskId: PgColumn;
    credentialEpoch: PgColumn;
  },
) {
  return [
    foreignKey({
      name: `${name}_station_fk`,
      columns: [t.tenantId, t.stationDeviceId, t.ownerKind],
      foreignColumns: [stationDevices.tenantId, stationDevices.id, stationDevices.kind],
    }),
    foreignKey({
      name: `${name}_kiosk_fk`,
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    check(
      `${name}_owner_check`,
      sql`(${t.ownerKind} in ('station','handheld') and ${t.stationDeviceId} is not null and ${t.kioskId} is null) or (${t.ownerKind}='kiosk' and ${t.kioskId} is not null and ${t.stationDeviceId} is null)`,
    ),
    check(`${name}_epoch_check`, sql`${t.credentialEpoch} > 0`),
  ];
}

/** Immutable facts frozen by native task owners, never populated from a grant-request DTO. */
export const deviceGrantTaskSources = pgTable(
  "device_grant_task_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...ownerColumns(),
    taskKind: text("task_kind").$type<"shift" | "inventory" | "pickup">().notNull(),
    taskId: uuid("task_id").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
    eventTypes: jsonb("event_types").$type<string[]>().notNull(),
    budget: jsonb("budget")
      .$type<{ id: string; unit: "event" | "unit" | "container"; maximum: number }[]>()
      .notNull(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => entitlementLifecyclePolicies.id),
    policyRevision: text("policy_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ...ownerConstraints("device_grant_sources", t),
    unique("device_grant_sources_tenant_id_uq").on(t.tenantId, t.id),
    check(
      "device_grant_sources_task_check",
      sql`${t.taskKind} in ('shift','inventory','pickup') and (${t.ownerKind}='kiosk')=(${t.taskKind}='pickup')`,
    ),
    check(
      "device_grant_sources_payload_check",
      sql`${t.snapshotDigest} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${t.scope})='object' and jsonb_typeof(${t.eventTypes})='array' and jsonb_array_length(${t.eventTypes}) > 0 and jsonb_typeof(${t.budget})='array' and jsonb_array_length(${t.budget}) > 0`,
    ),
  ],
);

/** Original signed bytes and issuance identity survive expiry, credential rotation and retries. */
export const deviceGrantIssuances = pgTable(
  "device_grant_issuances",
  {
    grantId: uuid("grant_id").primaryKey(),
    ...ownerColumns(),
    kindOfGrant: text("kind_of_grant").$type<"device" | "task">().notNull(),
    taskSourceId: uuid("task_source_id"),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => entitlementLifecyclePolicies.id),
    policyRevision: text("policy_revision").notNull(),
    entitlementRevision: text("entitlement_revision").notNull(),
    requestIdentity: text("request_identity").notNull(),
    headerKid: text("header_kid").notNull(),
    compactJws: text("compact_jws").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    startNotAfter: timestamp("start_not_after", { withTimezone: true }),
    completeNotAfter: timestamp("complete_not_after", { withTimezone: true }),
  },
  (t) => [
    ...ownerConstraints("device_grant_issuances", t),
    unique("device_grant_issuances_tenant_id_uq").on(t.tenantId, t.grantId),
    unique("device_grant_issuances_request_uq").on(t.tenantId, t.requestIdentity),
    foreignKey({
      name: "device_grant_issuances_source_fk",
      columns: [t.tenantId, t.taskSourceId],
      foreignColumns: [deviceGrantTaskSources.tenantId, deviceGrantTaskSources.id],
    }),
    check(
      "device_grant_issuances_shape_check",
      sql`(${t.kindOfGrant}='device' and ${t.taskSourceId} is null and ${t.startNotAfter} > ${t.issuedAt} and ${t.completeNotAfter} is null) or (${t.kindOfGrant}='task' and ${t.taskSourceId} is not null and ${t.completeNotAfter} > ${t.issuedAt} and ${t.startNotAfter} is null)`,
    ),
    check(
      "device_grant_issuances_payload_check",
      sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$' and length(${t.compactJws}) between 1 and 65536 and length(btrim(${t.headerKid})) > 0 and length(btrim(${t.requestIdentity})) > 0 and isfinite(${t.issuedAt}) and (${t.startNotAfter} is null or isfinite(${t.startNotAfter})) and (${t.completeNotAfter} is null or isfinite(${t.completeNotAfter}))`,
    ),
  ],
);

/** Retention is independent of productive acceptance. Invalid/unrecognized grants may be quarantined. */
export const deviceGrantEvidence = pgTable(
  "device_grant_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...ownerColumns(),
    grantId: uuid("grant_id"),
    evidenceIdentity: text("evidence_identity").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    disposition: text("disposition").$type<"accepted" | "duplicate" | "quarantined">().notNull(),
    reason: text("reason").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ...ownerConstraints("device_grant_evidence", t),
    foreignKey({
      name: "device_grant_evidence_issuance_fk",
      columns: [t.tenantId, t.grantId],
      foreignColumns: [deviceGrantIssuances.tenantId, deviceGrantIssuances.grantId],
    }),
    unique("device_grant_evidence_identity_uq").on(t.tenantId, t.evidenceIdentity),
    check(
      "device_grant_evidence_payload_check",
      sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${t.payload})='object' and octet_length(${t.payload}::text) <= 1048576 and length(btrim(${t.evidenceIdentity})) > 0 and ${t.disposition} in ('accepted','duplicate','quarantined')`,
    ),
  ],
);

/** Server-issued rollout history survives missing policies and credential recovery. */
export const deviceGrantConfigurations = pgTable(
  "device_grant_configurations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigserial("sequence", { mode: "bigint" }).notNull().unique(),
    ...ownerColumns(),
    mode: text("mode").$type<"observe" | "strict">().notNull(),
    policyId: uuid("policy_id").references(() => entitlementLifecyclePolicies.id),
    policyRevision: text("policy_revision"),
    decisionReference: text("decision_reference"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ...ownerConstraints("device_grant_configurations", t),
    index("device_grant_config_station_latest_idx")
      .on(t.tenantId, t.ownerKind, t.stationDeviceId, t.sequence)
      .where(sql`${t.stationDeviceId} is not null`),
    index("device_grant_config_kiosk_latest_idx")
      .on(t.tenantId, t.ownerKind, t.kioskId, t.sequence)
      .where(sql`${t.kioskId} is not null`),
    check(
      "device_grant_configurations_mode_check",
      sql`${t.mode} in ('observe','strict') and (${t.mode} <> 'strict' or ${t.policyId} is not null) and ((${t.policyId} is null and ${t.policyRevision} is null and ${t.decisionReference} is null) or (${t.policyId} is not null and length(btrim(${t.policyRevision})) > 0 and length(btrim(${t.decisionReference})) > 0)) is true and isfinite(${t.issuedAt})`,
    ),
  ],
);

/** Pending survives a failed owner transaction; finalResponse commits with its effects. */
export const deviceGrantIngestReceipts = pgTable(
  "device_grant_ingest_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...ownerColumns(),
    identity: text("identity").notNull(),
    operation: text("operation").notNull(),
    batchId: text("batch_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    envelopeDigest: text("envelope_digest").notNull(),
    transportDigest: text("transport_digest").notNull(),
    retainedPayload: jsonb("retained_payload").$type<Record<string, unknown>>().notNull(),
    mode: text("mode").$type<"observe" | "strict">().notNull(),
    configurationId: uuid("configuration_id").references(() => deviceGrantConfigurations.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    finalResponse: jsonb("final_response").$type<Record<string, unknown>>(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    ...ownerConstraints("device_grant_ingest", t),
    unique("device_grant_ingest_tenant_id_uq").on(t.tenantId, t.id),
    unique("device_grant_ingest_identity_uq").on(t.tenantId, t.identity),
    check(
      "device_grant_ingest_shape_check",
      sql`${t.identity} ~ '^[0-9a-f]{64}$' and ${t.payloadDigest} ~ '^[0-9a-f]{64}$' and ${t.envelopeDigest} ~ '^[0-9a-f]{64}$' and ${t.transportDigest} ~ '^[0-9a-f]{64}$' and ${t.mode} in ('observe','strict') and jsonb_typeof(${t.retainedPayload})='object' and octet_length(${t.retainedPayload}::text) <= 4194304 and isfinite(${t.receivedAt}) and ((${t.finalResponse} is null and ${t.finalizedAt} is null) or (jsonb_typeof(${t.finalResponse})='object' and ${t.finalizedAt} is not null and isfinite(${t.finalizedAt})))`,
    ),
  ],
);

/** An accepted productive fact is charged once across batches, grant renewals and epochs. */
export const deviceGrantEffects = pgTable(
  "device_grant_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...ownerColumns(),
    identity: text("identity").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    taskKind: text("task_kind").$type<"shift" | "inventory" | "pickup">().notNull(),
    taskId: uuid("task_id").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    eventType: text("event_type").notNull(),
    cost: jsonb("cost").$type<Record<string, number>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    ...ownerConstraints("device_grant_effects", t),
    unique("device_grant_effects_identity_uq").on(t.tenantId, t.identity),
    foreignKey({
      name: "device_grant_effects_receipt_fk",
      columns: [t.tenantId, t.receiptId],
      foreignColumns: [deviceGrantIngestReceipts.tenantId, deviceGrantIngestReceipts.id],
    }),
    foreignKey({
      name: "device_grant_effects_grant_fk",
      columns: [t.tenantId, t.grantId],
      foreignColumns: [deviceGrantIssuances.tenantId, deviceGrantIssuances.grantId],
    }),
    check(
      "device_grant_effects_shape_check",
      sql`${t.identity} ~ '^[0-9a-f]{64}$' and ${t.payloadDigest} ~ '^[0-9a-f]{64}$' and ${t.snapshotDigest} ~ '^[0-9a-f]{64}$' and ${t.taskKind} in ('shift','inventory','pickup') and jsonb_typeof(${t.cost})='object' and isfinite(${t.createdAt})`,
    ),
  ],
);

/** Identity includes owner/task/snapshot/budget line, never credential epoch or policy. */
export const deviceGrantConsumption = pgTable(
  "device_grant_consumption",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...ownerColumns(),
    identity: text("identity").notNull(),
    taskKind: text("task_kind").$type<"shift" | "inventory" | "pickup">().notNull(),
    taskId: uuid("task_id").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    budgetLineId: text("budget_line_id").notNull(),
    consumed: bigint("consumed", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    ...ownerConstraints("device_grant_consumption", t),
    unique("device_grant_consumption_identity_uq").on(t.tenantId, t.identity),
    check(
      "device_grant_consumption_shape_check",
      sql`${t.identity} ~ '^[0-9a-f]{64}$' and ${t.snapshotDigest} ~ '^[0-9a-f]{64}$' and ${t.taskKind} in ('shift','inventory','pickup') and length(btrim(${t.budgetLineId})) > 0 and ${t.consumed} between 0 and 9007199254740991`,
    ),
  ],
);
