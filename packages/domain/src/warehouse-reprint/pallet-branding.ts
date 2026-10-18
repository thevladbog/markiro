import { z } from "zod";
import { productLabelValueDigest } from "../product-labels/km.js";
import { sheetLogoFingerprint } from "../labels/pallet-sheet-branding.js";
import { validateMonoBitmap } from "../labels/mono-compose.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z.strictObject({
  schemaVersion: z.literal(1),
  producerVersion: z.literal("logo-raster-v1"),
  tenantId: z.string().min(1),
  ownerDigest: hash,
  organizationName: z.string().trim().min(1).max(255),
  organizationInn: z
    .string()
    .regex(/^(?:\d{10}|\d{12})$/)
    .nullable()
    .optional(),
  logoRevision: z.uuid().nullable(),
  sourceChecksum: hash.nullable(),
  digest: hash,
  logo: z.strictObject({
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(512),
    stride: z.number().int().positive().max(128),
    pixelsBase64: z.string().max(90000),
    digest: hash,
    source: z.enum(["organization", "markiro"]),
  }),
});
/** Validate the transferable envelope without decoding images or depending on a browser. */
export function validatePalletBranding(json: string) {
  if (new TextEncoder().encode(json).length > 131072)
    throw new Error("Pallet branding exceeds bounds");
  const saved = envelope.parse(JSON.parse(json));
  const { digest, ...content } = saved;
  if (digest !== productLabelValueDigest(content)) throw new Error("Pallet branding changed");
  const binary = atob(saved.logo.pixelsBase64);
  if (btoa(binary) !== saved.logo.pixelsBase64) throw new Error("Invalid branding encoding");
  const bitmap = {
    width: saved.logo.width,
    height: saved.logo.height,
    stride: saved.logo.stride,
    pixels: Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  };
  validateMonoBitmap(bitmap);
  if (sheetLogoFingerprint(bitmap) !== saved.logo.digest) throw new Error("Pallet logo changed");
  if (
    saved.logo.source === "organization"
      ? !saved.logoRevision || !saved.sourceChecksum
      : saved.logoRevision !== null || saved.sourceChecksum !== null
  )
    throw new Error("Pallet branding provenance mismatch");
  return saved;
}
