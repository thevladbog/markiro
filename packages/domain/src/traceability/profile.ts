import { DomainError } from "../errors.js";

export const TRACEABILITY_PROFILE_CODE = Object.freeze({
  RU_CHZ: "RU_CHZ",
  US_FSMA204_PROCESSOR: "US_FSMA204_PROCESSOR",
  US_GENERIC_LOT_TRACEABILITY: "US_GENERIC_LOT_TRACEABILITY",
} as const);

export type TraceabilityProfileCode =
  (typeof TRACEABILITY_PROFILE_CODE)[keyof typeof TRACEABILITY_PROFILE_CODE];

export type TraceabilityCte = "receiving" | "transformation" | "shipping";

export interface TraceabilityProfileFeatures {
  readonly traceability: boolean;
  readonly ftrClaims: boolean;
  readonly ruRegulatory: boolean;
  readonly cteSet: readonly TraceabilityCte[];
}

const PROCESSOR_CTES: readonly TraceabilityCte[] = Object.freeze([
  "receiving",
  "transformation",
  "shipping",
]);

const FEATURES: Readonly<Record<TraceabilityProfileCode, TraceabilityProfileFeatures>> =
  Object.freeze({
    RU_CHZ: Object.freeze({
      traceability: false,
      ftrClaims: false,
      ruRegulatory: true,
      cteSet: Object.freeze([]),
    }),
    US_FSMA204_PROCESSOR: Object.freeze({
      traceability: true,
      ftrClaims: true,
      ruRegulatory: false,
      cteSet: PROCESSOR_CTES,
    }),
    US_GENERIC_LOT_TRACEABILITY: Object.freeze({
      traceability: true,
      ftrClaims: false,
      ruRegulatory: false,
      cteSet: PROCESSOR_CTES,
    }),
  });

export function parseTraceabilityProfile(value: unknown): TraceabilityProfileCode {
  if (
    value === "RU_CHZ" ||
    value === "US_FSMA204_PROCESSOR" ||
    value === "US_GENERIC_LOT_TRACEABILITY"
  ) {
    return value;
  }
  throw new DomainError("invalid_traceability_profile", "Unknown traceability profile.");
}

/** Profile capability policy, not an assessment of a food's regulatory applicability. */
export function profileFeatures(profile: TraceabilityProfileCode): TraceabilityProfileFeatures {
  return FEATURES[parseTraceabilityProfile(profile)];
}
