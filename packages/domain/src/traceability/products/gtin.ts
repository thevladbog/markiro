import { DomainError } from "../../errors.js";
import { isValidGtin, normalizeToGtin14 } from "../../gs1/gtin.js";
import { parseTraceabilityProfile } from "../profile.js";

/** Catalog data policy only; callers must enforce authorization separately. */
export function normalizeCatalogGtin(profile: unknown, input: unknown): string | null {
  const parsedProfile = parseTraceabilityProfile(profile);

  if (input === null || input === undefined) {
    if (
      parsedProfile === "US_FSMA204_PROCESSOR" ||
      parsedProfile === "US_GENERIC_LOT_TRACEABILITY"
    ) {
      return null;
    }
    throw new DomainError("GTIN_REQUIRED", "GTIN is required.");
  }

  if (typeof input !== "string" || !isValidGtin(input)) {
    throw new DomainError("GTIN_INVALID", "GTIN is invalid.");
  }

  return normalizeToGtin14(input);
}
