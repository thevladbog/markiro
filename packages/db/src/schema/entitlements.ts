import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";
import { tenantSubscriptions } from "./saas.js";

/** Explicit policy documents only. Approval is never inferred or seeded by migrations. */
export const entitlementLifecyclePolicies = pgTable(
  "entitlement_lifecycle_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyKey: text("policy_key").notNull(),
    version: integer("version").notNull(),
    status: text("status").$type<"draft" | "approved">().notNull().default("draft"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    decisionReference: text("decision_reference"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByPlatformUserId: text("approved_by_platform_user_id").references(
      () => platformUsers.id,
    ),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("entitlement_lifecycle_policies_key_version_uq").on(t.policyKey, t.version),
    check(
      "entitlement_lifecycle_policies_version_check",
      sql`${t.version} > 0 and length(btrim(${t.policyKey})) between 1 and 100`,
    ),
    check(
      "entitlement_lifecycle_policies_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 65536 and ${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "entitlement_lifecycle_policies_approval_check",
      sql`(${t.status} = 'draft' and ${t.approvedAt} is null and ${t.approvedByPlatformUserId} is null) or (${t.status} = 'approved' and ${t.approvedAt} is not null and isfinite(${t.approvedAt}) and ${t.approvedByPlatformUserId} is not null and ${t.decisionReference} is not null and length(btrim(${t.decisionReference})) between 1 and 1000)`,
    ),
  ],
);

/** bigint mode preserves every PostgreSQL revision bit; encode as decimal strings on the wire. */
export const entitlementRevisions = pgTable(
  "entitlement_revisions",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    usageRevision: bigint("usage_revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "entitlement_revisions_nonnegative_check",
      sql`${t.revision} >= 0 and ${t.usageRevision} >= 0`,
    ),
  ],
);

