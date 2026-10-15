import type { TFunction } from "i18next";

import type { HostApi } from "../../host/api.js";
import type { AboutData } from "./about-data.js";
import { licenseSupportBlock } from "./license/license-support.js";
import { BUILT_IN_SUPPORT_KEYS } from "./support-keys.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";
import { createUsageContributor, type UsageLoad } from "./support-usage.js";

/** What a contributor may read: the facts the base text already carries, what the page learned, and the host. */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
  /**
   * Reads the host through the office session (`session.call`, plan ЛЦ-3):
   * an ended session and a rejected device go to the shell as everywhere, and
   * a contributor whose read fails says so in its block or loses it.
   */
  read: <T>(operation: (api: HostApi, token: string) => Promise<T>) => Promise<T>;
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
 * license first (plan ЛЦ-3), then the usage statistics, encrypted for the
 * maker (beta 3 feedback).
 */
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [
  licenseSupportBlock,
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
