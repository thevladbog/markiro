import { canonicalExportDigest } from "../export/canonical.js";
import type { UsPlanConfiguredFacts } from "./snapshot.js";

export interface UsPlanImpact {
  changedSections: Array<"tenant" | "profile" | "tlcSourceLocations" | "productProfiles">;
  changedLocationIds: string[];
  changedProductIds: string[];
}

function changedIds<T>(
  before: T[],
  after: T[],
  idOf: (item: T) => string,
  valueOf: (item: T) => unknown,
): string[] {
  const previous = new Map(
    before.map((item) => [idOf(item), canonicalExportDigest(valueOf(item))]),
  );
  const current = new Map(after.map((item) => [idOf(item), canonicalExportDigest(valueOf(item))]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((id) => previous.get(id) !== current.get(id))
    .sort();
}

/** Compare only configured facts; historical snapshots and workflow policy remain frozen. */
export function compareUsPlanConfiguredFacts(
  frozen: UsPlanConfiguredFacts,
  current: UsPlanConfiguredFacts,
): UsPlanImpact {
  const changedLocationIds = changedIds(
    frozen.tlcSourceLocations,
    current.tlcSourceLocations,
    (location) => location.id,
    ({ description: d }) => ({
      partyId: d.partyId,
      businessName: d.businessName,
      phoneNumber: d.phoneNumber,
      addressKind: d.addressKind,
      streetAddress: d.streetAddress,
      latitude: d.latitude,
      longitude: d.longitude,
      city: d.city,
      stateOrRegion: d.stateOrRegion,
      zipOrPostalCode: d.zipOrPostalCode,
      countryCode: d.countryCode,
    }),
  );
  const changedProductIds = changedIds(
    frozen.productProfiles,
    current.productProfiles,
    (product) => product.productId,
    ({ revision, coverageStatus }) => ({ revision, coverageStatus }),
  );
  const changedSections: UsPlanImpact["changedSections"] = [];
  if (frozen.tenantName !== current.tenantName) changedSections.push("tenant");
  if (
    frozen.profileCode !== current.profileCode ||
    frozen.baselineVersion !== current.baselineVersion ||
    frozen.timeZone !== current.timeZone ||
    frozen.retentionYears !== current.retentionYears
  )
    changedSections.push("profile");
  if (changedLocationIds.length) changedSections.push("tlcSourceLocations");
  if (changedProductIds.length) changedSections.push("productProfiles");
  return { changedSections, changedLocationIds, changedProductIds };
}