/** Untrusted JSON is deliberately unknown here; strict registry/effect validation belongs to the service boundary. */
export const entitlementSources = pgTable(
  "entitlement_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    kind: text("kind").$type<"temporary" | "compatibility">().notNull(),
    version: integer("version").notNull().default(1),
    effects: jsonb("effects").$type<unknown[]>().notNull(),
    operationIds: jsonb("operation_ids").$type<unknown[]>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    prepared: boolean("prepared").notNull().default(true),
    reason: text("reason").notNull(),
    decisionReference: text("decision_reference").notNull(),
    requestId: uuid("request_id").notNull(),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByPlatformUserId: text("revoked_by_platform_user_id").references(() => platformUsers.id),
    revocationReason: text("revocation_reason"),
    revocationDecisionReference: text("revocation_decision_reference"),
    revocationRequestId: uuid("revocation_request_id"),
  },
  (t) => [
    unique("entitlement_sources_tenant_id_uq").on(t.tenantId, t.id),
    unique("entitlement_sources_version_id_uq").on(t.versionId),
    unique("entitlement_sources_tenant_request_uq").on(t.tenantId, t.requestId),
    uniqueIndex("entitlement_sources_tenant_revoke_request_uq")
      .on(t.tenantId, t.revocationRequestId)
      .where(sql`${t.revocationRequestId} is not null`),
    index("entitlement_sources_tenant_subscription_idx").on(
      t.tenantId,
      t.subscriptionId,
      t.startsAt,
    ),
    foreignKey({
      name: "entitlement_sources_tenant_subscription_fk",
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    check(
      "entitlement_sources_kind_version_check",
      sql`${t.kind} in ('temporary','compatibility') and ${t.version} > 0 and ${t.prepared} = true`,
    ),
    check(
      "entitlement_sources_interval_check",
      sql`isfinite(${t.startsAt}) and (${t.endsAt} is null or (isfinite(${t.endsAt}) and ${t.endsAt} > ${t.startsAt})) and (${t.kind} <> 'temporary' or ${t.endsAt} is not null)`,
    ),
    check(
      "entitlement_sources_effects_check",
      sql`case when jsonb_typeof(${t.effects}) = 'array' then jsonb_array_length(${t.effects}) between 1 and 11 and octet_length(${t.effects}::text) <= 8192 else false end`,
    ),
    check(
      "entitlement_sources_operations_check",
      sql`case when jsonb_typeof(${t.operationIds}) = 'array' then jsonb_array_length(${t.operationIds}) between 1 and 64 and octet_length(${t.operationIds}::text) <= 8192 else false end`,
    ),
    check(
      "entitlement_sources_compatibility_check",
      sql`${t.kind} <> 'compatibility' or ${t.effects} <@ '[{"key":"chzIntegration","featureEnabled":true},{"key":"inventory","featureEnabled":true},{"key":"commerceMl","featureEnabled":true},{"key":"handheld","featureEnabled":true}]'::jsonb`,
    ),
    check(
      "entitlement_sources_reason_check",
      sql`length(btrim(${t.reason})) between 1 and 1000 and length(btrim(${t.decisionReference})) between 1 and 1000`,
    ),
    check(
      "entitlement_sources_revocation_check",
      sql`(${t.revokedAt} is null and ${t.revokedByPlatformUserId} is null and ${t.revocationReason} is null and ${t.revocationDecisionReference} is null and ${t.revocationRequestId} is null) or (${t.revokedAt} is not null and isfinite(${t.revokedAt}) and ${t.revokedAt} >= ${t.createdAt} and ${t.revokedByPlatformUserId} is not null and ${t.revocationRequestId} is not null and ${t.revocationReason} is not null and length(btrim(${t.revocationReason})) between 1 and 1000 and ${t.revocationDecisionReference} is not null and length(btrim(${t.revocationDecisionReference})) between 1 and 1000)`,
    ),
  ],
);

export const entitlementSourcePreviews = pgTable(
  "entitlement_source_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    intent: text("intent").$type<"prepare" | "revoke">().notNull(),
    requestId: uuid("request_id").notNull(),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    usageRevision: bigint("usage_revision", { mode: "bigint" }).notNull(),
    usageFingerprint: text("usage_fingerprint").notNull(),
    registryVersion: text("registry_version").notNull(),
    lifecyclePolicyFingerprint: text("lifecycle_policy_fingerprint").notNull(),
    nextChangeAt: timestamp("next_change_at", { withTimezone: true }),
    beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>().notNull(),
    afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    resultSourceId: uuid("result_source_id"),
  },
  (t) => [
    unique("entitlement_previews_tenant_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "entitlement_previews_tenant_subscription_fk",
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    foreignKey({
      name: "entitlement_previews_tenant_result_fk",
      columns: [t.tenantId, t.resultSourceId],
      foreignColumns: [entitlementSources.tenantId, entitlementSources.id],
    }),
    check(
      "entitlement_previews_identity_check",
      sql`${t.intent} in ('prepare','revoke') and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and ${t.usageFingerprint} ~ '^[0-9a-f]{64}$' and ${t.lifecyclePolicyFingerprint} ~ '^[0-9a-f]{64}$' and length(btrim(${t.registryVersion})) between 1 and 100 and ${t.revision} >= 0 and ${t.usageRevision} >= 0`,
    ),
    check(
      "entitlement_previews_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 32768 and jsonb_typeof(${t.beforeSnapshot}) = 'object' and octet_length(${t.beforeSnapshot}::text) <= 1048576 and jsonb_typeof(${t.afterSnapshot}) = 'object' and octet_length(${t.afterSnapshot}::text) <= 1048576`,
    ),
    check(
      "entitlement_previews_interval_check",
      sql`isfinite(${t.createdAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and (${t.nextChangeAt} is null or (isfinite(${t.nextChangeAt}) and ${t.nextChangeAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.nextChangeAt}))`,
    ),
    check(
      "entitlement_previews_result_check",
      sql`(${t.confirmedAt} is null and ${t.resultSourceId} is null) or (${t.confirmedAt} is not null and ${t.resultSourceId} is not null and isfinite(${t.confirmedAt}) and ${t.confirmedAt} >= ${t.createdAt} and ${t.confirmedAt} < ${t.expiresAt})`,
    ),
  ],
);

/** Sanitized decision facts, never provider payloads or credentials. */
export const entitlementShadowObservations = pgTable(
  "entitlement_shadow_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    registryVersion: text("registry_version").notNull(),
    revision: bigint("revision", { mode: "bigint" }),
    usageRevision: bigint("usage_revision", { mode: "bigint" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").$type<"allow" | "deny" | "unknown" | "error">().notNull(),
    reasonCodes: jsonb("reason_codes").$type<unknown[]>().notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    requestId: text("request_id"),
    resourceScope: jsonb("resource_scope").$type<Record<string, unknown>>().notNull(),
    fencedAttempt: integer("fenced_attempt"),
    lifecyclePolicyFingerprint: text("lifecycle_policy_fingerprint"),
  },
  (t) => [
    index("entitlement_shadow_tenant_observed_idx").on(t.tenantId, t.observedAt),
    check(
      "entitlement_shadow_identity_check",
      sql`length(btrim(${t.operationId})) between 1 and 100 and length(btrim(${t.registryVersion})) between 1 and 100 and length(btrim(${t.actorType})) between 1 and 100 and ${t.outcome} in ('allow','deny','unknown','error') and (${t.revision} is null or ${t.revision} >= 0) and (${t.usageRevision} is null or ${t.usageRevision} >= 0) and (${t.fencedAttempt} is null or ${t.fencedAttempt} > 0) and (${t.lifecyclePolicyFingerprint} is null or ${t.lifecyclePolicyFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "entitlement_shadow_payload_check",
      sql`case when jsonb_typeof(${t.reasonCodes}) = 'array' then jsonb_array_length(${t.reasonCodes}) <= 64 and octet_length(${t.reasonCodes}::text) <= 8192 else false end and jsonb_typeof(${t.resourceScope}) = 'object' and octet_length(${t.resourceScope}::text) <= 8192`,
    ),
  ],
);
