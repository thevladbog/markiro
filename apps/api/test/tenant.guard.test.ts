import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { Auth } from "@markiro/db";
import { TenantGuard } from "../src/tenancy/tenant.guard";

interface FakeRequest {
  headers: Record<string, string>;
  tenantId?: string;
  userId?: string;
}

function fakeAuth(getSession: Auth["api"]["getSession"]): Auth {
  return { api: { getSession } } as unknown as Auth;
}

function contextFor(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("TenantGuard", () => {
  it("throws UnauthorizedException when there is no session", async () => {
    const guard = new TenantGuard(fakeAuth(async () => null));
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.userId).toBeUndefined();
  });

  it("throws ForbiddenException when the session has no active organization", async () => {
    const guard = new TenantGuard(
      fakeAuth(async () => ({
        session: { activeOrganizationId: null },
        user: { id: "user_1" },
      })),
    );
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("sets req.tenantId and returns true when an active organization exists", async () => {
    const guard = new TenantGuard(
      fakeAuth(async () => ({
        session: { activeOrganizationId: "org_1" },
        user: { id: "user_1" },
      })),
    );
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_1");
    expect(req.userId).toBe("user_1");
  });
});
