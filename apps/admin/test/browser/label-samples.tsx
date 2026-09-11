import {
  generateTspl,
  generateZpl,
  labelFieldDisplayValue,
  mmToDots,
  needsImageRendering,
  parseLabelCode,
  ptToDots,
  rasterAlignOffsetDots,
} from "@markiro/domain";
import "@markiro/ui/styles.css";
import samples from "../../../../examples/labels/manifest.json";
import { draw } from "../../src/pages/labels/renderer.js";
import { decodeRasterToRgba } from "../../src/pages/labels/editor/raster-preview.js";
import { rasterizeText } from "../../src/labels/rasterizer.js";
import { checkFamilyCoverage } from "../../src/labels/fontCoverage.js";
import { labelRenderOptions } from "../../src/pages/labels/preview-data.js";

async function renderSample(index: number, code: string, ssccSvg: string | null) {
  const sample = samples[index];
  if (!sample) throw new Error("Unknown sample");
  const { spec, warnings } = parseLabelCode(code, { language: "zpl", dpi: 203 });
  if (warnings.length) throw new Error(JSON.stringify(warnings));
  const purpose = sample.purpose === "box" ? "box" : "product_duplicate";
  if (!(await checkFamilyCoverage("IBM Plex Sans"))) throw new Error("Cyrillic font unavailable");
  const canvas = document.querySelector("canvas");
  const context = canvas?.getContext("2d");
  if (!canvas || !context) throw new Error("Missing preview canvas");
  canvas.width = mmToDots(spec.widthMm, spec.dpi);
  canvas.height = mmToDots(spec.heightMm, spec.dpi);
  const rasterElements = spec.elements.filter((element) =>
    element.kind === "text"
      ? needsImageRendering(element.text)
      : element.kind === "field" &&
        needsImageRendering(
          labelFieldDisplayValue(element.field, sample.sampleData, element.textFormat),
        ),
  );
  // Use the editor's shared layout renderer, then the exact print bitmaps.
  // Omit schematic Cyrillic first so no approximate glyph tails remain.
  draw(
    { ...spec, elements: spec.elements.filter((element) => !rasterElements.includes(element)) },
    context,
    203 / 25.4,
    sample.sampleData,
    labelRenderOptions(purpose),
  );
  for (const element of rasterElements) {
    if (element.kind !== "text" && element.kind !== "field") continue;
    const text =
      element.kind === "text"
        ? element.text
        : labelFieldDisplayValue(element.field, sample.sampleData, element.textFormat);
    const maxWidthPx =
      element.maxWidthMm === undefined ? undefined : mmToDots(element.maxWidthMm, spec.dpi);
    const raster = await rasterizeText(text, {
      fontFamily: "IBM Plex Sans",
      fontSizePx: ptToDots(element.fontSizePt, spec.dpi),
      bold: element.bold ?? false,
      maxLines: element.maxLines ?? 1,
      ...(maxWidthPx === undefined ? {} : { maxWidthPx }),
    });
    const offset = rasterAlignOffsetDots(element.align, maxWidthPx, raster.width);
    context.putImageData(
      new ImageData(decodeRasterToRgba(raster), raster.width, raster.height),
      mmToDots(element.xMm, spec.dpi) + offset,
      mmToDots(element.yMm, spec.dpi),
    );
  }
  // The editor's linear barcode is schematic. Replace only that region with
  // a real GS1-128 symbol, retaining the imported dimensions and quiet zones.
  if (ssccSvg) {
    const barcode = spec.elements.find((element) => element.kind === "barcode");
    if (!barcode || barcode.kind !== "barcode" || !barcode.moduleWidthMm)
      throw new Error("Missing SSCC geometry");
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ssccSvg)}`;
    await image.decode();
    const x = mmToDots(barcode.xMm, 203);
    const y = mmToDots(barcode.yMm, 203);
    const width = 156 * mmToDots(barcode.moduleWidthMm, 203);
    const height = mmToDots(barcode.sizeMm, 203);
    context.fillStyle = "white";
    context.fillRect(x, y, width, height);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, x, y, width, height);
  }
  // Exercise the real browser text rasterizer and both printer generators.
  for (const dpi of [203, 300] as const) {
    const deps = { rasterizeText, ...labelRenderOptions(purpose) };
    for (const generate of [generateZpl, generateTspl]) {
      const output = await generate({ ...spec, dpi }, sample.sampleData, deps);
      if (output.includes("{{") || output.length < 100)
        throw new Error("Incomplete printer output");
    }
  }
  return { id: sample.id, width: canvas.width, height: canvas.height };
}

declare global {
  interface Window {
    renderLabelSample: typeof renderSample;
  }
}
window.renderLabelSample = renderSample;
