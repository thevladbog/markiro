import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import type { CacheAge } from "../sync/worker.js";
import type { BoxRegistryMeta, StoredBoxRegistryRow } from "../store/box-registry.js";
import type { BoxLine } from "./cart.js";

export type BoxResolution =
  | { kind: "resolved"; box: BoxLine }
  | {
      kind: "rejected";
      notice: "unknown-box" | "registry-unavailable" | "registry-blocked";
    };

export interface BoxResolutionInput {
  sscc: string;
  bootstrap: KioskBootstrapSnapshotDto;
  registryAge: CacheAge;
}

export interface BoxResolutionStore {
  readMeta: () => Promise<BoxRegistryMeta | null>;
  lookup: (sscc: string) => Promise<StoredBoxRegistryRow | null>;
}

/** Resolves an SSCC only against the already-active local cut; this path never fetches. */
export async function resolveBoxScan(
  input: BoxResolutionInput,
  store: BoxResolutionStore,
): Promise<BoxResolution> {
  const meta = await store.readMeta();
  if (!meta) return { kind: "rejected", notice: "registry-unavailable" };
  if (input.registryAge === "blocked") return { kind: "rejected", notice: "registry-blocked" };
  const row = await store.lookup(input.sscc);
  if (!row) return { kind: "rejected", notice: "unknown-box" };
  const product = input.bootstrap.products.find((candidate) => candidate.id === row.productId);
  if (!product) return { kind: "rejected", notice: "unknown-box" };
  return {
    kind: "resolved",
    box: {
      kind: "box",
      boxId: row.boxId,
      sscc: row.sscc,
      productId: row.productId,
      name: product.name,
      bottleCount: row.bottleCount,
      unitPrice: product.unitPrice,
      contentKeys: [...row.contentKeys],
      registryVersion: row.version,
    },
  };
}
