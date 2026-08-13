import { isValidSscc } from "@markiro/domain";
import type { KioskBoxRegistryChange } from "../api/types.js";
import {
  STORE_BOX_REGISTRY_ACTIVE,
  STORE_BOX_REGISTRY_META,
  STORE_BOX_REGISTRY_STAGING,
  withStore,
  withTransaction,
} from "./db.js";

const ACTIVE_META_KEY = "active";
const STAGING_META_KEY = "staging";
const MAX_REVISION = 9_223_372_036_854_775_807n;

export interface StoredBoxRegistryRow {
  sscc: string;
  boxId: string;
  productId: string;
  bottleCount: number;
  contentKeys: string[];
  updatedAt: string;
  /** Revision at which this row was last upserted. */
  version: string;
}

export interface BoxRegistryMeta {
  version: string;
  generatedAt: string;
}

interface StagingMeta {
  since: string | null;
  until: string;
}

interface StagedChange {
  sscc: string;
  change: KioskBoxRegistryChange;
}

function revision(value: string): string {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error("invalid box registry version");
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("invalid box registry version");
  }
  if (parsed > MAX_REVISION) throw new Error("invalid box registry version");
  return value;
}

function checkedChange(value: unknown): KioskBoxRegistryChange {
  if (!value || typeof value !== "object") throw new Error("invalid box registry change");
  const change = value as Record<string, unknown>;
  if (change.kind !== "upsert" && change.kind !== "remove")
    throw new Error("invalid box registry kind");
  if (typeof change.sscc !== "string" || !isValidSscc(change.sscc))
    throw new Error("invalid box registry sscc");
  if (typeof change.updatedAt !== "string" || Number.isNaN(Date.parse(change.updatedAt)))
    throw new Error("invalid box registry updatedAt");
  if (change.kind === "remove") {
    if (Object.keys(change).some((key) => !["kind", "sscc", "updatedAt"].includes(key)))
      throw new Error("invalid box registry remove fields");
    return { kind: "remove", sscc: change.sscc, updatedAt: change.updatedAt };
  }
  if (typeof change.boxId !== "string" || change.boxId === "")
    throw new Error("invalid box registry boxId");
  if (typeof change.productId !== "string" || change.productId === "")
    throw new Error("invalid box registry productId");
  if (
    !Number.isInteger(change.bottleCount) ||
    (change.bottleCount as number) < 1 ||
    (change.bottleCount as number) > 500
  )
    throw new Error("invalid box registry bottleCount");
  if (!Array.isArray(change.contentKeys) || change.contentKeys.length !== change.bottleCount) {
    throw new Error("invalid box registry contentKeys");
  }
  const contentKeys: string[] = [];
  for (const key of change.contentKeys as unknown[]) {
    if (typeof key !== "string" || key === "") throw new Error("invalid box registry contentKeys");
    contentKeys.push(key);
  }
  if (new Set(contentKeys).size !== contentKeys.length)
    throw new Error("invalid box registry contentKeys");
  const allowed = ["kind", "boxId", "sscc", "productId", "bottleCount", "contentKeys", "updatedAt"];
  if (Object.keys(change).some((key) => !allowed.includes(key)))
    throw new Error("invalid box registry upsert fields");
  return {
    kind: "upsert",
    boxId: change.boxId,
    sscc: change.sscc,
    productId: change.productId,
    bottleCount: change.bottleCount,
    contentKeys,
    updatedAt: change.updatedAt,
  };
}

function checkedChanges(changes: readonly KioskBoxRegistryChange[]): KioskBoxRegistryChange[] {
  if (!Array.isArray(changes) || changes.length > 500)
    throw new Error("invalid box registry page size");
  const result = changes.map(checkedChange);
  const contentKeyCount = result.reduce(
    (total, change) => total + (change.kind === "upsert" ? change.contentKeys.length : 0),
    0,
  );
  if (contentKeyCount > 1_000) throw new Error("box registry page contentKeys overflow");
  if (new Set(result.map((change) => change.sscc)).size !== result.length)
    throw new Error("duplicate box registry change");
  return result;
}

function sameCut(meta: StagingMeta | undefined, since: string | null, until: string): boolean {
  return meta?.since === since && meta.until === until;
}

export async function readBoxRegistryMeta(): Promise<BoxRegistryMeta | null> {
  const found = await withStore<BoxRegistryMeta>(STORE_BOX_REGISTRY_META, "readonly", (store) =>
    store.get(ACTIVE_META_KEY),
  );
  if (
    !found ||
    typeof found.generatedAt !== "string" ||
    Number.isNaN(Date.parse(found.generatedAt))
  ) {
    return null;
  }
  try {
    revision(found.version);
    return found;
  } catch {
    return null;
  }
}

