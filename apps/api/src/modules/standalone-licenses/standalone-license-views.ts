import type { schema } from "@markiro/db";
import {
  standaloneActivationRequestSchema,
  standaloneLicensePayloadV1Schema,
} from "@markiro/domain";
import {
  platformTimestampSchema,
  standaloneIssuanceSummarySchema,
  standaloneLicenseFileSchema,
  standaloneSiteSchema,
  type StandaloneIssuanceSummary,
  type StandaloneLicenseFile,
  type StandaloneSite,
} from "@markiro/platform-contracts";

export type StandaloneSiteRow = typeof schema.standaloneSites.$inferSelect;
export type StandaloneIssuanceRow = typeof schema.standaloneLicenseIssuances.$inferSelect;
/** Spec §6.2 step 4: remind 30 days before `validUntil`. */
export const RENEWAL_NOTICE_MS = 30 * 86_400_000;

/** What the host reported in its last activation request (plan Д10), or `null` if unreadable. */
export function siteUsage(
  site: StandaloneSiteRow,
): { stations: number; cabinetUsers: number; lines: number } | null {
  const request = standaloneActivationRequestSchema.safeParse(site.lastActivationRequest);
  if (!request.success) return null;
  const { stations, cabinetUsers, lines } = request.data.usage;
  return { stations, cabinetUsers, lines };
}

export function issuanceSummary(row: StandaloneIssuanceRow): StandaloneIssuanceSummary {
  const payload = standaloneLicensePayloadV1Schema.parse(row.payload);
  return standaloneIssuanceSummarySchema.parse({
    licenseId: row.id,
    siteId: row.siteId,
    sequence: row.sequence,
    hostId: row.hostId,
    source: row.source,
    plan: row.plan,
    planVersionId: row.planVersionId,
    entitlementRevision: row.entitlementRevision.toString(),
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil.toISOString(),
    validUntilReason: row.validUntilReason,
    graceDays: row.graceDays,
    kid: row.kid,
    sha256: row.sha256,
    issuedAt: row.issuedAt.toISOString(),
    issuedByPlatformUserId: row.issuedByPlatformUserId,
    replaces: row.replacesId,
    sourceAssignments: row.sourceAssignments ?? null,
    customer: { name: payload.customer.name, inn: payload.customer.inn },
    rights: { quotas: payload.quotas, features: payload.features },
  });
}

export function licenseFileName(hostId: string, sequence: number): string {
  return `markiro-${hostId.slice(0, 8)}-${String(sequence).padStart(3, "0")}.mklic`;
}

export function licenseFile(row: StandaloneIssuanceRow): StandaloneLicenseFile {
  return standaloneLicenseFileSchema.parse({
    issuance: issuanceSummary(row),
    fileName: licenseFileName(row.hostId, row.sequence),
    compact: row.compact,
    sha256: row.sha256,
  });
}

export function siteView(
  site: StandaloneSiteRow,
  latest: StandaloneIssuanceRow | null,
  now: Date,
): StandaloneSite {
  const request = standaloneActivationRequestSchema.safeParse(site.lastActivationRequest);
  return standaloneSiteSchema.parse({
    id: site.id,
    tenantId: site.tenantId,
    hostId: site.hostId,
    name: site.name,
    requestInn: site.requestInn,
    hostVersion: request.success ? request.data.hostVersion : null,
    usage: siteUsage(site),
    // The request's instant is checked for shape only; a non-calendar one shows no date.
    requestCreatedAt:
      request.success && platformTimestampSchema.safeParse(request.data.createdAt).success
        ? request.data.createdAt
        : null,
    hostHistory: site.hostHistory,
    lastIssuedSequence: site.lastIssuedSequence,
    latestIssuance: latest ? issuanceSummary(latest) : null,
    renewalDue: latest !== null && latest.validUntil.getTime() - now.getTime() <= RENEWAL_NOTICE_MS,
    createdAt: site.createdAt.toISOString(),
  });
}
