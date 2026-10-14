import type { TFunction } from "i18next";

import type { AboutData } from "./about-data.js";
import { BUILT_IN_SUPPORT_KEYS } from "./support-keys.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";
import { createUsageContributor, type UsageLoad } from "./support-usage.js";

/** What a contributor may read: the facts the base text already carries and what the page learned. */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
  /** What the page learned of the host's usage statistics; absent where it was not asked. */
  usage?: UsageLoad;
}

/**
 * Adds a block to the support text (extension point T2 of the license and
 * update spec). It returns `null` for nothing to say. A contributor that
 * throws or rejects loses only its own block.
 */
export type SupportContributor = (
  context: SupportContext,
) => SupportBlock | null | Promise<SupportBlock | null>;

/**
 * The contributors, in the order their blocks follow the base text: the
 * usage statistics, encrypted for the maker (beta 3 feedback).
 */
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [
  createUsageContributor(BUILT_IN_SUPPORT_KEYS),
];

/** The blocks of `contributors`, each isolated from the others' failures. */
export async function collectSupportBlocks(
  contributors: readonly SupportContributor[],
  context: SupportContext,
): Promise<SupportBlock[]> {
  const settled = await Promise.allSettled(
    contributors.map(async (contribute) => contribute(context)),
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value !== null ? [result.value] : [],
  );
}
