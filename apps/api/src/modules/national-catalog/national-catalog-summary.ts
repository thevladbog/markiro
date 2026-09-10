import type { schema } from "@markiro/db";
import {
  currentCatalogProjection,
  readCatalogProjection,
  reviewedCatalogValues,
} from "./national-catalog-observation-projection";
import { readRefreshCheckpoint, safeRefreshErrorCode } from "./national-catalog-refresh-state";
import type { ChzSummary } from "@markiro/platform-contracts";
import { canonicalJsonHash } from "./national-catalog-products.service";

/** Missing targets mean unsupported/unknown, never a provider assertion of removal. */
export type CatalogValueProjection = { version: 1; values: Record<string, unknown> };
export function hasUnreviewedCatalogChanges(input: {
  reviewed: CatalogValueProjection | null;
  observed: CatalogValueProjection | null;
  current: CatalogValueProjection | null;
}): boolean {
  const { reviewed, observed, current } = input;
  if (!reviewed || !observed || !current) return false;
  return Object.entries(observed.values).some(([target, value]) => {
    if (!Object.hasOwn(reviewed.values, target) || !Object.hasOwn(current.values, target))
      return false;
    const hash = canonicalJsonHash(value);
    return (
      hash !== canonicalJsonHash(reviewed.values[target]) &&
      hash !== canonicalJsonHash(current.values[target])
    );
  });
}
export function buildChzSummary(input: ChzSummary): ChzSummary {
  return input.linkId === null
    ? {
        linkId: null,
        revision: null,
        statusKeys: [],
        rawStatus: null,
        rawDetailedStatuses: [],
        lastSuccessAt: null,
        lastAttemptAt: null,
        refreshing: false,
        lastOutcome: "never",
        hasChanges: false,
        lastErrorCode: null,
      }
    : { ...input, hasChanges: !input.statusKeys.includes("archived") && input.hasChanges };
}

export function summaryForCatalogLink(
  link: typeof schema.nationalCatalogProductLinks.$inferSelect | null,
  product: {
    gtin14: string;
    name: string;
    printName: string | null;
    shelfLifeDays: number | null;
    egaisCode?: string | null;
    chzProductGroupCode: number | null;
  },
  imageChecksum: string | null,
  localState: unknown,
): ChzSummary {
  const reviewed = readCatalogProjection(link?.reviewedProjection);
  const observed = readCatalogProjection(link?.observedProjection);
  const identityMatches = link?.boundGtin14 === product.gtin14;
  return buildChzSummary({
    linkId: link?.id ?? null,
    revision: link?.revision ?? null,
    statusKeys: link ? (link.statusKeys.length ? link.statusKeys : ["unknown"]) : [],
    rawStatus: link?.rawStatus ?? null,
    rawDetailedStatuses: link?.rawDetailedStatuses ?? [],
    lastSuccessAt: link?.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: link?.lastAttemptAt?.toISOString() ?? null,
    refreshing: readRefreshCheckpoint(link?.refreshCheckpoint)?.enqueuePending ?? false,
    lastOutcome: link && !identityMatches ? "error" : (link?.lastOutcome ?? "never"),
    lastErrorCode:
      link && !identityMatches
        ? "local_gtin_changed"
        : safeRefreshErrorCode(link?.refreshErrorCode),
    hasChanges:
      identityMatches &&
      hasUnreviewedCatalogChanges({
        reviewed: reviewedCatalogValues(reviewed),
        observed,
        current: currentCatalogProjection(reviewed, product, imageChecksum, localState),
      }),
  });
}
