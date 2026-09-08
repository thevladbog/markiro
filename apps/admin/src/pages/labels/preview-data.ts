import { sampleLabelData, type LabelTemplatePurpose } from "@markiro/domain";

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
const rasterOptions = { kmDataMatrix: "raster" } as const;
const nativeOptions = {};
export function labelPreviewData(purpose: LabelTemplatePurpose = "box") {
  return purpose === "product_duplicate" ? duplicateSample : boxSample;
}
export function labelRenderOptions(purpose: LabelTemplatePurpose = "box") {
  return purpose === "product_duplicate" ? rasterOptions : nativeOptions;
}
