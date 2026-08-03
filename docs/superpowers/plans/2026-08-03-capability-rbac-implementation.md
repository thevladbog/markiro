# Capability-Based Cabinet RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce capability-based authorization for every cabinet request so managers own operations, administrators own integrations/settings/credentials, owners additionally own organization membership, and members have no cabinet access.

**Architecture:** A browser-safe capability vocabulary and pure role resolver live in `@markiro/domain`. Better Auth keeps its organization membership store and gains a static `manager` role, while a Nest authorization boundary reloads the active membership on every cabinet request and enforces explicit route policies. The admin app bootstraps effective capabilities from `GET /access/me` and uses that server-produced document for navigation, route, and sensitive-action gating.

**Tech Stack:** TypeScript 6, Better Auth 1.6.23 organization plugin, NestJS 11 guards/metadata, Drizzle ORM 0.45/PostgreSQL, React 19, React Router 8, TanStack Query 5, Vitest 4, Supertest.

## Global Constraints

- The server is the authoritative authorization boundary; UI checks are usability controls only.
- `manager` receives `operations.read` and `operations.write`.
- `admin` receives all manager capabilities plus `integrations.read`, `integrations.write`, `tenant.settings.manage`, and `credentials.manage`.
- `owner` receives all admin capabilities plus `members.manage`.
- `member` and unknown roles receive no cabinet capabilities.
- Better Auth comma-separated multi-role memberships receive the union of recognized-role capabilities; unknown entries add nothing.
- Better Auth's built-in organization mutation endpoints remain owner-only; `admin`, `manager`, and `member` get non-mutating organization access only.
- `admin` receives only Better Auth's internal `apiKey.create` permission needed by server-side issuance; generic `/api/auth/api-key/*` HTTP management endpoints are blocked.
- Handlers declaring multiple capabilities use all-of semantics.
- `GET /access/me` is explicitly membership-only and returns an empty capability list for a valid `member`.
- Membership and role are loaded per request; do not add cross-request authorization caching.
- No database migration is required: `member.role` remains the existing text column.
- Station API keys, kiosk tokens, public API consumers, and `/1c_exchange` keep their current authentication behavior.
- A station may continue to call the existing shared product/shift routes, but a session caller on the same route must pass the relevant cabinet permission.
- Security logs must never include API keys, pairing codes, exchange secrets, cookies, or authorization headers.

---

## File Structure

### Shared contract

- Create `packages/domain/src/access/cabinet.ts` — capability constants, role normalization, deterministic role-to-capability resolution, all-of helper.
- Create `packages/domain/test/cabinet-access.test.ts` — exact role matrix and multi-role tests.
- Modify `packages/domain/src/index.ts` — public exports used by API and admin.

### Better Auth organization access

- Create `packages/db/src/organization-access.ts` — one static Better Auth access-control instance and the four organization roles.
- Create `packages/db/test/organization-access.test.ts` — owner-only organization mutation checks.
- Modify `packages/db/src/auth-config.ts` — register `organization({ ac, roles })`.
- Modify `apps/api/src/auth/auth.setup.ts` — block Better Auth's generic HTTP API-key management surface before mounting the general auth handler.
- Modify `packages/db/package.json` — expose the browser-safe `./organization-access` subpath.
- Modify `apps/admin/package.json` and `pnpm-lock.yaml` — add the workspace subpath provider as a dependency.
- Modify `apps/admin/src/auth/client.ts` — pass the same static Better Auth role configuration to `organizationClient`.
- Modify `apps/api/test/auth.e2e.test.ts` — prove the generic API-key HTTP endpoint is unreachable.

### API authorization boundary

- Create `apps/api/src/authorization/access-policy.ts` — explicit route-policy metadata and decorators.
- Create `apps/api/src/authorization/authorization.service.ts` — tenant-scoped membership lookup and principal construction.
- Create `apps/api/src/authorization/authorization.guard.ts` — fail-closed policy evaluation.
- Create `apps/api/src/authorization/security-audit.service.ts` — structured denial and credential-mutation logging.
- Create `apps/api/src/tenancy/station-only.guard.ts` — reject Better Auth sessions on station-only routes.
- Create `apps/api/src/authorization/access.controller.ts` — `GET /access/me`.
- Create `apps/api/src/authorization/authorization.module.ts` — global providers/controller.
- Create `apps/api/test/authorization.service.test.ts`, `authorization.guard.test.ts`, and `security-audit.service.test.ts`.
- Create `apps/api/test/station-only.guard.test.ts`.
- Modify `apps/api/src/tenancy/tenant.guard.ts` and `apps/api/test/tenant.guard.test.ts` — attach explicit `authKind`.
- Modify `apps/api/src/app.module.ts` — import the authorization module.

### API route policies

- Modify every cabinet controller listed in Tasks 4 and 5 — replace `SessionOnlyGuard` with `AuthorizationGuard` and exact capability metadata.
- Delete `apps/api/src/tenancy/session-only.guard.ts` after the last use is removed.
- Create `apps/api/test/authorization-metadata.test.ts` — architectural coverage for controller guards and policies.
- Create `apps/api/test/authorization.e2e.test.ts` — representative owner/admin/manager/member matrix.
- Modify `apps/api/test/support/auth.ts` — role-changing test helper.

### Admin access boundary

- Create `apps/admin/src/access/api.ts` — `/access/me` query.
- Create `apps/admin/src/access/context.tsx` — access provider, `useCan`, and route gate.
- Create `apps/admin/src/access/NoCabinetAccess.tsx` — intentional member/stale-membership state.
- Create `apps/admin/src/access/ForbiddenPage.tsx` — explicit direct-route denial.
- Create `apps/admin/test/access.test.tsx` and `apps/admin/test/access-routing.test.tsx`.
- Modify `apps/admin/src/pages/Shell.tsx` — load access after session/organization.
- Modify `apps/admin/src/app.tsx` — capability-protected route elements.
- Modify `apps/admin/src/layout/AppShell.tsx` — capability-filtered navigation.
- Modify `apps/admin/src/pages/kiosks/index.tsx`, `pages/catalog/ProductForm.tsx`, `pages/integrations/ChannelPage.tsx`, and `pages/integrations/ApiKeysPanel.tsx` — sensitive-action gating.
- Modify operational page components listed in Task 9 — hide ordinary mutations without `operations.write`.
- Modify `apps/admin/src/i18n/ru.json` and `en.json` — no-access/forbidden copy.
- Update shell/layout and affected page tests.

### Rollout

- Create `docs/runbooks/cabinet-rbac-rollout.md` — membership inventory, promotion, deploy, smoke, and rollback procedure.
- Modify `docs/architecture.md` — durable authorization-boundary summary.
- Modify `docs/device-key-surface.md` — replace obsolete `SessionOnlyGuard` terminology with explicit cabinet/shared/station-only policies.

---

### Task 1: Define the Shared Capability Contract

**Files:**

- Create: `packages/domain/src/access/cabinet.ts`
- Create: `packages/domain/test/cabinet-access.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Produces: `CABINET_CAPABILITY`, `CabinetCapability`, `CabinetRole`, `ResolvedCabinetAccess`, `resolveCabinetAccess(rawRole)`, and `hasCabinetCapabilities(actual, required)`.
- Consumes: nothing outside `@markiro/domain`.

- [ ] **Step 1: Write the failing role-matrix tests**

```ts
import { describe, expect, it } from "vitest";
import {
  CABINET_CAPABILITY as C,
  hasCabinetCapabilities,
  resolveCabinetAccess,
} from "../src/access/cabinet.js";

