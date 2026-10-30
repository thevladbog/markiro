import { HostError } from "../../host/client.js";
import { errorMessageKey } from "../../host/errors.js";

const CREATION_REFUSALS = new Set([
  "org_gln_missing",
  "license_restricted",
  "feature_disabled",
  "restore_hold",
  "sscc_reserved",
]);
/** Explain expected operational refusals without exposing host constraint names. */
export function palletCreationFailureKey(error: unknown): string {
  if (
    error instanceof HostError &&
    error.code === "conflict" &&
    typeof error.details.constraint === "string" &&
    CREATION_REFUSALS.has(error.details.constraint)
  )
    return `office.createPallet.failures.${error.details.constraint}`;
  return errorMessageKey(error);
}
