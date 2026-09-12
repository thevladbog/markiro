import {
  entitlementSourceListSchema,
  entitlementSourcePreviewRequestSchema,
  entitlementSourcePreviewSchema,
  entitlementSourceConfirmSchema,
  entitlementSourceConfirmationSchema,
  type EntitlementSourcePreviewRequest,
  type EntitlementSourceConfirm,
  assignAddonSchema,
  assignPlanSchema,
  createTenantSchema,
  platformTenantV3Contracts,
  COMMERCIAL_VERSION_HEADER,
  platformTenantIdSchema,
  platformCatalogV3Contracts,
  platformCommercialContracts,
  type AssignableCatalogVersionV3 as AssignableCatalogVersion,
  type AssignAddonInput,
  type AssignPlanInput,
  type CreateTenantInput,
  type TenantDetailV3 as TenantDetail,
  type TenantListItem,
  type TenantListQuery,
  type TenantListResponse,
  type TenantSubscriptionV3 as TenantSubscription,
  type TenantSubscriptionAddonV3 as TenantSubscriptionAddon,
  type TenantSubscriptionStatus,
  type BankAccountArchiveInput,
  type BankAccountInput,
  type BillingProfileInput,
  platformDeviceLicensingContracts,
  cancelDeviceReservationSchema,
  type CancelDeviceReservation,
} from "@markiro/platform-contracts";

import { platformApiFetch, CURRENT_COMMERCIAL_VERSION } from "../../api/client.js";

export {
  assignAddonSchema as assignAddonInputSchema,
  assignPlanSchema as assignPlanInputSchema,
  createTenantSchema as createTenantInputSchema,
  platformTenantIdSchema as tenantIdSchema,
};
type DetailPlanVersion = TenantSubscription["planVersion"];

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
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.list.response,
  });
}

export async function createTenant(input: CreateTenantInput) {
  const validated = createTenantSchema.parse(input);
  return platformApiFetch("/tenants", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.create.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function getTenant(tenantId: string): Promise<TenantDetail> {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/tenants/${validatedId}`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.detail.response,
  });
}
export function getTenantDeviceLicensing(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(
    platformDeviceLicensingContracts.inspect.path.replace(":tenantId", validatedId),
    {
      responseSchema: platformDeviceLicensingContracts.inspect.response,
    },
  );
}
export function cancelTenantDeviceReservation(
  tenantId: string,
  deviceId: string,
  input: CancelDeviceReservation,
) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const body = cancelDeviceReservationSchema.parse(input);
  return platformApiFetch(
    platformDeviceLicensingContracts.cancelReservation.path
      .replace(":tenantId", validatedId)
      .replace(":deviceId", deviceId),
    {
      responseSchema: platformDeviceLicensingContracts.cancelReservation.response,
      method: platformDeviceLicensingContracts.cancelReservation.method,
      body: JSON.stringify(body),
    },
  );
}

export async function renewOwnerActivation(tenantId: string) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  return platformApiFetch(`/tenants/${validatedId}/owner-activation/renew`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.renewActivation.response,
    method: "POST",
    body: "{}",
  });
}

export async function listAssignableCatalogVersions() {
  return platformApiFetch("/catalog/items", {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformCatalogV3Contracts.list.response,
  });
}

export async function assignTenantPlan(tenantId: string, input: AssignPlanInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignPlanSchema.parse(input);
  return platformApiFetch(`/tenants/${validatedId}/subscription/plan`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.assignPlan.response,
    method: "POST",
    body: JSON.stringify(validated),
  });
}

export async function assignTenantAddon(tenantId: string, input: AssignAddonInput) {
  const validatedId = platformTenantIdSchema.parse(tenantId);
  const validated = assignAddonSchema.parse(input);
  return platformApiFetch(`/tenants/${validatedId}/subscription/addons`, {
    headers: { [COMMERCIAL_VERSION_HEADER]: CURRENT_COMMERCIAL_VERSION },
    responseSchema: platformTenantV3Contracts.assignAddon.response,
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

export function getTenantEntitlements(tenantId: string) {
  return platformApiFetch(`/tenants/${platformTenantIdSchema.parse(tenantId)}/entitlements`, {
    responseSchema: entitlementSourceListSchema,
  });
}
export function previewTenantEntitlementSource(
  tenantId: string,
  input: EntitlementSourcePreviewRequest,
) {
  return platformApiFetch(
    `/tenants/${platformTenantIdSchema.parse(tenantId)}/entitlements/preview`,
    {
      method: "POST",
      body: JSON.stringify(entitlementSourcePreviewRequestSchema.parse(input)),
      responseSchema: entitlementSourcePreviewSchema,
    },
  );
}
export function confirmTenantEntitlementSource(tenantId: string, input: EntitlementSourceConfirm) {
  return platformApiFetch(
    `/tenants/${platformTenantIdSchema.parse(tenantId)}/entitlements/confirm`,
    {
      method: "POST",
      body: JSON.stringify(entitlementSourceConfirmSchema.parse(input)),
      responseSchema: entitlementSourceConfirmationSchema,
    },
  );
}
