import { DomainError } from "../errors.js";
import { parseTraceabilityProfile, type TraceabilityProfileCode } from "./profile.js";

export type DeploymentEdition = "RU" | "US";

const EDITION_PROFILES: Readonly<Record<DeploymentEdition, readonly TraceabilityProfileCode[]>> =
  Object.freeze({
    RU: Object.freeze(["RU_CHZ"] as const),
    US: Object.freeze(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const),
  });

/** Read only from trusted server/build configuration, never a tenant request. */
export function parseDeploymentEdition(value: unknown): DeploymentEdition {
  if (value === "RU" || value === "US") return value;
  throw new DomainError("invalid_deployment_edition", "An explicit RU or US edition is required.");
}

export function allowedProfiles(edition: DeploymentEdition): readonly TraceabilityProfileCode[] {
  return EDITION_PROFILES[parseDeploymentEdition(edition)];
}

export function assertProfileAllowed(
  edition: DeploymentEdition,
  value: unknown,
): asserts value is TraceabilityProfileCode {
  const profiles = allowedProfiles(edition);
  const profile = parseTraceabilityProfile(value);
  if (!profiles.includes(profile)) {
    throw new DomainError(
      "profile_not_allowed_in_edition",
      "The traceability profile is not allowed in this deployment edition.",
    );
  }
}
