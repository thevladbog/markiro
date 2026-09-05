import { DomainError } from "../../errors.js";

export const TLC_ASSIGNMENT_BASES = [
  "transformation",
  "initial_packing",
  "first_land_receiving",
  "exempt_supplier_receipt",
  "imported",
] as const;
export type TlcAssignmentBasis = (typeof TLC_ASSIGNMENT_BASES)[number];

export const P0_ASSIGNMENT_BASES = [
  "transformation",
  "exempt_supplier_receipt",
  "imported",
] as const;
export type P0TlcAssignmentBasis = (typeof P0_ASSIGNMENT_BASES)[number];
export type LotAssignmentContext = "manual" | "receiving" | "transformation";

/**
 * Operation vocabulary, not event finalization or permission checking. The caller
 * supplies the trusted context and still checks reuse of an existing supplier TLC,
 * source/location completeness, reviewed exemption basis and event lifecycle.
 */
export function assertLotAssignmentBasis(
  basis: unknown,
  context: unknown,
): asserts basis is P0TlcAssignmentBasis {
  if (context !== "manual" && context !== "receiving" && context !== "transformation") {
    throw new DomainError("ASSIGNMENT_CONTEXT_INVALID", "Unknown lot assignment operation.");
  }
  if (!TLC_ASSIGNMENT_BASES.some((value) => value === basis)) {
    throw new DomainError("ASSIGNMENT_BASIS_INVALID", "Unknown TLC assignment basis.");
  }
  if (basis === "initial_packing" || basis === "first_land_receiving") {
    throw new DomainError(
      "ASSIGNMENT_BASIS_RESERVED",
      "This assignment basis is not enabled in P0.",
    );
  }
  const allowed =
    (basis === "imported" && (context === "manual" || context === "receiving")) ||
    (basis === "exempt_supplier_receipt" && context === "receiving") ||
    (basis === "transformation" && context === "transformation");
  if (!allowed) {
    throw new DomainError(
      "ASSIGNMENT_BASIS_NOT_ALLOWED",
      "The assignment requires a different operation.",
    );
  }
}
