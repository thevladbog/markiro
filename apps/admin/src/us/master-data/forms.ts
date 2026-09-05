import {
  createUsLocationSchema,
  createUsPartySchema,
  type CreateUsLocation,
  type CreateUsParty,
  type UpdateUsLocation,
} from "@markiro/platform-contracts";
import {
  TRACEABILITY_LOCATION_ROLES,
  validateLocationDescription,
  type LocationDescriptionInput,
  type TraceabilityLocationRole,
} from "@markiro/domain";

export type FormErrorCode = "required" | "format";
export type FormErrors = Record<string, FormErrorCode>;

export type PartyFormValues = {
  name: string;
  legalName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
};

export type LocationFormValues = {
  partyId: string;
  name: string;
  businessName: string;
  phoneNumber: string;
  addressKind: "street" | "coordinates";
  streetAddress: string;
  latitude: string;
  longitude: string;
  city: string;
  stateOrRegion: string;
  zipOrPostalCode: string;
  countryCode: string;
  roles: TraceabilityLocationRole[];
};

export const locationRoles = TRACEABILITY_LOCATION_ROLES;

export function emptyPartyForm(): PartyFormValues {
  return {
    name: "",
    legalName: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
    notes: "",
  };
}

export function emptyLocationForm(): LocationFormValues {
  return {
    partyId: "",
    name: "",
    businessName: "",
    phoneNumber: "",
    addressKind: "street",
    streetAddress: "",
    latitude: "",
    longitude: "",
    city: "",
    stateOrRegion: "",
    zipOrPostalCode: "",
    countryCode: "US",
    roles: [],
  };
}

function nullable(value: string): string | null {
  return value.trim() ? value : null;
}

function formErrors(
  issues: readonly { path: PropertyKey[]; code: string }[],
  values: Record<string, unknown>,
): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || errors[field]) continue;
    const value = values[field];
    errors[field] =
      value === null || (typeof value === "string" && !value.trim()) ? "required" : "format";
  }
  return errors;
}

export function parsePartyForm(
  form: PartyFormValues,
): { ok: true; value: CreateUsParty } | { ok: false; errors: FormErrors } {
  const normalized = {
    name: form.name,
    legalName: nullable(form.legalName),
    contactName: nullable(form.contactName),
    contactPhone: nullable(form.contactPhone),
    contactEmail: nullable(form.contactEmail),
    notes: nullable(form.notes),
  };
  const result = createUsPartySchema.safeParse(normalized);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: formErrors(result.error.issues, normalized) };
}

function normalizedLocation(form: LocationFormValues): CreateUsLocation {
  return {
    partyId: form.partyId,
    name: form.name,
    businessName: form.businessName,
    phoneNumber: nullable(form.phoneNumber),
    addressKind: form.addressKind,
    streetAddress: form.addressKind === "street" ? nullable(form.streetAddress) : null,
    latitude: form.addressKind === "coordinates" ? nullable(form.latitude) : null,
    longitude: form.addressKind === "coordinates" ? nullable(form.longitude) : null,
    city: nullable(form.city),
    stateOrRegion: nullable(form.stateOrRegion),
    zipOrPostalCode: nullable(form.zipOrPostalCode),
    countryCode: nullable(form.countryCode),
    roles: form.roles,
  };
}

export function parseLocationForm(
  form: LocationFormValues,
  mode: "create" | "edit",
): { ok: true; value: CreateUsLocation | UpdateUsLocation } | { ok: false; errors: FormErrors } {
  const result = createUsLocationSchema.safeParse(normalizedLocation(form));
  if (!result.success)
    return { ok: false, errors: formErrors(result.error.issues, normalizedLocation(form)) };
  if (mode === "create") return { ok: true, value: result.data };
  const editable: UpdateUsLocation = {
    name: result.data.name,
    businessName: result.data.businessName,
    phoneNumber: result.data.phoneNumber,
    addressKind: result.data.addressKind,
    streetAddress: result.data.streetAddress,
    latitude: result.data.latitude,
    longitude: result.data.longitude,
    city: result.data.city,
    stateOrRegion: result.data.stateOrRegion,
    zipOrPostalCode: result.data.zipOrPostalCode,
    countryCode: result.data.countryCode,
    roles: result.data.roles,
  };
  return { ok: true, value: editable };
}

export function locationDescriptionGaps(form: LocationFormValues): string[] {
  const normalized = normalizedLocation(form);
  const input: LocationDescriptionInput = {
    businessName: normalized.businessName,
    phoneNumber: normalized.phoneNumber,
    addressKind: normalized.addressKind,
    streetAddress: normalized.streetAddress,
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    city: normalized.city,
    stateOrRegion: normalized.stateOrRegion,
    zipOrPostalCode: normalized.zipOrPostalCode,
    countryCode: normalized.countryCode,
  };
  return validateLocationDescription(input, "export_ready")
    .filter((issue) => issue.code === "required")
    .map((issue) => issue.field);
}
