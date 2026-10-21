import { ApiRequestError } from "../../api/client.js";

export type LeadOperation = "update" | "contacted" | "link" | "createTenant" | "anonymize";

const COMMON_ERROR_KEYS: Readonly<Record<string, string>> = {
  lead_not_found: "leads.errors.lead_not_found",
  lead_anonymized: "leads.errors.lead_anonymized",
};

// Tenant provisioning answers the create action with its own codes; the rest
// of the tenant vocabulary stays generic, like `tenants/errorMessages.ts`.
const TENANT_ERROR_KEYS: Readonly<Record<string, string>> = {
  lead_tenant_not_found: "leads.errors.lead_tenant_not_found",
  lead_tenant_slug_taken: "leads.errors.lead_tenant_slug_taken",
  tenant_not_found: "leads.errors.lead_tenant_not_found",
  tenant_cabinet_access_mismatch: "leads.errors.tenant_cabinet_access_mismatch",
};

const FALLBACK_KEYS: Record<LeadOperation, string> = {
  update: "leads.errors.update_failed",
  contacted: "leads.errors.contacted_failed",
  link: "leads.errors.link_failed",
  createTenant: "leads.errors.create_tenant_failed",
  anonymize: "leads.errors.anonymize_failed",
};

export function leadErrorMessageKey(operation: LeadOperation, error: unknown): string {
  const code = error instanceof ApiRequestError && error.kind === "domain" ? error.code : null;
  const tenantKeys = operation === "link" || operation === "createTenant" ? TENANT_ERROR_KEYS : {};
  return (
    (code ? (COMMON_ERROR_KEYS[code] ?? tenantKeys[code]) : undefined) ?? FALLBACK_KEYS[operation]
  );
}
