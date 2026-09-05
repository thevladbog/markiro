/** P0 vocabulary only. Units are explicit; no conversion or equivalence is inferred. */
export const UOM_CODES_V1 = Object.freeze([
  "lb",
  "oz",
  "kg",
  "g",
  "each",
  "case",
  "bag",
  "cup",
  "gal",
  "l",
] as const);
export type TraceabilityUom = (typeof UOM_CODES_V1)[number];

export function isTraceabilityUom(value: string): value is TraceabilityUom {
  return UOM_CODES_V1.some((unit) => unit === value);
}
