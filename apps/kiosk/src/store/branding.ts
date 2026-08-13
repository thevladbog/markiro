import type { KioskBrandingDto, KioskBootstrapSnapshotDto } from "../api/types.js";
import { readSnapshot } from "./cache.js";
import { readConfig } from "./config.js";
import { STORE_SNAPSHOT, withStore } from "./db.js";

const BRANDING_KEY = "branding";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 15_000;

export interface BrandingOwner {
  serverUrl: string;
  kioskId: string;
  credentialGeneration: string;
}

export interface CachedBranding {
  organizationName: string;
  logoBlob: Blob | null;
  revision: string | null;
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
  const row = value as Partial<BrandingOwner> | null | undefined;
  const serverUrl = nonEmpty(row?.serverUrl);
  const kioskId = nonEmpty(row?.kioskId);
  const credentialGeneration = nonEmpty(row?.credentialGeneration);
  return serverUrl && kioskId && credentialGeneration
    ? { serverUrl, kioskId, credentialGeneration }
    : null;
}

function sameOwner(left: BrandingOwner | null, right: BrandingOwner | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.serverUrl === right.serverUrl &&
    left.kioskId === right.kioskId &&
    left.credentialGeneration === right.credentialGeneration
  );
}

export function brandingOwnerOf(value: unknown): BrandingOwner | null {
  return ownerOf(value);
}

function organizationNameOf(bootstrap: KioskBootstrapSnapshotDto | null): string {
  return nonEmpty(bootstrap?.branding?.organizationName) ?? "Маркиро";
}

function checkedStored(value: unknown, owner: BrandingOwner | null): CheckedBranding | null {
  const row = value as Partial<StoredBranding> | null | undefined;
  if (!sameOwner(ownerOf(row?.owner), owner)) return null;
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
  const cached = checkedStored(raw, ownerOf(config));
  return {
    organizationName: organizationNameOf(snapshot?.bootstrap ?? null),
    logoBlob: cached?.logoBlob ?? null,
    revision: cached?.revision ?? null,
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

function logoRequestUrl(serverUrl: string, logoUrl: string): string | null {
  if (!logoUrl.startsWith("/") || logoUrl.startsWith("//")) return null;
  const base = serverUrl.replace(/\/+$/, "");
  const candidate = `${base}${logoUrl}`;
  try {
    const server = new URL(serverUrl, globalThis.location?.origin ?? "https://local.invalid");
    const target = new URL(candidate, globalThis.location?.origin ?? "https://local.invalid");
    return target.origin === server.origin ? target.toString() : null;
  } catch {
    return null;
  }
}

export async function refreshCachedBranding(input: {
  owner: BrandingOwner;
  token: string;
  branding: KioskBrandingDto;
  fetch?: typeof fetch;
  decode?: (blob: Blob) => Promise<boolean>;
}): Promise<CachedBranding> {
  const organizationName = nonEmpty(input.branding.organizationName) ?? "Маркиро";
  const existingRaw = await withStore<unknown>(STORE_SNAPSHOT, "readonly", (store) =>
    store.get(BRANDING_KEY),
  );
  const existing = checkedStored(existingRaw, input.owner);
  const revision = nonEmpty(input.branding.logoRevision);
  const path = nonEmpty(input.branding.logoUrl);
  if (!revision || !path) {
    await withStore(STORE_SNAPSHOT, "readwrite", (store) => store.delete(BRANDING_KEY));
    return { organizationName, logoBlob: null, revision: null };
  }
  if (existing?.revision === revision)
    return { organizationName, logoBlob: existing.logoBlob, revision };
  const url = logoRequestUrl(input.owner.serverUrl, path);
  if (!url) return { organizationName, logoBlob: null, revision: null };

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
    const blob = await response.blob();
    if (
      blob.size === 0 ||
      blob.size > MAX_LOGO_BYTES ||
      blob.type !== "image/webp" ||
      !(await (input.decode ?? defaultDecode)(blob))
    ) {
      throw new Error("logo is not a decodable WebP");
    }
    const stored: StoredBranding = {
      owner: input.owner,
      organizationName,
      revision,
      logoBytes: await blob.arrayBuffer(),
    };
    await withStore(STORE_SNAPSHOT, "readwrite", (store) => store.put(stored, BRANDING_KEY));
    return { organizationName, logoBlob: blob, revision };
  } catch {
    if (existing) {
      const retained: StoredBranding = {
        owner: existing.owner,
        organizationName,
        revision: existing.revision,
        logoBytes: existing.logoBytes,
      };
      await withStore(STORE_SNAPSHOT, "readwrite", (store) => store.put(retained, BRANDING_KEY));
      return { organizationName, logoBlob: existing.logoBlob, revision: retained.revision };
    }
    return { organizationName, logoBlob: null, revision: null };
  }
}
