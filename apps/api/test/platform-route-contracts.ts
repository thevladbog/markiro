import {
  platformAuditContracts,
  platformAuthContracts,
  platformCatalogContracts,
  platformCommercialContracts,
  platformTeamContracts,
  platformTenantContracts,
} from "@markiro/platform-contracts";
import type { ZodType } from "zod";

export type PlatformHttpMethod = "get" | "post" | "patch";
export type PlatformSuccessStatus = "200" | "201";

export interface PlatformRouteContract {
  method: PlatformHttpMethod;
  path: string;
  status: PlatformSuccessStatus;
  response: ZodType;
  body?: ZodType;
  public?: true;
}

const route = (
  method: PlatformHttpMethod,
  path: string,
  status: PlatformSuccessStatus,
  response: ZodType,
  options: Pick<PlatformRouteContract, "body" | "public"> = {},
): PlatformRouteContract => ({ method, path, status, response, ...options });

export const CURRENT_SAAS_ROUTES = [
  route("get", "/platform/me", "200", platformAuthContracts.me.response),
  route(
    "post",
    "/platform/activation/complete",
    "201",
    platformAuthContracts.activationComplete.response,
    { body: platformAuthContracts.activationComplete.body, public: true },
  ),
  route("get", "/platform/team", "200", platformTeamContracts.list.response),
  route("post", "/platform/team", "201", platformTeamContracts.invite.response, {
    body: platformTeamContracts.invite.body,
  }),
  route("patch", "/platform/team/{id}/role", "200", platformTeamContracts.changeRole.response, {
    body: platformTeamContracts.changeRole.body,
  }),
  route("post", "/platform/team/{id}/suspend", "201", platformTeamContracts.suspend.response),
  route(
    "post",
    "/platform/team/{id}/activation/renew",
    "201",
    platformTeamContracts.renewActivation.response,
  ),
  route(
    "post",
    "/platform/team/{id}/2fa/recover",
    "201",
    platformTeamContracts.recoverTwoFactor.response,
  ),
  route("get", "/platform/audit", "200", platformAuditContracts.list.response),
  route("get", "/platform/tenants", "200", platformTenantContracts.list.response),
  route("post", "/platform/tenants", "201", platformTenantContracts.create.response, {
    body: platformTenantContracts.create.body,
  }),
  route("get", "/platform/tenants/{id}", "200", platformTenantContracts.detail.response),
  route(
    "post",
    "/platform/tenants/{id}/owner-activation/renew",
    "200",
    platformTenantContracts.renewActivation.response,
  ),
  route(
    "post",
    "/platform/tenants/{id}/subscription/plan",
    "201",
    platformTenantContracts.assignPlan.response,
    { body: platformTenantContracts.assignPlan.body },
  ),
  route(
    "post",
    "/platform/tenants/{id}/subscription/addons",
    "201",
    platformTenantContracts.assignAddon.response,
    { body: platformTenantContracts.assignAddon.body },
  ),
  route("get", "/platform/catalog/items", "200", platformCatalogContracts.list.response),
  route(
    "get",
    "/platform/catalog/items/{id}/versions",
    "200",
    platformCatalogContracts.listVersions.response,
  ),
  route(
    "get",
    "/platform/catalog/items/{id}/versions/{versionId}",
    "200",
    platformCatalogContracts.getVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions",
    "201",
    platformCatalogContracts.createVersion.response,
    { body: platformCatalogContracts.createVersion.body },
  ),
  route(
    "patch",
    "/platform/catalog/items/{id}/versions/{versionId}",
    "200",
    platformCatalogContracts.updateVersion.response,
    { body: platformCatalogContracts.updateVersion.body },
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions/{versionId}/publish",
    "200",
    platformCatalogContracts.publishVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/versions/{versionId}/retire",
    "200",
    platformCatalogContracts.retireVersion.response,
  ),
  route(
    "post",
    "/platform/catalog/items/{id}/archive",
    "200",
    platformCatalogContracts.archiveItem.response,
  ),
  route(
    "get",
    "/platform/settings/demo-plan",
    "200",
    platformCatalogContracts.getDefaultDemo.response,
  ),
  route(
    "patch",
    "/platform/settings/demo-plan",
    "200",
    platformCatalogContracts.setDefaultDemo.response,
    { body: platformCatalogContracts.setDefaultDemo.body },
  ),
  route("get", "/platform/offers", "200", platformCommercialContracts.offers.list.response),
  route("get", "/platform/offers/{id}", "200", platformCommercialContracts.offers.detail.response),
  route("post", "/platform/offers", "201", platformCommercialContracts.offers.create.response, {
    body: platformCommercialContracts.offers.create.body,
  }),
  route(
    "post",
    "/platform/offers/{id}/publish",
    "200",
    platformCommercialContracts.offers.publish.response,
  ),
  route(
    "get",
    "/platform/offers/{id}/documents",
    "200",
    platformCommercialContracts.offers.documents.list.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/documents",
    "201",
    platformCommercialContracts.offers.documents.render.response,
  ),
  route(
    "get",
    "/platform/offers/{id}/documents/{documentId}/download",
    "200",
    platformCommercialContracts.offers.documents.download.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/cancel",
    "200",
    platformCommercialContracts.offers.cancel.response,
  ),
  route(
    "post",
    "/platform/offers/{id}/payment",
    "201",
    platformCommercialContracts.offers.payment.response,
    { body: platformCommercialContracts.offers.payment.body },
  ),
  route("get", "/platform/invoices", "200", platformCommercialContracts.invoices.list.response),
  route(
    "get",
    "/platform/invoices/{id}",
    "200",
    platformCommercialContracts.invoices.detail.response,
  ),
  route("post", "/platform/invoices", "201", platformCommercialContracts.invoices.create.response, {
    body: platformCommercialContracts.invoices.create.body,
  }),
  route(
    "post",
    "/platform/invoices/{id}/issue",
    "201",
    platformCommercialContracts.invoices.issue.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/document",
    "201",
    platformCommercialContracts.invoices.document.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/documents",
    "200",
    platformCommercialContracts.invoices.documents.list.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/documents",
    "201",
    platformCommercialContracts.invoices.documents.render.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/document",
    "200",
    platformCommercialContracts.invoices.documentUrl.response,
  ),
  route(
    "get",
    "/platform/invoices/{id}/documents/{documentId}/download",
    "200",
    platformCommercialContracts.invoices.documents.download.response,
  ),
  route(
    "post",
    "/platform/invoices/{id}/apply",
    "201",
    platformCommercialContracts.invoices.apply.response,
    { body: platformCommercialContracts.invoices.apply.body },
  ),
  route(
    "post",
    "/platform/invoices/{id}/cancel",
    "201",
    platformCommercialContracts.invoices.cancel.response,
  ),
  route("get", "/platform/payments", "200", platformCommercialContracts.payments.list.response),
  route(
    "post",
    "/platform/payments/invoices/{invoiceId}",
    "201",
    platformCommercialContracts.payments.manual.response,
    { body: platformCommercialContracts.payments.manual.body },
  ),
  route(
    "post",
    "/platform/payments/imports",
    "201",
    platformCommercialContracts.payments.import.response,
    { body: platformCommercialContracts.payments.import.body },
  ),
] as const satisfies readonly PlatformRouteContract[];

export const CURRENT_SAAS_ROUTE_KEYS = CURRENT_SAAS_ROUTES.map(
  ({ method, path }) => `${method.toUpperCase()} ${path}`,
).sort();
