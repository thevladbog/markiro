import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import type { EntitlementSnapshotV1, StandaloneLicenseRights } from "@markiro/platform-contracts";

export type StandaloneFeatureKey = (typeof STANDALONE_FEATURE_KEYS)[number];
export const MAX_LICENSE_TERM_MS = 365 * 86_400_000;
export const MAX_VALIDITY_STEPS = 64;
const DAY_MS = 86_400_000;

export interface LicenseValidity {
  validUntil: Date;
  reason: "subscription_end" | "entitlement_reduction" | "one_year_cap" | "offline_term";
  /** The time-bound instant the preview promised; `null` for the one-year cap. */
  boundaryAt: Date | null;
}

/**
 * The file carries the snapshot's candidate rights (spec §6.2): quotas as they
 * are (`null` = unlimited) and every feature as a boolean — a feature the
 * catalog never mapped (`null`) is exported as `false` and named (ЛО26).
 */
export function exportStandaloneRights(snapshot: EntitlementSnapshotV1): {
  rights: StandaloneLicenseRights;
  unmapped: StandaloneFeatureKey[];
} {
  const quotas = snapshot.candidate.quotas;
  const features = snapshot.candidate.features;
  return {
    rights: {
      quotas: {
        lines: quotas.lines.limit,
        stations: quotas.stations.limit,
        kiosks: quotas.kiosks.limit,
        cabinetUsers: quotas.cabinetUsers.limit,
      },
      features: {
        labelEditor: features.labelEditor === true,
        publicApi: features.publicApi === true,
        pallets: features.pallets === true,
        chzIntegration: features.chzIntegration === true,
        inventory: features.inventory === true,
        commerceMl: features.commerceMl === true,
        handheld: features.handheld === true,
      },
    },
    unmapped: STANDALONE_FEATURE_KEYS.filter((key) => features[key] === null),
  };
}

/** A reduction: any quota lower (or newly limited), or any feature switched off. */
export function rightsReduce(
  before: StandaloneLicenseRights,
  after: StandaloneLicenseRights,
): boolean {
  for (const key of STANDALONE_QUOTA_KEYS) {
    const was = before.quotas[key];
    const will = after.quotas[key];
    if (will !== null && (was === null || will < was)) return true;
  }
  return STANDALONE_FEATURE_KEYS.some((key) => before.features[key] && !after.features[key]);
}

/**
 * `validUntil` = the subscription end, or the first boundary where the rights
 * shrink, never later than one year from issuance (plan Д5). Increases do not cut
 * the file — the next issuance brings them. Out of steps, it cuts at that
 * boundary rather than trust what it did not evaluate.
 */
export async function licenseValidity(input: {
  at: Date;
  first: EntitlementSnapshotV1;
  snapshotAt: (at: Date) => Promise<EntitlementSnapshotV1>;
  maxSteps?: number;
}): Promise<LicenseValidity> {
  const cap = new Date(input.at.getTime() + MAX_LICENSE_TERM_MS);
  const endsAt = input.first.current.subscription?.endsAt;
  const end = endsAt ? new Date(endsAt) : null;
  const limit: LicenseValidity =
    end !== null && end < cap
      ? { validUntil: end, reason: "subscription_end", boundaryAt: end }
      : { validUntil: cap, reason: "one_year_cap", boundaryAt: null };
  const maxSteps = input.maxSteps ?? MAX_VALIDITY_STEPS;
  let previous = exportStandaloneRights(input.first).rights;
  let next = input.first.nextChangeAt === null ? null : new Date(input.first.nextChangeAt);
  for (let step = 0; next !== null && next < limit.validUntil; step++) {
    if (step >= maxSteps)
      return { validUntil: next, reason: "entitlement_reduction", boundaryAt: next };
    const snapshot = await input.snapshotAt(next);
    const rights = exportStandaloneRights(snapshot).rights;
    if (rightsReduce(previous, rights))
      return { validUntil: next, reason: "entitlement_reduction", boundaryAt: next };
    previous = rights;
    next = snapshot.nextChangeAt === null ? null : new Date(snapshot.nextChangeAt);
  }
  return limit;
}

/** A catalog plan version's entitlement row (`plan_entitlements`) as offline terms read it. */
export interface PlanEntitlementRow {
  maxLines: number | null;
  maxStations: number | null;
  maxKiosks: number | null;
  maxCabinetUsers: number | null;
  labelEditorEnabled: boolean;
  publicApiEnabled: boolean;
  palletsEnabled: boolean;
  chzIntegrationEnabled: boolean | null;
  inventoryEnabled: boolean | null;
  commerceMlEnabled: boolean | null;
  handheldEnabled: boolean | null;
}

/**
 * Offline terms (owner decision 2026-10-13): the rights are the chosen plan
 * version's own quotas and features, exactly as the catalog states them; a
 * feature the catalog never mapped (`null`) is exported as `false` and named,
 * like the subscription path (ЛО26).
 */
export function exportPlanRights(plan: PlanEntitlementRow): {
  rights: StandaloneLicenseRights;
  unmapped: StandaloneFeatureKey[];
} {
  const features = {
    labelEditor: plan.labelEditorEnabled,
    publicApi: plan.publicApiEnabled,
    pallets: plan.palletsEnabled,
    chzIntegration: plan.chzIntegrationEnabled,
    inventory: plan.inventoryEnabled,
    commerceMl: plan.commerceMlEnabled,
    handheld: plan.handheldEnabled,
  } satisfies Record<StandaloneFeatureKey, boolean | null>;
  return {
    rights: {
      quotas: {
        lines: plan.maxLines,
        stations: plan.maxStations,
        kiosks: plan.maxKiosks,
        cabinetUsers: plan.maxCabinetUsers,
      },
      features: {
        labelEditor: features.labelEditor === true,
        publicApi: features.publicApi === true,
        pallets: features.pallets === true,
        chzIntegration: features.chzIntegration === true,
        inventory: features.inventory === true,
        commerceMl: features.commerceMl === true,
        handheld: features.handheld === true,
      },
    },
    unmapped: STANDALONE_FEATURE_KEYS.filter((key) => features[key] === null),
  };
}

/**
 * An offline file ends exactly `termDays` after its issuance: 1-365 days, so
 * never later than a year and never open-ended. A term outside that is a
 * programming error here — the contract already refused it at the boundary.
 */
export function offlineValidity(at: Date, termDays: number): LicenseValidity {
  if (!Number.isInteger(termDays) || termDays < 1 || termDays * DAY_MS > MAX_LICENSE_TERM_MS)
    throw new RangeError("Offline term out of range");
  return {
    validUntil: new Date(at.getTime() + termDays * DAY_MS),
    reason: "offline_term",
    boundaryAt: null,
  };
}
