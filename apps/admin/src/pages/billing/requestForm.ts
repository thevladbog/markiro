export const BILLING_REQUEST_TYPES = [
  "renewal",
  "capacity_change",
  "additional_service",
  "documents",
  "other",
] as const;

export type BillingRequestType = (typeof BILLING_REQUEST_TYPES)[number];

export interface BillingRequestFormValues {
  type: BillingRequestType;
  description: string;
  desiredAt: string;
  contextType: string;
  contextId: string;
  files: File[];
}

export interface BillingRequestFormErrors {
  description?: "required" | "tooLong";
  desiredAt?: "invalid";
  files: Array<{ fileName: string; reason: "type" | "size" }>;
}

export interface BillingRequestContext {
  type: "limit" | "subscription" | "invoice" | "offer" | "document";
  id: string;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const LIMIT_CONTEXT_IDS = new Set(["lines", "stations", "kiosks", "cabinetUsers"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBillingRequestType(value: string | null): value is BillingRequestType {
  return BILLING_REQUEST_TYPES.some((type) => type === value);
}

export function contextFromSearch(params: URLSearchParams): BillingRequestContext | null {
  const type = params.get("contextType");
  const id = params.get("contextId");
  if (!type || !id) return null;
  if (type === "limit") return LIMIT_CONTEXT_IDS.has(id) ? { type, id } : null;
  if (
    (type === "subscription" || type === "invoice" || type === "offer" || type === "document") &&
    UUID.test(id)
  ) {
    return { type, id };
  }
  return null;
}

export function validCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function desiredAtIso(value: string): string | undefined {
  return value && validCivilDate(value) ? `${value}T00:00:00.000Z` : undefined;
}

export function validateBillingRequestForm(
  values: BillingRequestFormValues,
): BillingRequestFormErrors {
  const description = values.description.trim();
  const errors: BillingRequestFormErrors = { files: [] };
  if (description.length === 0) errors.description = "required";
  else if (description.length > 4000) errors.description = "tooLong";
  if (values.desiredAt && !validCivilDate(values.desiredAt)) errors.desiredAt = "invalid";
  for (const file of values.files) {
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      errors.files.push({ fileName: file.name, reason: "type" });
    }
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      errors.files.push({ fileName: file.name, reason: "size" });
    }
  }
  return errors;
}

export function hasBillingRequestFormErrors(errors: BillingRequestFormErrors): boolean {
  return Boolean(errors.description || errors.desiredAt || errors.files.length > 0);
}