describe("resolveCabinetAccess", () => {
  it("gives a manager operations only", () => {
    expect(resolveCabinetAccess("manager")).toEqual({
      roles: ["manager"],
      capabilities: [C.OPERATIONS_READ, C.OPERATIONS_WRITE],
    });
  });

  it("makes admin a superset of manager and owner a superset of admin", () => {
    expect(resolveCabinetAccess("admin").capabilities).toEqual([
      C.OPERATIONS_READ,
      C.OPERATIONS_WRITE,
      C.INTEGRATIONS_READ,
      C.INTEGRATIONS_WRITE,
      C.TENANT_SETTINGS_MANAGE,
      C.CREDENTIALS_MANAGE,
    ]);
    expect(resolveCabinetAccess("owner").capabilities).toEqual([
      C.OPERATIONS_READ,
      C.OPERATIONS_WRITE,
      C.INTEGRATIONS_READ,
      C.INTEGRATIONS_WRITE,
      C.TENANT_SETTINGS_MANAGE,
      C.CREDENTIALS_MANAGE,
      C.MEMBERS_MANAGE,
    ]);
  });

  it("gives member and unknown roles no capabilities", () => {
    expect(resolveCabinetAccess("member").capabilities).toEqual([]);
    expect(resolveCabinetAccess("future-role").capabilities).toEqual([]);
  });

  it("normalizes a comma-separated multi-role membership", () => {
    expect(resolveCabinetAccess(" member, admin,admin, future-role ")).toEqual({
      roles: ["member", "admin"],
      capabilities: [
        C.OPERATIONS_READ,
        C.OPERATIONS_WRITE,
        C.INTEGRATIONS_READ,
        C.INTEGRATIONS_WRITE,
        C.TENANT_SETTINGS_MANAGE,
        C.CREDENTIALS_MANAGE,
      ],
    });
  });

  it("checks every required capability", () => {
    const admin = resolveCabinetAccess("admin").capabilities;
    expect(hasCabinetCapabilities(admin, [C.INTEGRATIONS_WRITE, C.CREDENTIALS_MANAGE])).toBe(true);
    expect(hasCabinetCapabilities(admin, [C.MEMBERS_MANAGE])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/domain test -- cabinet-access.test.ts`
Expected: FAIL because `src/access/cabinet.ts` does not exist.

- [ ] **Step 3: Implement the capability vocabulary and resolver**

```ts
export const CABINET_CAPABILITY = {
  OPERATIONS_READ: "operations.read",
  OPERATIONS_WRITE: "operations.write",
  INTEGRATIONS_READ: "integrations.read",
  INTEGRATIONS_WRITE: "integrations.write",
  TENANT_SETTINGS_MANAGE: "tenant.settings.manage",
  CREDENTIALS_MANAGE: "credentials.manage",
  MEMBERS_MANAGE: "members.manage",
} as const;

export type CabinetCapability = (typeof CABINET_CAPABILITY)[keyof typeof CABINET_CAPABILITY];
export type CabinetRole = "owner" | "admin" | "manager" | "member";

export interface ResolvedCabinetAccess {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

const C = CABINET_CAPABILITY;
const CAPABILITY_ORDER: CabinetCapability[] = [
  C.OPERATIONS_READ,
  C.OPERATIONS_WRITE,
  C.INTEGRATIONS_READ,
  C.INTEGRATIONS_WRITE,
  C.TENANT_SETTINGS_MANAGE,
  C.CREDENTIALS_MANAGE,
  C.MEMBERS_MANAGE,
];

const ROLE_CAPABILITIES: Record<CabinetRole, readonly CabinetCapability[]> = {
  member: [],
  manager: [C.OPERATIONS_READ, C.OPERATIONS_WRITE],
  admin: [
    C.OPERATIONS_READ,
    C.OPERATIONS_WRITE,
    C.INTEGRATIONS_READ,
    C.INTEGRATIONS_WRITE,
    C.TENANT_SETTINGS_MANAGE,
    C.CREDENTIALS_MANAGE,
  ],
  owner: CAPABILITY_ORDER,
};

function isCabinetRole(value: string): value is CabinetRole {
  return value === "owner" || value === "admin" || value === "manager" || value === "member";
}

export function resolveCabinetAccess(rawRole: string): ResolvedCabinetAccess {
  const roles = Array.from(
    new Set(
      rawRole
        .split(",")
        .map((role) => role.trim())
        .filter(isCabinetRole),
    ),
  );
  const granted = new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role]));
  return {
    roles,
    capabilities: CAPABILITY_ORDER.filter((capability) => granted.has(capability)),
  };
}

export function hasCabinetCapabilities(
  actual: readonly CabinetCapability[],
  required: readonly CabinetCapability[],
): boolean {
  const granted = new Set(actual);
  return required.every((capability) => granted.has(capability));
}
```

Export these values/types from `packages/domain/src/index.ts`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @markiro/domain test -- cabinet-access.test.ts`
Expected: PASS.

Run: `pnpm --filter @markiro/domain typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/access/cabinet.ts packages/domain/src/index.ts packages/domain/test/cabinet-access.test.ts
git commit -m "feat(domain): define cabinet capabilities"
```

---

### Task 2: Configure Better Auth Organization Roles

**Files:**

- Create: `packages/db/src/organization-access.ts`
- Create: `packages/db/test/organization-access.test.ts`
- Modify: `packages/db/src/auth-config.ts`
- Modify: `packages/db/package.json`
- Modify: `apps/admin/package.json`
- Modify: `apps/admin/src/auth/client.ts`
- Modify: `apps/api/src/auth/auth.setup.ts`
- Modify: `apps/api/test/auth.e2e.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `organizationAccessControl` and `organizationRoles` from `@markiro/db/organization-access`.
- Consumes: Better Auth 1.6.23 `defaultStatements`, `ownerAc`, and `memberAc`.
- Policy: owner keeps organization mutation rights; admin/manager/member use the non-mutating `memberAc` statements, with only admin additionally receiving internal `apiKey.create`.

- [ ] **Step 1: Write the failing Better Auth role-policy test**

```ts
import { describe, expect, it } from "vitest";
import { organizationRoles } from "../src/organization-access.js";

describe("Better Auth organization roles", () => {
  it("allows only owner to mutate the organization and members", () => {
    expect(organizationRoles.owner.authorize({ organization: ["update"] }).success).toBe(true);
    expect(organizationRoles.owner.authorize({ member: ["update"] }).success).toBe(true);

    for (const role of [
      organizationRoles.admin,
      organizationRoles.manager,
      organizationRoles.member,
    ]) {
      expect(role.authorize({ organization: ["update"] }).success).toBe(false);
      expect(role.authorize({ member: ["update"] }).success).toBe(false);
      expect(role.authorize({ invitation: ["create"] }).success).toBe(false);
    }
  });

  it("keeps non-mutating access-control discovery for known members", () => {
    expect(organizationRoles.admin.authorize({ ac: ["read"] }).success).toBe(true);
    expect(organizationRoles.manager.authorize({ ac: ["read"] }).success).toBe(true);
    expect(organizationRoles.member.authorize({ ac: ["read"] }).success).toBe(true);
  });

  it("gives only admin and owner the internal permission needed to mint org keys", () => {
    expect(organizationRoles.owner.authorize({ apiKey: ["create"] }).success).toBe(true);
    expect(organizationRoles.admin.authorize({ apiKey: ["create"] }).success).toBe(true);
    expect(organizationRoles.admin.authorize({ apiKey: ["read"] }).success).toBe(false);
    expect(organizationRoles.manager.authorize({ apiKey: ["create"] }).success).toBe(false);
    expect(organizationRoles.member.authorize({ apiKey: ["create"] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/db test -- organization-access.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create one static Better Auth access-control configuration**

```ts
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

export const organizationAccessControl = createAccessControl({
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
});

export const organizationRoles = {
  owner: organizationAccessControl.newRole({
    ...ownerAc.statements,
    apiKey: ["create", "read", "update", "delete"],
  }),
  admin: organizationAccessControl.newRole({
    ...memberAc.statements,
    apiKey: ["create"],
  }),
  manager: organizationAccessControl.newRole({
    ...memberAc.statements,
    apiKey: [],
  }),
  member: organizationAccessControl.newRole({
    ...memberAc.statements,
    apiKey: [],
  }),
};
```

In `auth-config.ts` replace `organization()` with:

```ts
organization({
  ac: organizationAccessControl,
  roles: organizationRoles,
});
```

Expose a browser-safe subpath from `packages/db/package.json`:

```json
"./organization-access": {
  "types": "./dist/organization-access.d.ts",
  "default": "./dist/organization-access.js"
}
```

- [ ] **Step 4: Wire the identical configuration into the organization client**

Run: `pnpm --filter @markiro/admin add '@markiro/db@workspace:*'`
Expected: `apps/admin/package.json` and `pnpm-lock.yaml` change without downloading a new external package.

Update `apps/admin/src/auth/client.ts`:

```ts
import { organizationAccessControl, organizationRoles } from "@markiro/db/organization-access";

const realAuthClient = createAuthClient({
  plugins: [
    organizationClient({
      ac: organizationAccessControl,
      roles: organizationRoles,
    }),
  ],
}) as unknown as AuthClientLike;
```

- [ ] **Step 5: Block the generic Better Auth API-key HTTP surface**

In `mountAuth`, register a narrow route before the catch-all Better Auth handler:

```ts
server.all("/api/auth/api-key/*splat", (_request, response) => {
  response.sendStatus(404);
});
server.all("/api/auth/*splat", toNodeHandler(auth));
```

This blocks browser/session calls to Better Auth's create/list/update/delete endpoints while leaving direct server calls such as `auth.api.createApiKey` and `auth.api.verifyApiKey` intact.

Import `signUpAndActivate` from `test/support/auth.ts` and add this e2e assertion:

```ts
it("does not expose Better Auth's generic API-key management endpoint", async () => {
  const agent = request.agent(app!.getHttpServer());
  const organizationId = await signUpAndActivate(agent);

  await agent
    .post("/api/auth/api-key/create")
    .send({ configId: "station", organizationId, name: "bypass" })
    .expect(404);
});
```

- [ ] **Step 6: Run focused tests, builds, and typechecks**

Run: `pnpm --filter @markiro/db test -- organization-access.test.ts`
Expected: PASS.

Run: `pnpm --filter @markiro/db build`
Expected: PASS and `dist/organization-access.js` exists.

Run: `pnpm --filter @markiro/admin typecheck`
Expected: PASS with the custom `manager` role accepted by `organizationClient`.

Run: `pnpm --filter @markiro/api test -- auth.e2e.test.ts`
Expected: PASS with the normal Postgres/auth env, including the generic API-key endpoint returning `404`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/organization-access.ts packages/db/src/auth-config.ts packages/db/package.json packages/db/test/organization-access.test.ts apps/admin/package.json apps/admin/src/auth/client.ts apps/api/src/auth/auth.setup.ts apps/api/test/auth.e2e.test.ts pnpm-lock.yaml
git commit -m "feat(auth): configure cabinet organization roles"
```

---

### Task 3: Build the API Authorization Boundary

**Files:**

- Create: `apps/api/src/authorization/access-policy.ts`
- Create: `apps/api/src/authorization/authorization.service.ts`
- Create: `apps/api/src/authorization/authorization.guard.ts`
- Create: `apps/api/src/authorization/security-audit.service.ts`
- Create: `apps/api/src/tenancy/station-only.guard.ts`
- Create: `apps/api/src/authorization/access.controller.ts`
- Create: `apps/api/src/authorization/authorization.module.ts`
- Create: `apps/api/test/authorization.service.test.ts`
- Create: `apps/api/test/authorization.guard.test.ts`
- Create: `apps/api/test/security-audit.service.test.ts`
- Create: `apps/api/test/station-only.guard.test.ts`
- Modify: `apps/api/src/tenancy/tenant.guard.ts`
- Modify: `apps/api/test/tenant.guard.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Consumes: `resolveCabinetAccess` and `hasCabinetCapabilities` from Task 1; `DB` and `schema.member`.
- Produces: `RouteAccessPolicy`, `RequirePermissions`, `AllowStationOrPermissions`, `RequireMembership`, `AuthorizationService.resolvePrincipal(userId, tenantId)`, `AuthorizationGuard`, `SecurityAuditService`, and `GET /access/me`.
- Request extension: `authKind?: "session" | "station"` and `cabinetPrincipal?: CabinetPrincipal`.

- [ ] **Step 1: Write failing service tests for tenant-scoped membership resolution**

Use a condition-aware fake DB like `tenant.guard.test.ts`. Cover:

```ts
it("resolves only the membership matching both user and active tenant", async () => {
  const principal = await service.resolvePrincipal("user_1", "org_1");
  expect(principal).toEqual({
    userId: "user_1",
    tenantId: "org_1",
    roles: ["manager"],
    capabilities: ["operations.read", "operations.write"],
  });
});

it("returns null when only a cross-tenant membership exists", async () => {
  await expect(service.resolvePrincipal("user_1", "org_other")).resolves.toBeNull();
});

it("reloads the role on every call", async () => {
  expect((await service.resolvePrincipal("user_1", "org_1"))?.roles).toEqual(["manager"]);
  membershipRows[0]!.role = "admin";
  expect((await service.resolvePrincipal("user_1", "org_1"))?.roles).toEqual(["admin"]);
});
```

- [ ] **Step 2: Write failing guard-policy tests**

Define dummy handlers with the real decorators and assert:

```ts
it("fails closed when no route policy exists", async () => {
  await expect(
    guard.canActivate(contextFor(sessionRequest, unclassifiedHandler)),
  ).rejects.toBeInstanceOf(ForbiddenException);
});

it("lets a station use only a station-or-cabinet policy", async () => {
  await expect(guard.canActivate(contextFor(stationRequest, sharedReadHandler))).resolves.toBe(
    true,
  );
  await expect(
    guard.canActivate(contextFor(stationRequest, cabinetWriteHandler)),
  ).rejects.toBeInstanceOf(ForbiddenException);
});

it("requires every declared capability for a session", async () => {
  service.resolvePrincipal.mockResolvedValue(managerPrincipal);
  await expect(guard.canActivate(contextFor(sessionRequest, operationalHandler))).resolves.toBe(
    true,
  );
  await expect(
    guard.canActivate(contextFor(sessionRequest, credentialHandler)),
  ).rejects.toBeInstanceOf(ForbiddenException);
});

it("allows member to call only the membership bootstrap policy", async () => {
  service.resolvePrincipal.mockResolvedValue(memberPrincipal);
  await expect(guard.canActivate(contextFor(sessionRequest, accessMeHandler))).resolves.toBe(true);
  await expect(
    guard.canActivate(contextFor(sessionRequest, operationalHandler)),
  ).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [ ] **Step 3: Run the focused tests to verify they fail**

Run: `pnpm --filter @markiro/api test -- authorization.service.test.ts authorization.guard.test.ts`
Expected: FAIL because the authorization classes do not exist.

- [ ] **Step 4: Implement explicit route-policy metadata**

```ts
import { SetMetadata } from "@nestjs/common";
import type { CabinetCapability } from "@markiro/domain";

export const ROUTE_ACCESS_POLICY = Symbol("ROUTE_ACCESS_POLICY");

export type RouteAccessPolicy =
  | { mode: "cabinet"; capabilities: readonly CabinetCapability[] }
  | { mode: "station-or-cabinet"; capabilities: readonly CabinetCapability[] }
  | { mode: "membership" };

export const RequirePermissions = (...capabilities: CabinetCapability[]) =>
  SetMetadata(ROUTE_ACCESS_POLICY, { mode: "cabinet", capabilities } satisfies RouteAccessPolicy);

export const AllowStationOrPermissions = (...capabilities: CabinetCapability[]) =>
  SetMetadata(ROUTE_ACCESS_POLICY, {
    mode: "station-or-cabinet",
    capabilities,
  } satisfies RouteAccessPolicy);

export const RequireMembership = () =>
  SetMetadata(ROUTE_ACCESS_POLICY, { mode: "membership" } satisfies RouteAccessPolicy);
```

- [ ] **Step 5: Implement the membership service and typed principal**

```ts
export interface CabinetPrincipal extends ResolvedCabinetAccess {
  userId: string;
  tenantId: string;
}

@Injectable()
export class AuthorizationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async resolvePrincipal(userId: string, tenantId: string): Promise<CabinetPrincipal | null> {
    const [membership] = await this.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, tenantId)));
    if (!membership) return null;
    return { userId, tenantId, ...resolveCabinetAccess(membership.role) };
  }
}
```

- [ ] **Step 6: Mark the authenticated principal kind in `TenantGuard`**

On the session branch set `req.authKind = "session"`. On the verified station-key branch set `req.authKind = "station"`. Extend `RequestWithTenant` with `authKind` and `cabinetPrincipal`, then extend `tenant.guard.test.ts` to assert both values. Do not infer station identity from `deviceId` because a valid key may currently have no matching device row.

Run: `pnpm --filter @markiro/api test -- tenant.guard.test.ts`
Expected: PASS.

- [ ] **Step 7: Add a station-only guard**

```ts
@Injectable()
export class StationOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    if (request.authKind !== "station") {
      throw new ForbiddenException("Station device authentication required");
    }
    return true;
  }
}
```

Test that `authKind: "station"` passes and `authKind: "session"` or missing `authKind` returns `403`. Do not require `deviceId` in this guard; `StationScansController` keeps its stricter existing device-row check.

- [ ] **Step 8: Implement fail-closed guard evaluation**

```ts
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly audit: SecurityAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const policy = this.reflector.getAllAndOverride<RouteAccessPolicy>(ROUTE_ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return this.deny(request, "missing_policy");

    if (request.authKind === "station") {
      if (policy.mode === "station-or-cabinet") return true;
      return this.deny(request, "session_required");
    }

    if (request.authKind !== "session" || !request.userId || !request.tenantId) {
      return this.deny(request, "session_required");
    }

    const principal = await this.authorization.resolvePrincipal(request.userId, request.tenantId);
    if (!principal) return this.deny(request, "membership_missing");
    request.cabinetPrincipal = principal;

    if (policy.mode === "membership") return true;
    if (hasCabinetCapabilities(principal.capabilities, policy.capabilities)) return true;
    return this.deny(request, "insufficient_permission", policy.capabilities);
  }

  private deny(
    request: RequestWithTenant,
    reason: string,
    required: readonly CabinetCapability[] = [],
  ): never {
    this.audit.authorizationDenied({
      tenantId: request.tenantId ?? null,
      userId: request.userId ?? null,
      reason,
      required,
    });
    throw new ForbiddenException("Insufficient cabinet permissions");
  }
}
```

- [ ] **Step 9: Add structured security logging without secrets**

`SecurityAuditService` exposes:

```ts
authorizationDenied(event: {
  tenantId: string | null;
  userId: string | null;
  reason: string;
  required: readonly CabinetCapability[];
}): void;

credentialMutation(event: {
  tenantId: string;
  userId: string;
  action: string;
  resourceId: string | null;
}): void;
```

Each method writes one JSON object through a dedicated Nest `Logger("SecurityAudit")`. The logger accepts only the listed fields. Test the emitted JSON keys and assert serialized output does not contain `key`, `secret`, `token`, `code`, `cookie`, or `authorization` fields.

- [ ] **Step 10: Add `GET /access/me` and the global module**

```ts
export interface AccessDocumentDto {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

@Controller("access")
@UseGuards(TenantGuard, AuthorizationGuard)
export class AccessController {
  @Get("me")
  @RequireMembership()
  me(@Req() request: RequestWithTenant): AccessDocumentDto {
    const principal = request.cabinetPrincipal!;
    return { roles: principal.roles, capabilities: principal.capabilities };
  }
}
```

Make `AuthorizationModule` global, register/export `AuthorizationService`, `AuthorizationGuard`, and `SecurityAuditService`, register `AccessController`, and import the module from `AppModule.forRoot`.

- [ ] **Step 11: Run focused tests and typecheck**

Run: `pnpm --filter @markiro/api test -- authorization.service.test.ts authorization.guard.test.ts security-audit.service.test.ts station-only.guard.test.ts tenant.guard.test.ts`
Expected: PASS.

Run: `pnpm --filter @markiro/api typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/authorization apps/api/src/tenancy/tenant.guard.ts apps/api/src/tenancy/station-only.guard.ts apps/api/src/app.module.ts apps/api/test/authorization.service.test.ts apps/api/test/authorization.guard.test.ts apps/api/test/security-audit.service.test.ts apps/api/test/station-only.guard.test.ts apps/api/test/tenant.guard.test.ts
git commit -m "feat(api): add cabinet authorization boundary"
```

---

### Task 4: Protect Operational and Shared Station Routes

**Files:**

- Create: `apps/api/test/authorization-metadata.test.ts`
- Modify: `apps/api/src/modules/boxes/boxes.controller.ts`
- Modify: `apps/api/src/modules/box-exceptions/box-exceptions.controller.ts`
- Modify: `apps/api/src/modules/employees/employees.controller.ts`
- Modify: `apps/api/src/modules/pickup-reasons/pickup-reasons.controller.ts`
- Modify: `apps/api/src/modules/lines/lines.controller.ts`
- Modify: `apps/api/src/modules/counterparties/counterparties.controller.ts`
- Modify: `apps/api/src/modules/label-templates/label-templates.controller.ts`
- Modify: `apps/api/src/modules/conflicts/conflicts.controller.ts`
- Modify: `apps/api/src/modules/operators/operators.controller.ts`
- Modify: `apps/api/src/modules/pickup-rejections/pickup-rejections.controller.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.controller.ts`
- Modify: `apps/api/src/modules/products/products.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/src/modules/operators/station-operators.controller.ts`
- Modify: `apps/api/src/modules/station-scans/station-scans.controller.ts`
- Modify: `apps/api/test/station-auth.e2e.test.ts`

**Interfaces:**

- Consumes: `AuthorizationGuard` and route decorators from Task 3.
- Produces: explicit operational policies on every listed handler.
- Shared route rule: station succeeds without cabinet membership; a session caller still needs the declared operation capability.

- [ ] **Step 1: Write the failing architectural metadata test**

Use Nest's `GUARDS_METADATA`/`PATH_METADATA` and `Reflector.getAllAndOverride` to inspect each controller prototype. The test must:

1. Assert every listed controller has both `TenantGuard` and `AuthorizationGuard` at class level.
2. Enumerate every decorated route method and assert it resolves a `ROUTE_ACCESS_POLICY` from method or class.
3. Assert no listed source file contains `SessionOnlyGuard`.

The first controller list is:

```ts
const OPERATIONAL_CONTROLLERS = [
  BoxesController,
  BoxExceptionsController,
  EmployeesController,
  PickupReasonsController,
  LinesController,
  CounterpartiesController,
  LabelTemplatesController,
  ConflictsController,
  OperatorsController,
  PickupRejectionsController,
  PickupOrdersController,
  ProductsController,
  ShiftsController,
];

const reflector = new Reflector();

for (const controller of OPERATIONAL_CONTROLLERS) {
  const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
  expect(classGuards).toContain(TenantGuard);
  expect(classGuards).toContain(AuthorizationGuard);

  const prototype = controller.prototype as Record<string, (...args: never[]) => unknown>;
  for (const methodName of Object.getOwnPropertyNames(prototype)) {
    if (methodName === "constructor") continue;
    const handler = prototype[methodName]!;
    if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

    const methodGuards = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    const guardNames = [...classGuards, ...methodGuards].map(
      (guard: { name?: string }) => guard.name,
    );
    expect(guardNames).not.toContain("SessionOnlyGuard");

    const policy = reflector.getAllAndOverride<RouteAccessPolicy>(ROUTE_ACCESS_POLICY, [
      handler,
      controller,
    ]);
    expect(policy, controller.name + "." + methodName).toBeDefined();
  }
}
```

- [ ] **Step 2: Run the metadata test to verify it fails**

Run: `pnpm --filter @markiro/api test -- authorization-metadata.test.ts`
Expected: FAIL on the first controller still using `SessionOnlyGuard` or lacking a policy.

- [ ] **Step 3: Apply this exact operational policy matrix**

Use class-level `@RequirePermissions` only when every method has the same policy. Otherwise annotate each handler:

| Controller method(s)                                  | Policy             |
| ----------------------------------------------------- | ------------------ |
| `BoxesController.list`                                | `operations.read`  |
| `BoxExceptionsController.list`                        | `operations.read`  |
| `EmployeesController.list`                            | `operations.read`  |
| Employee create/update/delete and badge create/delete | `operations.write` |
| `PickupReasonsController.list`                        | `operations.read`  |
| Pickup reason create/update/delete                    | `operations.write` |
| Lines list/get                                        | `operations.read`  |
| Lines create/update/delete                            | `operations.write` |
| Counterparties list/get/getSscc                       | `operations.read`  |
| Counterparties create/update/delete/putSscc           | `operations.write` |
| Label templates list/get                              | `operations.read`  |
| Label templates create/update/delete                  | `operations.write` |
| `ConflictsController.list`                            | `operations.read`  |
| `ConflictsController.review`                          | `operations.write` |
| `OperatorsController.list`                            | `operations.read`  |
| Operator grant/update/revoke                          | `operations.write` |
| `PickupRejectionsController.list`                     | `operations.read`  |
| Pickup rejection acknowledge                          | `operations.write` |
| Pickup orders list/get/slip                           | `operations.read`  |
| Pickup order resolve/cancel/export                    | `operations.write` |

Every class uses:

```ts
@UseGuards(TenantGuard, AuthorizationGuard)
```

Every read/write handler uses:

```ts
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
// or
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
```

- [ ] **Step 4: Protect the mixed product controller without breaking stations**

Apply:

| `ProductsController` method                       | Policy                                       |
| ------------------------------------------------- | -------------------------------------------- |
| `listProducts`                                    | `AllowStationOrPermissions(operations.read)` |
| `checkGtinOwner`                                  | `AllowStationOrPermissions(operations.read)` |
| `getProduct`                                      | `RequirePermissions(operations.read)`        |
| `createProduct`, `updateProduct`, `deleteProduct` | `RequirePermissions(operations.write)`       |

Remove every method-level `SessionOnlyGuard`.

- [ ] **Step 5: Protect the mixed shift controller without breaking stations**

Apply:

| `ShiftsController` method                  | Policy                                        |
| ------------------------------------------ | --------------------------------------------- |
| `listShifts`                               | `AllowStationOrPermissions(operations.read)`  |
| `createShift`                              | `AllowStationOrPermissions(operations.write)` |
| `getShift`                                 | `RequirePermissions(operations.read)`         |
| `updateShift`, `deleteShift`, `closeShift` | `RequirePermissions(operations.write)`        |
| `openShift`                                | `AllowStationOrPermissions(operations.write)` |
| `getBundle`                                | `AllowStationOrPermissions(operations.read)`  |

The station paths keep the same HTTP behavior; only session callers gain membership/capability enforcement.

- [ ] **Step 6: Run metadata, unit, and representative regressions**

Before running them, apply `@UseGuards(TenantGuard, StationOnlyGuard)` to `StationOperatorsController` and `StationScansController`. Keep the scan handler's existing `deviceId` assertion. Add a regression proving a Better Auth session receives `403` from `GET /station/operators` while the enrolled station key still receives `200`.

Extend `authorization-metadata.test.ts` with a separate assertion that both station-only controllers carry `TenantGuard` plus `StationOnlyGuard` and do not carry `AuthorizationGuard`; they are machine routes, not cabinet routes.

Run: `pnpm --filter @markiro/api test -- authorization-metadata.test.ts products.e2e.test.ts shifts.e2e.test.ts shifts-bundle.e2e.test.ts employees.e2e.test.ts pickup-orders.e2e.test.ts`
Expected: metadata PASS; database suites PASS when env is available and remain explicitly skipped only under their existing env gate.

Run: `pnpm --filter @markiro/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/boxes/boxes.controller.ts apps/api/src/modules/box-exceptions/box-exceptions.controller.ts apps/api/src/modules/employees/employees.controller.ts apps/api/src/modules/pickup-reasons/pickup-reasons.controller.ts apps/api/src/modules/lines/lines.controller.ts apps/api/src/modules/counterparties/counterparties.controller.ts apps/api/src/modules/label-templates/label-templates.controller.ts apps/api/src/modules/conflicts/conflicts.controller.ts apps/api/src/modules/operators/operators.controller.ts apps/api/src/modules/operators/station-operators.controller.ts apps/api/src/modules/station-scans/station-scans.controller.ts apps/api/src/modules/pickup-rejections/pickup-rejections.controller.ts apps/api/src/modules/pickup-orders/pickup-orders.controller.ts apps/api/src/modules/products/products.controller.ts apps/api/src/modules/shifts/shifts.controller.ts apps/api/test/authorization-metadata.test.ts apps/api/test/station-auth.e2e.test.ts
git commit -m "feat(api): enforce operational cabinet permissions"
```

Before committing, inspect `git diff --cached --name-only` and unstage any service/DTO file not intentionally touched by this task.

---

### Task 5: Protect Administrative Routes and Audit Credential Mutations

**Files:**

- Modify: `apps/api/src/modules/org-profile/org-profile.controller.ts`
- Modify: `apps/api/src/modules/integrations/integrations.controller.ts`
- Modify: `apps/api/src/modules/api-keys/api-keys.controller.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.controller.ts`
- Modify: `apps/api/src/modules/kiosks/kiosks.controller.ts`
- Modify: `apps/api/test/authorization-metadata.test.ts`
- Create: `apps/api/test/credential-audit.test.ts`
- Delete: `apps/api/src/tenancy/session-only.guard.ts`

**Interfaces:**

- Consumes: Task 3 policies and `SecurityAuditService.credentialMutation`.
- Produces: integration/settings/credential boundaries and successful sensitive-action audit events.

- [ ] **Step 1: Extend the metadata test and verify it fails**

Add these controllers to the inspected set:

```ts
const ADMINISTRATIVE_CONTROLLERS = [
  AccessController,
  OrgProfileController,
  IntegrationsController,
  ProductExternalLinkController,
  ApiKeysController,
  StationDevicesController,
  KiosksController,
];
```

Run the same metadata loop over `[...OPERATIONAL_CONTROLLERS, ...ADMINISTRATIVE_CONTROLLERS]`. Its guard-name assertion detects any remaining method- or class-level `SessionOnlyGuard` use without importing the soon-to-be-deleted class.

Run: `pnpm --filter @markiro/api test -- authorization-metadata.test.ts`
Expected: FAIL until the controllers are migrated.

- [ ] **Step 2: Apply the tenant-settings policy**

Every `OrgProfileController` handler requires `tenant.settings.manage`, including reads of profile and SSCC settings:

```ts
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE)
```

- [ ] **Step 3: Apply the integration policy matrix**

| Controller method(s)                           | Required capabilities                         |
| ---------------------------------------------- | --------------------------------------------- |
| Integration list/detail/journal/listCandidates | `integrations.read`                           |
| Integration update/link/hide/unhide            | `integrations.write`                          |
| `issueCredentials`                             | `integrations.write` and `credentials.manage` |
| `ProductExternalLinkController.unlink`         | `integrations.write`                          |

Use one decorator with two arguments for issuance; the guard's all-of semantics must require both.

- [ ] **Step 4: Apply machine-credential policies**

All methods in `ApiKeysController` and `StationDevicesController` require `credentials.manage`.

In `KiosksController`:

| Method                            | Required capabilities |
| --------------------------------- | --------------------- |
| list                              | `operations.read`     |
| create/update/archive/setProducts | `operations.write`    |
| enroll/issuePairingCode           | `credentials.manage`  |

Keep kiosk record management operational and credential issuance administrative.

- [ ] **Step 5: Record successful credential mutations**

Inject `SecurityAuditService` into the four relevant controllers and log only after the service call succeeds:

```ts
const result = await this.service.create(...);
this.audit.credentialMutation({
  tenantId: req.tenantId!,
  userId: req.userId!,
  action: "public_api_key.issue",
  resourceId: result.id,
});
return result;
```

Use these stable action names:

- `public_api_key.issue` / `public_api_key.revoke`
- `station_device.enroll` / `station_device.revoke`
- `kiosk.enroll` / `kiosk_pairing_code.issue`
- `integration_credentials.issue`

Never pass the returned key, token, code, login, or secret into the audit service.

Add focused controller tests for all seven action names. The public-key issuance case establishes the pattern:

At the top of the file, isolate station enrollment from process env:

```ts
vi.mock("../src/env", () => ({
  loadEnv: () => ({ BETTER_AUTH_URL: "https://api.example.test" }),
}));
```

```ts
it("audits public API key issuance without the plaintext key", async () => {
  const service = {
    create: vi.fn().mockResolvedValue({ id: "key_1", key: "mk_plaintext" }),
  };
  const audit = { credentialMutation: vi.fn() };
  const controller = new ApiKeysController(service as never, audit as never);

  await controller.create({ tenantId: "org_1", userId: "user_1" } as RequestWithTenant, {
    name: "Warehouse",
  });

  expect(audit.credentialMutation).toHaveBeenCalledWith({
    tenantId: "org_1",
    userId: "user_1",
    action: "public_api_key.issue",
    resourceId: "key_1",
  });
  expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("mk_plaintext");
});
```

Add the remaining exact cases:

| Controller call                                              | Successful service result                            | Expected action                 | Expected resource id |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------- | -------------------- |
| `ApiKeysController.revoke(req, "key_2")`                     | resolves `void`                                      | `public_api_key.revoke`         | `key_2`              |
| `StationDevicesController.enroll(req, body)`                 | `{ deviceId: "station_1", name, apiKey, serverUrl }` | `station_device.enroll`         | `station_1`          |
| `StationDevicesController.revoke(req, "station_2")`          | resolves `void`                                      | `station_device.revoke`         | `station_2`          |
| `KiosksController.enroll(req, "kiosk_1")`                    | `{ token: "plain-token" }`                           | `kiosk.enroll`                  | `kiosk_1`            |
| `KiosksController.issuePairingCode(req, "kiosk_2")`          | `{ code: "12345678", expiresAt }`                    | `kiosk_pairing_code.issue`      | `kiosk_2`            |
| `IntegrationsController.issueCredentials(req, "commerceml")` | `{ login: "plain-login", secret: "plain-secret" }`   | `integration_credentials.issue` | `commerceml`         |

For each returned plaintext fixture, assert its value is absent from the serialized audit calls. Add one rejected-service case per controller class and assert `credentialMutation` was not called.

- [ ] **Step 6: Remove the obsolete session-only guard**

Run: `rg -n "SessionOnlyGuard" apps/api/src`
Expected: no results after comments/imports/decorators are migrated.

Delete `apps/api/src/tenancy/session-only.guard.ts`.

- [ ] **Step 7: Run focused administrative and machine regressions**

Run: `pnpm --filter @markiro/api test -- authorization-metadata.test.ts credential-audit.test.ts org-profile.e2e.test.ts integrations.e2e.test.ts api-keys.e2e.test.ts station-devices.e2e.test.ts kiosks.e2e.test.ts kiosk-pairing.e2e.test.ts station-auth.e2e.test.ts`
Expected: cabinet tests PASS for their owner fixtures; station/kiosk auth regressions PASS unchanged when env is available.

Run: `pnpm --filter @markiro/api typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/org-profile/org-profile.controller.ts apps/api/src/modules/integrations/integrations.controller.ts apps/api/src/modules/api-keys/api-keys.controller.ts apps/api/src/modules/station-devices/station-devices.controller.ts apps/api/src/modules/kiosks/kiosks.controller.ts apps/api/src/tenancy/session-only.guard.ts apps/api/test/authorization-metadata.test.ts apps/api/test/credential-audit.test.ts
git commit -m "feat(api): protect tenant internals and credentials"
```

---

### Task 6: Add the API RBAC Matrix and Better Auth Bypass Tests

**Files:**

- Modify: `apps/api/test/support/auth.ts`
- Create: `apps/api/test/authorization.e2e.test.ts`

**Interfaces:**

- Consumes: complete API authorization boundary from Tasks 1–5.
- Produces: test helpers `setOnlyOrganizationMemberRole(db, organizationId, role)` and end-to-end proof of the agreed matrix.

- [ ] **Step 1: Add a role-changing e2e helper**

```ts
export async function setOnlyOrganizationMemberRole(
  db: Db,
  organizationId: string,
  role: string,
): Promise<void> {
  const rows = await db
    .update(schema.member)
    .set({ role })
    .where(eq(schema.member.organizationId, organizationId))
    .returning({ id: schema.member.id });
  if (rows.length !== 1) {
    throw new Error("Expected exactly one organization member in test fixture");
  }
}
```

Keep `signUpAndActivate`'s existing string return contract so current suites do not churn.

- [ ] **Step 2: Write the end-to-end role matrix**

Create a fresh organization/agent per role scenario. At minimum prove:

```ts
const VALID_KIOSK = {
  name: "Manager kiosk",
  location: null,
  dayLimitPerEmployee: 5,
  showPrices: true,
};

async function activeOrganizationFixture() {
  const agent = request.agent(app!.getHttpServer());
  const organizationId = await signUpAndActivate(agent);
  return { agent, organizationId };
}

it("manager can operate but cannot reach tenant internals", async () => {
  const { agent, organizationId } = await activeOrganizationFixture();
  await setOnlyOrganizationMemberRole(db, organizationId, "manager");

  await agent.get("/products").expect(200);
  await agent.post("/kiosks").send(VALID_KIOSK).expect(201);
  await agent.get("/integrations").expect(403);
  await agent.get("/org/profile").expect(403);
  await agent.get("/station-devices").expect(403);
  await agent.get("/integrations/public_api/keys").expect(403);
});

it("admin inherits operations and can administer integrations/settings/credentials", async () => {
  const { agent, organizationId } = await activeOrganizationFixture();
  await setOnlyOrganizationMemberRole(db, organizationId, "admin");

  await agent.get("/products").expect(200);
  await agent.get("/integrations").expect(200);
  await agent.get("/org/profile").expect(200);
  await agent.get("/station-devices").expect(200);
});

it("member can bootstrap an empty access document but cannot enter operations", async () => {
  const { agent, organizationId } = await activeOrganizationFixture();
  await setOnlyOrganizationMemberRole(db, organizationId, "member");

  expect((await agent.get("/access/me").expect(200)).body).toEqual({
    roles: ["member"],
    capabilities: [],
  });
  await agent.get("/boxes").expect(403);
});
```

Also cover:

- no session returns `401` from `GET /access/me`;
- a valid session without an active organization returns `403`;
- owner `/access/me` contains all seven capabilities;
- unknown role gets `/access/me` with empty roles/capabilities and `403` on operations;
- `admin,member` resolves the admin union;
- deleting the membership makes the next `/access/me` return `403`;
- changing manager to admin changes the next response without re-login;
- a member row from another tenant does not authorize the active tenant.

- [ ] **Step 3: Prove Better Auth's own organization endpoints cannot bypass owner-only membership policy**

Extend `authorization.e2e.test.ts`:

1. An owner can update its organization.
2. After the fixture membership is changed to `admin`, the same Better Auth organization-update endpoint returns `403`.
3. An admin cannot call Better Auth member-role update/invitation mutation endpoints.

Use these Better Auth 1.6.23 requests:

```ts
it("keeps Better Auth organization mutations owner-only", async () => {
  const { agent, organizationId } = await activeOrganizationFixture();

  await agent
    .post("/api/auth/organization/update")
    .send({ organizationId, data: { name: "Owner updated" } })
    .expect(200);

  await setOnlyOrganizationMemberRole(db, organizationId, "admin");

  await agent
    .post("/api/auth/organization/update")
    .send({ organizationId, data: { name: "Admin bypass" } })
    .expect(403);

  await agent
    .post("/api/auth/organization/invite-member")
    .send({
      organizationId,
      email: "invite-target@example.com",
      role: "manager",
    })
    .expect(403);
});
```

- [ ] **Step 4: Run the e2e matrix**

Run: `pnpm --filter @markiro/api test -- authorization.e2e.test.ts auth.e2e.test.ts`
Expected: PASS with the normal Postgres/auth env. If the suite is skipped because env is absent, do not mark this task complete until the same command runs in CI or an env-equipped workspace.

- [ ] **Step 5: Run all API tests**

Run: `pnpm --filter @markiro/api test`
Expected: PASS, including station, kiosk, public API, and 1C regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/support/auth.ts apps/api/test/authorization.e2e.test.ts
git commit -m "test(api): cover cabinet RBAC matrix"
```

---

### Task 7: Bootstrap Effective Access in the Admin App

**Files:**

- Create: `apps/admin/src/access/api.ts`
- Create: `apps/admin/src/access/context.tsx`
- Create: `apps/admin/src/access/NoCabinetAccess.tsx`
- Create: `apps/admin/src/access/ForbiddenPage.tsx`
- Create: `apps/admin/test/access.test.tsx`
- Modify: `apps/admin/src/pages/Shell.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/shell.test.tsx`
- Modify: `apps/admin/test/shell-layout.test.tsx`

**Interfaces:**

- Consumes: `GET /access/me` and shared `CabinetCapability`/`CabinetRole` types.
- Produces: `AccessDocument`, `useAccessDocument(activeOrganizationId)`, `AccessProvider`, `useAccess`, `useCan`, and `NoCabinetAccess`.

- [ ] **Step 1: Write failing access-bootstrap tests**

Test these shell states:

1. Session loading — existing spinner.
2. No session — existing `/login` redirect.
3. No active organization — existing `/org/select` redirect.
4. Active organization + pending `/access/me` — spinner, no app queries.
5. Manager/admin/owner access document — renders shell.
6. Member document with empty capabilities — renders no-access state, not sidebar.
7. `403` from `/access/me` — renders the same intentional no-access state.
8. Non-403 failure — renders retryable load error.
9. Changing active organization changes the query key and refetches access.

Use a path-aware fetch stub:

```ts
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/access/me")) {
      return jsonResponse(200, {
        roles: ["manager"],
        capabilities: ["operations.read", "operations.write"],
      });
    }
    if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
    throw new Error("Unexpected request: " + url);
  }),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/admin test -- access.test.tsx shell.test.tsx`
Expected: FAIL because the shell does not fetch access.

- [ ] **Step 3: Implement the access query**

```ts
export interface AccessDocument {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

export function useAccessDocument(activeOrganizationId: string): UseQueryResult<AccessDocument> {
  return useQuery({
    queryKey: ["cabinet-access", activeOrganizationId],
    queryFn: () => apiFetch<AccessDocument>("/access/me"),
    staleTime: 0,
  });
}
```

The active organization id belongs in the key even though the server derives it from the session cookie.

- [ ] **Step 4: Implement the provider and no-access state**

```tsx
const AccessContext = createContext<AccessDocument | null>(null);

export function AccessProvider({
  value,
  children,
}: {
  value: AccessDocument;
  children: ReactNode;
}) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessDocument {
  const access = useContext(AccessContext);
  if (!access) throw new Error("useAccess must be used inside AccessProvider");
  return access;
}

export function useCan(capability: CabinetCapability): boolean {
  return useAccess().capabilities.includes(capability);
}
```

`NoCabinetAccess` shows translated title/body plus actions to select another organization and sign out. It must not mount `AppShell` or any operational query hooks:

```tsx
export function NoCabinetAccess() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  return (
    <div style={{ padding: "48px 32px" }}>
      <EmptyState
        title={t("access.noAccessTitle")}
        hint={t("access.noAccessBody")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" onClick={() => navigate("/org/select")}>
              {t("access.selectOrganization")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void authClient.signOut().then(() => navigate("/login"))}
            >
              {t("common.signOut")}
            </Button>
          </div>
        }
      />
    </div>
  );
}
```

Define `CenteredSpinner` and `AccessLoadError` as private components in `pages/Shell.tsx`; `AccessLoadError` owns the query `refetch` callback used by the translated retry button.

Create the direct-route denial component now so Task 8 only wires it:

```tsx
export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <div data-testid="forbidden-page" style={{ padding: "48px 32px" }}>
      <EmptyState
        title={t("access.forbiddenTitle")}
        hint={t("access.forbiddenBody")}
        action={<Link to="/">{t("access.backToOverview")}</Link>}
      />
    </div>
  );
}
```

- [ ] **Step 5: Gate `ShellPage` on the access document**

After the existing session and active-org checks:

```tsx
const access = useAccessDocument(session.session.activeOrganizationId);
if (access.isPending) return <CenteredSpinner />;
if (access.error instanceof ApiRequestError && access.error.status === 403) {
  return <NoCabinetAccess />;
}
if (access.isError || !access.data) return <AccessLoadError />;
if (access.data.capabilities.length === 0) return <NoCabinetAccess />;
return (
  <AccessProvider value={access.data}>
    <AppShell />
  </AccessProvider>
);
```

Keep hooks unconditionally ordered by moving the post-session logic into a child component that receives the non-null active organization id; do not call `useAccessDocument` only after conditional returns in the same component.

- [ ] **Step 6: Add RU/EN copy**

Add exact semantic keys under `access`:

- `loading`
- `loadErrorTitle` / `loadErrorBody` / `retry`
- `noAccessTitle` / `noAccessBody`
- `selectOrganization`
- `forbiddenTitle` / `forbiddenBody` / `backToOverview`

Use natural Russian product copy; do not expose internal role names or permission strings in the message.

- [ ] **Step 7: Run admin tests and typecheck**

Run: `pnpm --filter @markiro/admin test -- access.test.tsx shell.test.tsx shell-layout.test.tsx`
Expected: PASS.

Run: `pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/access apps/admin/src/pages/Shell.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/access.test.tsx apps/admin/test/shell.test.tsx apps/admin/test/shell-layout.test.tsx
git commit -m "feat(admin): bootstrap cabinet access"
```

---

### Task 8: Gate Admin Routes, Navigation, and Sensitive Actions

**Files:**

- Create: `apps/admin/test/access-routing.test.tsx`
- Modify: `apps/admin/src/access/context.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/pages/pickup/api.ts`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx`
- Modify: `apps/admin/src/pages/integrations/ApiKeysPanel.tsx`
- Modify: `apps/admin/test/shell-layout.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/catalog.test.tsx`
- Modify: relevant integration page tests

**Interfaces:**

- Consumes: `useCan` and the access document from Task 7.
- Produces: `RequireCapability` route element and capability-aware `NAV_ITEMS`.

- [ ] **Step 1: Write failing navigation and direct-route tests**

For manager access, assert:

- operational nav links are present;
- `Интеграции` and `Настройки` are absent;
- direct `/integrations` and `/settings` render the translated forbidden state;
- direct `/catalog` renders the catalog page.

For admin/owner access, assert integrations/settings routes and nav are present.

For a synthetic future access document containing only `integrations.read`, assert the integration route works while operational routes are forbidden and no pickup-order badge request is sent. This proves routes depend on capabilities rather than role names.

In `access-routing.test.tsx`, define `renderAccessRoute(initialPath, access)` by using the same `QueryClientProvider`, `ThemeProvider`, `MemoryRouter`, fake `AuthClientProvider`, and active-session fixture already present in `shell-layout.test.tsx`, but render the exported `AppRoutes`. Its path-aware fetch mock returns the supplied document for `/api/access/me` and records any other API request for assertions.

- [ ] **Step 2: Run routing tests to verify they fail**

Run: `pnpm --filter @markiro/admin test -- access-routing.test.tsx shell-layout.test.tsx`
Expected: FAIL because routes/nav are not capability-aware.

- [ ] **Step 3: Add a reusable direct-route gate**

```tsx
export function RequireCapability({
  capability,
  children,
}: {
  capability: CabinetCapability;
  children: ReactNode;
}) {
  return useCan(capability) ? <>{children}</> : <ForbiddenPage />;
}
```

Export `AppRoutes` separately from `App` so `MemoryRouter` tests exercise the real route tree:

```tsx
export function AppRoutes() {
  return <Routes>{/* the existing routes, each protected below */}</Routes>;
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: Apply the route matrix**

| Routes                                                                                                                 | Capability               |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `/`, `/catalog`, `/shifts`, `/boxes`, `/conflicts`, `/counterparties`, `/employees`, `/kiosks`, `/labels*`, `/pickup*` | `operations.read`        |
| `/integrations`, `/integrations/:type`                                                                                 | `integrations.read`      |
| `/settings`                                                                                                            | `tenant.settings.manage` |

Wrap each route element in `RequireCapability`. Do not redirect unauthorized direct URLs silently; render the explicit forbidden page so a stale bookmark is understandable.

- [ ] **Step 5: Filter sidebar navigation by the same capability**

Change `NAV_ITEMS` entries to include `capability: CabinetCapability` and filter with `useCan` before mapping to `SidebarItem`.

Make the badge query capability-aware:

```ts
export function usePendingOrderCount(enabled = true): number {
  const { data } = usePickupOrders({ status: "pending" }, enabled);
  return data?.length ?? 0;
}
```

Add the optional `enabled` argument to `usePickupOrders` and pass it to TanStack Query. `AppShell` calls `usePendingOrderCount(useCan(CABINET_CAPABILITY.OPERATIONS_READ))` so a future integration-only grant never makes an unauthorized operational request.

- [ ] **Step 6: Gate the kiosk pairing action**

In `KiosksPage`:

```tsx
const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
```

Render the pairing button and `PairingCodeModal` only when true. Do not call `handleIssuePairingCode` from any manager-visible control. The kiosk create/edit/archive/product actions remain visible to managers.

- [ ] **Step 7: Gate product unlink and integration credential controls**

- `ProductForm` renders the unlink button only with `integrations.write`; the product form itself remains operational.
- `ChannelPage` renders exchange credential issuance only with `credentials.manage`.
- `ApiKeysPanel` must not mount key list/issue/revoke hooks without `credentials.manage`; render a translated restricted notice instead. Keep hook order valid by making the exported `ApiKeysPanel` choose between `RestrictedApiKeysPanel` and a child `AuthorizedApiKeysPanel` that owns all existing data hooks.
- Integration settings/candidate mutations require `integrations.write`. Current admin/owner receive it, but tests use a synthetic `integrations.read`-only document to prove mutation controls disappear.

- [ ] **Step 8: Run affected UI tests**

Run: `pnpm --filter @markiro/admin test -- access-routing.test.tsx shell-layout.test.tsx kiosks.test.tsx catalog.test.tsx integrations-api-keys.test.tsx integrations-channel.test.tsx`
Expected: PASS.

Run: `pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/app.tsx apps/admin/src/access/context.tsx apps/admin/src/access/ForbiddenPage.tsx apps/admin/src/layout/AppShell.tsx apps/admin/src/pages/pickup/api.ts apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/catalog/ProductForm.tsx apps/admin/src/pages/integrations/ChannelPage.tsx apps/admin/src/pages/integrations/ApiKeysPanel.tsx apps/admin/test/access-routing.test.tsx apps/admin/test/shell-layout.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/catalog.test.tsx apps/admin/test/integrations-api-keys.test.tsx apps/admin/test/integrations-channel.test.tsx
git commit -m "feat(admin): enforce capability-aware navigation"
```

Before committing, inspect the staged test list so unrelated pre-existing test changes are not included.

---

### Task 9: Gate Operational Mutation Controls

**Files:**

- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/pages/counterparties/index.tsx`
- Modify: `apps/admin/src/pages/employees/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/ReasonsEditor.tsx`
- Modify: `apps/admin/src/pages/labels/index.tsx`
- Modify: `apps/admin/src/pages/conflicts/index.tsx`
- Modify: `apps/admin/src/pages/pickup/index.tsx`
- Modify: `apps/admin/src/pages/pickup/OrderDetail.tsx`
- Modify: `apps/admin/src/pages/pickup/Rejections.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`
- Modify: `apps/admin/test/catalog.test.tsx`
- Modify: `apps/admin/test/shifts.test.tsx`
- Modify: `apps/admin/test/counterparties.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/labels-library.test.tsx`
- Modify: `apps/admin/test/conflicts.test.tsx`
- Modify: `apps/admin/test/pickup.test.tsx`
- Modify: `apps/admin/test/pickup-detail.test.tsx`
- Modify: `apps/admin/test/pickup-rejections.test.tsx`

**Interfaces:**

- Consumes: `useCan(CABINET_CAPABILITY.OPERATIONS_WRITE)` and `RequireCapability` from Tasks 7–8.
- Produces: a coherent read-only operational experience for a future custom grant without weakening any server policy.

- [ ] **Step 1: Write failing read-only UI tests**

Add a shared test access document:

```ts
const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};
```

For each affected page, render its normal loaded state inside `AccessProvider value={OPERATIONS_READ_ONLY}` and assert data remains visible while mutations do not:

| Test file                    | Data that remains visible | Controls that must be absent                                  |
| ---------------------------- | ------------------------- | ------------------------------------------------------------- |
| `catalog.test.tsx`           | product rows              | add, edit, delete                                             |
| `shifts.test.tsx`            | shift rows                | add, edit, delete, close                                      |
| `counterparties.test.tsx`    | counterparty rows         | add, edit, delete, SSCC save                                  |
| `employees.test.tsx`         | employee rows             | add, edit, archive/delete, badge and station-access mutations |
| `kiosks.test.tsx`            | kiosk rows and reasons    | add, edit, archive, assortment save, reason mutations         |
| `labels-library.test.tsx`    | template rows             | add, edit, delete                                             |
| `conflicts.test.tsx`         | conflict rows             | review/resolve                                                |
| `pickup.test.tsx`            | order rows                | export and bulk state mutations                               |
| `pickup-detail.test.tsx`     | order details             | resolve and cancel                                            |
| `pickup-rejections.test.tsx` | rejection rows            | acknowledge                                                   |

Add positive assertions with an access document containing both operational capabilities so the existing controls still render.

In `access-routing.test.tsx`, use the `renderAccessRoute` helper created in Task 8:

```tsx
it("keeps the label library readable but blocks editor routes", async () => {
  renderAccessRoute("/labels", OPERATIONS_READ_ONLY);
  expect(await screen.findByRole("heading", { name: "Шаблоны этикеток" })).toBeDefined();
  cleanup();

  renderAccessRoute("/labels/new", OPERATIONS_READ_ONLY);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  cleanup();

  renderAccessRoute("/labels/template_1", OPERATIONS_READ_ONLY);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @markiro/admin test -- access-routing.test.tsx catalog.test.tsx shifts.test.tsx counterparties.test.tsx employees.test.tsx kiosks.test.tsx labels-library.test.tsx conflicts.test.tsx pickup.test.tsx pickup-detail.test.tsx pickup-rejections.test.tsx
```

Expected: FAIL because the current pages render mutation controls from route access alone.

- [ ] **Step 3: Protect editor routes**

Keep `/labels` on `operations.read`. Change `/labels/new` and `/labels/:id` to `operations.write`:

```tsx
<Route
  path="labels/new"
  element={
    <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
      <LabelEditorPage />
    </RequireCapability>
  }
/>
```

Apply the identical wrapper to `labels/:id`.

- [ ] **Step 4: Gate catalog, shift, and counterparty mutations**

Each page computes:

```ts
const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
```

Apply these exact rules:

- `CatalogPage`: hide page-header/empty-state add buttons and row edit/delete actions when false.
- `ShiftsPage`: hide add, edit, delete, and close actions when false; shift rows and filters remain.
- `CounterpartiesPage`: hide add/edit/delete and do not expose SSCC mutation controls when false.

Do not merely disable click handlers while leaving secret or destructive modals reachable; the controls and unopened mutation modals should not render for read-only access.

- [ ] **Step 5: Gate employee and kiosk mutations**

- `EmployeesPage`: hide add/edit/archive, badge issue/revoke, and station-access grant/reset/revoke controls when `canWrite` is false.
- `KiosksPage`: hide add/edit/archive and assortment mutations when false. Pairing remains governed independently by `credentials.manage` from Task 8.
- Render `ReasonsEditor` only with `operations.write`. Its reason list is already delivered through the kiosk/operational domain; this slice does not add a separate read-only reason editor.

- [ ] **Step 6: Gate labels, conflicts, and pickup mutations**

- `LabelTemplatesPage`: keep the list visible, hide create/edit/delete actions without `operations.write`.
- `ConflictsPage`: keep conflict details visible, hide review/resolve actions.
- `PickupPage`: keep order rows/detail navigation visible, hide export and state-changing bulk actions.
- `OrderDetailPage`: keep item/receipt data visible, hide resolve/cancel.
- `RejectionsPage`: keep rejection data visible, hide acknowledge.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @markiro/admin test -- access-routing.test.tsx catalog.test.tsx shifts.test.tsx counterparties.test.tsx employees.test.tsx kiosks.test.tsx labels-library.test.tsx conflicts.test.tsx pickup.test.tsx pickup-detail.test.tsx pickup-rejections.test.tsx
pnpm --filter @markiro/admin typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/app.tsx apps/admin/src/pages/catalog/index.tsx apps/admin/src/pages/shifts/index.tsx apps/admin/src/pages/counterparties/index.tsx apps/admin/src/pages/employees/index.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/ReasonsEditor.tsx apps/admin/src/pages/labels/index.tsx apps/admin/src/pages/conflicts/index.tsx apps/admin/src/pages/pickup/index.tsx apps/admin/src/pages/pickup/OrderDetail.tsx apps/admin/src/pages/pickup/Rejections.tsx apps/admin/test/access-routing.test.tsx apps/admin/test/catalog.test.tsx apps/admin/test/shifts.test.tsx apps/admin/test/counterparties.test.tsx apps/admin/test/employees.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/labels-library.test.tsx apps/admin/test/conflicts.test.tsx apps/admin/test/pickup.test.tsx apps/admin/test/pickup-detail.test.tsx apps/admin/test/pickup-rejections.test.tsx
git commit -m "feat(admin): gate operational mutation controls"
```

---

### Task 10: Add the Membership Rollout Runbook and Run Full Verification

**Files:**

- Create: `docs/runbooks/cabinet-rbac-rollout.md`
- Modify: `docs/architecture.md`
- Modify: `docs/device-key-surface.md`

**Interfaces:**

- Consumes: completed API/admin behavior.
- Produces: an operator-safe deployment procedure with explicit membership inventory and smoke checks.

- [ ] **Step 1: Write the rollout runbook**

The runbook must include this read-only inventory:

```sql
SELECT
  m.id AS membership_id,
  m.organization_id,
  o.name AS organization_name,
  u.email,
  m.role
FROM member AS m
JOIN organization AS o ON o.id = m.organization_id
JOIN "user" AS u ON u.id = m.user_id
ORDER BY o.name, u.email;
```

For every intended cabinet user currently stored as `member`, record an explicit approved target role before changing data. Use a transaction and membership ids, never email-only or organization-wide updates:

```sql
BEGIN;

UPDATE member
SET role = 'manager'
WHERE id = ANY($1::text[])
  AND role = 'member'
RETURNING id, organization_id, user_id, role;

COMMIT;
```

The runbook must state that `$1` is a parameterized array supplied by the deployment operator, and the returned row count must equal the approved inventory count before deployment continues.

- [ ] **Step 2: Document deploy and smoke order**

Record:

1. Back up membership rows.
2. Inventory and approve role changes.
3. Apply explicit promotions.
4. Deploy API and admin from the same revision.
5. Smoke owner, admin, manager, and member accounts.
6. Smoke station scan/product/shift calls, kiosk bootstrap/order, public API authentication, and 1C exchange.
7. On authorization regression, roll back the application revision; do not broadly promote members or add a permissive authorization flag.

- [ ] **Step 3: Update architecture documentation**

Add a concise “Cabinet authorization” section to `docs/architecture.md` covering:

- Better Auth membership vs production operator identity;
- per-request membership reload;
- centralized capability resolver;
- explicit cabinet/shared/membership-only route policies;
- UI bootstrap from `/access/me`;
- owner-only Better Auth organization mutations.

Link the approved design spec and rollout runbook.

Update `docs/device-key-surface.md` in the same pass: replace `SessionOnlyGuard` terminology with the new authorization policies, document `StationOnlyGuard` for roster/scans, and document `AllowStationOrPermissions` for shared product/shift routes. Preserve the explicit route inventory.

- [ ] **Step 4: Run formatting and focused package verification**

Run:

```bash
pnpm exec prettier --write packages/domain/src/access/cabinet.ts packages/domain/test/cabinet-access.test.ts packages/db/src/organization-access.ts packages/db/test/organization-access.test.ts apps/api/src/authorization apps/api/src/tenancy/station-only.guard.ts apps/api/test/authorization.service.test.ts apps/api/test/authorization.guard.test.ts apps/api/test/security-audit.service.test.ts apps/api/test/station-only.guard.test.ts apps/api/test/authorization-metadata.test.ts apps/api/test/authorization.e2e.test.ts apps/admin/src/access apps/admin/test/access.test.tsx apps/admin/test/access-routing.test.tsx docs/runbooks/cabinet-rbac-rollout.md docs/architecture.md docs/device-key-surface.md
pnpm --filter @markiro/domain test
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
```

Expected: all tests PASS. Database-backed suites must run in an env-equipped workspace or CI, not be counted as verified merely because `describe.skipIf` skipped them.

- [ ] **Step 5: Run whole-repository quality gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Perform final security assertions**

Run:

```bash
rg -n "SessionOnlyGuard" apps/api/src
rg -n "RequirePermissions|AllowStationOrPermissions|RequireMembership" apps/api/src/modules apps/api/src/authorization
git diff --check
git status --short
```

Expected:

- no `SessionOnlyGuard` result;
- every cabinet controller is represented in the policy output;
- no whitespace errors;
- only intended RBAC files are modified/staged; pre-existing user changes remain untouched.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/runbooks/cabinet-rbac-rollout.md docs/architecture.md docs/device-key-surface.md
git commit -m "docs: add cabinet RBAC rollout runbook"
```

- [ ] **Step 8: Request final code review**

Use `superpowers:requesting-code-review` against the complete RBAC commit range. Review specifically for:

- an unclassified cabinet route;
- a session bypass on shared station routes;
- a Better Auth organization-endpoint bypass;
- missing all-of checks for credential issuance;
- UI-only enforcement without matching server policy;
- secret material in security logs;
- regression to station, kiosk, public API, or 1C authentication.

Do not mark the stabilization item complete until review findings are resolved and the full verification commands are rerun.
