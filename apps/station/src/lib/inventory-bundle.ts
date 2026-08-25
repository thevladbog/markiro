import type { StationClient } from "./api-client.js";
import {
  parseStationInventoryBundleManifest,
  parseStationInventoryBundlePage,
} from "@markiro/domain";
import {
  beginInventoryMirror,
  ingestInventoryPage,
  publishInventorySnapshot,
  readInventoryMirrorState,
} from "./inventory-mirror.js";
import type { SqlExecutor } from "./mirror.js";

/**
 * Downloads the immutable Task 2 bundle into snapshot-scoped rows. Every
 * restart reuses the persisted cursor and generation. Publication itself is
 * delegated to inventory-mirror's single guarded UPDATE; this orchestration
 * never sends BEGIN/COMMIT through the pooled executor.
 */
export async function mirrorInventoryBundle(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  inventoryId: string,
): Promise<boolean> {
  const manifest = parseStationInventoryBundleManifest(
    await client.get<unknown>(`/station/inventories/${inventoryId}/bundle/manifest`),
  );
  if (manifest.inventoryId !== inventoryId) {
    throw new Error("inventory bundle requested inventory mismatch");
  }
  const candidate = await beginInventoryMirror(exec, manifest);
  if (candidate.alreadyActive) return true;

  let state = await readInventoryMirrorState(exec, inventoryId);
  if (
    state?.verifiedDigest === candidate.combinedDigest &&
    state.verifiedContentDigest === candidate.contentDigest
  ) {
    return publishInventorySnapshot(exec, candidate);
  }

  let cursor = state?.nextCursor ?? null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(manifest.limits.codePageSize) });
    if (cursor !== null) query.set("cursor", cursor);
    const page = parseStationInventoryBundlePage(
      await client.get<unknown>(
        `/station/inventories/${inventoryId}/bundle/codes?${query.toString()}`,
      ),
    );
    await ingestInventoryPage(exec, candidate, cursor, page);
    if (page.nextCursor === null) return publishInventorySnapshot(exec, candidate);
    cursor = page.nextCursor;
    state = await readInventoryMirrorState(exec, inventoryId);
    if (
      state?.stagedSnapshotId !== candidate.snapshotId ||
      state.generation !== candidate.generation
    ) {
      throw new Error("inventory bundle staging was superseded");
    }
  }
}
