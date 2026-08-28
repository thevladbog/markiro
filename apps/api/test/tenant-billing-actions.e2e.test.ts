import { CABINET_CAPABILITY, resolveCabinetAccess } from "@markiro/domain";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import type { AuthorizationService } from "../src/authorization/authorization.service";
import type { SecurityAuditService } from "../src/authorization/security-audit.service";
import {
  createBillingRequestSchema,
  offerChangeRequestSchema,
  requestReplySchema,
} from "../src/modules/tenant-billing/dto";
import { TenantBillingController } from "../src/modules/tenant-billing/tenant-billing.controller";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";
import { TenantGuard } from "../src/tenancy/tenant.guard";

function contextFor(
  role: "owner" | "admin" | "manager" | "member",
  handler: keyof TenantBillingController,
): ExecutionContext {
  const request = { authKind: "session" as const, tenantId: "tenant-a", userId: role };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => TenantBillingController.prototype[handler],
    getClass: () => TenantBillingController,
  } as unknown as ExecutionContext;
}

describe("tenant billing action route security and validation", () => {
  it("uses a bounded in-memory single-file multipart interceptor", () => {
    type MulterInterceptor = new () => {
      multer: {
        limits?: { fileSize?: number; files?: number; fields?: number; parts?: number };
        storage?: { _handleFile?: unknown };
      };
    };
    const [Interceptor] = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      TenantBillingController.prototype.attachToRequest,
    ) as MulterInterceptor[];
    if (!Interceptor) throw new Error("Expected billing attachment interceptor");
    const interceptor = new Interceptor();
    expect(interceptor.multer.limits).toEqual({
      fileSize: 5 * 1024 * 1024,
      files: 1,
      fields: 1,
      parts: 2,
    });
    expect(interceptor.multer.storage?._handleFile).toBeTypeOf("function");
  });

  it("uses the actual authorization guard to allow owner/admin and deny manager/member", async () => {
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
      await expect(guard.canActivate(contextFor(role, "createRequest"))).resolves.toBe(true);
    }
    for (const role of ["manager", "member"] as const) {
      await expect(guard.canActivate(contextFor(role, "createRequest"))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it("keeps every mutation behind BILLING_REQUEST and available in read-only recovery", () => {
    const reflector = new Reflector();
    expect(Reflect.getMetadata(GUARDS_METADATA, TenantBillingController)).toEqual([
      TenantGuard,
      AuthorizationGuard,
      SubscriptionAccessGuard,
    ]);
    for (const route of [
      "createRequest",
      "replyToRequest",
      "attachToRequest",
      "acceptOffer",
      "requestOfferChanges",
    ] as const) {
      const handler = TenantBillingController.prototype[route];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
      expect(
        reflector.getAllAndOverride(ROUTE_ACCESS_POLICY, [handler, TenantBillingController]),
      ).toEqual({
        mode: "cabinet",
        capabilities: [CABINET_CAPABILITY.BILLING_REQUEST],
      });
      expect(
        reflector.getAllAndOverride(ROUTE_SUBSCRIPTION_ACCESS_POLICY, [
          handler,
          TenantBillingController,
        ]),
      ).toEqual({ mode: "read_only_allowed", reason: "read" });
    }
  });

  it("strictly bounds request, reply, and change-request inputs", () => {
    expect(
      createBillingRequestSchema.safeParse({
        type: "other",
        description: "Request",
        idempotencyKey: randomUuid,
        status: "completed",
      }).success,
    ).toBe(false);
    expect(requestReplySchema.safeParse({ message: " ", idempotencyKey: randomUuid }).success).toBe(
      false,
    );
    expect(
      offerChangeRequestSchema.safeParse({ message: "x".repeat(2001), idempotencyKey: randomUuid })
        .success,
    ).toBe(false);
  });
});

const randomUuid = "11111111-1111-4111-8111-111111111111";
