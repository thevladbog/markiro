import { isValidSscc } from "@markiro/domain";
import type { KioskBoxRegistryChange } from "../api/types.js";
import {
  abortTransaction,
  STORE_BOX_REGISTRY_ACTIVE,
  STORE_BOX_REGISTRY_META,
  STORE_BOX_REGISTRY_STAGING,
  STORE_CONFIG,
  withTransaction,
} from "./db.js";
import {
  boxRegistryBindingOf,
  boxRegistryCredentialOwnerOf,
  sameBoxRegistryBinding,
  sameBoxRegistryCredentialOwner,
  type BoxRegistryBinding,
  type BoxRegistryCredentialOwner,
} from "./installation-binding.js";

export type { BoxRegistryBinding } from "./installation-binding.js";

const ACTIVE_META_KEY = "active";
const STAGING_META_KEY = "staging";
const CONFIG_KEY = "current";
const MAX_REVISION = 9_223_372_036_854_775_807n;
const MAX_PAGE_ITEMS = 500;
const MAX_CONTENT_KEYS = 1_000;
const MAX_STRING_BYTES = 1_024;
const MAX_PAGE_BYTES = 1_024 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredBoxRegistryRow {
  sscc: string;
  boxId: string;
  productId: string;
  bottleCount: number;
  contentKeys: string[];
  updatedAt: string;
  version: string;
}

export interface BoxRegistryMeta {
  binding: BoxRegistryBinding;
  credentialGeneration: string;
  version: string;
  /** Server-generated bootstrap timestamp from the refresh that activated it. */
  generatedAt: string;
}

export interface BoxRegistryCut extends BoxRegistryCredentialOwner {
  owner: string;
  since: string | null;
  until: string;
}

interface StagedChange {
  sscc: string;
  change: KioskBoxRegistryChange;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new Error("invalid box registry version");
  if (BigInt(value) > MAX_REVISION) throw new Error("invalid box registry version");
  return value;
}

function checkedCut(value: BoxRegistryCut): BoxRegistryCut {
  const credentialOwner = boxRegistryCredentialOwnerOf(value);
  if (!credentialOwner) throw new Error("invalid box registry credential owner");
  if (typeof value.owner !== "string" || value.owner.length === 0 || value.owner.length > 128)
    throw new Error("invalid box registry owner");
  const since = value.since === null ? null : revision(value.since);
  const until = revision(value.until);
  if (since !== null && BigInt(until) < BigInt(since)) throw new Error("invalid box registry cut");
  return { ...credentialOwner, owner: value.owner, since, until };
}

function sameCut(left: unknown, right: BoxRegistryCut): boolean {
  if (!left || typeof left !== "object") return false;
  const candidate = left as Partial<BoxRegistryCut>;
  return (
    candidate.owner === right.owner &&
    candidate.since === right.since &&
    candidate.until === right.until &&
    sameBoxRegistryCredentialOwner(boxRegistryCredentialOwnerOf(candidate), right)
  );
}

function checkedMeta(value: unknown): BoxRegistryMeta | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BoxRegistryMeta>;
  const credentialOwner = boxRegistryCredentialOwnerOf(candidate);
  if (
    !credentialOwner ||
    typeof candidate.generatedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.generatedAt))
  )
    return null;
  try {
    return {
      ...credentialOwner,
      version: revision(candidate.version),
      generatedAt: candidate.generatedAt,
    };
  } catch {
    return null;
  }
}

function clearRegistry(tx: IDBTransaction): void {
  tx.objectStore(STORE_BOX_REGISTRY_ACTIVE).clear();
  tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
  tx.objectStore(STORE_BOX_REGISTRY_META).clear();
}

function currentCredentialOwner(value: unknown): BoxRegistryCredentialOwner | null {
  const config = value as { token?: unknown } | null | undefined;
  return typeof config?.token === "string" && config.token.length > 0
    ? boxRegistryCredentialOwnerOf(value)
    : null;
}

