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

export interface InventoryMirrorLease {
  isCurrent: () => boolean;
  commitPublication?: (publishSnapshot: () => Promise<boolean>) => Promise<boolean>;
}

function leaseIsCurrent(lease: InventoryMirrorLease | undefined): boolean {
  return lease?.isCurrent() ?? true;
}

function commitPublication(
  lease: InventoryMirrorLease | undefined,
  publishSnapshot: () => Promise<boolean>,
): Promise<boolean> {
  return lease?.commitPublication?.(publishSnapshot) ?? publishSnapshot();
}

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
  lease?: InventoryMirrorLease,
): Promise<boolean> {
  const manifest = parseStationInventoryBundleManifest(
    await client.get<unknown>(`/station/inventories/${inventoryId}/bundle/manifest`),
  );
  if (!leaseIsCurrent(lease)) return false;
  if (manifest.inventoryId !== inventoryId) {
    throw new Error("inventory bundle requested inventory mismatch");
  }
  const candidate = await beginInventoryMirror(exec, manifest);
  if (!leaseIsCurrent(lease)) return false;
  if (candidate.alreadyActive) {
    return commitPublication(lease, () => Promise.resolve(true));
  }

  let state = await readInventoryMirrorState(exec, inventoryId);
  if (
    state?.verifiedDigest === candidate.combinedDigest &&
    state.verifiedContentDigest === candidate.contentDigest
  ) {
    if (!leaseIsCurrent(lease)) return false;
    return commitPublication(lease, () => publishInventorySnapshot(exec, candidate));
  }

  let cursor = state?.nextCursor ?? null;
  for (;;) {
    if (!leaseIsCurrent(lease)) return false;
    const query = new URLSearchParams({ limit: String(manifest.limits.codePageSize) });
    if (cursor !== null) query.set("cursor", cursor);
    const page = parseStationInventoryBundlePage(
      await client.get<unknown>(
        `/station/inventories/${inventoryId}/bundle/codes?${query.toString()}`,
      ),
    );
    if (!leaseIsCurrent(lease)) return false;
    await ingestInventoryPage(exec, candidate, cursor, page);
    if (!leaseIsCurrent(lease)) return false;
    if (page.nextCursor === null) {
      return commitPublication(lease, () => publishInventorySnapshot(exec, candidate));
    }
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
