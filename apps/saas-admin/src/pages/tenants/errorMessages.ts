import { ApiRequestError } from "../../api/client.js";

type TenantOperation = "create" | "renew" | "plan" | "addon";

const CREATE_ERROR_KEYS: Readonly<Record<string, string>> = {
  tenant_owner_email_conflict: "tenants.errors.tenant_owner_email_conflict",
  tenant_email_conflict: "tenants.errors.tenant_email_conflict",
  tenant_first_owner_conflict: "tenants.errors.tenant_first_owner_conflict",
  tenant_first_member_not_owner: "tenants.errors.tenant_first_member_not_owner",
  default_demo_not_configured: "tenants.errors.default_demo_not_configured",
};

const RENEW_ERROR_KEYS: Readonly<Record<string, string>> = {
  activation_delivery_sending: "tenants.errors.activation_delivery_sending",
  activation_delivery_changed: "tenants.errors.activation_delivery_changed",
  owner_already_activated: "tenants.errors.owner_already_activated",
};

const ASSIGNMENT_ERROR_KEYS: Readonly<Record<string, string>> = {
  subscription_schedule_exists: "tenants.errors.subscription_schedule_exists",
  subscription_compatible_plan_required: "tenants.errors.subscription_compatible_plan_required",
  published_catalog_version_required: "tenants.errors.published_catalog_version_required",
  effective_at_out_of_range: "tenants.errors.effective_at_out_of_range",
  subscription_term_out_of_range: "tenants.errors.subscription_term_out_of_range",
  subscription_term_already_ended: "tenants.errors.subscription_term_already_ended",
  subscription_current_end_required: "tenants.errors.subscription_current_end_required",
  subscription_start_required: "tenants.errors.subscription_start_required",
  addon_precedes_subscription_term: "tenants.errors.addon_precedes_subscription_term",
  addon_exceeds_subscription_term: "tenants.errors.addon_exceeds_subscription_term",
  subscription_timeline_changed: "tenants.errors.subscription_timeline_changed",
  subscription_addon_timeline_changed: "tenants.errors.subscription_addon_timeline_changed",
};

const FALLBACK_KEYS: Record<TenantOperation, string> = {
  create: "tenants.errors.create_failed",
  renew: "tenants.errors.renew_failed",
  plan: "tenants.errors.assignment_failed",
  addon: "tenants.errors.assignment_failed",
};

export function tenantErrorMessageKey(operation: TenantOperation, error: unknown): string {
  const code = error instanceof ApiRequestError && error.kind === "domain" ? error.code : null;
  const allowed =
    operation === "create"
      ? CREATE_ERROR_KEYS
      : operation === "renew"
        ? RENEW_ERROR_KEYS
        : ASSIGNMENT_ERROR_KEYS;
  return (code ? allowed[code] : undefined) ?? FALLBACK_KEYS[operation];
}
