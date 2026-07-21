export { gs1CheckDigit, hasValidCheckDigit } from "./gs1/check-digit.js";
export { DomainError } from "./errors.js";
export { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "./gs1/gtin.js";
export { kmKey, parseKm } from "./gs1/km.js";
export type { ParsedKm } from "./gs1/km.js";
export { buildSscc, isValidSscc, ssccSerialCapacity } from "./gs1/sscc.js";
export { classifyScan } from "./scan/classify.js";
export type { ScanInput } from "./scan/classify.js";
