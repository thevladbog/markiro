import { expect, it } from "vitest";
import {
  buildPalletSheetPresets,
  renderPalletSheet,
  nominalSheetGeometry,
  encodeMonoRaster,
  type RasterizeTextFn,
  type SheetLogo,
} from "@markiro/domain";
import {
  previewSheetContext,
  renderSheetPreview,
} from "../src/pages/labels/editor/sheet/sheet-preview.js";
const logo: SheetLogo = {
  width: 20,
  height: 5,
  stride: 3,
  pixels: new Uint8Array(15),
  source: "markiro",
  digest: "preview",
};
const text: RasterizeTextFn = async (_value, opts) => {
  const width = Math.min(60, opts.maxWidthPx ?? 60),
    height = Math.ceil(opts.fontSizePx * 1.5);
  return {
    width,
    height,
    totalBytes: Math.ceil(width / 8) * height,
    bytesPerRow: Math.ceil(width / 8),
    hex: "00".repeat(Math.ceil(width / 8) * height),
  };
};
it("previews the actual draft through the domain renderer, including edited footer and copies", async () => {
  const preset = buildPalletSheetPresets()[2];
  if (!preset) throw new Error("Missing preset");
  const spec = { ...preset.spec, body: [], footer: { ...preset.spec.footer, barHeightMm: 40 } };
  const context = previewSheetContext(
    { date: false, egais: true, longName: true, maximumCounts: true },
    logo,
  );
  expect(context.productionDate).toBeNull();
  expect(context.egaisCode).toHaveLength(19);
  expect(context.productPrintName.split("\n")).toHaveLength(5);
  const actual = await renderSheetPreview(spec, context, text);
  const expected = await renderPalletSheet(spec, context, nominalSheetGeometry(spec), text);
  expect(encodeMonoRaster(actual)).toEqual(encodeMonoRaster(expected));
});
