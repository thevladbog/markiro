import { CABINET_CAPABILITY, resolveCabinetAccess } from "@markiro/domain";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import type { AuthorizationService } from "../src/authorization/authorization.service";
import type { SecurityAuditService } from "../src/authorization/security-audit.service";
import { TenantBillingController } from "../src/modules/tenant-billing/tenant-billing.controller";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";

function contextFor(role: "owner" | "admin" | "manager" | "member"): ExecutionContext {
  const request = { authKind: "session" as const, tenantId: "tenant-a", userId: role };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => TenantBillingController.prototype.overview,
    getClass: () => TenantBillingController,
  } as unknown as ExecutionContext;
}

describe("tenant billing authorization guard seam", () => {
  it("uses actual AuthorizationGuard capability evaluation for all cabinet roles", async () => {
    const authorization = {
      resolvePrincipal: vi.fn(async (userId: string, tenantId: string) => ({
        userId,
        tenantId,
        ...resolveCabinetAccess(userId as "owner" | "admin" | "manager" | "member"),
      })),
    };
    const guard = new AuthorizationGuard(
      new Reflector(),
      authorization as unknown as AuthorizationService,
      { authorizationDenied: vi.fn() } as unknown as SecurityAuditService,
    );

    for (const role of ["owner", "admin"] as const) {
      await expect(guard.canActivate(contextFor(role))).resolves.toBe(true);
    }
    for (const role of ["manager", "member"] as const) {
      await expect(guard.canActivate(contextFor(role))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("keeps every exposed read route behind BILLING_READ and read-only recovery", () => {
    const reflector = new Reflector();
    const routes = [
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
    expect(Reflect.getMetadata(GUARDS_METADATA, TenantBillingController)).toEqual([
      TenantGuard,
      AuthorizationGuard,
      SubscriptionAccessGuard,
    ]);
    for (const route of routes) {
      const handler = TenantBillingController.prototype[route];
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
});
