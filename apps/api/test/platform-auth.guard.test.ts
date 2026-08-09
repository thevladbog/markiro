import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { schema, type PlatformRole } from "@markiro/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RequirePlatformCapabilities,
  type PlatformCapability,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

class PlatformPolicyController {
  unclassified(): void {}

  @RequirePlatformCapabilities("tenants.write")
  createTenant(): void {}

  @RequirePlatformCapabilities("billing.write")
  recordPayment(): void {}
}

interface FakeRequest {
  headers: Record<string, string>;
  authKind?: "session" | "station";
  platformPrincipal?: unknown;
}

function contextFor(request: FakeRequest, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => PlatformPolicyController,
  } as unknown as ExecutionContext;
}

const unclassifiedHandler = PlatformPolicyController.prototype.unclassified;
const createTenantHandler = PlatformPolicyController.prototype.createTenant;
const recordPaymentHandler = PlatformPolicyController.prototype.recordPayment;

function platformSession(userId: string) {
  return {
    session: {
      id: `session-${userId}`,
      token: `session-token-secret-${userId}`,
      userId,
      expiresAt: new Date("2026-08-10T00:00:00Z"),
      createdAt: new Date("2026-08-09T00:00:00Z"),
      updatedAt: new Date("2026-08-09T00:00:00Z"),
    },
    user: {
      id: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      name: userId,
      createdAt: new Date("2026-08-09T00:00:00Z"),
      updatedAt: new Date("2026-08-09T00:00:00Z"),
      twoFactorEnabled: true,
    },
  };
}

describe("PlatformAuthGuard", () => {
  const tx = { kind: "audit-transaction" };
  let auth: { api: { getSession: ReturnType<typeof vi.fn> } };
  let db: {
    transaction: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let guard: PlatformAuthGuard;
  let platformUser: {
    id: string;
    role: PlatformRole;
    status: string;
    twoFactorEnabled: boolean;
  } | null;
  let twoFactor: { verified: boolean } | null;

  beforeEach(() => {
    platformUser = null;
    twoFactor = null;
    auth = { api: { getSession: vi.fn() } };
    db = {
      transaction: vi.fn(async (callback: (value: unknown) => Promise<void>) => callback(tx)),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(async () =>
            table === schema.platformUsers
              ? platformUser
                ? [platformUser]
                : []
              : twoFactor
                ? [twoFactor]
                : [],
          ),
        })),
      })),
    };
    audit = { record: vi.fn(async () => undefined) };
    guard = new PlatformAuthGuard(
      new Reflector(),
      auth as never,
      db as never,
      audit as unknown as PlatformAuditService,
    );
  });

  function expectDenial(input: {
    actorId: string | null;
    actorRole: PlatformRole | null;
    targetId: string;
    reason: string;
    required: PlatformCapability[];
  }) {
    expect(audit.record).toHaveBeenCalledWith(tx, {
      actorPlatformUserId: input.actorId,
      actorRole: input.actorRole,
      action: "platform.authorization.denied",
      outcome: "denied",
      tenantId: null,
      targetType: "platform_route",
      targetId: input.targetId,
      reason: input.reason,
      before: null,
      after: { requiredCapabilities: input.required },
      requestId: null,
    });
    const serializedAudit = JSON.stringify(audit.record.mock.calls);
    expect(serializedAudit).not.toContain("session-token-secret");
    expect(serializedAudit).not.toContain("totp-secret");
  }

  it("fails closed when a platform route has no capability metadata", async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} }, unclassifiedHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expectDenial({
      actorId: null,
      actorRole: null,
      targetId: "PlatformPolicyController.unclassified",
      reason: "missing_policy",
      required: [],
    });
  });

  it("rejects a customer session without consulting the platform session namespace", async () => {
    const customerRequest: FakeRequest = {
      headers: { cookie: "better-auth.session_token=customer-session-token-secret" },
      authKind: "session",
    };
    await expect(
      guard.canActivate(contextFor(customerRequest, createTenantHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expectDenial({
      actorId: null,
      actorRole: null,
      targetId: "PlatformPolicyController.createTenant",
      reason: "customer_session",
      required: ["tenants.write"],
    });
  });

  it("rejects an active platform administrator until verified TOTP is stored", async () => {
    auth.api.getSession.mockResolvedValue(platformSession("platform-admin"));
    platformUser = {
      id: "platform-admin",
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: false,
    };
    const platformAdminWithout2fa: FakeRequest = {
      headers: { cookie: "markiro-platform.session_token=session-token-secret-platform-admin" },
    };
    await expect(
      guard.canActivate(contextFor(platformAdminWithout2fa, createTenantHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expectDenial({
      actorId: "platform-admin",
      actorRole: "platform_admin",
      targetId: "PlatformPolicyController.createTenant",
      reason: "two_factor_required",
      required: ["tenants.write"],
    });
  });

  it("reloads the support role and rejects a billing capability it does not grant", async () => {
    auth.api.getSession.mockResolvedValue(platformSession("support-user"));
    platformUser = {
      id: "support-user",
      role: "support",
      status: "active",
      twoFactorEnabled: true,
    };
    twoFactor = { verified: true };
    const supportWith2fa: FakeRequest = {
      headers: { cookie: "markiro-platform.session_token=session-token-secret-support" },
    };
    await expect(
      guard.canActivate(contextFor(supportWith2fa, recordPaymentHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expectDenial({
      actorId: "support-user",
      actorRole: "support",
      targetId: "PlatformPolicyController.recordPayment",
      reason: "insufficient_capability",
      required: ["billing.write"],
    });
  });
});
