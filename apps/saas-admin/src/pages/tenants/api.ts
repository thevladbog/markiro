import {
  assignAddonSchema,
  assignPlanSchema,
  createTenantSchema,
  platformTenantContracts,
  platformTenantIdSchema,
  platformCatalogContracts,
  platformCommercialContracts,
  type AssignableCatalogVersion,
  type AssignAddonInput,
  type AssignPlanInput,
  type CreateTenantInput,
  type DetailPlanVersion,
  type TenantDetail,
  type TenantListItem,
  type TenantListQuery,
  type TenantListResponse,
  type TenantSubscription,
  type TenantSubscriptionAddon,
  type TenantSubscriptionStatus,
  type BankAccountArchiveInput,
  type BankAccountInput,
  type BillingProfileInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export {
  assignAddonSchema as assignAddonInputSchema,
  assignPlanSchema as assignPlanInputSchema,
  createTenantSchema as createTenantInputSchema,
  platformTenantIdSchema as tenantIdSchema,
};
export type {
  AssignableCatalogVersion,
  AssignAddonInput,
  AssignPlanInput,
  CreateTenantInput,
  DetailPlanVersion,
  TenantDetail,
  TenantListItem,
  TenantListResponse,
  TenantSubscription,
  TenantSubscriptionAddon,
  TenantSubscriptionStatus,
};

export async function listTenants(query: TenantListQuery): Promise<TenantListResponse> {
  const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
  if (query.status) params.set("status", query.status);
  return platformApiFetch(`/tenants?${params.toString()}`, {
    responseSchema: platformTenantContracts.list.response,
  });
}

export async function createTenant(input: CreateTenantInput) {
  const validated = createTenantSchema.parse(input);
  return platformApiFetch("/tenants", {
    responseSchema: platformTenantContracts.create.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function getTenant(tenantId: string): Promise<TenantDetail> {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/tenants/${validatedId}`, {
    responseSchema: platformTenantContracts.detail.response,
  });
}

export async function renewOwnerActivation(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/tenants/${validatedId}/owner-activation/renew`, {
    responseSchema: platformTenantContracts.renewActivation.response,
    method: "POST",
    body: "{}",
  });
}

export async function listAssignableCatalogVersions() {
  return platformApiFetch("/catalog/items", {
    responseSchema: platformCatalogContracts.list.response,
  });
}

export async function assignTenantPlan(tenantId: string, input: AssignPlanInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignPlanSchema.parse(input);
  return platformApiFetch(`/tenants/${validatedId}/subscription/plan`, {
    responseSchema: platformTenantContracts.assignPlan.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function assignTenantAddon(tenantId: string, input: AssignAddonInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignAddonSchema.parse(input);
  return platformApiFetch(`/tenants/${validatedId}/subscription/addons`, {
    responseSchema: platformTenantContracts.assignAddon.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function getTenantBillingProfile(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/profile`, {
    responseSchema: platformCommercialContracts.billingProfiles.tenant.get.response,
  });
}

export async function setTenantBillingProfile(tenantId: string, input: BillingProfileInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/profile`, {
    responseSchema: platformCommercialContracts.billingProfiles.tenant.set.response,
    method: "PUT",
    body: JSON.stringify(platformCommercialContracts.billingProfiles.tenant.set.body.parse(input)),
  });
}

export async function listTenantBankAccounts(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/accounts`, {
    responseSchema: platformCommercialContracts.billingAccounts.tenant.list.response,
  });
}

export async function createTenantBankAccount(tenantId: string, input: BankAccountInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/accounts`, {
    responseSchema: platformCommercialContracts.billingAccounts.tenant.create.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialContracts.billingAccounts.tenant.create.body.parse(input),
    ),
  });
}

export async function setTenantDefaultBankAccount(tenantId: string, accountId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/accounts/${accountId}/default`, {
    responseSchema: platformCommercialContracts.billingAccounts.tenant.setDefault.response,
    method: "PATCH",
  });
}

export async function archiveTenantBankAccount(
  tenantId: string,
  accountId: string,
  input: BankAccountArchiveInput = {},
) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/billing/tenants/${validatedId}/accounts/${accountId}/archive`, {
    responseSchema: platformCommercialContracts.billingAccounts.tenant.archive.response,
    method: "POST",
    body: JSON.stringify(
      platformCommercialContracts.billingAccounts.tenant.archive.body.parse(input),
    ),
  });
}
