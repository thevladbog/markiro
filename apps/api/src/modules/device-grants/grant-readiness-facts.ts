import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@markiro/db";
import type { DeviceKind } from "@markiro/domain";
import { grantReadinessReasonSchema, type GrantReadinessReason } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { parseApprovedGrantPolicy } from "./grant-policy";

const REPORT_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export interface GrantReadinessTargetPolicy {
  id: string;
  revision: string;
  approved: boolean;
}

export interface GrantReadinessConfigurationFacts {
  id: string;
  credentialEpoch: number;
  mode: "observe" | "strict";
  policyRevision: string | null;
}

export interface GrantReadinessClientReportFacts {
  id: string;
  receivedAt: Date;
  clientBuild: string;
  storageRevision: number;
  credentialEpoch: number;
  mode: "observe" | "strict";
  policyRevision: string | null;
  keysetRevision: string | null;
  verifiedGrantId: string | null;
  configurationId: string | null;
  matchesCurrentConfiguration: boolean;
  verifiedGrantMatched: boolean;
}

export interface GrantReadinessVerifiedGrantFacts {
  id: string;
  credentialEpoch: number;
  policyId: string;
  policyRevision: string;
  issuedAt: Date;
  startNotAfter: Date | null;
  kid: string;
}

export interface GrantReadinessFacts {
  tenantId: string;
  tenantName: string;
  deviceId: string;
  deviceKind: DeviceKind;
  deviceName: string;
  credentialEpoch: number;
  credentialActive: boolean;
  deviceRevoked: boolean;
  revokedAt: Date | null;
  workingAssignmentPresent: boolean;
  assignmentId: string | null;
  lastSeenAt: Date | null;
  subscriptionActive: boolean;
  currentPolicy: GrantReadinessTargetPolicy | null;
  signingConfigured: boolean;
  currentKeysetRevision: string | null;
  retiredKids: ReadonlySet<string>;
  configuration: GrantReadinessConfigurationFacts | null;
  clientReport: GrantReadinessClientReportFacts | null;
  verifiedGrant: GrantReadinessVerifiedGrantFacts | null;
  evidence: { acceptedCount: number; lastAcceptedAt: Date | null };
}

export interface GrantReadinessFactFilters {
  tenantId?: string;
  deviceKind?: DeviceKind;
  deviceIds?: readonly string[];
}

export interface GrantReadinessFactCursor {
  tenantId: string;
  deviceKind: DeviceKind;
  deviceId: string;
}

export interface GrantReadinessFactPage {
  after?: GrantReadinessFactCursor;
  limit: number;
}

export interface GrantReadinessSigningFacts {
  configured: boolean;
  keysetRevision: string | null;
  retiredKids: ReadonlySet<string>;
}

export function classifyGrantReadiness(
  facts: GrantReadinessFacts,
  targetPolicy: GrantReadinessTargetPolicy,
  asOf: Date,
): { status: "eligible"; reasons: [] } | { status: "blocked"; reasons: GrantReadinessReason[] } {
  const reasons = new Set<GrantReadinessReason>();
  const report = facts.clientReport;
  const configuration = facts.configuration;
  const grant = facts.verifiedGrant;
  const lastSeenAt = facts.lastSeenAt;
  const authenticatedAfterReport =
    report === null ? true : authenticatedAtOrAfter(lastSeenAt, report.receivedAt);

  if (!facts.credentialActive || !authenticatedAfterReport) reasons.add("credential_inactive");
  if (facts.deviceRevoked) reasons.add("device_revoked");
  if (!facts.workingAssignmentPresent) reasons.add("working_assignment_missing");
  if (!facts.subscriptionActive) reasons.add("subscription_missing");
  if (
    facts.currentPolicy?.id !== targetPolicy.id ||
    facts.currentPolicy.revision !== targetPolicy.revision
  )
    reasons.add("target_policy_not_current");
  if (!targetPolicy.approved || facts.currentPolicy?.approved !== true)
    reasons.add("target_policy_not_approved");
  if (!facts.signingConfigured || facts.currentKeysetRevision === null)
    reasons.add("signing_not_configured");
  if (!configuration) reasons.add("configuration_missing");
  if (!report) reasons.add("client_report_missing");
  if (report && asOf.getTime() - report.receivedAt.getTime() > REPORT_FRESHNESS_MS)
    reasons.add("client_report_stale");
  if (report && report.credentialEpoch !== facts.credentialEpoch)
    reasons.add("credential_epoch_mismatch");
  if (
    report &&
    configuration &&
    (configuration.credentialEpoch !== facts.credentialEpoch ||
      report.configurationId !== configuration.id ||
      report.mode !== "observe" ||
      configuration.mode !== "observe" ||
      report.policyRevision !== targetPolicy.revision ||
      configuration.policyRevision !== targetPolicy.revision ||
      !report.matchesCurrentConfiguration)
  )
    reasons.add("configuration_mismatch");
  if (report && report.keysetRevision !== facts.currentKeysetRevision)
    reasons.add("keyset_mismatch");
  if (!report?.verifiedGrantId) reasons.add("verified_grant_missing");
  if (
    report?.verifiedGrantId &&
    (!grant ||
      report.verifiedGrantId !== grant.id ||
      !report.verifiedGrantMatched ||
      grant.credentialEpoch !== facts.credentialEpoch ||
      grant.policyId !== targetPolicy.id ||
      grant.policyRevision !== targetPolicy.revision)
  )
    reasons.add("verified_grant_mismatch");
  if (grant && facts.retiredKids.has(grant.kid)) reasons.add("grant_key_retired");

  const ordered = grantReadinessReasonSchema.options.filter((reason) => reasons.has(reason));
  return ordered.length === 0
    ? { status: "eligible", reasons: [] }
    : { status: "blocked", reasons: ordered };
}

