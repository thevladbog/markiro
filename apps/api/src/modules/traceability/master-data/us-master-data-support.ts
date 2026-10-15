import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  buildLocationDescriptionSnapshot,
  hasUsCapabilities,
  resolveUsAccess,
  type UsCapability,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  provisionUsTraceabilityProfileSchema,
  type ProvisionUsTraceabilityProfileInput,
  type UsLocation,
  type UsParty,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";

export type UsMasterDataTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type PartyRow = typeof schema.traceabilityParties.$inferSelect;
export type LocationRow = typeof schema.traceabilityLocations.$inferSelect;
export type UsPartyList = { items: UsParty[]; limit: number; offset: number };
export type UsLocationList = { items: UsLocation[]; limit: number; offset: number };

const BASELINE_VERSION = "US-REG-2026-09-03";

type SafeIssue = { path: PropertyKey[]; message: string };
type SafeSchema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: SafeIssue[] } };
};

export function parseMasterDataInput<T>(schemaToParse: SafeSchema<T>, input: unknown): T {
  const parsed = schemaToParse.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: "invalid_master_data",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function canonicalCoordinate(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return value;
  const integer = (match[2] ?? "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").padEnd(6, "0");
  const sign = match[1] === "-" && !/^0+$/.test(`${integer}${fraction}`) ? "-" : "";
  return `${sign}${integer}.${fraction}`;
}

export function isUniqueConstraintViolation(error: unknown, constraint: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (
    (candidate.code ?? candidate.cause?.code) === "23505" &&
    (candidate.constraint ?? candidate.cause?.constraint) === constraint
  );
}

export function isPartyNameConflict(error: unknown): boolean {
  return isUniqueConstraintViolation(error, "traceability_parties_active_name_uq");
}

export function partyResponse(row: PartyRow): UsParty {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    notes: row.notes,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function locationPersistentSnapshot(row: LocationRow) {
  return {
    id: row.id,
    partyId: row.partyId,
    name: row.name,
    businessName: row.businessName,
    phoneNumber: row.phoneNumber,
    addressKind: row.addressKind,
    streetAddress: row.streetAddress,
    latitude: row.latitude,
    longitude: row.longitude,
    city: row.city,
    stateOrRegion: row.stateOrRegion,
    zipOrPostalCode: row.zipOrPostalCode,
    countryCode: row.countryCode,
    roles: row.roles,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function locationResponse(row: LocationRow): UsLocation {
  const persistent = locationPersistentSnapshot(row);
  const exportResult = buildLocationDescriptionSnapshot({
    id: row.id,
    partyId: row.partyId,
    businessName: row.businessName,
    phoneNumber: row.phoneNumber,
    addressKind: row.addressKind,
    streetAddress: row.streetAddress,
    latitude: row.latitude,
    longitude: row.longitude,
    city: row.city,
    stateOrRegion: row.stateOrRegion,
    zipOrPostalCode: row.zipOrPostalCode,
    countryCode: row.countryCode,
  });
  return {
    ...persistent,
    descriptionStatus: exportResult.ok
      ? { exportReady: true, issues: [] }
      : { exportReady: false, issues: exportResult.issues },
  };
}

export async function authorizeUsMasterData(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  // An explicit array means any of these capabilities; an empty array denies.
  required: UsCapability | readonly UsCapability[],
): Promise<ProvisionUsTraceabilityProfileInput["code"]> {
  return (await authorizeUsMasterDataDetails(tx, tenantId, actorUserId, required)).code;
}

export async function authorizeUsMasterDataDetails(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  required: UsCapability | readonly UsCapability[],
): Promise<Pick<ProvisionUsTraceabilityProfileInput, "code" | "timeZone">> {
  return authorizeUsMasterDataDetailsCore(tx, tenantId, actorUserId, required, {
    membership: readUsMasterDataMembership,
    profile: readUsMasterDataProfile,
  });
}

type Membership = { role: string } | undefined;
export type UsMasterDataRawProfile = {
  code: unknown;
  baselineVersion: unknown;
  retentionYears: unknown;
  timeZone: unknown;
};

export type UsMasterDataAuthorizationReaders = Readonly<{
  membership(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
  ): Promise<Membership>;
  profile(
    tx: UsMasterDataTransaction,
    tenantId: string,
  ): Promise<UsMasterDataRawProfile | undefined>;
}>;

export async function readUsMasterDataMembership(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
): Promise<Membership> {
  const [membership] = await tx
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actorUserId)))
    .limit(1)
    .for("share");
  return membership;
}

export function assertUsMasterDataCapabilities(
  membership: Membership,
  required: UsCapability | readonly UsCapability[],
): void {
  const access = resolveUsAccess(membership?.role ?? "");
  const alternatives = typeof required === "string" ? [required] : required;
  if (
    !membership ||
    !alternatives.some((capability) => hasUsCapabilities(access.capabilities, [capability]))
  ) {
    throw new ForbiddenException({ code: "insufficient_permission" });
  }
}

export async function readUsMasterDataProfile(
  tx: UsMasterDataTransaction,
  tenantId: string,
): Promise<UsMasterDataRawProfile | undefined> {
  // The lateral read depends on the already locked profile row. An absent or
  // blocked profile cannot acquire the later organization-profile lock.
  const result = await tx.execute<UsMasterDataRawProfile>(sql`
    WITH locked_profile AS MATERIALIZED (
      SELECT tenant_id, code, baseline_version, retention_years
      FROM traceability_profiles WHERE tenant_id = ${tenantId}
      LIMIT 1 FOR SHARE
    ), locked_org AS MATERIALIZED (
      SELECT organization_profile.time_zone
      FROM locked_profile profile
      CROSS JOIN LATERAL (
        SELECT time_zone FROM org_profiles
        WHERE tenant_id = profile.tenant_id LIMIT 1 FOR SHARE
      ) organization_profile
    )
    SELECT code, baseline_version AS "baselineVersion", retention_years AS "retentionYears",
      (SELECT time_zone FROM locked_org) AS "timeZone"
    FROM locked_profile
  `);
  const [profile] = result.rows;
  return profile;
}

export function validateUsMasterDataProfile(
  profile: UsMasterDataRawProfile | undefined,
): Pick<ProvisionUsTraceabilityProfileInput, "code" | "timeZone"> {
  if (!profile) throw new ForbiddenException({ code: "traceability_profile_required" });
  if (
    typeof profile.code !== "string" ||
    typeof profile.baselineVersion !== "string" ||
    typeof profile.retentionYears !== "number" ||
    typeof profile.timeZone !== "string"
  ) {
    throw new ServiceUnavailableException({ code: "traceability_profile_invalid" });
  }
  const valid = provisionUsTraceabilityProfileSchema.safeParse({
    code: profile.code,
    retentionYears: profile.retentionYears,
    timeZone: profile.timeZone,
  });
  if (!valid.success || profile.baselineVersion !== BASELINE_VERSION) {
    throw new ServiceUnavailableException({ code: "traceability_profile_invalid" });
  }
  return { code: valid.data.code, timeZone: valid.data.timeZone };
}

export async function authorizeUsMasterDataDetailsCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  required: UsCapability | readonly UsCapability[],
  readers: UsMasterDataAuthorizationReaders,
): Promise<Pick<ProvisionUsTraceabilityProfileInput, "code" | "timeZone">> {
  const membership = await readers.membership(tx, tenantId, actorUserId);
  assertUsMasterDataCapabilities(membership, required);
  const profile = await readers.profile(tx, tenantId);
  return validateUsMasterDataProfile(profile);
}

export async function authorizeUsMasterDataCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  required: UsCapability | readonly UsCapability[],
  readers: UsMasterDataAuthorizationReaders,
): Promise<ProvisionUsTraceabilityProfileInput["code"]> {
  return (await authorizeUsMasterDataDetailsCore(tx, tenantId, actorUserId, required, readers))
    .code;
}
