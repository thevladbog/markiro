import type { Type } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import {
  ROUTE_SUBSCRIPTION_ACCESS_POLICY,
  type SubscriptionAccessPolicy,
} from "../src/subscriptions/subscription-access-policy";
import { CURRENT_SAAS_ROUTE_KEYS } from "./platform-route-contracts";

type RegisteredRoute = {
  controller: Type<unknown>;
  handler: (...args: never[]) => unknown;
  handlerName: string;
  method: RequestMethod;
  path: string;
};

const UNSAFE_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

type CustomerRouteContract = {
  guards: readonly string[];
  policy: SubscriptionAccessPolicy;
};

const CABINET_GUARDS = ["TenantGuard", "AuthorizationGuard", "SubscriptionAccessGuard"] as const;
const KIOSK_GUARDS = ["KioskDeviceGuard", "SubscriptionAccessGuard"] as const;
const STATION_GUARDS = ["TenantGuard", "StationOnlyGuard", "SubscriptionAccessGuard"] as const;
const CABINET_STATION_GUARDS = [...CABINET_GUARDS, "StationOnlyGuard"] as const;

const customerContract = (
  guards: readonly string[],
  policy: SubscriptionAccessPolicy,
): CustomerRouteContract => ({ guards, policy });

const CUSTOMER_ROUTE_GROUPS: readonly {
  contract: CustomerRouteContract;
  routes: readonly string[];
}[] = [
  {
    contract: customerContract(CABINET_GUARDS, { mode: "read_only_allowed", reason: "read" }),
    routes: [
      "GET /code-search (CodeSearchController.classify)",
      "GET /code-search/codes (CodeSearchController.listCodes)",
      "GET /code-search/codes/:codeHash (CodeSearchController.getCodeCard)",
      "GET /code-search/boxes/:boxId (CodeSearchController.getBoxCard)",
      "GET /code-search/boxes/:boxId/report (CodeSearchController.boxReport)",
      "GET /conflicts (ConflictsController.listConflicts)",
      "GET /counterparties (CounterpartiesController.listCounterparties)",
      "GET /counterparties/:id (CounterpartiesController.getCounterparty)",
      "GET /counterparties/:id/sscc (CounterpartiesController.getSscc)",
      "GET /disaggregation (DisaggregationController.list)",
      "GET /disaggregation-reasons (DisaggregationReasonsController.listReasons)",
      "GET /disaggregation/:id (DisaggregationController.get)",
      "GET /disaggregation/:id/report (DisaggregationController.report)",
      "GET /employees (EmployeesController.listEmployees)",
      "GET /employees/linkable-members (EmployeesController.listLinkableMembers)",
      "GET /integrations (IntegrationsController.list)",
      "GET /integrations/:type (IntegrationsController.detail)",
      "GET /integrations/:type/candidates (IntegrationsController.listCandidates)",
      "GET /integrations/:type/journal (IntegrationsController.journal)",
      "GET /integrations/public_api/keys (ApiKeysController.list)",
      "GET /inventories (InventoriesController.list)",
      "GET /inventories/:id (InventoriesController.get)",
      "GET /inventories/:id/close-preview (InventoriesController.closePreview)",
      "GET /inventories/:id/discrepancies (InventoriesController.discrepancies)",
      "GET /inventories/:id/evidence (InventoriesController.evidence)",
      "GET /inventories/:id/late-events (InventoriesController.lateEvents)",
      "GET /inventories/:id/progress (InventoriesController.progress)",
      "GET /inventories/:id/task-form (InventoriesController.taskForm)",
      "GET /inventory-document-formats (InventoryDocumentFormatsController.list)",
      "GET /kiosks (KiosksController.listKiosks)",
      "GET /label-templates (LabelTemplatesController.listLabelTemplates)",
      "GET /label-templates/:id (LabelTemplatesController.getLabelTemplate)",
      "GET /lines (LinesController.listLines)",
      "GET /lines/:id (LinesController.getLine)",
      "GET /operators (OperatorsController.listOperators)",
      "GET /org/profile (OrgProfileController.getProfile)",
      "GET /org/profile/logo/:revision (OrgProfileController.getLogo)",
      "GET /org/profile/sscc (OrgProfileController.getSscc)",
      "GET /pickup-orders (PickupOrdersController.list)",
      "GET /pickup-orders/:id (PickupOrdersController.detail)",
      "GET /pickup-orders/:id/slip (PickupOrdersController.slip)",
      "GET /pickup-reasons (PickupReasonsController.listReasons)",
      "GET /pickup-rejections (PickupRejectionsController.list)",
      "GET /products (ProductsController.listProducts)",
      "GET /products/:id (ProductsController.getProduct)",
      "GET /products/:id/image/:checksum (ProductsController.readImage)",
      "GET /billing/invoices (TenantBillingController.list)",
      "GET /billing/invoices/:id (TenantBillingController.detail)",
      "GET /billing/invoices/:id/documents/:documentId/download (TenantBillingController.download)",
      "GET /shift-exports/:exportId/artifacts/:artifactId/download (ShiftExportsController.download)",
      "GET /shift-exports/formats (ShiftExportsController.formats)",
      "GET /shifts (ShiftsController.listShifts)",
      "GET /shifts/planning-config (ShiftsController.getPlanningConfig)",
      "GET /shifts/box-label-templates (ShiftsController.listBoxLabelTemplates)",
      "GET /shifts/:id (ShiftsController.getShift)",
      "GET /shifts/:shiftId/exports (ShiftExportsController.list)",
      "GET /lines/presence (LinesController.listPresence)",
      "GET /shift-close-conflicts (StationShiftCloseController.list)",
      "GET /station-devices (StationDevicesController.list)",
      "GET /team (TeamController.list)",
      "POST /products/gtin-check (ProductsController.checkGtinOwner)",
    ],
  },
  {
    contract: customerContract(CABINET_GUARDS, {
      mode: "read_only_allowed",
      reason: "security",
    }),
    routes: [
      "DELETE /employees/:id/badges/:badgeId (EmployeesController.revokeBadge)",
      "DELETE /integrations/public_api/keys/:id (ApiKeysController.revoke)",
      "DELETE /kiosks/:id (KiosksController.archiveKiosk)",
      "DELETE /operators/:employeeId (OperatorsController.revokeAccess)",
      "DELETE /station-devices/:id (StationDevicesController.revoke)",
      "DELETE /team/invitations/:id (TeamController.cancelInvitation)",
      "DELETE /team/members/:id (TeamController.removeMember)",
      "POST /kiosks/:id/unbind (KiosksController.unbindKiosk)",
    ],
  },
  {
    contract: customerContract(CABINET_GUARDS, {
      mode: "read_only_allowed",
      reason: "export",
    }),
    routes: [
      "POST /pickup-orders/export (PickupOrdersController.export)",
      "POST /shift-exports/:exportId/retry (ShiftExportsController.retry)",
      "POST /shifts/:shiftId/exports (ShiftExportsController.create)",
    ],
  },
  {
    contract: customerContract(CABINET_GUARDS, {
      mode: "feature",
      entitlement: "labelEditor",
    }),
    routes: [
      "DELETE /label-templates/:id (LabelTemplatesController.deleteLabelTemplate)",
      "PATCH /label-templates/:id (LabelTemplatesController.updateLabelTemplate)",
      "POST /label-templates (LabelTemplatesController.createLabelTemplate)",
    ],
  },
  {
    contract: customerContract(CABINET_GUARDS, {
      mode: "feature",
      entitlement: "publicApi",
    }),
    routes: ["POST /integrations/public_api/keys (ApiKeysController.create)"],
  },
  {
    contract: customerContract(CABINET_GUARDS, { mode: "recovery", kind: "shift" }),
    routes: [
      "GET /shifts/:id/bundle (ShiftsController.getBundle)",
      "GET /shifts/:id/reference-bundle (ShiftsController.getReferenceBundle)",
      "POST /shifts/:id/close (ShiftsController.closeShift)",
    ],
  },
  {
    contract: customerContract(CABINET_GUARDS, { mode: "write" }),
    routes: [
      "DELETE /counterparties/:id (CounterpartiesController.deleteCounterparty)",
      "DELETE /disaggregation-reasons/:id (DisaggregationReasonsController.archiveReason)",
      "DELETE /disaggregation/:id/lines/:lineId (DisaggregationController.removeLine)",
      "DELETE /employees/:id (EmployeesController.archiveEmployee)",
      "DELETE /lines/:id (LinesController.deleteLine)",
      "DELETE /org/profile/logo (OrgProfileController.deleteLogo)",
      "DELETE /pickup-reasons/:id (PickupReasonsController.archiveReason)",
      "DELETE /products/:id (ProductsController.deleteProduct)",
      "DELETE /products/:id/image (ProductsController.deleteImage)",
      "DELETE /products/:id/external-link (ProductExternalLinkController.unlink)",
      "DELETE /shifts/:id (ShiftsController.deleteShift)",
      "DELETE /team/members/:id/employee (TeamController.unlinkEmployee)",
      "PATCH /counterparties/:id (CounterpartiesController.updateCounterparty)",
      "PATCH /disaggregation-reasons/:id (DisaggregationReasonsController.updateReason)",
      "PATCH /disaggregation/:id (DisaggregationController.update)",
      "PATCH /employees/pickup-policy/limits (EmployeesController.bulkUpdatePickupLimits)",
      "PATCH /employees/pickup-policy/writeoff-permission (EmployeesController.bulkUpdatePickupWriteoff)",
      "PATCH /employees/:id (EmployeesController.updateEmployee)",
      "PATCH /employees/:id/pickup-policy (EmployeesController.updatePickupPolicy)",
      "PATCH /integrations/:type (IntegrationsController.update)",
      "PATCH /inventories/:id (InventoriesController.update)",
      "PATCH /kiosks/:id (KiosksController.updateKiosk)",
      "PATCH /lines/:id (LinesController.updateLine)",
      "PATCH /operators/:employeeId (OperatorsController.updateAccess)",
      "PATCH /pickup-reasons/:id (PickupReasonsController.updateReason)",
      "PATCH /products/:id (ProductsController.updateProduct)",
      "PATCH /shifts/:id (ShiftsController.updateShift)",
      "PATCH /station-devices/:id (StationDevicesController.update)",
      "PATCH /team/members/:id (TeamController.updateMember)",
      "POST /conflicts/:id/review (ConflictsController.reviewConflict)",
      "POST /counterparties (CounterpartiesController.createCounterparty)",
      "POST /disaggregation (DisaggregationController.create)",
      "POST /disaggregation-reasons (DisaggregationReasonsController.createReason)",
      "POST /disaggregation/:id/apply (DisaggregationController.apply)",
      "POST /disaggregation/:id/cancel (DisaggregationController.cancel)",
      "POST /disaggregation/:id/import (DisaggregationController.importLines)",
      "POST /disaggregation/:id/lines (DisaggregationController.addLines)",
      "POST /employees (EmployeesController.createEmployee)",
      "POST /employees/:id/badges (EmployeesController.issueBadge)",
      "POST /integrations/:type/candidates/:id/hide (IntegrationsController.hideCandidate)",
      "POST /integrations/:type/candidates/:id/link (IntegrationsController.linkCandidate)",
      "POST /integrations/:type/candidates/:id/unhide (IntegrationsController.unhideCandidate)",
      "POST /integrations/:type/credentials (IntegrationsController.issueCredentials)",
      "POST /inventories (InventoriesController.create)",
      "POST /inventories/:id/close (InventoriesController.close)",
      "POST /inventories/:id/complete (InventoriesController.complete)",
      "POST /inventories/:id/corrections (InventoriesController.correct)",
      "POST /inventories/:id/emergency-close (InventoriesController.emergencyClose)",
      "POST /inventories/:id/imports/:status (InventoriesController.importEvidence)",
      "POST /inventories/:id/late-events/discard (InventoriesController.discardLateEvents)",
      "POST /inventories/:id/late-events/:lateEventId/replay (InventoriesController.replayLateEvent)",
      "POST /inventories/:id/reopen (InventoriesController.reopen)",
      "POST /inventories/:id/snapshots (InventoriesController.fixSnapshot)",
      "POST /inventories/:id/start (InventoriesController.start)",
      "POST /kiosks (KiosksController.createKiosk)",
      "POST /kiosks/:id/enroll (KiosksController.enroll)",
      "POST /kiosks/:id/pairing-code (KiosksController.issuePairingCode)",
      "POST /lines (LinesController.createLine)",
      "POST /org/profile/logo (OrgProfileController.uploadLogo)",
      "POST /pickup-orders/:id/cancel (PickupOrdersController.cancel)",
      "POST /pickup-orders/:id/resolve (PickupOrdersController.resolve)",
      "POST /pickup-reasons (PickupReasonsController.createReason)",
      "POST /pickup-rejections/:id/acknowledge (PickupRejectionsController.acknowledge)",
      "POST /products (ProductsController.createProduct)",
      "POST /products/:id/image (ProductsController.uploadImage)",
      "POST /shifts (ShiftsController.createShift)",
      "POST /shifts/:id/open (ShiftsController.openShift)",
      "POST /shift-close-conflicts/:eventId/dismiss (StationShiftCloseController.dismiss)",
      "POST /station-devices (StationDevicesController.create)",
      "POST /station-devices/:id/pairing-code (StationDevicesController.issuePairingCode)",
      "POST /team/invitations (TeamController.createInvitation)",
      "POST /team/invitations/:id/resend (TeamController.resendInvitation)",
      "PUT /counterparties/:id/sscc (CounterpartiesController.putSscc)",
      "PUT /kiosks/:id/products (KiosksController.setProducts)",
      "PUT /operators/:employeeId (OperatorsController.grantAccess)",
      "PUT /org/profile (OrgProfileController.putProfile)",
      "PUT /org/profile/sscc (OrgProfileController.putSscc)",
      "PUT /team/members/:id/employee (TeamController.linkEmployee)",
    ],
  },
  {
    contract: customerContract(CABINET_STATION_GUARDS, { mode: "write" }),
    routes: [
      "POST /shifts/:id/enter (ShiftsController.enterShift)",
      "POST /station/shift-closures (StationShiftCloseController.close)",
    ],
  },
  {
    contract: customerContract(KIOSK_GUARDS, { mode: "read_only_allowed", reason: "read" }),
    routes: [
      "GET /kiosk/bootstrap (KioskController.bootstrap)",
      "GET /kiosk/branding/logo/:revision (KioskController.logo)",
      "GET /kiosk/box-registry (KioskController.boxRegistry)",
      "GET /kiosk/products/:id/image/:checksum (KioskController.readProductImage)",
    ],
  },
  {
    contract: customerContract(KIOSK_GUARDS, { mode: "recovery", kind: "kiosk" }),
    routes: ["POST /kiosk/order-admissions (KioskController.attestOrder)"],
  },
  {
    contract: customerContract(KIOSK_GUARDS, { mode: "recovery", kind: "kiosk" }),
    routes: ["POST /kiosk/orders (KioskController.createOrder)"],
  },
  {
    contract: customerContract(STATION_GUARDS, { mode: "recovery", kind: "station" }),
    routes: [
      "GET /station/inventories/:id/bundle/codes (StationInventoriesController.codes)",
      "GET /station/inventories/:id/bundle/manifest (StationInventoriesController.manifest)",
      "GET /station/inventories/:id/progress (StationInventoriesController.progress)",
      "GET /station/inventory-tasks (StationInventoriesController.list)",
      "POST /station/inventories/:id/event-batches (StationInventoriesController.eventBatch)",
      "POST /station/inventories/:id/join (StationInventoriesController.join)",
      "POST /station/inventories/:id/leave (StationInventoriesController.leave)",
      "POST /station/inventory-tasks/resolve-barcode (StationInventoriesController.resolveBarcode)",
      "POST /station/conflicts/status (StationScansController.conflictStatus)",
      "POST /station/codes/releases (StationScansController.codeReleases)",
      "POST /station/scans (StationScansController.ingest)",
    ],
  },
  {
    contract: customerContract(STATION_GUARDS, { mode: "read_only_allowed", reason: "read" }),
    routes: [
      "GET /station/products/:id/image/:checksum (StationProductImagesController.readProductImage)",
    ],
  },
] as const;

