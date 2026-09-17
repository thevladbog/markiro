import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  primaryKey,
  check,
  index,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { deviceGrantConfigurations } from "./device-grants.js";
import { stationDevices } from "./platform.js";

export type WorkingDeviceReplacementActorDomain = "cabinet" | "platform";
export type WorkingDeviceReplacementState =
  "prepared" | "draining" | "ready" | "executing" | "completed" | "cancelled";
export type WorkingDeviceReplacementRecoveryState =
  "not_required" | "required" | "draining" | "completed" | "evidence_unavailable";

export const workingDeviceReplacementPreviews = pgTable(
  "working_device_replacement_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    resultPreparationId: uuid("result_preparation_id"),
    response: jsonb("response").$type<unknown>(),
  },
  (t) => [
    unique("working_device_replacement_previews_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_replacement_previews_tenant_device_id_uq").on(
      t.tenantId,
      t.deviceId,
      t.id,
    ),
    unique("working_device_replacement_previews_tenant_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "working_device_replacement_previews_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check(
      "working_device_replacement_previews_actor_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256`,
    ),
    check(
      "working_device_replacement_previews_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and jsonb_typeof(${t.observation}) = 'object' and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "working_device_replacement_previews_interval_check",
      sql`isfinite(${t.createdAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
    check(
      "working_device_replacement_previews_result_check",
      sql`(${t.confirmedAt} is null and ${t.resultPreparationId} is null and ${t.response} is null) or (${t.confirmedAt} is not null and ${t.resultPreparationId} is not null and ${t.response} is not null and isfinite(${t.confirmedAt}) and ${t.confirmedAt} >= ${t.createdAt} and ${t.confirmedAt} < ${t.expiresAt})`,
    ),
  ],
);

export const workingDeviceReplacementPreparations = pgTable(
  "working_device_replacement_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").$type<WorkingDeviceReplacementState>().notNull().default("prepared"),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledActorDomain:
      text("cancelled_actor_domain").$type<WorkingDeviceReplacementActorDomain>(),
    cancelledActorId: text("cancelled_actor_id"),
  },
  (t) => [
    unique("working_device_replacement_preparations_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_replacement_preparations_tenant_device_id_uq").on(
      t.tenantId,
      t.deviceId,
      t.id,
    ),
    unique("working_device_replacement_preparations_tenant_preview_uq").on(
      t.tenantId,
      t.deviceId,
      t.previewId,
    ),
    uniqueIndex("working_device_replacements_one_prepared_uq")
      .on(t.tenantId, t.deviceId)
      .where(sql`${t.state} in ('prepared','draining','ready','executing')`),
    foreignKey({
      name: "working_device_replacement_preparations_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_preparations_tenant_device_preview_fk",
      columns: [t.tenantId, t.deviceId, t.previewId],
      foreignColumns: [
        workingDeviceReplacementPreviews.tenantId,
        workingDeviceReplacementPreviews.deviceId,
        workingDeviceReplacementPreviews.id,
      ],
    }),
    check(
      "working_device_replacement_preparations_identity_check",
      sql`${t.state} in ('prepared','draining','ready','executing','completed','cancelled') and ${t.revision} >= 1 and ${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and jsonb_typeof(${t.observation}) = 'object' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and isfinite(${t.preparedAt})`,
    ),
    check(
      "working_device_replacement_preparations_cancellation_check",
      sql`((${t.state} <> 'cancelled' and ${t.cancelledAt} is null and ${t.cancelledActorDomain} is null and ${t.cancelledActorId} is null) or (${t.state} = 'cancelled' and ${t.cancelledAt} is not null and isfinite(${t.cancelledAt}) and ${t.cancelledAt} >= ${t.preparedAt} and ${t.cancelledActorDomain} is not null and ${t.cancelledActorDomain} in ('cabinet','platform') and ${t.cancelledActorId} is not null and length(btrim(${t.cancelledActorId})) between 1 and 256)) is true`,
    ),
  ],
);

/** Each new epoch/facts snapshot supersedes the previous intent; request identity is durable. */
export const workingDeviceReplacementReadinessIntents = pgTable(
  "working_device_replacement_readiness_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    credentialEpoch: bigint("credential_epoch", { mode: "number" }).notNull(),
    preparationRevision: integer("preparation_revision").notNull(),
    assignmentRevision: integer("assignment_revision").notNull(),
    entitlementRevision: bigint("entitlement_revision", { mode: "bigint" }).notNull(),
    usageRevision: bigint("usage_revision", { mode: "bigint" }).notNull(),
    grantConfigurationId: uuid("grant_configuration_id"),
    grantConfigurationSequence: bigint("grant_configuration_sequence", { mode: "bigint" }),
    factsFingerprint: text("facts_fingerprint").notNull(),
    state: text("state")
      .$type<"active" | "superseded" | "cancelled" | "completed">()
      .notNull()
      .default("active"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    response: jsonb("response").$type<Record<string, unknown>>(),
  },
  (t) => [
    unique("working_device_replacement_intents_identity_uq").on(
      t.tenantId,
      t.deviceId,
      t.preparationId,
      t.id,
      t.credentialEpoch,
    ),
    unique("working_device_replacement_intents_request_uq").on(
      t.tenantId,
      t.actorDomain,
      t.requestId,
    ),
    uniqueIndex("working_device_replacement_intents_active_uq")
      .on(t.tenantId, t.preparationId)
      .where(sql`${t.state} = 'active'`),
    foreignKey({
      name: "working_device_replacement_intents_source_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_intents_preparation_fk",
      columns: [t.tenantId, t.deviceId, t.preparationId],
      foreignColumns: [
        workingDeviceReplacementPreparations.tenantId,
        workingDeviceReplacementPreparations.deviceId,
        workingDeviceReplacementPreparations.id,
      ],
    }),
    foreignKey({
      name: "working_device_replacement_intents_configuration_fk",
      columns: [t.tenantId, t.grantConfigurationId],
      foreignColumns: [deviceGrantConfigurations.tenantId, deviceGrantConfigurations.id],
    }),
    check(
      "working_device_replacement_intents_identity_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and ${t.credentialEpoch} between 1 and 9007199254740991 and ${t.preparationRevision} > 0 and ${t.assignmentRevision} > 0 and ${t.entitlementRevision} >= 0 and ${t.usageRevision} >= 0 and ((${t.grantConfigurationId} is null and ${t.grantConfigurationSequence} is null) or (${t.grantConfigurationId} is not null and ${t.grantConfigurationSequence} is not null and ${t.grantConfigurationSequence} > 0))`,
    ),
    check(
      "working_device_replacement_intents_interval_check",
      sql`isfinite(${t.requestedAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.requestedAt} and ((${t.state} = 'active' and ${t.closedAt} is null) or (${t.state} in ('superseded','cancelled','completed') and ${t.closedAt} is not null and isfinite(${t.closedAt}) and ${t.closedAt} >= ${t.requestedAt}))`,
    ),
    check(
      "working_device_replacement_intents_response_check",
      sql`${t.response} is null or (jsonb_typeof(${t.response}) = 'object' and octet_length(${t.response}::text) <= 262144)`,
    ),
  ],
);

/** Immutable normalized evidence. Sequence zero is the first report in the wire contract. */
export const workingDeviceReplacementReadinessReports = pgTable(
  "working_device_replacement_readiness_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    requestId: uuid("request_id").notNull(),
    credentialEpoch: bigint("credential_epoch", { mode: "number" }).notNull(),
    reportSequence: bigint("report_sequence", { mode: "number" }).notNull(),
    clientBuild: text("client_build").notNull(),
    storageRevision: bigint("storage_revision", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    counters: jsonb("counters").$type<Record<string, number | "unsupported">>().notNull(),
    eligibility: jsonb("eligibility")
      .$type<{ status: "eligible" | "blocked"; reasons: string[] }>()
      .notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("working_device_replacement_reports_identity_uq").on(
      t.tenantId,
      t.deviceId,
      t.preparationId,
      t.id,
      t.credentialEpoch,
    ),
    unique("working_device_replacement_reports_request_uq").on(t.tenantId, t.requestId),
    unique("working_device_replacement_reports_sequence_uq").on(
      t.tenantId,
      t.intentId,
      t.reportSequence,
    ),
    index("working_device_replacement_reports_received_idx").on(
      t.tenantId,
      t.deviceId,
      t.receivedAt,
    ),
    foreignKey({
      name: "working_device_replacement_reports_source_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_reports_intent_fk",
      columns: [t.tenantId, t.deviceId, t.preparationId, t.intentId, t.credentialEpoch],
      foreignColumns: [
        workingDeviceReplacementReadinessIntents.tenantId,
        workingDeviceReplacementReadinessIntents.deviceId,
        workingDeviceReplacementReadinessIntents.preparationId,
        workingDeviceReplacementReadinessIntents.id,
        workingDeviceReplacementReadinessIntents.credentialEpoch,
      ],
    }),
    check(
      "working_device_replacement_reports_identity_check",
      sql`${t.credentialEpoch} between 1 and 9007199254740991 and ${t.reportSequence} between 0 and 9007199254740991 and ${t.storageRevision} between 1 and 9007199254740991 and length(btrim(${t.clientBuild})) between 1 and 100 and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and isfinite(${t.receivedAt})`,
    ),
    check(
      "working_device_replacement_reports_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 262144 and jsonb_typeof(${t.response}) = 'object' and octet_length(${t.response}::text) <= 262144 and jsonb_typeof(${t.counters}) = 'object' and octet_length(${t.counters}::text) <= 4096 and ${t.counters} ?& array['scans','inventories','shiftClosures','productLabels','boxes','exceptions','conflicts','unknownPrints'] and ${t.counters} - array['scans','inventories','shiftClosures','productLabels','boxes','exceptions','conflicts','unknownPrints'] = '{}'::jsonb and not jsonb_path_exists(${t.counters}, '$.* ? ((@.type() != "number" && @.type() != "string") || (@.type() == "string" && @ != "unsupported") || (@.type() == "number" && (@ < 0 || @ > 9007199254740991 || @.floor() != @)))')`,
    ),
    check(
      "working_device_replacement_reports_eligibility_check",
      sql`(jsonb_typeof(${t.eligibility}) = 'object' and octet_length(${t.eligibility}::text) <= 4096 and ${t.eligibility} ?& array['status','reasons'] and ${t.eligibility} - array['status','reasons'] = '{}'::jsonb and jsonb_typeof(${t.eligibility}->'reasons') = 'array' and ((${t.eligibility}->>'status' = 'eligible' and ${t.eligibility}->'reasons' = '[]'::jsonb) or (${t.eligibility}->>'status' = 'blocked' and jsonb_array_length(${t.eligibility}->'reasons') between 1 and 32))) is true`,
    ),
  ],
);

/** Persisted cutover steps fence admission until the old cloud credential is revoked. */
export const workingDeviceReplacementExecutions = pgTable(
  "working_device_replacement_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    mode: text("mode").$type<"normal" | "emergency">().notNull(),
    state: text("state").$type<"executing" | "completed">().notNull().default("executing"),
    step: text("step")
      .$type<"revoke_pending" | "credential_revoked" | "transferred">()
      .notNull()
      .default("revoke_pending"),
    sourceCredentialEpoch: bigint("source_credential_epoch", { mode: "number" }).notNull(),
    sourceApiKeyId: text("source_api_key_id"),
    factsFingerprint: text("facts_fingerprint").notNull(),
    readinessReportId: uuid("readiness_report_id"),
    emergencyReason: text("emergency_reason"),
    serverFacts: jsonb("server_facts").$type<Record<string, unknown>>().notNull().default({}),
    targetDeviceId: uuid("target_device_id"),
    offlineAuthorityUntil: timestamp("offline_authority_until", { withTimezone: true }).notNull(),
    newWorkAllowedAt: timestamp("new_work_allowed_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    repairAttempts: integer("repair_attempts").notNull().default(0),
    lastRepairAt: timestamp("last_repair_at", { withTimezone: true }),
    nextRepairAt: timestamp("next_repair_at", { withTimezone: true }),
    credentialRevokedAt: timestamp("credential_revoked_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    response: jsonb("response").$type<Record<string, unknown>>(),
    recoveryState: text("recovery_state")
      .$type<WorkingDeviceReplacementRecoveryState>()
      .notNull()
      .default("not_required"),
    recoveryCredentialEpoch: bigint("recovery_credential_epoch", { mode: "number" }),
    recoveryClosedAt: timestamp("recovery_closed_at", { withTimezone: true }),
    recoveryCloseReason: text("recovery_close_reason"),
  },
  (t) => [
    unique("working_device_replacement_executions_preparation_uq").on(t.tenantId, t.preparationId),
    unique("working_device_replacement_executions_request_uq").on(
      t.tenantId,
      t.actorDomain,
      t.requestId,
    ),
    unique("working_device_replacement_executions_target_uq").on(t.tenantId, t.targetDeviceId),
    index("working_device_replacement_executions_repair_idx").on(t.state, t.startedAt),
    index("replacement_executions_due_repair_idx")
      .on(sql`coalesce(${t.nextRepairAt}, ${t.startedAt})`, t.startedAt, t.id)
      .where(sql`${t.state} = 'executing'`),
    check(
      "replacement_executions_repair_check",
      sql`((${t.repairAttempts} = 0 and ${t.lastRepairAt} is null and ${t.nextRepairAt} is null) or (${t.repairAttempts} > 0 and ${t.lastRepairAt} is not null and ${t.nextRepairAt} is not null and isfinite(${t.lastRepairAt}) and isfinite(${t.nextRepairAt}) and ${t.lastRepairAt} >= ${t.startedAt} and ${t.nextRepairAt} >= ${t.lastRepairAt})) is true`,
    ),
    foreignKey({
      name: "working_device_replacement_executions_source_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_executions_preparation_fk",
      columns: [t.tenantId, t.deviceId, t.preparationId],
      foreignColumns: [
        workingDeviceReplacementPreparations.tenantId,
        workingDeviceReplacementPreparations.deviceId,
        workingDeviceReplacementPreparations.id,
      ],
    }),
    foreignKey({
      name: "working_device_replacement_executions_target_fk",
      columns: [t.tenantId, t.targetDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_executions_report_fk",
      columns: [
        t.tenantId,
        t.deviceId,
        t.preparationId,
        t.readinessReportId,
        t.sourceCredentialEpoch,
      ],
      foreignColumns: [
        workingDeviceReplacementReadinessReports.tenantId,
        workingDeviceReplacementReadinessReports.deviceId,
        workingDeviceReplacementReadinessReports.preparationId,
        workingDeviceReplacementReadinessReports.id,
        workingDeviceReplacementReadinessReports.credentialEpoch,
      ],
    }),
    check(
      "working_device_replacement_executions_identity_check",
      sql`${t.revision} > 0 and ${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and ${t.sourceCredentialEpoch} between 1 and 9007199254740991 and (${t.targetDeviceId} is null or ${t.targetDeviceId} <> ${t.deviceId}) and (${t.sourceApiKeyId} is null or length(btrim(${t.sourceApiKeyId})) between 1 and 256)`,
    ),
    check(
      "working_device_replacement_executions_mode_check",
      sql`((${t.mode} = 'normal' and ${t.readinessReportId} is not null and ${t.emergencyReason} is null and ${t.recoveryState} = 'not_required') or (${t.mode} = 'emergency' and ${t.emergencyReason} is not null and length(btrim(${t.emergencyReason})) between 1 and 1000 and ${t.recoveryState} in ('required','draining','completed','evidence_unavailable'))) is true`,
    ),
    check(
      "working_device_replacement_executions_step_check",
      sql`((${t.state} = 'executing' and ${t.targetDeviceId} is null and ${t.executedAt} is null and ${t.response} is null and ((${t.step} = 'revoke_pending' and ${t.credentialRevokedAt} is null) or (${t.step} = 'credential_revoked' and ${t.credentialRevokedAt} is not null))) or (${t.state} = 'completed' and ${t.step} = 'transferred' and ${t.targetDeviceId} is not null and ${t.credentialRevokedAt} is not null and ${t.executedAt} is not null and ${t.response} is not null)) is true`,
    ),
    check(
      "working_device_replacement_executions_interval_check",
      sql`isfinite(${t.startedAt}) and isfinite(${t.offlineAuthorityUntil}) and isfinite(${t.newWorkAllowedAt}) and ${t.newWorkAllowedAt} >= ${t.offlineAuthorityUntil} and (${t.credentialRevokedAt} is null or (isfinite(${t.credentialRevokedAt}) and ${t.credentialRevokedAt} >= ${t.startedAt})) and (${t.executedAt} is null or (isfinite(${t.executedAt}) and ${t.executedAt} >= ${t.credentialRevokedAt}))`,
    ),
    check(
      "working_device_replacement_executions_payload_check",
      sql`jsonb_typeof(${t.serverFacts}) = 'object' and octet_length(${t.serverFacts}::text) <= 262144 and (${t.response} is null or (jsonb_typeof(${t.response}) = 'object' and octet_length(${t.response}::text) <= 262144))`,
    ),
    check(
      "working_device_replacement_executions_recovery_check",
      sql`((${t.recoveryState} in ('not_required','required','draining') and ${t.recoveryClosedAt} is null and ${t.recoveryCloseReason} is null) or (${t.recoveryState} in ('completed','evidence_unavailable') and ${t.state} = 'completed' and ${t.recoveryClosedAt} is not null and isfinite(${t.recoveryClosedAt}) and ${t.recoveryClosedAt} >= ${t.executedAt} and ((${t.recoveryState} = 'completed' and ${t.recoveryCloseReason} is null) or (${t.recoveryState} = 'evidence_unavailable' and ${t.recoveryCloseReason} is not null and length(btrim(${t.recoveryCloseReason})) between 1 and 1000)))) and (${t.recoveryCredentialEpoch} is null or (${t.mode} = 'emergency' and ${t.recoveryCredentialEpoch} > ${t.sourceCredentialEpoch} and ${t.recoveryCredentialEpoch} <= 9007199254740991))`,
    ),
  ],
);

/** Append-only source acknowledgement; frozen drain intents are never rewritten. */
export const workingDeviceReplacementClosureAcknowledgements = pgTable(
  "working_device_replacement_closure_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    credentialEpoch: bigint("credential_epoch", { mode: "number" }).notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("working_device_replacement_closure_ack_request_uq").on(t.tenantId, t.requestId),
    index("working_device_replacement_closure_ack_intent_idx").on(
      t.tenantId,
      t.deviceId,
      t.intentId,
      t.credentialEpoch,
    ),
    foreignKey({
      name: "working_device_replacement_closure_ack_intent_fk",
      columns: [t.tenantId, t.deviceId, t.preparationId, t.intentId, t.credentialEpoch],
      foreignColumns: [
        workingDeviceReplacementReadinessIntents.tenantId,
        workingDeviceReplacementReadinessIntents.deviceId,
        workingDeviceReplacementReadinessIntents.preparationId,
        workingDeviceReplacementReadinessIntents.id,
        workingDeviceReplacementReadinessIntents.credentialEpoch,
      ],
    }),
    check(
      "working_device_replacement_closure_ack_bounds",
      sql`${t.credentialEpoch} between 1 and 9007199254740991 and ${t.requestHash} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${t.response})='object' and octet_length(${t.response}::text)<=8192 and isfinite(${t.acknowledgedAt})`,
    ),
  ],
);

/** Immutable, actor-bound approval snapshot; a preview never starts a cutover. */
export const workingDeviceReplacementExecutionPreviews = pgTable(
  "working_device_replacement_execution_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    preparationId: uuid("preparation_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    mode: text("mode").$type<"normal" | "emergency">().notNull(),
    emergencyReason: text("emergency_reason"),
    factsFingerprint: text("facts_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    newWorkAllowedAt: timestamp("new_work_allowed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("replacement_execution_previews_request_uq").on(t.tenantId, t.actorDomain, t.requestId),
    foreignKey({
      name: "replacement_execution_previews_preparation_fk",
      columns: [t.tenantId, t.deviceId, t.preparationId],
      foreignColumns: [
        workingDeviceReplacementPreparations.tenantId,
        workingDeviceReplacementPreparations.deviceId,
        workingDeviceReplacementPreparations.id,
      ],
    }),
    check(
      "replacement_execution_previews_identity_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and ${t.expectedRevision} > 0 and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "replacement_execution_previews_mode_check",
      sql`((${t.mode} = 'normal' and ${t.emergencyReason} is null) or (${t.mode} = 'emergency' and ${t.emergencyReason} is not null and length(btrim(${t.emergencyReason})) between 1 and 1000)) is true`,
    ),
    check(
      "replacement_execution_previews_interval_check",
      sql`isfinite(${t.createdAt}) and isfinite(${t.expiresAt}) and isfinite(${t.newWorkAllowedAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
  ],
);

/** Latest authenticated v1 capability observation for one installation epoch. */
export const workingDeviceReplacementCapabilities = pgTable(
  "working_device_replacement_capabilities",
  {
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    credentialEpoch: integer("credential_epoch").notNull(),
    supported: boolean("supported").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.deviceId, t.credentialEpoch] }),
    foreignKey({
      name: "replacement_capabilities_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check("replacement_capabilities_epoch_check", sql`${t.credentialEpoch} > 0`),
    check(
      "replacement_capabilities_interval_check",
      sql`isfinite(${t.observedAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.observedAt} and ${t.expiresAt} <= ${t.observedAt} + interval '5 minutes'`,
    ),
  ],
);
