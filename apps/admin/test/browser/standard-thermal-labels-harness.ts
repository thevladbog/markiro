import "@markiro/ui/styles.css";
import "../../src/global.css";
import {
  buildDefaultLabelTemplates,
  buildPalletLabelTemplates,
  sampleLabelData,
  renderMonoLabel,
  encodeMonoRaster,
  createLabelRenderPlan,
  emitLabelRenderPlan,
  withPrinterDpi,
  type PrinterDpi,
} from "@markiro/domain";
import { rasterizeText as adminText } from "../../src/labels/rasterizer.js";
import { rasterizeText as stationText } from "../../../station/src/lib/rasterizer.js";
import { loadCabinetSheetBranding } from "../../src/pages/labels/editor/sheet/sheet-branding.js";
import { paintSheetRaster } from "../../src/pages/labels/editor/sheet/sheet-preview.js";
const params = new URLSearchParams(location.search);
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
const container: HTMLElement = root;
container.style.cssText =
  "display:grid;grid-template-columns:repeat(4,min-content);gap:24px;padding:24px;background:#e9e9e9;align-items:start";
async function run() {
  const { logo } = await loadCabinetSheetBranding();
  const dpi: PrinterDpi = params.get("dpi") === "300" ? 300 : 203;
  const templates = [...buildDefaultLabelTemplates(), ...buildPalletLabelTemplates()].filter(
    (t) => t.spec.widthMm !== 58,
  );
  let parity = true,
    overlaps = 0;
  const regions: unknown[] = [];
  for (const { name, spec: original } of templates) {
    const pallet = name.startsWith("Палет");
    const spec = withPrinterDpi(original, dpi);
    const product = params.has("long")
      ? "Сидр полусухой\nгазированный\n«ДИКИЙ КРЕСТ»\n0,45 л"
      : "Сидр полусухой газированный «ДИКИЙ КРЕСТ», 0,45 л";
    const fields = {
      ...sampleLabelData(),
      "product.name": product,
      "product.printName": params.has("long") ? product : "ДИКИЙ КРЕСТ\nСидр, 0,45 л",
      sscc: "146000000000001231",
      "product.egais": "0300000000000123456",
      "product.gtin": "04600000000128",
      qty: params.has("max") ? (pallet ? "9999999" : "10000") : pallet ? "1440" : "12",
      "qty.boxes": params.has("max") ? "999999" : "120",
      date: "10.10.2026",
      expiry: "09.10.2027",
    };
    const admin = await renderMonoLabel(spec, fields, adminText, { logo });
    const station = await renderMonoLabel(spec, fields, stationText, { logo });
    const bytes = encodeMonoRaster(admin),
      other = encodeMonoRaster(station);
    parity &&= bytes.length === other.length && bytes.every((byte, index) => byte === other[index]);
    const plan = await createLabelRenderPlan(spec, fields, {
      dpi,
      language: "zpl",
      rasterizeText: adminText,
      logo,
    });
    const boxes = plan.elements
      .filter((e) => e.kind !== "rectangle")
      .map((e) => ({
        id: e.id,
        x: e.xDots,
        y: e.yDots,
        w: e.kind === "raster" ? e.raster.width : e.widthDots,
        h: e.kind === "raster" ? e.raster.height : e.heightDots,
      }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!,
          b = boxes[j]!;
        if (
          Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
          Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
        ) {
          overlaps++;
          regions.push({ name, a, b });
        }
      }
    const card = document.createElement("section");
    card.dataset.template = name;
    const caption = document.createElement("p");
    caption.textContent = name;
    const canvas = document.createElement("canvas");
    canvas.style.width = `${spec.widthMm * 3}px`;
    canvas.style.height = `${spec.heightMm * 3}px`;
    card.append(caption, canvas);
    container.append(card);
    paintSheetRaster(canvas, admin);
    card.dataset.zplLogo = String(emitLabelRenderPlan(plan).includes("^GFA"));
  }
  document.documentElement.dataset.thermalParity = String(parity);
  document.documentElement.dataset.thermalCount = String(templates.length);
  document.documentElement.dataset.thermalOverlaps = String(overlaps);
  document.documentElement.dataset.thermalRegions = JSON.stringify(regions);
  document.documentElement.dataset.logoSize = `${logo.width}x${logo.height}`;
  document.documentElement.dataset.thermalReady = "true";
}
await run().catch((error: unknown) => {
  document.documentElement.dataset.thermalError =
    error instanceof Error ? error.message : String(error);
  container.textContent = document.documentElement.dataset.thermalError;
});
