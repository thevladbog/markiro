export { gs1CheckDigit, hasValidCheckDigit } from "./gs1/check-digit.js";
export { DomainError } from "./errors.js";
export { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "./gs1/gtin.js";
export { canonicalizeKm, kmHash, kmKey, MAX_KM_UTF8_BYTES, parseKm } from "./gs1/km.js";
export type { ParsedKm } from "./gs1/km.js";
export {
  buildSscc,
  formatSsccHri,
  formatSsccWithAi,
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
  labelFieldDisplayValue,
  mmToDots,
  parseLabelTemplate,
  ptToDots,
  QTY_UNIT_SUFFIX,
  sampleLabelData,
} from "./labels/model.js";
export { formatLabelDate, LABEL_DATE_FORMAT } from "./labels/date.js";
export {
  code128ModuleCount,
  CODE128_FNC1_MODULES,
  CODE128_FRAME_MODULES,
  CODE128_SYMBOL_MODULES,
  EAN13_MODULES,
  GS1_128_QUIET_ZONE_MODULES,
} from "./labels/code128.js";
export { DEFAULT_BOX_LABEL_TEMPLATE_NAME, buildDefaultLabelTemplates } from "./labels/defaults.js";
export type { DefaultLabelTemplate } from "./labels/defaults.js";
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
export type { RasterizeTextOptions } from "./labels/raster-types.js";
export {
  AVG_CHAR_WIDTH_EM,
  clipWithEllipsis,
  estimatedLineCount,
  estimatedTextWidthMm,
  LINE_HEIGHT_EM,
  ptToMm,
  wrapTextToWidth,
  WRAP_ELLIPSIS,
} from "./labels/wrap.js";
export {
  BAR_WIDTH_PER_CHAR_FACTOR,
  elementBoundsMm,
  INTERIOR_MODULES,
  QUIET_ZONE_MODULES,
  TOTAL_MODULES,
} from "./labels/bounds.js";
export type { BoundsMm } from "./labels/bounds.js";
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
export { formatShiftNumber, shiftMonthKey } from "./shift-number.js";
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