function preflightPage(values: unknown): asserts values is readonly KioskBoxRegistryChange[] {
  if (!Array.isArray(values) || values.length > MAX_PAGE_ITEMS)
    throw new Error("invalid box registry page size");
  const encoder = new TextEncoder();
  let bytes = 0;
  let contentKeyCount = 0;
  const count = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw new Error(`invalid box registry ${label}`);
    if (value.length > MAX_STRING_BYTES) throw new Error(`${label} exceeds 1024 UTF-8 bytes`);
    const size = encoder.encode(value).byteLength;
    if (size > MAX_STRING_BYTES) throw new Error(`${label} exceeds 1024 UTF-8 bytes`);
    bytes += size;
    if (bytes > MAX_PAGE_BYTES) throw new Error("box registry page exceeds one MiB");
    return value;
  };
  for (const value of values as unknown[]) {
    if (!value || typeof value !== "object") throw new Error("invalid box registry change");
    const change = value as Record<string, unknown>;
    count(change.kind, "kind");
    count(change.sscc, "sscc");
    count(change.updatedAt, "updatedAt");
    if (change.kind === "upsert") {
      count(change.boxId, "boxId");
      count(change.productId, "productId");
      if (!Array.isArray(change.contentKeys)) throw new Error("invalid box registry contentKeys");
      contentKeyCount += change.contentKeys.length;
      if (contentKeyCount > MAX_CONTENT_KEYS)
        throw new Error("box registry page contentKeys overflow");
      for (const key of change.contentKeys as unknown[]) count(key, "contentKey");
    }
  }
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
  if (typeof change.boxId !== "string" || !UUID_PATTERN.test(change.boxId))
    throw new Error("invalid box registry boxId");
  if (typeof change.productId !== "string" || !UUID_PATTERN.test(change.productId))
    throw new Error("invalid box registry productId");
  if (
    !Number.isInteger(change.bottleCount) ||
    (change.bottleCount as number) < 1 ||
    (change.bottleCount as number) > 500
  )
    throw new Error("invalid box registry bottleCount");
  if (!Array.isArray(change.contentKeys) || change.contentKeys.length !== change.bottleCount)
    throw new Error("invalid box registry contentKeys");
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

function checkedChanges(values: unknown): KioskBoxRegistryChange[] {
  preflightPage(values);
  const result = values.map(checkedChange);
  if (new Set(result.map((change) => change.sscc)).size !== result.length)
    throw new Error("duplicate box registry change");
  return result;
}

/** Reads the active meta and destroys it atomically when it belongs elsewhere. */
export async function readBoxRegistryMeta(
  bindingInput: BoxRegistryBinding,
): Promise<BoxRegistryMeta | null> {
  const binding = boxRegistryBindingOf(bindingInput);
  if (!binding) return null;
  let result: BoxRegistryMeta | null = null;
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_ACTIVE, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      const metaRequest = tx.objectStore(STORE_BOX_REGISTRY_META).get(ACTIVE_META_KEY);
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 2) return;
        const current = currentCredentialOwner(configRequest.result);
        if (!sameBoxRegistryBinding(current?.binding ?? null, binding)) return;
        const meta = checkedMeta(metaRequest.result);
        if (!meta) {
          if (metaRequest.result !== undefined) clearRegistry(tx);
          return;
        }
        if (!sameBoxRegistryCredentialOwner(meta, current)) {
          clearRegistry(tx);
          return;
        }
        result = meta;
      };
      configRequest.onsuccess = apply;
      metaRequest.onsuccess = apply;
    },
  );
  return result;
}

export async function lookupBox(
  bindingInput: BoxRegistryBinding,
  sscc: string,
): Promise<StoredBoxRegistryRow | null> {
  const binding = boxRegistryBindingOf(bindingInput);
  if (!binding || !isValidSscc(sscc)) return null;
  let result: StoredBoxRegistryRow | null = null;
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_ACTIVE, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      const metaRequest = tx.objectStore(STORE_BOX_REGISTRY_META).get(ACTIVE_META_KEY);
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 2) return;
        const current = currentCredentialOwner(configRequest.result);
        if (!sameBoxRegistryBinding(current?.binding ?? null, binding)) return;
        const meta = checkedMeta(metaRequest.result);
        if (!meta || !sameBoxRegistryCredentialOwner(meta, current)) {
          clearRegistry(tx);
          return;
        }
        const rowRequest = tx.objectStore(STORE_BOX_REGISTRY_ACTIVE).get(sscc);
        rowRequest.onsuccess = () => {
          const found = rowRequest.result as Partial<StoredBoxRegistryRow> | undefined;
          if (!found) return;
          try {
            const rawChange = {
              kind: "upsert",
              boxId: found.boxId,
              sscc: found.sscc,
              productId: found.productId,
              bottleCount: found.bottleCount,
              contentKeys: found.contentKeys,
              updatedAt: found.updatedAt,
            };
            preflightPage([rawChange]);
            const change = checkedChange(rawChange);
            const version = revision(found.version);
            if (change.kind === "upsert") result = { ...change, version };
          } catch {
            result = null;
          }
        };
      };
      configRequest.onsuccess = apply;
      metaRequest.onsuccess = apply;
    },
  );
  return result;
}

export async function beginBoxRegistryStage(cutInput: BoxRegistryCut): Promise<void> {
  const cut = checkedCut(cutInput);
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      configRequest.onsuccess = () => {
        if (!sameBoxRegistryCredentialOwner(currentCredentialOwner(configRequest.result), cut)) {
          abortTransaction(tx, new Error("box registry credential ownership changed"));
          return;
        }
        tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
        tx.objectStore(STORE_BOX_REGISTRY_META).put(cut, STAGING_META_KEY);
      };
    },
  );
}

