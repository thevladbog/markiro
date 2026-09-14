import { sql } from "drizzle-orm";
import {
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
import { workingDeviceAssignments } from "./device-licensing.js";
import { entitlementLifecyclePolicies } from "./entitlements.js";
import { platformUsers } from "./platform-auth.js";
import { stationDevices } from "./platform.js";
import { kiosks } from "./pickup.js";
import { tenantSubscriptions } from "./saas.js";

export type OfflineGrantActivationState = "prepared" | "confirmed" | "cancelled" | "needs_review";

/** A bounded two-operator decision snapshot. Prepare never changes runtime authority. */
export const offlineGrantActivationPreparations = pgTable(
  "offline_grant_activation_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").$type<OfflineGrantActivationState>().notNull().default("prepared"),
    basePolicyId: uuid("base_policy_id").notNull(),
    rolloutPolicyId: uuid("rollout_policy_id"),
    previewRequestId: uuid("preview_request_id").notNull(),
    previewDigest: text("preview_digest").notNull(),
    preparationDigest: text("preparation_digest").notNull(),
    prepareRequestId: uuid("prepare_request_id").notNull(),
    prepareRequestHash: text("prepare_request_hash").notNull(),
    prepareResponse: jsonb("prepare_response").$type<Record<string, unknown>>().notNull(),
    decisionReference: text("decision_reference").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    preparedByPlatformUserId: text("prepared_by_platform_user_id").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmRequestId: uuid("confirm_request_id"),
    confirmRequestHash: text("confirm_request_hash"),
    confirmResponse: jsonb("confirm_response").$type<Record<string, unknown>>(),
    confirmedByPlatformUserId: text("confirmed_by_platform_user_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelRequestId: uuid("cancel_request_id"),
    cancelRequestHash: text("cancel_request_hash"),
    cancelResponse: jsonb("cancel_response").$type<Record<string, unknown>>(),
    cancelledByPlatformUserId: text("cancelled_by_platform_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
  },
  (t) => [
    unique("offline_grant_activation_prepare_request_uq").on(t.prepareRequestId),
    unique("offline_grant_activation_confirm_request_uq").on(t.confirmRequestId),
    unique("offline_grant_activation_cancel_request_uq").on(t.cancelRequestId),
    unique("offline_grant_activation_preparation_digest_uq").on(t.preparationDigest),
    foreignKey({
      name: "offline_grant_activation_base_policy_fk",
      columns: [t.basePolicyId],
      foreignColumns: [entitlementLifecyclePolicies.id],
    }),
    foreignKey({
      name: "offline_grant_activation_rollout_policy_fk",
      columns: [t.rolloutPolicyId],
      foreignColumns: [entitlementLifecyclePolicies.id],
    }),
    foreignKey({
      name: "offline_grant_activation_prepared_by_fk",
      columns: [t.preparedByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }),
    foreignKey({
      name: "offline_grant_activation_confirmed_by_fk",
      columns: [t.confirmedByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }),
    foreignKey({
      name: "offline_grant_activation_cancelled_by_fk",
      columns: [t.cancelledByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }),
    check(
      "offline_grant_activation_state_check",
      sql`${t.state} in ('prepared','confirmed','cancelled','needs_review') and
        ((${t.state} = 'prepared' and ${t.rolloutPolicyId} is null and ${t.confirmRequestId} is null and ${t.confirmRequestHash} is null and ${t.confirmResponse} is null and ${t.confirmedByPlatformUserId} is null and ${t.confirmedAt} is null and ${t.cancelRequestId} is null and ${t.cancelRequestHash} is null and ${t.cancelResponse} is null and ${t.cancelledByPlatformUserId} is null and ${t.cancelledAt} is null and ${t.cancellationReason} is null)
        or (${t.state} = 'confirmed' and ${t.rolloutPolicyId} is not null and ${t.confirmRequestId} is not null and ${t.confirmRequestHash} is not null and ${t.confirmResponse} is not null and ${t.confirmedByPlatformUserId} is not null and ${t.confirmedAt} is not null and ${t.cancelRequestId} is null and ${t.cancelRequestHash} is null and ${t.cancelResponse} is null and ${t.cancelledByPlatformUserId} is null and ${t.cancelledAt} is null and ${t.cancellationReason} is null)
        or (${t.state} = 'needs_review' and ${t.rolloutPolicyId} is null and ${t.confirmRequestId} is not null and ${t.confirmRequestHash} is not null and ${t.confirmResponse} is not null and ${t.confirmedByPlatformUserId} is not null and ${t.confirmedAt} is not null and ${t.cancelRequestId} is null and ${t.cancelRequestHash} is null and ${t.cancelResponse} is null and ${t.cancelledByPlatformUserId} is null and ${t.cancelledAt} is null and ${t.cancellationReason} is null)
        or (${t.state} = 'cancelled' and ${t.rolloutPolicyId} is null and ((${t.confirmRequestId} is null and ${t.confirmRequestHash} is null and ${t.confirmResponse} is null and ${t.confirmedByPlatformUserId} is null and ${t.confirmedAt} is null) or (${t.confirmRequestId} is not null and ${t.confirmRequestHash} is not null and ${t.confirmResponse} is not null and ${t.confirmedByPlatformUserId} is not null and ${t.confirmedAt} is not null)) and ${t.cancelRequestId} is not null and ${t.cancelRequestHash} is not null and ${t.cancelResponse} is not null and ${t.cancelledByPlatformUserId} is not null and ${t.cancelledAt} is not null and ${t.cancellationReason} is not null))`,
    ),
    check(
      "offline_grant_activation_interval_check",
      sql`isfinite(${t.preparedAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} = ${t.preparedAt} + interval '30 minutes' and (${t.confirmedAt} is null or (isfinite(${t.confirmedAt}) and ${t.confirmedAt} >= ${t.preparedAt} and ${t.confirmedAt} < ${t.expiresAt})) and (${t.cancelledAt} is null or (isfinite(${t.cancelledAt}) and ${t.cancelledAt} >= ${t.preparedAt}))`,
    ),
    check(
      "offline_grant_activation_confirm_actor_check",
      sql`${t.confirmedByPlatformUserId} is null or ${t.confirmedByPlatformUserId} <> ${t.preparedByPlatformUserId}`,
    ),
    check(
      "offline_grant_activation_payload_check",
      sql`${t.previewDigest} ~ '^[0-9a-f]{64}$' and ${t.preparationDigest} ~ '^[0-9a-f]{64}$' and ${t.prepareRequestHash} ~ '^[0-9a-f]{64}$' and (${t.confirmRequestHash} is null or ${t.confirmRequestHash} ~ '^[0-9a-f]{64}$') and (${t.cancelRequestHash} is null or ${t.cancelRequestHash} ~ '^[0-9a-f]{64}$') and jsonb_typeof(${t.prepareResponse}) = 'object' and jsonb_typeof(${t.snapshot}) = 'object' and octet_length(${t.prepareResponse}::text) <= 262144 and octet_length(${t.snapshot}::text) <= 262144 and (${t.confirmResponse} is null or (jsonb_typeof(${t.confirmResponse}) = 'object' and octet_length(${t.confirmResponse}::text) <= 262144)) and (${t.cancelResponse} is null or (jsonb_typeof(${t.cancelResponse}) = 'object' and octet_length(${t.cancelResponse}::text) <= 262144)) and length(btrim(${t.decisionReference})) between 1 and 1000 and (${t.cancellationReason} is null or length(btrim(${t.cancellationReason})) between 1 and 1000)`,
    ),
  ],
);

/** Exact facts reserved by a preparation; released rows remain as history. */
export const offlineGrantActivationMembers = pgTable(
  "offline_grant_activation_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    tenantName: text("tenant_name").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    ownerKind: text("owner_kind").$type<"station" | "handheld" | "kiosk">().notNull(),
    stationDeviceId: uuid("station_device_id"),
    kioskId: uuid("kiosk_id"),
    deviceName: text("device_name").notNull(),
    credentialEpoch: integer("credential_epoch").notNull(),
    assignmentId: uuid("assignment_id"),
    configurationId: uuid("configuration_id").notNull(),
    clientReportId: uuid("client_report_id").notNull(),
    verifiedGrantId: uuid("verified_grant_id").notNull(),
    keysetRevision: text("keyset_revision").notNull(),
    entitlementRevision: text("entitlement_revision").notNull(),
    reservationState: text("reservation_state")
      .$type<"prepared" | "released">()
      .notNull()
      .default("prepared"),
  },
  (t) => [
    unique("offline_grant_activation_members_preparation_owner_uq").on(
      t.preparationId,
      t.ownerKind,
      t.stationDeviceId,
      t.kioskId,
    ),
    uniqueIndex("offline_grant_activation_members_station_prepared_uq")
      .on(t.tenantId, t.ownerKind, t.stationDeviceId)
      .where(sql`${t.stationDeviceId} is not null and ${t.reservationState} = 'prepared'`),
    uniqueIndex("offline_grant_activation_members_kiosk_prepared_uq")
      .on(t.tenantId, t.kioskId)
      .where(sql`${t.kioskId} is not null and ${t.reservationState} = 'prepared'`),
    foreignKey({
      name: "offline_grant_activation_members_preparation_fk",
      columns: [t.preparationId],
      foreignColumns: [offlineGrantActivationPreparations.id],
    }),
    foreignKey({
      name: "offline_grant_activation_members_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [organization.id],
    }),
    foreignKey({
      name: "offline_grant_activation_members_subscription_fk",
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    foreignKey({
      name: "offline_grant_activation_members_station_fk",
      columns: [t.tenantId, t.stationDeviceId, t.ownerKind],
      foreignColumns: [stationDevices.tenantId, stationDevices.id, stationDevices.kind],
    }),
    foreignKey({
      name: "offline_grant_activation_members_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    foreignKey({
      name: "offline_grant_activation_members_assignment_fk",
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [workingDeviceAssignments.tenantId, workingDeviceAssignments.id],
    }),
    check(
      "offline_grant_activation_members_owner_check",
      sql`(${t.ownerKind} in ('station','handheld') and ${t.stationDeviceId} is not null and ${t.kioskId} is null and ${t.assignmentId} is not null) or (${t.ownerKind} = 'kiosk' and ${t.kioskId} is not null and ${t.stationDeviceId} is null and ${t.assignmentId} is null)`,
    ),
    check(
      "offline_grant_activation_members_snapshot_check",
      sql`${t.credentialEpoch} > 0 and ${t.entitlementRevision} ~ '^(0|[1-9][0-9]*)$' and length(btrim(${t.tenantName})) between 1 and 300 and length(btrim(${t.deviceName})) between 1 and 300 and length(btrim(${t.keysetRevision})) between 1 and 512 and ${t.reservationState} in ('prepared','released')`,
    ),
  ],
);

/** Current exact-device rollout overlay; null revoked_at means active. */
export const offlineGrantDeviceActivations = pgTable(
  "offline_grant_device_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    ownerKind: text("owner_kind").$type<"station" | "handheld" | "kiosk">().notNull(),
    stationDeviceId: uuid("station_device_id"),
    kioskId: uuid("kiosk_id"),
    credentialEpoch: integer("credential_epoch").notNull(),
    basePolicyId: uuid("base_policy_id").notNull(),
    rolloutPolicyId: uuid("rollout_policy_id").notNull(),
    activatedByPlatformUserId: text("activated_by_platform_user_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("offline_grant_device_activations_tenant_id_uq").on(t.tenantId, t.id),
    index("offline_grant_device_activations_preparation_idx").on(t.preparationId),
    uniqueIndex("offline_grant_device_activations_station_active_uq")
      .on(t.tenantId, t.ownerKind, t.stationDeviceId)
      .where(sql`${t.stationDeviceId} is not null and ${t.revokedAt} is null`),
    uniqueIndex("offline_grant_device_activations_kiosk_active_uq")
      .on(t.tenantId, t.kioskId)
      .where(sql`${t.kioskId} is not null and ${t.revokedAt} is null`),
    foreignKey({
      name: "offline_grant_device_activations_preparation_fk",
      columns: [t.preparationId],
      foreignColumns: [offlineGrantActivationPreparations.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [organization.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_base_policy_fk",
      columns: [t.basePolicyId],
      foreignColumns: [entitlementLifecyclePolicies.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_rollout_policy_fk",
      columns: [t.rolloutPolicyId],
      foreignColumns: [entitlementLifecyclePolicies.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_activated_by_fk",
      columns: [t.activatedByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_subscription_fk",
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    foreignKey({
      name: "offline_grant_device_activations_station_fk",
      columns: [t.tenantId, t.stationDeviceId, t.ownerKind],
      foreignColumns: [stationDevices.tenantId, stationDevices.id, stationDevices.kind],
    }),
    foreignKey({
      name: "offline_grant_device_activations_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
    check(
      "offline_grant_device_activations_owner_check",
      sql`(${t.ownerKind} in ('station','handheld') and ${t.stationDeviceId} is not null and ${t.kioskId} is null) or (${t.ownerKind} = 'kiosk' and ${t.kioskId} is not null and ${t.stationDeviceId} is null)`,
    ),
    check(
      "offline_grant_device_activations_state_check",
      sql`${t.credentialEpoch} > 0 and ${t.rolloutPolicyId} <> ${t.basePolicyId} and isfinite(${t.activatedAt}) and (${t.revokedAt} is null or (isfinite(${t.revokedAt}) and ${t.revokedAt} >= ${t.activatedAt}))`,
    ),
  ],
);

export type OfflineGrantActivationPreparation =
  typeof offlineGrantActivationPreparations.$inferSelect;
export type NewOfflineGrantActivationPreparation =
  typeof offlineGrantActivationPreparations.$inferInsert;
export type OfflineGrantActivationMember = typeof offlineGrantActivationMembers.$inferSelect;
export type OfflineGrantDeviceActivation = typeof offlineGrantDeviceActivations.$inferSelect;
