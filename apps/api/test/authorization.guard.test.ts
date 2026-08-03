import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AllowStationOrPermissions,
  RequireMembership,
  RequirePermissions,
} from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import type { AuthorizationService } from "../src/authorization/authorization.service";
import type { SecurityAuditService } from "../src/authorization/security-audit.service";

class PolicyController {
  unclassified(): void {}

  @AllowStationOrPermissions("operations.read")
  sharedRead(): void {}

  @RequirePermissions("operations.write")
  cabinetWrite(): void {}

  @RequirePermissions("operations.read", "operations.write")
  operational(): void {}

  @RequirePermissions("operations.read", "credentials.manage")
  credential(): void {}

  @RequireMembership()
  accessMe(): void {}
}

interface FakeRequest {
  headers: Record<string, string>;
  authKind?: "session" | "station";
  tenantId?: string;
  userId?: string;
  cabinetPrincipal?: unknown;
}

function contextFor(request: FakeRequest, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => PolicyController,
  } as unknown as ExecutionContext;
}

const unclassifiedHandler = PolicyController.prototype.unclassified;
const sharedReadHandler = PolicyController.prototype.sharedRead;
const cabinetWriteHandler = PolicyController.prototype.cabinetWrite;
const operationalHandler = PolicyController.prototype.operational;
const credentialHandler = PolicyController.prototype.credential;
const accessMeHandler = PolicyController.prototype.accessMe;

const managerPrincipal = {
  userId: "user_1",
  tenantId: "org_1",
  roles: ["manager" as const],
  capabilities: ["operations.read" as const, "operations.write" as const],
};

const memberPrincipal = {
  userId: "user_1",
  tenantId: "org_1",
  roles: ["member" as const],
  capabilities: [],
};

describe("AuthorizationGuard", () => {
  const sessionRequest: FakeRequest = {
    headers: {},
    authKind: "session",
    tenantId: "org_1",
    userId: "user_1",
  };
  const stationRequest: FakeRequest = {
    headers: {},
    authKind: "station",
    tenantId: "org_1",
  };
  let service: { resolvePrincipal: ReturnType<typeof vi.fn> };
  let audit: {
    authorizationDenied: ReturnType<typeof vi.fn>;
    credentialMutation: ReturnType<typeof vi.fn>;
  };
  let guard: AuthorizationGuard;

  beforeEach(() => {
    service = { resolvePrincipal: vi.fn() };
    audit = { authorizationDenied: vi.fn(), credentialMutation: vi.fn() };
    guard = new AuthorizationGuard(
      new Reflector(),
      service as unknown as AuthorizationService,
      audit as unknown as SecurityAuditService,
    );
  });

  it("fails closed when no route policy exists", async () => {
    await expect(
      guard.canActivate(contextFor({ ...sessionRequest }, unclassifiedHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets a station use only a station-or-cabinet policy", async () => {
    await expect(
      guard.canActivate(contextFor({ ...stationRequest }, sharedReadHandler)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor({ ...stationRequest }, cabinetWriteHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("requires every declared capability for a session", async () => {
    service.resolvePrincipal.mockResolvedValue(managerPrincipal);
    await expect(
      guard.canActivate(contextFor({ ...sessionRequest }, operationalHandler)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor({ ...sessionRequest }, credentialHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows member to call only the membership bootstrap policy", async () => {
    service.resolvePrincipal.mockResolvedValue(memberPrincipal);
    await expect(
      guard.canActivate(contextFor({ ...sessionRequest }, accessMeHandler)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor({ ...sessionRequest }, operationalHandler)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
