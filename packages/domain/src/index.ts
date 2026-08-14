export { gs1CheckDigit, hasValidCheckDigit } from "./gs1/check-digit.js";
export { DomainError } from "./errors.js";
export { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "./gs1/gtin.js";
export { canonicalizeKm, kmHash, kmKey, MAX_KM_UTF8_BYTES, parseKm } from "./gs1/km.js";
export type { ParsedKm } from "./gs1/km.js";
export {
  buildSscc,
  isValidSscc,
  parseScannedSscc,
  parseSscc,
  ssccSerialCapacity,
} from "./gs1/sscc.js";
export type { ParsedSscc } from "./gs1/sscc.js";
export { classifyScan } from "./scan/classify.js";
export type { ScanInput } from "./scan/classify.js";
export { validatePickupKm } from "./scan/pickup.js";
export type { PickupKmResult } from "./scan/pickup.js";
export { validateShiftScan } from "./scan/validate.js";
export type { ScanVerdict, ShiftScanContext } from "./scan/validate.js";
export {
  LABEL_FIELDS,
  mmToDots,
  parseLabelTemplate,
  ptToDots,
  sampleLabelData,
} from "./labels/model.js";
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
  MAX_LABEL_CODE_BYTES,
  MAX_LABEL_CODE_COMMANDS,
  MAX_LABEL_CODE_ELEMENTS,
  parseLabelCode,
} from "./labels/import.js";
export type {
  LabelCodeLanguage,
  LabelImportResult,
  LabelImportWarning,
  LabelImportWarningCode,
  ParseLabelCodeOptions,
} from "./labels/import.js";
export { parseZplLabel } from "./labels/zpl-import.js";
export { parseTsplLabel } from "./labels/tspl-import.js";
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
export { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "./barcodes/svg.js";
export {
  deriveDigestB64,
  formatPhc,
  isCanonicalDigestB64,
  parsePhc,
  PHC_ITERATIONS,
  verifyPhc,
} from "./crypto/phc.js";
export type { ParsedPhc } from "./crypto/phc.js";
export { MAX_BOX_CLOSURES_PER_SYNC_BATCH } from "./sync/limits.js";
export {
  isShiftCloseReasonCode,
  SHIFT_CLOSE_REASON_CODES,
  shiftCloseReasonRequired,
} from "./shift-close.js";
export type { ShiftCloseReasonCode } from "./shift-close.js";
export {
  CABINET_CAPABILITY,
  hasCabinetCapabilities,
  resolveCabinetAccess,
} from "./access/cabinet.js";
export type { CabinetCapability, CabinetRole, ResolvedCabinetAccess } from "./access/cabinet.js";
export {
  getShiftExportFormat,
  renderShiftExport,
  sanitizeShiftExportFilenameSegment,
  SHIFT_EXPORT_FORMATS,
  ShiftExportDomainError,
} from "./shift-exports.js";
export type {
  RenderShiftExportInput,
  ShiftExportBoxMode,
  ShiftExportDomainErrorCode,
  ShiftExportFormatDescriptor,
  ShiftExportFormatId,
  ShiftExportPart,
  ShiftExportSource,
} from "./shift-exports.js";
