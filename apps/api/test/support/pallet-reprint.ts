import {
  buildPalletLabelTemplates,
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  makePalletLabelSource,
  productLabelValueDigest,
  sheetLogoFingerprint,
} from "@markiro/domain";

export const palletSscc = "146000000000001231";
const identity = {
  version: 1 as const,
  sscc: palletSscc,
  shiftId: "00000000-0000-4000-8000-000000000001",
  closedAt: "2026-10-11T00:00:00.000Z",
  boxCount: 1,
  itemCount: 1,
  boxSsccs: ["046000000000001234"],
  compositionDigest: "a".repeat(64),
};
export function sheetChoice(index = 0) {
  const preset = buildPalletSheetPresets()[index];
  if (!preset) throw new Error("Missing A4 preset");
  const id = `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`;
  const snapshot = createPalletSheetSnapshot({
    id,
    name: preset.name,
    revision: 1,
    spec: preset.spec,
  });
  return {
    kind: "a4" as const,
    id,
    name: snapshot.name,
    snapshot,
    snapshotDigest: productLabelValueDigest(snapshot),
  };
}
export function thermalChoice() {
  const template = buildPalletLabelTemplates()[0];
  if (!template) throw new Error("Missing thermal preset");
  return {
    kind: "thermal" as const,
    id: "00000000-0000-4000-8000-000000000030",
    name: template.name,
    snapshot: template.spec,
    snapshotDigest: productLabelValueDigest(template.spec),
  };
}
export function a4PalletSource() {
  const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
  const branding = {
    schemaVersion: 1,
    producerVersion: "logo-raster-v1",
    tenantId: "tenant-fixture",
    ownerDigest: "a".repeat(64),
    organizationName: "Исторический завод",
    organizationInn: "9705119097",
    logoRevision: null,
    sourceChecksum: null,
    logo: {
      width: 4,
      height: 1,
      stride: 1,
      pixelsBase64: "gA==",
      digest: sheetLogoFingerprint(bitmap),
      source: "markiro",
    },
  };
  return makePalletLabelSource({
    ...identity,
    rendering: {
      kind: "a4",
      rendererVersion: "pallet-sheet-v1",
      template: sheetChoice().snapshot,
      facts: {
        sscc: palletSscc,
        productPrintName: "Исторический товар",
        gtin14: "04600000000015",
        egaisCode: null,
        productionDate: "2026-10-11",
        shelfLifeDays: 1,
        boxCount: 1,
        itemCount: 1,
        shiftNumber: "Смена 1",
      },
      brandingJson: JSON.stringify({ ...branding, digest: productLabelValueDigest(branding) }),
    },
  });
}
