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
  type UsLocation,
  type UsParty,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";

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

export function isPartyNameConflict(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (
    (candidate.code ?? candidate.cause?.code) === "23505" &&
    (candidate.constraint ?? candidate.cause?.constraint) === "traceability_parties_active_name_uq"
  );
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
  required: UsCapability,
): Promise<void> {
  const [membership] = await tx
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actorUserId)))
    .limit(1)
    .for("share");
  const access = resolveUsAccess(membership?.role ?? "");
  if (!membership || !hasUsCapabilities(access.capabilities, [required])) {
    throw new ForbiddenException({ code: "insufficient_permission" });
  }

  // Keep the locks on independent rows: PostgreSQL cannot apply FOR SHARE to
  // the nullable side of the profile store's outer join.
  const [profile] = await tx
    .select({
      code: schema.traceabilityProfiles.code,
      baselineVersion: schema.traceabilityProfiles.baselineVersion,
      retentionYears: schema.traceabilityProfiles.retentionYears,
    })
    .from(schema.traceabilityProfiles)
    .where(eq(schema.traceabilityProfiles.tenantId, tenantId))
    .limit(1)
    .for("share");
  if (!profile) throw new ForbiddenException({ code: "traceability_profile_required" });

  const [organizationProfile] = await tx
    .select({ timeZone: schema.orgProfiles.timeZone })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId))
    .limit(1)
    .for("share");
  const valid = provisionUsTraceabilityProfileSchema.safeParse({
    code: profile.code,
    retentionYears: profile.retentionYears,
    timeZone: organizationProfile?.timeZone,
  });
  if (!valid.success || profile.baselineVersion !== BASELINE_VERSION) {
    throw new ServiceUnavailableException({ code: "traceability_profile_invalid" });
  }
}
