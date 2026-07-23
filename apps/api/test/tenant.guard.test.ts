import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { Auth } from "@markiro/db";
import { TenantGuard } from "../src/tenancy/tenant.guard";

interface FakeRequest {
  headers: Record<string, string>;
  tenantId?: string;
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
  });
});

function fakeAuthWithApiKey(
  getSession: Auth["api"]["getSession"],
  verifyApiKey: Auth["api"]["verifyApiKey"],
): Auth {
  return { api: { getSession, verifyApiKey } } as unknown as Auth;
}

describe("TenantGuard api-key path", () => {
  it("resolves tenantId from a valid x-api-key when there is no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_9");
  });

  it("throws Unauthorized for an invalid x-api-key and no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({ valid: false, error: { message: "bad", code: "INVALID" }, key: null }),
      ),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_bad" } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
