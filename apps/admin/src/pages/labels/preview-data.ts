import { sampleLabelData, type LabelField, type LabelTemplatePurpose } from "@markiro/domain";

type LabelRenderOptions = { kmDataMatrix?: "native" | "raster" };

const boxSample = sampleLabelData();
// Synthetic demonstration data, never a code taken from production.
const duplicateSample = {
  ...boxSample,
  "km.code": "010460000000001521DEMO-LABEL-42\u001d93Abcd",
  "product.gtin": "04600000000015",
  "product.printName": "Кега · демонстрационная этикетка",
  qty: "1",
  sscc: "",
};
// Synthetic demonstration data, never a code taken from production. A
// pallet carries its OWN sscc (never a box's), and its units figure covers
// every box stacked on it, so both differ from boxSample's -- qty.boxes
// (boxes on this pallet) comes straight from sampleLabelData() unchanged,
// which is exactly the count a pallet label needs and a box label never
// shows (see LABEL_FIELDS's doc comment in packages/domain/src/labels/model.ts).
const palletSample = {
  ...boxSample,
  sscc: "376006820000000021",
  qty: "240",
};

const rasterOptions: LabelRenderOptions = { kmDataMatrix: "raster" };
const nativeOptions: LabelRenderOptions = {};

/**
 * Exhaustive over `LabelTemplatePurpose` (not a binary ternary) so a purpose
 * added later cannot silently fall through to the box sample the way
 * "pallet" did before this map existed -- TypeScript requires every key of
 * the union to be present in a `Record<LabelTemplatePurpose, ...>` literal.
 */
const SAMPLE_DATA: Record<LabelTemplatePurpose, Record<LabelField, string>> = {
  box: boxSample,
  product_duplicate: duplicateSample,
  pallet: palletSample,
};

const RENDER_OPTIONS: Record<LabelTemplatePurpose, LabelRenderOptions> = {
  box: nativeOptions,
  product_duplicate: rasterOptions,
  pallet: nativeOptions,
};

export function labelPreviewData(
  purpose: LabelTemplatePurpose = "box",
): Record<LabelField, string> {
  return SAMPLE_DATA[purpose];
}
export function labelRenderOptions(purpose: LabelTemplatePurpose = "box"): LabelRenderOptions {
  return RENDER_OPTIONS[purpose];
}
