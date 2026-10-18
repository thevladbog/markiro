/**
 * The reasons of a box exception (stage 2a spec, decision 36), the same lists
 * as the host's (`markiro_proto::exception_reasons`, fixture
 * `proto/fixtures/exception-reasons.json`): codes, not words, so exports and
 * translations read them; words come only with `other`.
 */
export const REPRINT_REASONS = [
  "damaged_label",
  "unreadable_label",
  "printer_jam",
  "quality_request",
  "other",
] as const;
export type ReprintReason = (typeof REPRINT_REASONS)[number];

export const DISASSEMBLE_REASONS = [
  "wrong_product",
  "wrong_quantity",
  "damaged_package",
  "quality_rejected",
  "other",
] as const;
export type DisassembleReason = (typeof DISASSEMBLE_REASONS)[number];

/** The one reason that may carry words. */
export const OTHER_REASON = "other";

/** The longest words of `other`, in code points. */
export const MAX_REASON_TEXT_CHARS = 200;
