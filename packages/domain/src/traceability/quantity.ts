import { DomainError } from "../errors.js";

/** Entry validation for numeric(18,3). No rounding, binary floating point or UOM conversion. */
export function parseTraceabilityQuantity(value: string): string {
  const quantity = value.trim();
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/.test(quantity) || !/[1-9]/.test(quantity)) {
    throw new DomainError(
      "QUANTITY_INVALID",
      "Expected a positive decimal with at most three fractional digits.",
    );
  }
  return quantity;
}
