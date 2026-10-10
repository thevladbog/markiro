import { z } from "zod";
import {
  palletSheetTemplateSnapshotSchema,
  parsePalletSheetSnapshot,
  productLabelValueDigest,
  renderPalletSheet,
  encodeMonoRaster,
  resolvePalletSheetGeometry,
  type PalletSheetTemplateSnapshot,
  type RasterizeTextFn,
  type PalletSheetContext,
} from "@markiro/domain";
import {
  parseOrganizationBranding,
  serializeOrganizationBranding,
  type BrandingSnapshot,
} from "./organization-branding.js";
import { parsePrinterProfile, type PrinterProfile } from "./printer-routing.js";
import type { WindowsPageGeometry, WindowsSheetRequest } from "./hardware.js";
const finite = z.number().finite();
const bounds = z.strictObject({
  left: finite.nonnegative(),
  top: finite.nonnegative(),
  right: finite.positive(),
  bottom: finite.positive(),
});
const geometrySchema = z
  .strictObject({
    widthMm: finite.positive(),
    heightMm: finite.positive(),
    printableBoundsMm: bounds,
    guardMm: z.literal(0.5),
    deviceDpiX: z.union([z.literal(300), z.literal(600), z.literal(1200)]),
    deviceDpiY: z.union([z.literal(300), z.literal(600), z.literal(1200)]),
    fingerprint: z.string().min(1).max(4096),
  })
  .refine((g) => g.deviceDpiX === g.deviceDpiY);
const factsSchema = z.strictObject({
  sscc: z.string().regex(/^\d{18}$/),
  productPrintName: z.string().min(1).max(4096),
  gtin14: z.string().regex(/^\d{14}$/),
  egaisCode: z
    .string()
    .regex(/^\d{19}$/)
    .nullable(),
  productionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  shelfLifeDays: z.number().int().positive().nullable(),
  boxCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  shiftNumber: z.string().max(255).nullable(),
});
export type PalletSheetFacts = z.infer<typeof factsSchema>;
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  rendererVersion: z.literal("pallet-sheet-v1"),
  template: palletSheetTemplateSnapshotSchema,
  facts: factsSchema,
  brandingJson: z.string().max(131072),
  geometry: geometrySchema,
  replayOf: z
    .strictObject({
      attemptId: z.string().min(1).max(255),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
      geometryFingerprint: z.string().min(1).max(4096),
    })
    .nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PalletSheetPrintSnapshotV1 = z.infer<typeof schema>;
export function parsePalletSheetPrintSnapshot(json: string): PalletSheetPrintSnapshotV1 {
  if (new TextEncoder().encode(json).length > 700000) throw new Error("Unsupported sheet snapshot");
  const saved = schema.parse(JSON.parse(json));
  const { digest, ...content } = saved;
  if (productLabelValueDigest(content) !== digest) throw new Error("Sheet snapshot changed");
  parsePalletSheetSnapshot(saved.template);
  parseOrganizationBranding(saved.brandingJson);
  resolvePalletSheetGeometry(saved.template.spec, saved.geometry);
  if (saved.replayOf && saved.replayOf.geometryFingerprint !== saved.geometry.fingerprint)
    throw new Error("Replay geometry changed");
  return saved;
}
export function sheetRequest(snapshot: PalletSheetPrintSnapshotV1): WindowsSheetRequest {
  return {
    pageOptions: { mode: "a4_sheet", orientation: snapshot.template.spec.page.orientation },
    geometryFingerprint: snapshot.geometry.fingerprint,
  };
}
export async function rebuildPalletSheet(
  snapshot: PalletSheetPrintSnapshotV1,
  rasterize: RasterizeTextFn,
): Promise<Uint8Array> {
  const saved = parsePalletSheetPrintSnapshot(JSON.stringify(snapshot));
  const branding = parseOrganizationBranding(saved.brandingJson);
  const context: PalletSheetContext = {
    ...saved.facts,
    organizationName: branding.organizationName,
    logo: branding.logo,
  };
  return encodeMonoRaster(
    await renderPalletSheet(saved.template.spec, context, saved.geometry, rasterize),
  );
}
export async function preparePalletSheet(
  input: {
    profile: PrinterProfile;
    template: PalletSheetTemplateSnapshot;
    facts: PalletSheetFacts;
    branding: BrandingSnapshot;
    geometry: WindowsPageGeometry;
  },
  rasterize: RasterizeTextFn,
): Promise<{ bytes: Uint8Array; renderSnapshot: PalletSheetPrintSnapshotV1 }> {
  const profile = parsePrinterProfile(input.profile);
  if (!profile || profile.paper !== "a4") throw new Error("A4 Windows printer required");
  const content = {
    schemaVersion: 1 as const,
    rendererVersion: "pallet-sheet-v1" as const,
    template: parsePalletSheetSnapshot(input.template),
    facts: factsSchema.parse(input.facts),
    brandingJson: serializeOrganizationBranding(input.branding),
    geometry: geometrySchema.parse(input.geometry),
  };
  const renderSnapshot = parsePalletSheetPrintSnapshot(
    JSON.stringify({
      ...content,
      replayOf: null,
      digest: productLabelValueDigest({ ...content, replayOf: null }),
    }),
  );
  return { bytes: await rebuildPalletSheet(renderSnapshot, rasterize), renderSnapshot };
}
