export { gs1CheckDigit, hasValidCheckDigit } from "./gs1/check-digit.js";
export { DomainError } from "./errors.js";
export { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "./gs1/gtin.js";
export { kmKey, parseKm } from "./gs1/km.js";
export type { ParsedKm } from "./gs1/km.js";
export { buildSscc, isValidSscc, ssccSerialCapacity } from "./gs1/sscc.js";
export { classifyScan } from "./scan/classify.js";
export type { ScanInput } from "./scan/classify.js";
export { validatePickupKm } from "./scan/pickup.js";
export type { PickupKmResult } from "./scan/pickup.js";
export { validateShiftScan } from "./scan/validate.js";
export type { ScanVerdict, ShiftScanContext } from "./scan/validate.js";
export { mmToDots, parseLabelTemplate, ptToDots, sampleLabelData } from "./labels/model.js";
export type {
  LabelBarcodeElement,
  LabelBoxElement,
  LabelElement,
  LabelField,
  LabelFieldElement,
  LabelLineElement,
  LabelTemplateSpec,
  LabelTextElement,
} from "./labels/model.js";
export {
  buildGfaCommand,
  generateZpl,
  needsImageRendering,
  rasterAlignOffsetDots,
} from "./labels/zpl.js";
export type { GenerateZplDeps, RasterResult, RasterizeTextFn } from "./labels/zpl.js";
export { buildBitmapCommand, generateTspl } from "./labels/tspl.js";
export type { GenerateTsplDeps } from "./labels/tspl.js";
export { bitmapToTsplBytes, bitmapToZplHex, convertToMonochrome } from "./labels/raster.js";
export type { TsplBytesPacking, ZplHexPacking } from "./labels/raster.js";