// The read side is implemented below the pure classifier so callers cannot bypass
// the same eligibility rules when list and preview acquire facts differently.
export async function readGrantReadinessFacts(
  tx: Db | SubscriptionTransaction,
  asOf: Date,
  filters: GrantReadinessFactFilters,
  signing: GrantReadinessSigningFacts,
  page?: GrantReadinessFactPage,
): Promise<GrantReadinessFacts[]> {
  const rows: RawGrantReadinessRow[] = [];
  if (filters.deviceKind !== "kiosk") {
    const result = await tx.execute<RawGrantReadinessRow>(sql`
      select
        organization.id as "tenantId",
        organization.name as "tenantName",
        station_devices.id as "deviceId",
        station_devices.kind as "deviceKind",
        station_devices.name as "deviceName",
        station_devices.credential_epoch as "credentialEpoch",
        (station_devices.paired_at is not null and station_devices.revoked_at is null
          and station_key.id is not null and station_key.config_id = 'station'
          and station_key.reference_id = station_devices.tenant_id
          and station_key.enabled is not false
          and (station_key.expires_at is null or station_key.expires_at > ${asOf})) as "credentialActive",
        (station_devices.revoked_at is not null) as "deviceRevoked",
        station_devices.revoked_at as "revokedAt",
        (assignment.id is not null and assignment.state in ('reserved', 'assigned')) as "workingAssignmentPresent",
        case when assignment.state in ('reserved', 'assigned') then assignment.id else null end as "assignmentId",
        station_devices.last_seen_at as "lastSeenAt",
        (subscription.id is not null) as "subscriptionActive",
        subscription.policy_id as "policyId",
        subscription.policy_version as "policyVersion",
        subscription.policy_status as "policyStatus",
        subscription.policy_payload as "policyPayload",
        subscription.policy_payload_hash as "policyPayloadHash",
        subscription.policy_decision_reference as "policyDecisionReference",
        subscription.policy_approved_at as "policyApprovedAt",
        subscription.policy_approved_by as "policyApprovedBy",
        configuration.id as "configurationId",
        configuration.credential_epoch as "configurationCredentialEpoch",
        configuration.mode as "configurationMode",
        configuration.policy_revision as "configurationPolicyRevision",
        report.id as "reportId",
        report.received_at as "reportReceivedAt",
        report.client_build as "reportClientBuild",
        report.storage_revision as "reportStorageRevision",
        report.credential_epoch as "reportCredentialEpoch",
        report.reported_mode as "reportMode",
        report.reported_policy_revision as "reportPolicyRevision",
        report.reported_keyset_revision as "reportKeysetRevision",
        report.reported_grant_id as "reportVerifiedGrantId",
        report.configuration_id as "reportConfigurationId",
        report.matches_current_configuration as "reportMatchesConfiguration",
        report.verified_grant_matched as "reportVerifiedGrantMatched",
        issuance.grant_id as "grantId",
        issuance.credential_epoch as "grantCredentialEpoch",
        issuance.policy_id as "grantPolicyId",
        issuance.policy_revision as "grantPolicyRevision",
        issuance.issued_at as "grantIssuedAt",
        issuance.start_not_after as "grantStartNotAfter",
        issuance.header_kid as "grantKid",
        coalesce(evidence.accepted_count, 0)::int as "evidenceAcceptedCount",
        evidence.last_accepted_at as "evidenceLastAcceptedAt"
      from station_devices
      inner join organization on organization.id = station_devices.tenant_id
      left join apikey station_key on station_key.id = station_devices.api_key_id
      left join working_device_assignments assignment
        on assignment.tenant_id = station_devices.tenant_id
       and assignment.device_id = station_devices.id
      left join (${activeSubscriptionPolicySql(asOf)}) subscription
        on subscription.tenant_id = station_devices.tenant_id
      left join lateral (
        select id, credential_epoch, mode, policy_revision
        from device_grant_configurations
        where tenant_id = station_devices.tenant_id
          and owner_kind = station_devices.kind
          and station_device_id = station_devices.id
        order by sequence desc
        limit 1
      ) configuration on true
      left join lateral (
        select id, received_at, client_build, storage_revision, credential_epoch,
               reported_mode, reported_policy_revision, reported_keyset_revision,
               reported_grant_id, verified_grant_id, configuration_id, matches_current_configuration,
               verified_grant_matched
        from device_grant_client_readiness_reports
        where tenant_id = station_devices.tenant_id
          and owner_kind = station_devices.kind
          and station_device_id = station_devices.id
        order by sequence desc
        limit 1
      ) report on true
      left join lateral (
        select grant_id, credential_epoch, policy_id, policy_revision, issued_at,
               start_not_after, header_kid
        from device_grant_issuances
        where tenant_id = station_devices.tenant_id
          and owner_kind = station_devices.kind
          and station_device_id = station_devices.id
          and kind_of_grant = 'device'
          and grant_id = report.verified_grant_id
        limit 1
      ) issuance on true
      left join (
        select tenant_id, owner_kind, station_device_id,
               count(*) filter (where disposition in ('accepted','duplicate')) as accepted_count,
               max(received_at) filter (where disposition in ('accepted','duplicate')) as last_accepted_at
        from device_grant_evidence
        where station_device_id is not null
        group by tenant_id, owner_kind, station_device_id
      ) evidence
        on evidence.tenant_id = station_devices.tenant_id
       and evidence.owner_kind = station_devices.kind
       and evidence.station_device_id = station_devices.id
      where ${deviceFilterSql("station_devices", filters)}
        and ${pageBoundarySql("station_devices", page)}
      order by station_devices.tenant_id, station_devices.kind, station_devices.id
      ${limitSql(page)}
    `);
    rows.push(...result.rows);
  }
  if (filters.deviceKind === undefined || filters.deviceKind === "kiosk") {
    const result = await tx.execute<RawGrantReadinessRow>(sql`
      select
        organization.id as "tenantId",
        organization.name as "tenantName",
        kiosks.id as "deviceId",
        'kiosk'::text as "deviceKind",
        kiosks.name as "deviceName",
        kiosks.credential_epoch as "credentialEpoch",
        (kiosks.device_token_hash is not null and kiosks.status = 'active') as "credentialActive",
        (kiosks.status <> 'active') as "deviceRevoked",
        null::timestamptz as "revokedAt",
        (kiosks.status = 'active') as "workingAssignmentPresent",
        null::uuid as "assignmentId",
        kiosks.last_seen_at as "lastSeenAt",
        (subscription.id is not null) as "subscriptionActive",
        subscription.policy_id as "policyId",
        subscription.policy_version as "policyVersion",
        subscription.policy_status as "policyStatus",
        subscription.policy_payload as "policyPayload",
        subscription.policy_payload_hash as "policyPayloadHash",
        subscription.policy_decision_reference as "policyDecisionReference",
        subscription.policy_approved_at as "policyApprovedAt",
        subscription.policy_approved_by as "policyApprovedBy",
        configuration.id as "configurationId",
        configuration.credential_epoch as "configurationCredentialEpoch",
        configuration.mode as "configurationMode",
        configuration.policy_revision as "configurationPolicyRevision",
        report.id as "reportId",
        report.received_at as "reportReceivedAt",
        report.client_build as "reportClientBuild",
        report.storage_revision as "reportStorageRevision",
        report.credential_epoch as "reportCredentialEpoch",
        report.reported_mode as "reportMode",
        report.reported_policy_revision as "reportPolicyRevision",
        report.reported_keyset_revision as "reportKeysetRevision",
        report.reported_grant_id as "reportVerifiedGrantId",
        report.configuration_id as "reportConfigurationId",
        report.matches_current_configuration as "reportMatchesConfiguration",
        report.verified_grant_matched as "reportVerifiedGrantMatched",
        issuance.grant_id as "grantId",
        issuance.credential_epoch as "grantCredentialEpoch",
        issuance.policy_id as "grantPolicyId",
        issuance.policy_revision as "grantPolicyRevision",
        issuance.issued_at as "grantIssuedAt",
        issuance.start_not_after as "grantStartNotAfter",
        issuance.header_kid as "grantKid",
        coalesce(evidence.accepted_count, 0)::int as "evidenceAcceptedCount",
        evidence.last_accepted_at as "evidenceLastAcceptedAt"
      from kiosks
      inner join organization on organization.id = kiosks.tenant_id
      left join (${activeSubscriptionPolicySql(asOf)}) subscription
        on subscription.tenant_id = kiosks.tenant_id
      left join lateral (
        select id, credential_epoch, mode, policy_revision
        from device_grant_configurations
        where tenant_id = kiosks.tenant_id and owner_kind = 'kiosk' and kiosk_id = kiosks.id
        order by sequence desc limit 1
      ) configuration on true
      left join lateral (
        select id, received_at, client_build, storage_revision, credential_epoch,
               reported_mode, reported_policy_revision, reported_keyset_revision,
               reported_grant_id, verified_grant_id, configuration_id, matches_current_configuration,
               verified_grant_matched
        from device_grant_client_readiness_reports
        where tenant_id = kiosks.tenant_id and owner_kind = 'kiosk' and kiosk_id = kiosks.id
        order by sequence desc limit 1
      ) report on true
      left join lateral (
        select grant_id, credential_epoch, policy_id, policy_revision, issued_at,
               start_not_after, header_kid
        from device_grant_issuances
        where tenant_id = kiosks.tenant_id and owner_kind = 'kiosk' and kiosk_id = kiosks.id
          and kind_of_grant = 'device' and grant_id = report.verified_grant_id
        limit 1
      ) issuance on true
      left join (
        select tenant_id, kiosk_id,
               count(*) filter (where disposition in ('accepted','duplicate')) as accepted_count,
               max(received_at) filter (where disposition in ('accepted','duplicate')) as last_accepted_at
        from device_grant_evidence
        where owner_kind = 'kiosk' and kiosk_id is not null
        group by tenant_id, kiosk_id
      ) evidence
        on evidence.tenant_id = kiosks.tenant_id and evidence.kiosk_id = kiosks.id
      where ${deviceFilterSql("kiosks", filters)}
        and ${pageBoundarySql("kiosks", page)}
      order by kiosks.tenant_id, kiosks.id
      ${limitSql(page)}
    `);
    rows.push(...result.rows);
  }
  const facts = rows.map((row) => mapRawFacts(row, signing)).sort(compareFacts);
  return page ? facts.slice(0, page.limit) : facts;
}

