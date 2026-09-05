export const TRACEABILITY_LOCATION_ROLES = [
  "supplier",
  "processor",
  "ship_from",
  "receive_at",
  "recipient",
  "tlc_source",
] as const;

export type TraceabilityLocationRole = (typeof TRACEABILITY_LOCATION_ROLES)[number];

export interface LocationDescriptionInput {
  businessName: string;
  phoneNumber: string | null;
  addressKind: "street" | "coordinates";
  streetAddress: string | null;
  latitude: string | null;
  longitude: string | null;
  city: string | null;
  stateOrRegion: string | null;
  zipOrPostalCode: string | null;
  countryCode: string | null;
}

export type LocationDescriptionIssue = {
  field: keyof LocationDescriptionInput;
  code: "required" | "format";
};

export interface LocationDescriptionSnapshot {
  schemaVersion: 1;
  locationId: string;
  partyId: string;
  businessName: string;
  phoneNumber: string;
  address:
    | { kind: "street"; streetAddress: string }
    | { kind: "coordinates"; latitude: string; longitude: string };
  city: string;
  stateOrRegion: string;
  zipOrPostalCode: string;
  countryCode: string;
  countryDisplay: string;
}

const PHONE_PATTERN = /^[\d\s+().,-]*(?:(?:x|ext)[\d\s+().,-]*)?$/i;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const PLAIN_DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;

function isNonblank(value: string): boolean {
  return value.trim().length > 0;
}

function isCoordinate(value: string, minimum: number, maximum: number): boolean {
  if (!PLAIN_DECIMAL_PATTERN.test(value)) return false;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= minimum && numericValue <= maximum;
}

function isPhoneNumber(value: string): boolean {
  return value.length >= 3 && value.length <= 40 && /\d/.test(value) && PHONE_PATTERN.test(value);
}

export function validateLocationDescription(
  input: LocationDescriptionInput,
  mode: "draft" | "export_ready",
): LocationDescriptionIssue[] {
  const issues: LocationDescriptionIssue[] = [];
  const required = mode === "export_ready";

  if (!isNonblank(input.businessName)) {
    issues.push({ field: "businessName", code: "required" });
  }

  if (input.phoneNumber === null) {
    if (required) issues.push({ field: "phoneNumber", code: "required" });
  } else if (!isPhoneNumber(input.phoneNumber)) {
    issues.push({ field: "phoneNumber", code: "format" });
  }

  if (input.addressKind === "street") {
    if (input.streetAddress === null) {
      if (required) issues.push({ field: "streetAddress", code: "required" });
    } else if (!isNonblank(input.streetAddress)) {
      issues.push({ field: "streetAddress", code: "format" });
    }
    if (input.latitude !== null) issues.push({ field: "latitude", code: "format" });
    if (input.longitude !== null) issues.push({ field: "longitude", code: "format" });
  } else {
    if (input.streetAddress !== null) {
      issues.push({ field: "streetAddress", code: "format" });
    }
    if (input.latitude === null) {
      if (required) issues.push({ field: "latitude", code: "required" });
    } else if (!isCoordinate(input.latitude, -90, 90)) {
      issues.push({ field: "latitude", code: "format" });
    }
    if (input.longitude === null) {
      if (required) issues.push({ field: "longitude", code: "required" });
    } else if (!isCoordinate(input.longitude, -180, 180)) {
      issues.push({ field: "longitude", code: "format" });
    }
  }

  for (const field of ["city", "stateOrRegion", "zipOrPostalCode"] as const) {
    const value = input[field];
    if (value === null) {
      if (required) issues.push({ field, code: "required" });
    } else if (!isNonblank(value)) {
      issues.push({ field, code: "format" });
    }
  }

  if (input.countryCode === null) {
    if (required) issues.push({ field: "countryCode", code: "required" });
  } else if (!COUNTRY_CODE_PATTERN.test(input.countryCode)) {
    issues.push({ field: "countryCode", code: "format" });
  }

  return issues;
}

const COUNTRY_DISPLAY: Readonly<Record<string, string>> = {
  US: "United States",
  CA: "Canada",
  MX: "Mexico",
};

/**
 * Precondition: the caller has validated `id` and `partyId` as UUIDs. This
 * builder validates description completeness and format, not identity.
 */
export function buildLocationDescriptionSnapshot(
  location: LocationDescriptionInput & { id: string; partyId: string },
):
  | { ok: true; snapshot: LocationDescriptionSnapshot }
  | { ok: false; issues: LocationDescriptionIssue[] } {
  const issues = validateLocationDescription(location, "export_ready");
  if (issues.length > 0) return { ok: false, issues };

  const { phoneNumber, city, stateOrRegion, zipOrPostalCode, countryCode } = location;
  if (
    phoneNumber === null ||
    city === null ||
    stateOrRegion === null ||
    zipOrPostalCode === null ||
    countryCode === null
  ) {
    return { ok: false, issues: validateLocationDescription(location, "export_ready") };
  }

  let address: LocationDescriptionSnapshot["address"];
  if (location.addressKind === "street") {
    if (location.streetAddress === null) {
      return { ok: false, issues: validateLocationDescription(location, "export_ready") };
    }
    address = { kind: "street", streetAddress: location.streetAddress };
  } else {
    if (location.latitude === null || location.longitude === null) {
      return { ok: false, issues: validateLocationDescription(location, "export_ready") };
    }
    address = {
      kind: "coordinates",
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }

  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      locationId: location.id,
      partyId: location.partyId,
      businessName: location.businessName,
      phoneNumber,
      address,
      city,
      stateOrRegion,
      zipOrPostalCode,
      countryCode,
      countryDisplay: COUNTRY_DISPLAY[countryCode] ?? countryCode,
    },
  };
}
