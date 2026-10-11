import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  gs1CheckDigit,
  productLabelValueDigest,
  sheetLogoFingerprint,
} from "@markiro/domain";
import { loadBundledMarkiroLogo, parseOrganizationBranding } from "./organization-branding.js";
import { preparePalletSheet } from "./pallet-sheet-print-snapshot.js";
import type { PrinterProfile } from "./printer-routing.js";
import type { WindowsPageGeometry } from "./hardware.js";
import { rasterizeDriverText } from "./rasterizer.js";

/** Synthetic SSCC for this setup run; never allocated to a production pallet. */
export function makeA4TestSscc(): string {
  const random = crypto.getRandomValues(new Uint8Array(13));
  const body = "9999" + Array.from(random, (byte) => String(byte % 10)).join("");
  return body + gs1CheckDigit(body);
}

export async function prepareA4TestPrint(
  profile: PrinterProfile,
  geometry: WindowsPageGeometry,
  orientation: "portrait" | "landscape",
  sscc: string,
  text: { title: string; product: string },
) {
  const preset = buildPalletSheetPresets().find(
    (candidate) =>
      candidate.spec.page.orientation === orientation && candidate.spec.page.copies === 1,
  );
  if (!preset) throw new Error("A4 test template unavailable");
  const bitmap = await loadBundledMarkiroLogo();
  const content = {
    schemaVersion: 1,
    producerVersion: "logo-raster-v1",
    tenantId: "workstation-test",
    ownerDigest: productLabelValueDigest("workstation-test"),
    organizationName: text.title,
    logoRevision: null,
    sourceChecksum: null,
    logo: {
      width: bitmap.width,
      height: bitmap.height,
      stride: bitmap.stride,
      pixelsBase64: btoa(Array.from(bitmap.pixels, (byte) => String.fromCharCode(byte)).join("")),
      digest: sheetLogoFingerprint(bitmap),
      source: "markiro",
    },
  };
  const branding = parseOrganizationBranding(
    JSON.stringify({ ...content, digest: productLabelValueDigest(content) }),
  );
  return preparePalletSheet(
    {
      profile,
      geometry,
      template: createPalletSheetSnapshot({
        id: crypto.randomUUID(),
        name: text.title,
        revision: 1,
        spec: preset.spec,
      }),
      branding,
      facts: {
        sscc,
        productPrintName: text.product,
        gtin14: "04600000000015",
        productionDate: null,
        shelfLifeDays: null,
        egaisCode: null,
        boxCount: 48,
        itemCount: 576,
        shiftNumber: null,
      },
    },
    rasterizeDriverText,
  );
}