interface RawGrantReadinessRow extends Record<string, unknown> {
  tenantId: string;
  tenantName: string;
  deviceId: string;
  deviceKind: DeviceKind;
  deviceName: string;
  credentialEpoch: number;
  credentialActive: boolean;
  deviceRevoked: boolean;
  revokedAt: Date | string | null;
  workingAssignmentPresent: boolean;
  assignmentId: string | null;
  lastSeenAt: Date | string | null;
  subscriptionActive: boolean;
  policyId: string | null;
  policyVersion: number | null;
  policyStatus: "draft" | "approved" | null;
  policyPayload: Record<string, unknown> | null;
  policyPayloadHash: string | null;
  policyDecisionReference: string | null;
  policyApprovedAt: Date | string | null;
  policyApprovedBy: string | null;
  configurationId: string | null;
  configurationCredentialEpoch: number | null;
  configurationMode: "observe" | "strict" | null;
  configurationPolicyRevision: string | null;
  reportId: string | null;
  reportReceivedAt: Date | string | null;
  reportClientBuild: string | null;
  reportStorageRevision: number | null;
  reportCredentialEpoch: number | null;
  reportMode: "observe" | "strict" | null;
  reportPolicyRevision: string | null;
  reportKeysetRevision: string | null;
  reportVerifiedGrantId: string | null;
  reportConfigurationId: string | null;
  reportMatchesConfiguration: boolean | null;
  reportVerifiedGrantMatched: boolean | null;
  grantId: string | null;
  grantCredentialEpoch: number | null;
  grantPolicyId: string | null;
  grantPolicyRevision: string | null;
  grantIssuedAt: Date | string | null;
  grantStartNotAfter: Date | string | null;
  grantKid: string | null;
  evidenceAcceptedCount: number;
  evidenceLastAcceptedAt: Date | string | null;
}

