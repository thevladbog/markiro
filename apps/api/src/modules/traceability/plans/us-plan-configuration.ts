import { schema } from "@markiro/db";
import { canonicalExportDigest, type UsPlanConfiguredFacts } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, arrayContains, asc, eq } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

/** The authorized caller owns a REPEATABLE READ transaction; no live read escapes it. */
export async function readUsPlanConfiguration(
  tx: UsMasterDataTransaction,
  tenantId: string,
): Promise<{ facts: UsPlanConfiguredFacts; digest: string }> {
  const [organization] = await tx
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  const [profile] = await tx
    .select()
    .from(schema.traceabilityProfiles)
    .where(eq(schema.traceabilityProfiles.tenantId, tenantId))
    .limit(1);
  const [orgProfile] = await tx
    .select({ timeZone: schema.orgProfiles.timeZone })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId))
    .limit(1);
  if (
    !organization ||
    !profile ||
    profile.code !== "US_FSMA204_PROCESSOR" ||
    profile.baselineVersion === null ||
    !orgProfile?.timeZone
  ) {
    throw new ServiceUnavailableException({ code: "us_plan_configuration_invalid" });
  }
  const locations = await tx
    .select()
    .from(schema.traceabilityLocations)
    .where(
      and(
        eq(schema.traceabilityLocations.tenantId, tenantId),
        eq(schema.traceabilityLocations.archived, false),
        arrayContains(schema.traceabilityLocations.roles, ["tlc_source"]),
      ),
    )
    .orderBy(asc(schema.traceabilityLocations.id));
  const productProfiles = await tx
    .select({
      productId: schema.productTraceabilityProfiles.productId,
      revision: schema.productTraceabilityProfiles.revision,
      coverageStatus: schema.productTraceabilityProfiles.coverageStatus,
    })
    .from(schema.productTraceabilityProfiles)
    .where(eq(schema.productTraceabilityProfiles.tenantId, tenantId))
    .orderBy(asc(schema.productTraceabilityProfiles.productId));
  const facts: UsPlanConfiguredFacts = {
    tenantName: organization.name,
    profileCode: profile.code,
    baselineVersion: profile.baselineVersion,
    timeZone: orgProfile.timeZone,
    retentionYears: profile.retentionYears,
    tlcSourceLocations: locations.map((row) => ({
      id: row.id,
      description: {
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
      },
    })),
    productProfiles,
  };
  return { facts, digest: canonicalExportDigest(facts) };
}
