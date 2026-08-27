import { CABINET_CAPABILITY, resolveCabinetAccess } from "@markiro/domain";
import { NotFoundException, type INestApplication } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenantBillingController } from "../src/modules/tenant-billing/tenant-billing.controller";
import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { SUBSCRIPTION_ENFORCEMENT_MODE } from "../src/subscriptions/entitlements.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";

describe("tenant billing read routes", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const billing = {
      overview: async () => ({}),
      subscription: async () => ({}),
      listInvoices: async () => ({ items: [] }),
      listDocuments: async () => ({ items: [] }),
      invoiceDetail: async (_tenantId: string, id: string) => {
        if (id === "31111111-1111-4111-8111-111111111111") {
          throw new NotFoundException({ code: "invoice_not_found" });
        }
        return {};
      },
      offerDetail: async (_tenantId: string, id: string) => {
        if (id === "41111111-1111-4111-8111-111111111111") {
          throw new NotFoundException({ code: "offer_not_found" });
        }
        return {};
      },
      downloadInvoiceDocument: async () => {
        throw new NotFoundException({ code: "invoice_document_not_ready" });
      },
      downloadOfferDocument: async () => {
        throw new NotFoundException({ code: "offer_document_not_ready" });
      },
      downloadActDocument: async () => {
        throw new NotFoundException({ code: "act_document_not_found" });
      },
    };
    const ref = await Test.createTestingModule({
      controllers: [TenantBillingController],
      providers: [
        Reflector,
        AuthorizationGuard,
        {
          provide: AuthorizationService,
          useValue: {
            resolvePrincipal: async (role: string) => ({
              userId: role,
              tenantId: "tenant-a",
              roles: [role],
              capabilities: resolveCabinetAccess(role).capabilities,
            }),
          },
        },
        { provide: SecurityAuditService, useValue: { authorizationDenied: () => undefined } },
        { provide: SUBSCRIPTION_ENFORCEMENT_MODE, useValue: "managed_only" },
        { provide: TenantBillingReadService, useValue: billing },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          const request = context.switchToHttp().getRequest();
          const headers = request.headers as Record<string, string | undefined>;
          request.authKind = "session";
          request.tenantId = headers["x-tenant-id"] ?? "tenant-a";
          request.userId = headers["x-role"] ?? "owner";
          return true;
        },
      })
      .overrideGuard(SubscriptionAccessGuard)
      .useFactory({
        factory: (reflector: Reflector) =>
          new SubscriptionAccessGuard(
            reflector,
            { resolve: async () => ({ access: "read_only", features: {} }) } as never,
            "managed_only",
          ),
        inject: [Reflector],
      })
      .compile();
    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("allows billing reads only to owner/admin and keeps every read route in subscription recovery", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(resolveCabinetAccess(role).capabilities).toContain(CABINET_CAPABILITY.BILLING_READ);
    }
    for (const role of ["manager", "member"] as const) {
      expect(resolveCabinetAccess(role).capabilities).not.toContain(
        CABINET_CAPABILITY.BILLING_READ,
      );
    }

    const reflector = new Reflector();
    const routeNames = [
      "overview",
      "subscription",
      "listInvoices",
      "invoiceDetail",
      "listDocuments",
      "offerDetail",
      "downloadInvoiceDocument",
      "downloadOfferDocument",
      "downloadActDocument",
    ] as const;
    const guards = Reflect.getMetadata(GUARDS_METADATA, TenantBillingController) as unknown[];
    expect(guards).toEqual([TenantGuard, AuthorizationGuard, SubscriptionAccessGuard]);

    for (const name of routeNames) {
      const handler = TenantBillingController.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();
      expect(
        reflector.getAllAndOverride(ROUTE_ACCESS_POLICY, [handler, TenantBillingController]),
      ).toEqual({ mode: "cabinet", capabilities: [CABINET_CAPABILITY.BILLING_READ] });
      expect(
        reflector.getAllAndOverride(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
          handler,
          TenantBillingController,
        ]),
      ).toEqual({ mode: "read_only_allowed", reason: "read" });
    }
  });

  it("returns 200 to owner/admin, 403 to manager/member, and 404 for every foreign detail or download", async () => {
    for (const role of ["owner", "admin"]) {
      await request(app.getHttpServer()).get("/billing/overview").set("x-role", role).expect(200);
    }
    for (const role of ["manager", "member"]) {
      await request(app.getHttpServer()).get("/billing/overview").set("x-role", role).expect(403);
    }
    for (const path of [
      "/billing/invoices/31111111-1111-4111-8111-111111111111",
      "/billing/offers/41111111-1111-4111-8111-111111111111",
      "/billing/invoices/31111111-1111-4111-8111-111111111111/documents/51111111-1111-4111-8111-111111111111/download",
      "/billing/offers/41111111-1111-4111-8111-111111111111/documents/61111111-1111-4111-8111-111111111111/download",
      "/billing/acts/71111111-1111-4111-8111-111111111111/documents/81111111-1111-4111-8111-111111111111/download",
    ]) {
      await request(app.getHttpServer()).get(path).set("x-role", "owner").expect(404);
    }
  });
});
