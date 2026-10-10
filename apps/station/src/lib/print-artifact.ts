import {
  encodeMonoRaster,
  renderMonoLabel,
  withPrinterDpi,
  type LabelTemplateSpec,
  type LabelField,
  type RasterizeTextFn,
} from "@markiro/domain";
import { renderLabelBytes } from "./print-label.js";
import { printerMode, type PrinterProfile } from "./printer-routing.js";
export interface PrintArtifact {
  format: "zpl" | "tspl" | "mono-raster-v1";
  dpi: 203 | 300;
  bytes: Uint8Array;
}
export async function renderPrintArtifact(
  spec: LabelTemplateSpec,
  fields: Record<LabelField, string>,
  profile: PrinterProfile,
  rasterizeText: RasterizeTextFn,
  options: { kmDataMatrix?: "native" | "raster" } = {},
): Promise<PrintArtifact> {
  if (profile.paper === "a4") throw new Error("A4 requires a pallet sheet template");
  if (printerMode(profile) === "windows_driver") {
    if (profile.target.kind !== "usb" || !profile.dpi)
      throw new Error("Windows printer and DPI required");
    return {
      format: "mono-raster-v1",
      dpi: profile.dpi,
      bytes: encodeMonoRaster(
        await renderMonoLabel(withPrinterDpi(spec, profile.dpi), fields, rasterizeText),
      ),
    };
  }
  return {
    format: profile.language,
    dpi: profile.dpi ?? spec.dpi,
    bytes: await renderLabelBytes(spec, fields, profile.language, rasterizeText, {
      ...options,
      dpi: profile.dpi,
    }),
  };
}