const CUSTOMER_ROUTE_ENTRIES = CUSTOMER_ROUTE_GROUPS.flatMap(({ contract, routes }) =>
  routes.map((route) => [route, contract] as const),
);
const CUSTOMER_ROUTE_CONTRACTS: Readonly<Record<string, CustomerRouteContract>> =
  Object.fromEntries(CUSTOMER_ROUTE_ENTRIES);

// Every entry is an intentional trust-domain exception to the cabinet/station/kiosk
// subscription guard. The equality assertion below makes stale exemptions fail too.
type RouteExemption = {
  reason: string;
  requiredGuards?: readonly string[];
  platformPolicy?: true;
};

const platform = (reason: string): RouteExemption => ({ reason, platformPolicy: true });
const profile: RouteExemption = {
  reason: "user security/profile continuity remains available in read-only mode",
  requiredGuards: ["ProfileSessionGuard"],
};

const EXEMPTIONS: Readonly<Record<string, RouteExemption>> = {
  "BillingAccountsController.archiveOperator": platform(
    "operator bank-account archival is guarded by platform billing capabilities",
  ),
  "BillingAccountsController.archiveTenant": platform(
    "tenant bank-account archival is guarded by platform billing capabilities",
  ),
  "BillingAccountsController.createOperator": platform(
    "operator bank-account creation is guarded by platform billing capabilities",
  ),
  "BillingAccountsController.createTenant": platform(
    "tenant bank-account creation is guarded by platform billing capabilities",
  ),
  "BillingAccountsController.setOperatorDefault": platform(
    "operator default-account mutation is guarded by platform billing capabilities",
  ),
  "BillingAccountsController.setTenantDefault": platform(
    "tenant default-account mutation is guarded by platform billing capabilities",
  ),
  "BillingController.create": platform(
    "platform invoice creation is guarded by platform billing capabilities",
  ),
  "BillingController.issue": platform(
    "platform invoice issuance is guarded by platform billing capabilities",
  ),
  "BillingController.document": platform(
    "platform invoice document rendering is guarded by platform billing capabilities",
  ),
  "BillingController.documentsRender": platform(
    "platform invoice document rendering is guarded by platform billing capabilities",
  ),
  "BillingController.apply": platform(
    "platform invoice application is guarded by platform billing capabilities",
  ),
  "BillingController.cancel": platform(
    "platform invoice cancellation is guarded by platform billing capabilities",
  ),
  "BillingPaymentsController.record": platform(
    "platform payment recording is guarded by platform billing capabilities",
  ),
  "BillingPaymentsController.import": platform(
    "platform bank import is guarded by platform billing capabilities",
  ),
  "BillingPaymentsController.resolveMatch": platform(
    "platform payment matching decisions are guarded by platform billing capabilities",
  ),
  "BillingProfilesController.setOperator": platform(
    "operator billing profile mutation is guarded by platform billing capabilities",
  ),
  "BillingProfilesController.setTenant": platform(
    "tenant billing profile mutation is guarded by platform billing capabilities",
  ),
  "PlatformOffersController.create": platform(
    "platform billing offer creation is guarded by platform capabilities",
  ),
  "PlatformOffersController.publish": platform(
    "platform billing offer publication is guarded by platform capabilities",
  ),
  "PlatformOffersController.documentsRender": platform(
    "platform billing offer document rendering is guarded by platform capabilities",
  ),
  "PlatformOffersController.cancel": platform(
    "platform billing offer cancellation is guarded by platform capabilities",
  ),
  "PlatformOffersController.pay": platform(
    "platform payment fulfilment is guarded by platform capabilities",
  ),
  "ProfileController.deleteAvatar": profile,
  "ProfileController.updateProfile": profile,
  "ProfileController.uploadAvatar": profile,
  "ExchangeController.get": {
    reason:
      "conditional CommerceML import is enforced by EntitlementsService after authoritative session resolution; query/export/success remain available",
  },
  "ExchangeController.post": {
    reason:
      "CommerceML transport upload and export-success acknowledgement preserve recovery continuity",
  },
  "DemoRequestsController.submit": {
    reason:
      "public landing submission is intentionally unauthenticated and enforces strict input, bounded rate limits, consent, captcha, and fixed recipients",
  },
  "InvitationsController.accept": {
    reason: "public invitation token/session lifecycle is an authentication and security flow",
  },
  "InvitationsController.register": {
    reason: "public invitation token registration is an authentication and security flow",
  },
  "InvitationsController.reject": {
    reason: "public invitation token/session lifecycle is an authentication and security flow",
  },
  "KioskPairController.pair": {
    reason:
      "unpaired kiosk has no device identity; PairingService resolves the authoritative tenant and enforces write access",
  },
  "StationPairController.pair": {
    reason:
      "unpaired station has no device identity; StationPairingService resolves the authoritative tenant and enforces write/quota access",
  },
  "TenantOwnerActivationController.complete": {
    reason: "single-use tenant-owner activation token is a public authentication lifecycle flow",
  },
  "TenantOwnerActivationController.status": {
    reason:
      "single-use tenant-owner activation token status is a public authentication lifecycle flow",
  },
  "PlatformActivationController.complete": platform(
    "public platform activation token is verified by the global platform trust-domain guard",
  ),
  "PlatformCatalogController.archive": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.createVersion": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.publish": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.retire": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.updateVersion": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformSettingsController.setDefaultDemo": platform(
    "platform setting mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.changeRole": platform(
    "platform team mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.invite": platform(
    "platform team mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.recoverTwoFactor": platform(
    "platform account recovery uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.renewActivation": platform(
    "platform account lifecycle uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.suspend": platform(
    "platform account lifecycle uses the isolated platform principal and capability policy",
  ),
  "PlatformTenantsController.assignAddon": platform(
    "subscription lifecycle is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.assignPlan": platform(
    "subscription lifecycle is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.create": platform(
    "tenant provisioning is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.renewActivation": platform(
    "tenant owner lifecycle is administered by the isolated platform trust domain",
  ),
};

const requestMethodName = (method: RequestMethod): string => RequestMethod[method] ?? "UNKNOWN";

function asPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asPaths);
  if (typeof value === "string") return [value];
  return [""];
}

function joinPath(controllerPath: string, handlerPath: string): string {
  return `/${[controllerPath, handlerPath]
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .join("/")}`;
}

function registeredRoutes(container: ModulesContainer): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | undefined;
      if (!controller) continue;
      const prototype = controller.prototype as Record<string, (...args: never[]) => unknown>;
      for (const handlerName of Object.getOwnPropertyNames(prototype)) {
        if (handlerName === "constructor") continue;
        const handler = prototype[handlerName];
        if (!handler) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const controllerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
        const handlerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, handler));
        for (const controllerPath of controllerPaths) {
          for (const handlerPath of handlerPaths) {
            routes.push({
              controller,
              handler,
              handlerName,
              method,
              path: joinPath(controllerPath, handlerPath),
            });
          }
        }
      }
    }
  }
  return routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

function routeKey(route: RegisteredRoute): string {
  return `${requestMethodName(route.method)} ${route.path} (${route.controller.name}.${route.handlerName})`;
}

function exemptionKey(route: RegisteredRoute): string {
  return `${route.controller.name}.${route.handlerName}`;
}

function platformRouteContractKey(route: RegisteredRoute): string {
  const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return `${requestMethodName(route.method)} ${openApiPath}`;
}

describe("registered subscription route inventory", () => {
  let ref: TestingModule;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
    const env = loadEnv();
    const auth = setupAuth(env);
    const platform = setupPlatformAuth(env, auth.db);
    ref = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...auth,
          ...platform,
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    }).compile();
    routes = registeredRoutes(ref.get(ModulesContainer));
  });

  afterAll(async () => {
    await ref?.close();
  });

  it("matches the canonical customer route and subscription-policy inventory exactly", () => {
    expect(new Set(CUSTOMER_ROUTE_ENTRIES.map(([route]) => route)).size).toBe(
      CUSTOMER_ROUTE_ENTRIES.length,
    );
    const reflector = new Reflector();
    const actual = Object.fromEntries(
      routes
        // SubscriptionAccessGuard is the executable boundary that defines a
        // customer route. Filtering by a hand-maintained controller-name list
        // would let an entirely new guarded GET controller escape the exact
        // inventory until somebody remembered to extend two lists at once.
        .filter((route) => {
          const guards = [
            ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[]),
            ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[]),
          ];
          return guards.includes(SubscriptionAccessGuard);
        })
        .map((route) => {
          const guards = [
            ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[]),
            ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[]),
          ].map((guard) => guard.name);
          const policy = reflector.getAllAndOverride<SubscriptionAccessPolicy>(
            ROUTE_SUBSCRIPTION_ACCESS_POLICY,
            [route.handler, route.controller],
          );
          return [routeKey(route), { guards, policy }] as const;
        }),
    );

    expect(actual).toEqual(CUSTOMER_ROUTE_CONTRACTS);
  });

  it("classifies every customer route and pins its exact trust-chain guard order", () => {
    const reflector = new Reflector();
    const inspected = routes.filter((route) => {
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[]),
        ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[]),
      ];
      return (
        guards.includes(SubscriptionAccessGuard) ||
        UNSAFE_METHODS.has(route.method) ||
        (route.controller.name === "ExchangeController" && route.handlerName === "get")
      );
    });
    const encounteredExemptions: string[] = [];
    const unclassified: string[] = [];

    for (const route of inspected) {
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[];
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[];
      const guards = [...classGuards, ...methodGuards];
      const subscriptionIndex = guards.indexOf(SubscriptionAccessGuard);
      const policy = reflector.getAllAndOverride<SubscriptionAccessPolicy>(
        ROUTE_SUBSCRIPTION_ACCESS_POLICY,
        [route.handler, route.controller],
      );

      if (subscriptionIndex >= 0) {
        expect(policy, `${routeKey(route)} lacks a subscription policy`).toBeDefined();
        if (UNSAFE_METHODS.has(route.method)) {
          const handlerPolicy = Reflect.getMetadata(
            ROUTE_SUBSCRIPTION_ACCESS_POLICY,
            route.handler,
          ) as SubscriptionAccessPolicy | undefined;
          expect(
            handlerPolicy,
            `${routeKey(route)} inherits class read access instead of declaring mutation policy`,
          ).toBeDefined();
          // Whether an unsafe verb is a write, recovery action, feature gate,
          // export/security continuity action, or an intentional side-effect-
          // free POST is pinned by the exact canonical inventory above. A
          // blanket read_only_allowed ban would reject those documented
          // exceptions; this branch only prevents silent inheritance.
        }
        const names = guards.map((guard) => guard.name);
        const stationOnlyCabinetRoute =
          (route.controller.name === "ShiftsController" && route.handlerName === "enterShift") ||
          (route.controller.name === "StationShiftCloseController" &&
            route.handlerName === "close");
        const expected =
          route.controller.name === "KioskController"
            ? ["KioskDeviceGuard", "SubscriptionAccessGuard"]
            : route.controller.name === "StationScansController" ||
                route.controller.name === "StationInventoriesController" ||
                route.controller.name === "StationProductImagesController"
              ? ["TenantGuard", "StationOnlyGuard", "SubscriptionAccessGuard"]
              : stationOnlyCabinetRoute
                ? [
                    "TenantGuard",
                    "AuthorizationGuard",
                    "SubscriptionAccessGuard",
                    "StationOnlyGuard",
                  ]
                : ["TenantGuard", "AuthorizationGuard", "SubscriptionAccessGuard"];
        expect(names, `${routeKey(route)} changed its exact identity/authorization chain`).toEqual(
          expected,
        );
        if (
          route.controller.name === "ShiftsController" &&
          (route.handlerName === "getBundle" || route.handlerName === "getReferenceBundle")
        ) {
          expect(policy).toEqual({ mode: "recovery", kind: "shift" });
        }
        continue;
      }

      const key = exemptionKey(route);
      encounteredExemptions.push(key);
      const exemption = EXEMPTIONS[key];
      if (!exemption) {
        unclassified.push(routeKey(route));
        continue;
      }
      expect(
        exemption.reason.trim().length,
        `${routeKey(route)} has no documented reason`,
      ).toBeGreaterThan(0);
      if (exemption.requiredGuards) {
        expect(
          guards.map((guard) => guard.name),
          `${routeKey(route)} lost its exemption identity guard`,
        ).toEqual(expect.arrayContaining([...exemption.requiredGuards]));
      }
      if (exemption.platformPolicy) {
        expect(
          reflector.getAllAndOverride(PLATFORM_ACCESS_POLICY, [route.handler, route.controller]),
          `${routeKey(route)} lost its platform authentication/capability policy`,
        ).toBeDefined();
      }
    }

    expect(unclassified, "unclassified registered unsafe routes").toEqual([]);
    expect(encounteredExemptions.sort()).toEqual(Object.keys(EXEMPTIONS).sort());
  });

  it("keeps every platform route inside the isolated platform policy boundary", () => {
    const reflector = new Reflector();
    const unprotected = routes
      .filter((route) => route.path === "/platform" || route.path.startsWith("/platform/"))
      .filter(
        (route) =>
          reflector.getAllAndOverride(PLATFORM_ACCESS_POLICY, [route.handler, route.controller]) ===
          undefined,
      )
      .map(routeKey);

    expect(unprotected).toEqual([]);
  });

  it("matches the exact current SaaS route contracts against the production AppModule", () => {
    const actual = routes
      .filter((route) => route.path === "/platform" || route.path.startsWith("/platform/"))
      .filter((route) => route.controller.name !== "BillingProfilesController")
      .map(platformRouteContractKey)
      .sort();

    expect(actual).toEqual(CURRENT_SAAS_ROUTE_KEYS);
  });
});
