import {
  encodeMonoRaster,
  renderMonoLabel,
  withPrinterDpi,
  createLabelRenderPlan,
  emitLabelRenderPlan,
  labelTemplateUsesField,
  productLabelBytesDigest,
  warehouseSourceSchema,
  warehouseTemplateSchema,
  type WarehouseReprintSource,
  type WarehouseTemplate,
  type RasterizeTextFn,
  type MonoBitmap,
} from "@markiro/domain";
import { bytesToBase64 } from "../hardware.js";
import { parsePrinterProfile, printerMode, type PrinterProfile } from "../printer-routing.js";
import { latin1ToBytes } from "../print-label.js";
export async function renderWarehouseLabel(
  value: WarehouseReprintSource,
  selection: WarehouseTemplate,
  profile: PrinterProfile,
  rasterizeText: RasterizeTextFn,
  options: { logo?: MonoBitmap } = {},
) {
  const source = warehouseSourceSchema.parse(value);
  const template = warehouseTemplateSchema.parse(selection);
  const printer = parsePrinterProfile(profile);
  if (!printer || printer.dpi === null) throw new Error("WAREHOUSE_PRINTER_DPI");
  if (
    !template.enabled ||
    template.purpose !== (source.kind === "box" ? "box" : "product_duplicate")
  )
    throw new Error("WAREHOUSE_TEMPLATE_PURPOSE");
  if (
    template.chzProductGroupCodes !== null &&
    (source.chzProductGroupCode === null ||
      !template.chzProductGroupCodes.includes(source.chzProductGroupCode))
  )
    throw new Error("WAREHOUSE_TEMPLATE_GROUP");
  if (source.unavailableFields.some((field) => labelTemplateUsesField(template.spec, field)))
    throw new Error("WAREHOUSE_SOURCE_FIELDS");
  const fields = { ...source.fields };
  if (printerMode(printer) === "windows_driver") {
    const bytes = encodeMonoRaster(
      await renderMonoLabel(
        withPrinterDpi(template.spec, printer.dpi),
        fields,
        rasterizeText,
        options,
      ),
    );
    return {
      fields,
      bytesBase64: bytesToBase64(bytes),
      bytesDigest: productLabelBytesDigest(bytes),
    };
  }
  const plan = await createLabelRenderPlan(template.spec, fields, {
    language: printer.language,
    dpi: printer.dpi,
    rasterizeText,
    ...options,
  });
  const bytes = latin1ToBytes(emitLabelRenderPlan(plan));
  return { fields, bytesBase64: bytesToBase64(bytes), bytesDigest: productLabelBytesDigest(bytes) };
}
