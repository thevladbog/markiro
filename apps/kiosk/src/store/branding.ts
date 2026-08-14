import type { KioskBrandingDto, KioskBootstrapSnapshotDto } from "../api/types.js";
import { readSnapshot } from "./cache.js";
import { readConfig } from "./config.js";
import { STORE_CONFIG, STORE_SNAPSHOT, withStore, withTransaction } from "./db.js";
import {
  boxRegistryCredentialOwnerOf,
  sameBoxRegistryCredentialOwner,
} from "./installation-binding.js";

const CONFIG_KEY = "current";
const BRANDING_KEY = "branding";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BrandingOwner {
  serverUrl: string;
  kioskId: string;
  credentialGeneration: string;
}

export interface CachedBranding {
  organizationName: string;
  logoBlob: Blob | null;
  revision: string | null;
  owner: BrandingOwner | null;
}

export interface DisplayedBranding {
  owner: BrandingOwner;
  revision: string;
}

export interface BrandingRefreshResult {
  applied: boolean;
  owner: BrandingOwner;
  branding: CachedBranding;
}

interface StoredBranding {
  owner: BrandingOwner;
  organizationName: string;
  revision: string;
  logoBytes: ArrayBuffer;
}

interface CheckedBranding extends StoredBranding {
  logoBlob: Blob;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function ownerOf(value: unknown): BrandingOwner | null {
  const registry = boxRegistryCredentialOwnerOf(value);
  return registry
    ? {
        serverUrl: registry.binding.serverUrl,
        kioskId: registry.binding.kioskId,
        credentialGeneration: registry.credentialGeneration,
      }
    : null;
}

export function sameBrandingOwner(
  left: BrandingOwner | null,
  right: BrandingOwner | null,
): boolean {
  return sameBoxRegistryCredentialOwner(
    left ? boxRegistryCredentialOwnerOf(left) : null,
    right ? boxRegistryCredentialOwnerOf(right) : null,
  );
}

export function brandingOwnerOf(value: unknown): BrandingOwner | null {
  return ownerOf(value);
}

export function shouldActivateBranding(
  result: BrandingRefreshResult,
  currentOwner: BrandingOwner | null,
  requestId: number,
  currentRequestId: number,
): boolean {
  return (
    result.applied &&
    requestId === currentRequestId &&
    sameBrandingOwner(result.owner, currentOwner)
  );
}

function organizationNameOf(bootstrap: KioskBootstrapSnapshotDto | null): string {
  return nonEmpty(bootstrap?.branding?.organizationName) ?? "Маркиро";
}

function checkedStored(value: unknown, owner: BrandingOwner | null): CheckedBranding | null {
  const row = value as Partial<StoredBranding> | null | undefined;
  if (!sameBrandingOwner(ownerOf(row?.owner), owner)) return null;
  const organizationName = nonEmpty(row?.organizationName);
  const revision = nonEmpty(row?.revision);
  const logoBytes = row?.logoBytes;
  if (
    !organizationName ||
    !revision ||
    Object.prototype.toString.call(logoBytes) !== "[object ArrayBuffer]" ||
    (logoBytes as ArrayBuffer).byteLength === 0
  )
    return null;
  return {
    owner: owner!,
    organizationName,
    revision,
    logoBytes: logoBytes as ArrayBuffer,
    logoBlob: new Blob([logoBytes as ArrayBuffer], { type: "image/webp" }),
  };
}

export async function loadCachedBranding(): Promise<CachedBranding> {
  const [snapshot, config, raw] = await Promise.all([
    readSnapshot(),
    readConfig(),
    withStore<unknown>(STORE_SNAPSHOT, "readonly", (store) => store.get(BRANDING_KEY)),
  ]);
  const owner = ownerOf(config);
  const cached = checkedStored(raw, owner);
  return {
    organizationName: organizationNameOf(snapshot?.bootstrap ?? null),
    logoBlob: cached?.logoBlob ?? null,
    revision: cached?.revision ?? null,
    owner: cached?.owner ?? null,
  };
}

async function defaultDecode(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function exactLogoUrl(serverUrl: string, branding: KioskBrandingDto): string | null {
  const revision = nonEmpty(branding.logoRevision);
  const advertised = nonEmpty(branding.logoUrl);
  if (!revision || !advertised || !UUID.test(revision)) return null;
  const expectedPath = `/kiosk/branding/logo/${encodeURIComponent(revision)}`;
  if (advertised !== expectedPath) return null;
  try {
    const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
    const resolved = new URL(`${serverUrl.replace(/\/+$/, "")}${expectedPath}`, origin);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

async function readBoundedWebp(response: Response): Promise<Blob> {
  if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/webp")
    throw new Error("logo is not a WebP");
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_LOGO_BYTES)
      throw new Error("logo content length is invalid");
  }
  if (!response.body) throw new Error("logo has no response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_LOGO_BYTES) {
        await reader.cancel("logo exceeded byte budget");
        throw new Error("logo exceeded byte budget");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("logo is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([bytes], { type: "image/webp" });
}

async function commitIfCurrent(
  owner: BrandingOwner,
  mutate: (store: IDBObjectStore) => void,
): Promise<boolean> {
  let applied = false;
  await withTransaction([STORE_CONFIG, STORE_SNAPSHOT], "readwrite", (tx) => {
    const request = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
    request.onsuccess = () => {
      if (!sameBrandingOwner(ownerOf(request.result), owner)) return;
      mutate(tx.objectStore(STORE_SNAPSHOT));
      applied = true;
    };
  });
  return applied;
}

export async function invalidateCachedBranding(displayed: DisplayedBranding): Promise<boolean> {
  let applied = false;
  await withTransaction([STORE_CONFIG, STORE_SNAPSHOT], "readwrite", (tx) => {
    const configRequest = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
    const brandingStore = tx.objectStore(STORE_SNAPSHOT);
    const brandingRequest = brandingStore.get(BRANDING_KEY);
    let configReady = false;
    let brandingReady = false;
    const invalidateIfStillDisplayed = () => {
      if (!configReady || !brandingReady) return;
      if (!sameBrandingOwner(ownerOf(configRequest.result), displayed.owner)) return;
      const stored = checkedStored(brandingRequest.result, displayed.owner);
      if (!stored || stored.revision !== displayed.revision) return;
      brandingStore.delete(BRANDING_KEY);
      applied = true;
    };
    configRequest.onsuccess = () => {
      configReady = true;
      invalidateIfStillDisplayed();
    };
    brandingRequest.onsuccess = () => {
      brandingReady = true;
      invalidateIfStillDisplayed();
    };
  });
  return applied;
}

export async function refreshCachedBranding(input: {
  owner: BrandingOwner;
  token: string;
  branding: KioskBrandingDto;
  fetch?: typeof fetch;
  decode?: (blob: Blob) => Promise<boolean>;
}): Promise<BrandingRefreshResult> {
  const result = (branding: CachedBranding, applied: boolean): BrandingRefreshResult => ({
    branding,
    applied,
    owner: input.owner,
  });
  const organizationName = nonEmpty(input.branding.organizationName) ?? "Маркиро";
  const existingRaw = await withStore<unknown>(STORE_SNAPSHOT, "readonly", (store) =>
    store.get(BRANDING_KEY),
  );
  const existing = checkedStored(existingRaw, input.owner);
  const revision = nonEmpty(input.branding.logoRevision);
  const path = nonEmpty(input.branding.logoUrl);
  if (!revision || !path) {
    const applied = await commitIfCurrent(input.owner, (store) => store.delete(BRANDING_KEY));
    return result({ organizationName, logoBlob: null, revision: null, owner: null }, applied);
  }
  if (existing?.revision === revision)
    return result(
      { organizationName, logoBlob: existing.logoBlob, revision, owner: input.owner },
      true,
    );
  const url = exactLogoUrl(input.owner.serverUrl, input.branding);
  if (!url) {
    const applied = await commitIfCurrent(input.owner, (store) => store.delete(BRANDING_KEY));
    return result({ organizationName, logoBlob: null, revision: null, owner: null }, applied);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (input.fetch ?? fetch)(url, {
        headers: { "x-kiosk-token": input.token },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`logo request failed with ${response.status}`);
    const blob = await readBoundedWebp(response);
    if (!(await (input.decode ?? defaultDecode)(blob))) throw new Error("logo cannot be decoded");
    const stored: StoredBranding = {
      owner: input.owner,
      organizationName,
      revision,
      logoBytes: await blob.arrayBuffer(),
    };
    const applied = await commitIfCurrent(input.owner, (store) => store.put(stored, BRANDING_KEY));
    return result(
      {
        organizationName,
        logoBlob: applied ? blob : null,
        revision: applied ? revision : null,
        owner: applied ? input.owner : null,
      },
      applied,
    );
  } catch {
    if (existing) {
      const retained: StoredBranding = {
        owner: existing.owner,
        organizationName,
        revision: existing.revision,
        logoBytes: existing.logoBytes,
      };
      const applied = await commitIfCurrent(input.owner, (store) =>
        store.put(retained, BRANDING_KEY),
      );
      return result(
        {
          organizationName,
          logoBlob: applied ? existing.logoBlob : null,
          revision: applied ? retained.revision : null,
          owner: applied ? input.owner : null,
        },
        applied,
      );
    }
    return result({ organizationName, logoBlob: null, revision: null, owner: null }, false);
  }
}