function activeSubscriptionPolicySql(asOf: Date): SQL {
  return sql`
    select tenant_subscriptions.id, tenant_subscriptions.tenant_id,
           entitlement_lifecycle_policies.id as policy_id,
           entitlement_lifecycle_policies.version as policy_version,
           entitlement_lifecycle_policies.status as policy_status,
           entitlement_lifecycle_policies.payload as policy_payload,
           entitlement_lifecycle_policies.payload_hash as policy_payload_hash,
           entitlement_lifecycle_policies.decision_reference as policy_decision_reference,
           entitlement_lifecycle_policies.approved_at as policy_approved_at,
           entitlement_lifecycle_policies.approved_by_platform_user_id as policy_approved_by
    from tenant_subscriptions
    inner join catalog_item_versions
      on catalog_item_versions.id = tenant_subscriptions.plan_version_id
    left join entitlement_lifecycle_policies
      on entitlement_lifecycle_policies.id = catalog_item_versions.lifecycle_policy_id
    where tenant_subscriptions.status in ('trial','active')
      and (tenant_subscriptions.starts_at is null or tenant_subscriptions.starts_at <= ${asOf})
      and (tenant_subscriptions.ends_at is null or tenant_subscriptions.ends_at > ${asOf})
  `;
}

function deviceFilterSql(
  deviceTable: "station_devices" | "kiosks",
  filters: GrantReadinessFactFilters,
): SQL {
  const conditions: SQL[] = [sql`true`];
  const tenant = sql.raw(`${deviceTable}.tenant_id`);
  const id = sql.raw(`${deviceTable}.id`);
  if (filters.tenantId) conditions.push(sql`${tenant} = ${filters.tenantId}`);
  if (deviceTable === "station_devices" && filters.deviceKind)
    conditions.push(sql`station_devices.kind = ${filters.deviceKind}`);
  if (filters.deviceIds) {
    if (filters.deviceIds.length === 0) conditions.push(sql`false`);
    else
      conditions.push(
        sql`${id} in (${sql.join(
          filters.deviceIds.map((deviceId) => sql`${deviceId}::uuid`),
          sql`, `,
        )})`,
      );
  }
  return sql.join(conditions, sql` and `);
}

