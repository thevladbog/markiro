import type { BoxRegistryPage, BoxRegistryQuery } from "../../host/pallet-assembly.js";

interface RegistrySync {
  state: { until: string; restoreEpoch: string | null } | null;
  getPage: (query: BoxRegistryQuery) => Promise<BoxRegistryPage>;
  applyPage: (page: BoxRegistryPage, mode: { full: boolean; first: boolean }) => Promise<void>;
  active?: () => boolean;
}

/** Applies only one registry window. The store advances its watermark after the last page. */
export async function syncPalletBoxRegistry({
  state,
  getPage,
  applyPage,
  active = () => true,
}: RegistrySync): Promise<void> {
  if (!active()) return;
  let base = state === null ? {} : { since: state.until };
  let page = await getPage(base);
  if (!active()) return;
  if (state !== null && state.restoreEpoch !== (page.restoreEpoch ?? null)) {
    base = {};
    page = await getPage(base);
  }
  const full = !("since" in base);
  const { until, restoreEpoch } = page;
  const seen = new Set<string>();
  let first = true;
  while (active()) {
    if (page.until !== until || page.restoreEpoch !== restoreEpoch) {
      throw new Error("Box registry window changed before completion");
    }
    const cursor = page.nextCursor;
    if (cursor !== undefined && seen.has(cursor)) throw new Error("Box registry cursor repeated");
    await applyPage(page, { full, first });
    if (cursor === undefined || !active()) return;
    seen.add(cursor);
    page = await getPage({ ...base, until, cursor });
    first = false;
  }
}