export async function discardBoxRegistryStage(cutInput: BoxRegistryCut): Promise<void> {
  const cut = checkedCut(cutInput);
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const request = meta.get(STAGING_META_KEY);
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 2) return;
        if (!sameBoxRegistryCredentialOwner(currentCredentialOwner(configRequest.result), cut))
          return;
        if (!sameCut(request.result, cut)) return;
        tx.objectStore(STORE_BOX_REGISTRY_STAGING).clear();
        meta.delete(STAGING_META_KEY);
      };
      configRequest.onsuccess = apply;
      request.onsuccess = apply;
    },
  );
}

export async function stageBoxRegistryPage(
  cutInput: BoxRegistryCut,
  changes: readonly KioskBoxRegistryChange[],
): Promise<void> {
  const cut = checkedCut(cutInput);
  const safe = checkedChanges(changes);
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const request = meta.get(STAGING_META_KEY);
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 2) return;
        if (!sameBoxRegistryCredentialOwner(currentCredentialOwner(configRequest.result), cut)) {
          abortTransaction(tx, new Error("box registry credential ownership changed"));
          return;
        }
        if (!sameCut(request.result, cut)) {
          abortTransaction(tx, new Error("box registry staging ownership lost"));
          return;
        }
        const staging = tx.objectStore(STORE_BOX_REGISTRY_STAGING);
        for (const change of safe)
          staging.put({ sscc: change.sscc, change } satisfies StagedChange);
      };
      configRequest.onsuccess = apply;
      request.onsuccess = apply;
    },
  );
}

export async function activateBoxRegistryPage(
  cutInput: BoxRegistryCut,
  finalChanges: readonly KioskBoxRegistryChange[],
  generatedAt: string,
): Promise<void> {
  const cut = checkedCut(cutInput);
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt)))
    throw new Error("invalid box registry generatedAt");
  const final = checkedChanges(finalChanges);
  await withTransaction(
    [STORE_CONFIG, STORE_BOX_REGISTRY_ACTIVE, STORE_BOX_REGISTRY_STAGING, STORE_BOX_REGISTRY_META],
    "readwrite",
    (tx) => {
      const active = tx.objectStore(STORE_BOX_REGISTRY_ACTIVE);
      const staging = tx.objectStore(STORE_BOX_REGISTRY_STAGING);
      const meta = tx.objectStore(STORE_BOX_REGISTRY_META);
      const activeMetaRequest = meta.get(ACTIVE_META_KEY);
      const stagingMetaRequest = meta.get(STAGING_META_KEY);
      const stagedRequest = staging.getAll();
      const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      let ready = 0;
      const apply = () => {
        ready += 1;
        if (ready !== 4) return;
        if (!sameBoxRegistryCredentialOwner(currentCredentialOwner(configRequest.result), cut)) {
          abortTransaction(tx, new Error("box registry credential ownership changed"));
          return;
        }
        if (!sameCut(stagingMetaRequest.result, cut)) {
          abortTransaction(tx, new Error("box registry staging ownership lost"));
          return;
        }
        const activeMeta = checkedMeta(activeMetaRequest.result);
        if (activeMeta && !sameBoxRegistryCredentialOwner(activeMeta, cut)) {
          abortTransaction(tx, new Error("box registry credential ownership changed"));
          return;
        }
        if (cut.since === null && activeMeta && BigInt(cut.until) <= BigInt(activeMeta.version)) {
          abortTransaction(tx, new Error("older box registry snapshot cannot replace active"));
          return;
        }
        if (cut.since !== null && activeMeta?.version !== cut.since) {
          abortTransaction(tx, new Error("box registry active version changed"));
          return;
        }
        const staged = (stagedRequest.result as StagedChange[]).map((entry) => entry.change);
        if (cut.since === null) active.clear();
        for (const change of [...staged, ...final]) {
          if (change.kind === "remove") active.delete(change.sscc);
          else
            active.put({
              ...change,
              contentKeys: [...change.contentKeys],
              version: cut.until,
            } satisfies StoredBoxRegistryRow);
        }
        meta.put(
          {
            binding: cut.binding,
            credentialGeneration: cut.credentialGeneration,
            version: cut.until,
            generatedAt,
          } satisfies BoxRegistryMeta,
          ACTIVE_META_KEY,
        );
        staging.clear();
        meta.delete(STAGING_META_KEY);
      };
      activeMetaRequest.onsuccess = apply;
      stagingMetaRequest.onsuccess = apply;
      stagedRequest.onsuccess = apply;
      configRequest.onsuccess = apply;
    },
  );
}
