import {
  assignableCatalogResponseSchema,
  assignAddonSchema,
  assignPlanSchema,
  createTenantSchema,
  platformTenantContracts,
  platformTenantIdSchema,
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
  return platformApiFetch(`/tenants?${params.toString()}`, platformTenantContracts.list.response);
}

export async function createTenant(input: CreateTenantInput) {
  const validated = createTenantSchema.parse(input);
  return platformApiFetch("/tenants", platformTenantContracts.create.response, {
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function getTenant(tenantId: string): Promise<TenantDetail> {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/tenants/${validatedId}`, platformTenantContracts.detail.response);
}

export async function renewOwnerActivation(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(
    `/tenants/${validatedId}/owner-activation/renew`,
    platformTenantContracts.renewActivation.response,
    { method: "POST", body: "{}" },
  );
}

export async function listAssignableCatalogVersions() {
  return platformApiFetch("/catalog/items", assignableCatalogResponseSchema);
}

export async function assignTenantPlan(tenantId: string, input: AssignPlanInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignPlanSchema.parse(input);
  return platformApiFetch(
    `/tenants/${validatedId}/subscription/plan`,
    platformTenantContracts.assignPlan.response,
    { method: "POST", body: JSON.stringify(validated) },
  );
}

export async function assignTenantAddon(tenantId: string, input: AssignAddonInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignAddonSchema.parse(input);
  return platformApiFetch(
    `/tenants/${validatedId}/subscription/addons`,
    platformTenantContracts.assignAddon.response,
    { method: "POST", body: JSON.stringify(validated) },
  );
}
