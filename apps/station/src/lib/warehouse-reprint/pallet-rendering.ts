import {
  encodeMonoRaster,
  renderMonoLabel,
  renderPalletSheet,
  nominalSheetGeometry,
  withPrinterDpi,
  productLabelValueDigest,
  labelTemplateUsesField,
  makePalletRenderingV2,
  type PalletLabelSourceV1,
  type PalletTemplateChoice,
  type PalletRenderingV2,
} from "@markiro/domain";
import { parseOrganizationBranding } from "../organization-branding.js";
import { rasterizeDriverText } from "../rasterizer.js";
import { printerMode, type PrinterProfile } from "../printer-routing.js";
export function originalPalletTemplate(source: PalletLabelSourceV1): PalletTemplateChoice {
  const r = source.rendering;
  return r.kind === "a4"
    ? {
        kind: "a4",
        id: null,
        name: r.template.name,
        snapshot: r.template,
        snapshotDigest: productLabelValueDigest(r.template),
      }
    : {
        kind: "thermal",
        id: null,
        name: "Original",
        snapshot: r.template,
        snapshotDigest: productLabelValueDigest(r.template),
      };
}
export function palletTemplateUnavailable(
  source: PalletLabelSourceV1,
  choice: PalletTemplateChoice,
  profile: PrinterProfile | null,
): string | null {
  if (choice.kind !== source.rendering.kind) return "WAREHOUSE_PALLET_TEMPLATE_KIND";
  if (!profile) return "WAREHOUSE_PRINTER_UNCONFIGURED";
  if (!profile.dpi) return "WAREHOUSE_PRINTER_DPI";
  if (
    choice.kind === "a4"
      ? profile.paper !== "a4" || printerMode(profile) !== "windows_driver"
      : profile.paper === "a4"
  )
    return "WAREHOUSE_PALLET_PRINTER_FORMAT";
  if (choice.id !== null && choice.kind === "thermal" && source.rendering.kind === "thermal") {
    if (!source.rendering.fields.date && labelTemplateUsesField(choice.snapshot, "date"))
      return "WAREHOUSE_SOURCE_DATE";
    if (!source.rendering.fields.expiry && labelTemplateUsesField(choice.snapshot, "expiry"))
      return "WAREHOUSE_SOURCE_EXPIRY";
  }
  try {
    makePalletRenderingV2(source, { ...choice, name: choice.name || "Original" });
  } catch {
    return "WAREHOUSE_SOURCE_FIELDS";
  }
  return null;
}
export async function previewPalletRendering(
  rendering: PalletRenderingV2["rendering"],
  dpi: 203 | 300 | null,
) {
  const saved = rendering,
    branding = saved.brandingJson ? parseOrganizationBranding(saved.brandingJson) : null;
  if (saved.kind === "a4") {
    if (!branding) throw new Error("WAREHOUSE_PALLET_SNAPSHOT_MISSING");
    return encodeMonoRaster(
      await renderPalletSheet(
        saved.template.spec,
        {
          ...saved.facts,
          organizationName: branding.organizationName,
          ...(branding.organizationInn !== undefined
            ? { organizationInn: branding.organizationInn }
            : {}),
          logo: branding.logo,
        },
        nominalSheetGeometry(saved.template.spec),
        rasterizeDriverText,
      ),
    );
  }
  return encodeMonoRaster(
    await renderMonoLabel(
      withPrinterDpi(saved.template, dpi ?? saved.template.dpi),
      saved.fields,
      rasterizeDriverText,
      { logo: branding?.logo ?? null },
    ),
  );
}