export async function lookupBox(sscc: string): Promise<StoredBoxRegistryRow | null> {
  if (!isValidSscc(sscc)) return null;
  const found = await withStore<StoredBoxRegistryRow>(
    STORE_BOX_REGISTRY_ACTIVE,
    "readonly",
    (store) => store.get(sscc),
  );
  if (!found) return null;
  try {
    const change = checkedChange({
      kind: "upsert",
      boxId: (found as Partial<StoredBoxRegistryRow>).boxId,
      sscc: (found as Partial<StoredBoxRegistryRow>).sscc,
      productId: (found as Partial<StoredBoxRegistryRow>).productId,
      bottleCount: (found as Partial<StoredBoxRegistryRow>).bottleCount,
      contentKeys: (found as Partial<StoredBoxRegistryRow>).contentKeys,
      updatedAt: (found as Partial<StoredBoxRegistryRow>).updatedAt,
    });
    revision((found as Partial<StoredBoxRegistryRow>).version as string);
    if (change.kind !== "upsert") return null;
    return { ...change, version: found.version };
  } catch {
    return null;
  }
}

/** Starts a new server-assigned cut and disowns every incomplete prior cut. */
export async function beginBoxRegistryStage(since: string | null, until: string): Promise<void> {
  if (since !== null) revision(since);
  revision(until);
  await withTransaction(
    [STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
      tx.objectStore(STORE_BOX_REGISTRY_META).put(
        { since, until } satisfies StagingMeta,
        STAGING_META_KEY,
      );
    },
  );
}

export async function discardBoxRegistryStage(): Promise<void> {
  await withTransaction(
    [STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
      tx.objectStore(STORE_BOX_REGISTRY_META).delete(STAGING_META_KEY);
    },
  );
}

/** Adds one non-final page. Readers continue to use the previous active cut. */
export async function stageBoxRegistryPage(
  since: string | null,
  until: string,
  changes: readonly KioskBoxRegistryChange[],
): Promise<void> {
  if (since !== null) revision(since);
  revision(until);
  const safe = checkedChanges(changes);
  await withTransaction(
    [STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const staging = tx.objectStore(STORE_BOX_REGISTRY_STAGING);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const request = meta.get(STAGING_META_KEY);
      request.onsuccess = () => {
        if (!sameCut(request.result as StagingMeta | undefined, since, until)) {
          staging.clear();
          meta.put({ since, until } satisfies StagingMeta, STAGING_META_KEY);
        }
        for (const change of safe)
          staging.put({ sscc: change.sscc, change } satisfies StagedChange);
      };
    },
  );
}

/**
 * Commits the final page and pointer metadata in one transaction. A delta
 * changes only named SSCCs; a full cut replaces the active registry wholesale.
 */
export async function activateBoxRegistryPage(
  since: string | null,
  until: string,
  finalChanges: readonly KioskBoxRegistryChange[],
  generatedAt: Date,
): Promise<void> {
  if (since !== null) revision(since);
  revision(until);
  if (Number.isNaN(generatedAt.getTime())) throw new Error("invalid box registry generatedAt");
  const final = checkedChanges(finalChanges);
  await withTransaction(
    [STORE_BOX_REGISTRY_ACTIVE, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const active = tx.objectStore(STORE_BOX_REGISTRY_ACTIVE);
      const staging = tx.objectStore(STORE_BOX_REGISTRY_STAGING);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const activeMetaRequest = meta.get(ACTIVE_META_KEY);
      const stagingMetaRequest = meta.get(STAGING_META_KEY);
      const stagedRequest = staging.getAll();
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 3) return;
        const activeMeta = activeMetaRequest.result as BoxRegistryMeta | undefined;
        if (since !== null && activeMeta?.version !== since) {
          tx.abort();
          return;
        }
        const stagingMeta = stagingMetaRequest.result as StagingMeta | undefined;
        const staged = sameCut(stagingMeta, since, until)
          ? (stagedRequest.result as StagedChange[]).map((entry) => entry.change)
          : [];
        const all = [...staged, ...final];
        if (since === null) active.clear();
        for (const change of all) {
          if (change.kind === "remove") {
            active.delete(change.sscc);
          } else {
            const row: StoredBoxRegistryRow = {
              sscc: change.sscc,
              boxId: change.boxId,
              productId: change.productId,
              bottleCount: change.bottleCount,
              contentKeys: [...change.contentKeys],
              updatedAt: change.updatedAt,
              version: until,
            };
            active.put(row);
          }
        }
        meta.put(
          { version: until, generatedAt: generatedAt.toISOString() } satisfies BoxRegistryMeta,
          ACTIVE_META_KEY,
        );
        staging.clear();
        meta.delete(STAGING_META_KEY);
      };
      activeMetaRequest.onsuccess = apply;
      stagingMetaRequest.onsuccess = apply;
      stagedRequest.onsuccess = apply;
    },
  );
}
