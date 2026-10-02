import { schema } from "@markiro/db";
import { canonicalExportDigest, type UsPlanConfiguredFacts } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

/**
 * One statement is one coherent MVCC snapshot, including collection insertions.
 * Phase B calls this after its locks under READ COMMITTED: that statement is the
 * configuration recheck's linearization point. Commits before lock acquisition
 * are visible; configuration changes after this snapshot are later source state.
 * REPEATABLE READ callers retain their existing transaction snapshot semantics.
 */
export async function readUsPlanConfiguration(
  tx: UsMasterDataTransaction,
  tenantId: string,
): Promise<{ facts: UsPlanConfiguredFacts; digest: string }> {
  const locations = schema.traceabilityLocations;
  const products = schema.productTraceabilityProfiles;
  const [configuration] = await tx
    .select({
      tenantName: schema.organization.name,
      profileCode: schema.traceabilityProfiles.code,
      baselineVersion: schema.traceabilityProfiles.baselineVersion,
      timeZone: schema.orgProfiles.timeZone,
      retentionYears: schema.traceabilityProfiles.retentionYears,
      tlcSourceLocations: sql<UsPlanConfiguredFacts["tlcSourceLocations"]>`coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', ${locations.id},
          'description', jsonb_build_object(
            'partyId', ${locations.partyId},
            'businessName', ${locations.businessName},
            'phoneNumber', ${locations.phoneNumber},
            'addressKind', ${locations.addressKind},
            'streetAddress', ${locations.streetAddress},
            'latitude', ${locations.latitude}::text,
            'longitude', ${locations.longitude}::text,
            'city', ${locations.city},
            'stateOrRegion', ${locations.stateOrRegion},
            'zipOrPostalCode', ${locations.zipOrPostalCode},
            'countryCode', ${locations.countryCode}
          )
        ) order by ${locations.id}) from ${locations}
        where ${locations.tenantId} = ${tenantId}
          and ${locations.archived} = false
          and 'tlc_source' = any(${locations.roles})
      ), '[]'::jsonb)`,
      productProfiles: sql<UsPlanConfiguredFacts["productProfiles"]>`coalesce((
        select jsonb_agg(jsonb_build_object(
          'productId', ${products.productId},
          'revision', ${products.revision},
          'coverageStatus', ${products.coverageStatus}
        ) order by ${products.productId}) from ${products}
        where ${products.tenantId} = ${tenantId}
      ), '[]'::jsonb)`,
    })
    .from(schema.organization)
    .innerJoin(
      schema.traceabilityProfiles,
      eq(schema.traceabilityProfiles.tenantId, schema.organization.id),
    )
    .innerJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (
    !configuration ||
    configuration.profileCode !== "US_FSMA204_PROCESSOR" ||
    configuration.baselineVersion === null ||
    !configuration.timeZone
  ) {
    throw new ServiceUnavailableException({ code: "us_plan_configuration_invalid" });
  }
  const facts: UsPlanConfiguredFacts = {
    ...configuration,
    profileCode: configuration.profileCode,
    baselineVersion: configuration.baselineVersion,
  };
  return { facts, digest: canonicalExportDigest(facts) };
}
