import { z } from "zod";
import {
  organizationBrandingDescriptorSchema,
  logoFromRgba,
  validateMonoBitmap,
  productLabelValueDigest,
  sheetLogoFingerprint,
  type MonoBitmap,
  type SheetLogo,
} from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "./credential-recovery.js";
import markiroLogoUrl from "../assets/markiro-print-logo.svg";

export interface OrganizationBrandingOwner {
  exec: SqlExecutor;
  client: { get: (path: string) => Promise<unknown>; download: (path: string) => Promise<Blob> };
  tenantId: string;
  generation: CredentialGeneration;
  isCurrent: () => boolean;
}
export interface BrandingSnapshot {
  schemaVersion: 1;
  producerVersion: "logo-raster-v1";
  tenantId: string;
  ownerDigest: string;
  organizationName: string;
  logoRevision: string | null;
  sourceChecksum: string | null;
  digest: string;
  logo: SheetLogo;
}
export interface BrandingResourcePorts {
  decodeLogo?: (blob: Blob) => Promise<MonoBitmap>;
  loadMarkiroLogo?: () => Promise<MonoBitmap>;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const storageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  producerVersion: z.literal("logo-raster-v1"),
  tenantId: z.string().min(1),
  ownerDigest: hash,
  organizationName: z.string().trim().min(1).max(255),
  logoRevision: z.uuid().nullable(),
  sourceChecksum: hash.nullable(),
  digest: hash,
  logo: z.strictObject({
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(512),
    stride: z.number().int().positive().max(128),
    pixelsBase64: z.string().max(90_000),
    digest: hash,
    source: z.enum(["organization", "markiro"]),
  }),
});
function base64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}
function unbase64(value: string): Uint8Array {
  const binary = atob(value),
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (base64(bytes) !== value) throw new Error("Invalid branding bytes");
  return bytes;
}
function logoDigest(bitmap: MonoBitmap): string {
  return sheetLogoFingerprint(bitmap);
}
export function serializeOrganizationBranding(snapshot: BrandingSnapshot): string {
  const { logo, ...content } = snapshot;
  return JSON.stringify({
    ...content,
    logo: {
      width: logo.width,
      height: logo.height,
      stride: logo.stride,
      pixelsBase64: base64(logo.pixels),
      digest: logo.digest,
      source: logo.source,
    },
  });
}
export function parseOrganizationBranding(json: string): BrandingSnapshot {
  if (new TextEncoder().encode(json).length > 131072)
    throw new Error("Branding snapshot is too large");
  const saved = storageSchema.parse(JSON.parse(json));
  const { digest, ...content } = saved;
  if (productLabelValueDigest(content) !== digest)
    throw new Error("Branding snapshot digest mismatch");
  const bitmap = {
    width: saved.logo.width,
    height: saved.logo.height,
    stride: saved.logo.stride,
    pixels: unbase64(saved.logo.pixelsBase64),
  };
  validateMonoBitmap(bitmap);
  if (logoDigest(bitmap) !== saved.logo.digest) throw new Error("Branding logo digest mismatch");
  if (
    saved.logo.source === "organization"
      ? !saved.logoRevision || !saved.sourceChecksum
      : saved.logoRevision !== null || saved.sourceChecksum !== null
  )
    throw new Error("Branding source mismatch");
  return {
    ...saved,
    logo: {
      ...bitmap,
      digest: saved.logo.digest,
      source: saved.logo.source,
      ...(saved.logoRevision ? { revision: saved.logoRevision } : {}),
    },
  };
}
function current(owner: Pick<OrganizationBrandingOwner, "generation" | "isCurrent">): boolean {
  return !owner.generation.sealed && owner.isCurrent();
}
async function ownership(owner: Pick<OrganizationBrandingOwner, "generation">): Promise<string> {
  const proof = credentialGenerationOwnership(owner.generation);
  if (!proof) throw new Error("Branding credential owner is unavailable");
  return proof;
}
export async function loadOrganizationBranding(
  owner: Omit<OrganizationBrandingOwner, "client">,
): Promise<BrandingSnapshot | null> {
  if (!current(owner)) return null;
  const ownerDigest = await ownership(owner);
  if (!current(owner)) return null;
  const [row] = await owner.exec.all<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM station_organization_branding WHERE tenant_id=? AND owner_digest=?",
    [owner.tenantId, ownerDigest],
  );
  if (!current(owner) || !row) return null;
  const snapshot = parseOrganizationBranding(row.snapshot_json);
  if (snapshot.tenantId !== owner.tenantId || snapshot.ownerDigest !== ownerDigest)
    throw new Error("Branding owner mismatch");
  return snapshot;
}
async function decodeBrowserLogo(blob: Blob, scale = 1): Promise<MonoBitmap> {
  const url = URL.createObjectURL(blob),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (
      image.naturalWidth < 1 ||
      image.naturalHeight < 1 ||
      image.naturalWidth > 8192 ||
      image.naturalHeight > 8192
    )
      throw new Error("Invalid logo image dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    if (canvas.width > 1024 || canvas.height > 512)
      throw new Error("Logo image exceeds cache bounds");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Logo canvas unavailable");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return logoFromRgba(
      canvas.width,
      canvas.height,
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function loadBundledMarkiroLogo(): Promise<MonoBitmap> {
  const response = await fetch(markiroLogoUrl);
  if (!response.ok) throw new Error("Bundled Markiro logo unavailable");
  const blob = await response.blob();
  if (blob.size > 131072) throw new Error("Bundled logo exceeds bounds");
  return decodeBrowserLogo(blob, 3.5);
}
export async function decodeStationBrandingLogo(blob: Blob): Promise<MonoBitmap> {
  if (blob.type !== "image/webp") throw new Error("Invalid Station logo content type");
  return decodeBrowserLogo(blob);
}
const refreshes = new WeakMap<CredentialGeneration, Promise<void>>();
export async function refreshOrganizationBranding(
  owner: OrganizationBrandingOwner,
  ports: BrandingResourcePorts = {},
): Promise<void> {
  const existing = refreshes.get(owner.generation);
  if (existing) return existing;
  const run = refresh(owner, ports);
  refreshes.set(owner.generation, run);
  try {
    await run;
  } finally {
    if (refreshes.get(owner.generation) === run) refreshes.delete(owner.generation);
  }
}
async function refresh(
  owner: OrganizationBrandingOwner,
  ports: BrandingResourcePorts,
): Promise<void> {
  if (!current(owner)) return;
  const ownerDigest = await ownership(owner);
  if (!current(owner)) return;
  const metadata = organizationBrandingDescriptorSchema.parse(
    await owner.client.get("/station/branding"),
  );
  if (!current(owner)) return;
  let bitmap: MonoBitmap,
    sourceChecksum: string | null = null;
  if (metadata.logo && metadata.logoRevision && metadata.logoUrl) {
    if (metadata.logoUrl !== `/station/branding/logo/${metadata.logoRevision}`)
      throw new Error("Invalid Station branding route");
    const blob = await owner.client.download(metadata.logoUrl);
    if (!current(owner)) return;
    if (blob.type !== metadata.logo.contentType || blob.size !== metadata.logo.byteSize)
      throw new Error("Branding source metadata mismatch");
    const checksum = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (checksum !== metadata.logo.checksum) throw new Error("Branding source checksum mismatch");
    bitmap = await (ports.decodeLogo ?? decodeStationBrandingLogo)(blob);
    if (bitmap.width !== metadata.logo.width || bitmap.height !== metadata.logo.height)
      throw new Error("Branding source dimensions mismatch");
    sourceChecksum = checksum;
  } else bitmap = await (ports.loadMarkiroLogo ?? loadBundledMarkiroLogo)();
  validateMonoBitmap(bitmap);
  if (!current(owner)) return;
  const content = {
    schemaVersion: 1 as const,
    producerVersion: "logo-raster-v1" as const,
    tenantId: owner.tenantId,
    ownerDigest,
    organizationName: metadata.organizationName,
    logoRevision: metadata.logoRevision,
    sourceChecksum,
    logo: {
      width: bitmap.width,
      height: bitmap.height,
      stride: bitmap.stride,
      pixelsBase64: base64(bitmap.pixels),
      digest: logoDigest(bitmap),
      source: metadata.logoRevision ? ("organization" as const) : ("markiro" as const),
    },
  };
  const json = JSON.stringify({ ...content, digest: productLabelValueDigest(content) });
  parseOrganizationBranding(json);
  const lease = acquireCredentialCommitLease(owner.generation);
  if (!lease) return;
  try {
    if (!current(owner)) return;
    await owner.exec.run(
      `INSERT INTO station_organization_branding(tenant_id,owner_digest,snapshot_json) VALUES(?,?,?)
      ON CONFLICT(tenant_id,owner_digest) DO UPDATE SET snapshot_json=excluded.snapshot_json`,
      [owner.tenantId, ownerDigest, json],
    );
  } finally {
    lease.release();
  }
}