function pageBoundarySql(
  deviceTable: "station_devices" | "kiosks",
  page: GrantReadinessFactPage | undefined,
): SQL {
  const after = page?.after;
  if (!after) return sql`true`;
  const tenant = sql.raw(`${deviceTable}.tenant_id`);
  const id = sql.raw(`${deviceTable}.id`);
  const kind = deviceTable === "station_devices" ? sql`station_devices.kind` : sql`'kiosk'::text`;
  return sql`(
    ${tenant} > ${after.tenantId}
    or (${tenant} = ${after.tenantId} and ${kind} > ${after.deviceKind})
    or (${tenant} = ${after.tenantId} and ${kind} = ${after.deviceKind}
      and ${id} > ${after.deviceId}::uuid)
  )`;
}

function limitSql(page: GrantReadinessFactPage | undefined): SQL {
  return page ? sql`limit ${page.limit}` : sql``;
}

function mapRawFacts(
  row: RawGrantReadinessRow,
  signing: GrantReadinessSigningFacts,
): GrantReadinessFacts {
  const parsedPolicy =
    row.policyId &&
    row.policyVersion &&
    row.policyStatus &&
    row.policyPayload &&
    row.policyPayloadHash
      ? parseApprovedGrantPolicy({
          id: row.policyId,
          version: row.policyVersion,
          status: row.policyStatus,
          payload: row.policyPayload,
          payloadHash: row.policyPayloadHash,
          decisionReference: row.policyDecisionReference,
          approvedAt: databaseDate(row.policyApprovedAt),
          approvedByPlatformUserId: row.policyApprovedBy,
        })
      : null;
  const currentPolicy = row.policyId
    ? {
        id: row.policyId,
        revision:
          parsedPolicy?.revision ??
          `${row.policyId}:${row.policyVersion ?? 0}:${row.policyPayloadHash ?? "invalid"}`,
        approved: parsedPolicy !== null,
      }
    : null;
  const configuration =
    row.configurationId && row.configurationCredentialEpoch && row.configurationMode
      ? {
          id: row.configurationId,
          credentialEpoch: row.configurationCredentialEpoch,
          mode: row.configurationMode,
          policyRevision: row.configurationPolicyRevision,
        }
      : null;
  const clientReport =
    row.reportId &&
    row.reportReceivedAt &&
    row.reportClientBuild &&
    row.reportStorageRevision &&
    row.reportCredentialEpoch &&
    row.reportMode &&
    row.reportMatchesConfiguration !== null &&
    row.reportVerifiedGrantMatched !== null
      ? {
          id: row.reportId,
          receivedAt: databaseDate(row.reportReceivedAt)!,
          clientBuild: row.reportClientBuild,
          storageRevision: row.reportStorageRevision,
          credentialEpoch: row.reportCredentialEpoch,
          mode: row.reportMode,
          policyRevision: row.reportPolicyRevision,
          keysetRevision: row.reportKeysetRevision,
          verifiedGrantId: row.reportVerifiedGrantId,
          configurationId: row.reportConfigurationId,
          matchesCurrentConfiguration: row.reportMatchesConfiguration,
          verifiedGrantMatched: row.reportVerifiedGrantMatched,
        }
      : null;
  const verifiedGrant =
    row.grantId &&
    row.grantCredentialEpoch &&
    row.grantPolicyId &&
    row.grantPolicyRevision &&
    row.grantIssuedAt &&
    row.grantKid
      ? {
          id: row.grantId,
          credentialEpoch: row.grantCredentialEpoch,
          policyId: row.grantPolicyId,
          policyRevision: row.grantPolicyRevision,
          issuedAt: databaseDate(row.grantIssuedAt)!,
          startNotAfter: databaseDate(row.grantStartNotAfter),
          kid: row.grantKid,
        }
      : null;
  return {
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    deviceId: row.deviceId,
    deviceKind: row.deviceKind,
    deviceName: row.deviceName,
    credentialEpoch: row.credentialEpoch,
    credentialActive: row.credentialActive,
    deviceRevoked: row.deviceRevoked,
    revokedAt: databaseDate(row.revokedAt),
    workingAssignmentPresent: row.workingAssignmentPresent,
    assignmentId: row.assignmentId,
    lastSeenAt: databaseDate(row.lastSeenAt),
    subscriptionActive: row.subscriptionActive,
    currentPolicy,
    signingConfigured: signing.configured,
    currentKeysetRevision: signing.keysetRevision,
    retiredKids: signing.retiredKids,
    configuration,
    clientReport,
    verifiedGrant,
    evidence: {
      acceptedCount: row.evidenceAcceptedCount,
      lastAcceptedAt: databaseDate(row.evidenceLastAcceptedAt),
    },
  };
}

function compareFacts(left: GrantReadinessFacts, right: GrantReadinessFacts): number {
  return (
    left.tenantId.localeCompare(right.tenantId) ||
    left.deviceKind.localeCompare(right.deviceKind) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

function databaseDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid readiness timestamp");
  return parsed;
}

function authenticatedAtOrAfter(lastSeenAt: Date | null, reportReceivedAt: Date): boolean {
  return lastSeenAt !== null && lastSeenAt.getTime() >= reportReceivedAt.getTime();
}
