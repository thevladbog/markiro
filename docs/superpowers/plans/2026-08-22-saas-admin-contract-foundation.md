# SaaS Admin Contract Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every existing SaaS platform endpoint and client call consume one shared runtime contract, with precise and safe failure diagnostics instead of generic load errors.

**Architecture:** Add `@markiro/platform-contracts` as a framework-independent Zod package. Controllers validate request bodies and serialize successful results with schemas from that package; `apps/saas-admin` passes the same response schema to one typed client. A platform-only request context and exception filter add stable error codes and request IDs without exposing bodies or secrets.

**Tech Stack:** TypeScript 6, Zod 4, NestJS 11, React 19, TanStack Query 5, Vitest 4, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-22-saas-admin-redesign-and-legal-profiles-design.md`

## Global Constraints

- Preserve opaque bounded tenant identifiers; do not reintroduce UUID-only tenant validation.
- Normalize production-like PostgreSQL timestamp strings before ISO validation.
- Never log response bodies, cookies, auth material, TOTP secrets, activation tokens, or DaData credentials.
- A schema failure in one panel must not discard independently loaded successful panels.
- Keep the customer admin, kiosk, and station contracts outside this package.
- Build the contract package before API or SaaS tests that consume its compiled exports.
- Commit only the paths named by each task; preserve unrelated worktree changes.

---

## Task 1: Create the shared platform-contract package and primitives

**Files:**

- Create: `packages/platform-contracts/package.json`
- Create: `packages/platform-contracts/tsconfig.json`
- Create: `packages/platform-contracts/tsconfig.test.json`
- Create: `packages/platform-contracts/vitest.config.ts`
- Create: `packages/platform-contracts/src/index.ts`
- Create: `packages/platform-contracts/src/primitives.ts`
- Create: `packages/platform-contracts/src/errors.ts`
- Create: `packages/platform-contracts/test/primitives.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/saas-admin/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing primitive-contract tests**

```ts
import { describe, expect, it } from "vitest";
import { platformErrorSchema, platformTenantIdSchema, platformTimestampSchema } from "../src";

describe("platform contract primitives", () => {
  it("accepts legacy tenant references and PostgreSQL timestamps", () => {
    expect(platformTenantIdSchema.parse("legacy_better_auth_org")).toBe("legacy_better_auth_org");
    expect(platformTimestampSchema.parse("2026-08-11 18:08:42.158")).toBe(
      "2026-08-11T18:08:42.158Z",
    );
  });

  it("requires a machine code and request id for errors", () => {
    expect(
      platformErrorSchema.parse({
        code: "tenant_not_found",
        message: "Tenant not found",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({ code: "tenant_not_found" });
  });
});
```

- [ ] **Step 2: Run the primitive test directly and confirm the shared exports are missing**

Run: `node_modules/.bin/vitest run packages/platform-contracts/test/primitives.test.ts`

Expected: missing `../src` or missing-export failure.

- [ ] **Step 3: Implement the package with exact shared primitives**

Export `platformTenantIdSchema`, `platformUuidSchema`, `platformMoneySchema`,
`platformTimestampSchema`, `platformNullableTimestampSchema`, `platformErrorSchema`, and inferred
types. `platformTimestampSchema` must transform accepted database strings to UTC ISO strings.

- [ ] **Step 4: Wire exact workspace dependencies and regenerate the lockfile**

Add `@markiro/platform-contracts: workspace:*` to API and SaaS admin. Keep `zod` at the repository's
exact `4.4.3` version, expose `zod` as a peer dependency and a development dependency as
`@markiro/domain` does, and run `corepack pnpm install --lockfile-only`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
```

Commit: `feat(platform-contracts): add shared contract primitives`

---

## Task 2: Move tenant and subscription contracts to the shared package

**Files:**

- Create: `packages/platform-contracts/src/tenants.ts`
- Create: `packages/platform-contracts/test/tenants.test.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `apps/api/src/modules/platform-tenants/dto.ts`
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts`
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.service.ts`
- Modify: `apps/saas-admin/src/pages/tenants/api.ts`
- Modify: `apps/api/test/platform-tenants.contract.test.ts`
- Modify: `apps/saas-admin/test/tenants.test.tsx`
- Modify: `apps/saas-admin/test/tenant-detail.test.tsx`

- [ ] **Step 1: Add production-like failing fixtures**

Cover list, detail, create, catalog-for-assignment, plan assignment, and add-on assignment. Include
`tenantId: "legacy_better_auth_org"`, `createdAt: "2026-08-11 18:08:42.158"`, nullable subscription
boundaries, and unmanaged tenants.

- [ ] **Step 2: Prove the current duplicate contracts diverge**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run test/tenants.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/tenants.test.tsx test/tenant-detail.test.tsx
```

Expected: missing shared schemas first; the existing SaaS regressions must stay green until the
consumer switch.

- [ ] **Step 3: Define endpoint schemas and explicit result types**

Export contracts such as:

```ts
export const platformTenantContracts = {
  list: { query: tenantListQuerySchema, response: tenantListResponseSchema },
  detail: { params: tenantParamsSchema, response: tenantDetailSchema },
  create: { body: createTenantSchema, response: createTenantResponseSchema },
  assignPlan: { body: assignPlanSchema, response: planAssignmentResponseSchema },
  assignAddon: { body: assignAddonSchema, response: addonAssignmentResponseSchema },
} as const;
```

- [ ] **Step 4: Switch both boundaries to the shared definitions**

API DTO modules re-export shared input types instead of redefining them. The service returns named
result types. The controller parses every success response. SaaS `api.ts` removes its local response
schemas and uses the contract-aware client added in Task 6; until then call `.response.parse` after
`platformApiFetch<unknown>`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/platform-tenants.contract.test.ts test/platform-tenants.e2e.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/tenants.test.tsx test/tenant-detail.test.tsx
```

Commit: `refactor(platform-contracts): unify tenant contracts`

---

## Task 3: Unify catalog contracts

**Files:**

- Create: `packages/platform-contracts/src/catalog.ts`
- Create: `packages/platform-contracts/test/catalog.test.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `apps/api/src/modules/platform-catalog/dto.ts`
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.controller.ts`
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.service.ts`
- Modify: `apps/saas-admin/src/pages/catalog/api.ts`
- Modify: `apps/saas-admin/src/pages/documents/types.ts`
- Modify: `apps/api/test/platform-catalog.e2e.test.ts`
- Modify: `apps/saas-admin/test/catalog.test.tsx`
- Modify: `apps/saas-admin/test/document-composer.test.tsx`

- [ ] **Step 1: Write failing request/response contract tests for plan, add-on, and service versions**

Assert the discriminated fields, financial terms, entitlement limits, status transitions, demo-plan
setting, and `null` versus omitted behavior.

- [ ] **Step 2: Run the focused tests and capture the missing shared exports**

Run: `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/catalog.test.ts`

- [ ] **Step 3: Implement `platformCatalogContracts` and delete handwritten SaaS interfaces**

Infer `CatalogVersion`, `CatalogVersionCreate`, and `CatalogVersionPatch` from shared Zod schemas.
Keep `catalogVersionToCreateInput()` as a mapping function, but type it entirely from the package.

- [ ] **Step 4: Parse API responses at the controller boundary and the browser boundary**

Use a common `parsePlatformResponse(schema, value)` helper in the API. Do not cast service rows to
the contract type.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/platform-catalog.e2e.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx test/document-composer.test.tsx
```

Commit: `refactor(platform-contracts): unify catalog contracts`

---

## Task 4: Unify offers, invoices, payments, and document contracts

**Files:**

- Create: `packages/platform-contracts/src/commercial.ts`
- Create: `packages/platform-contracts/test/commercial.test.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `apps/api/src/modules/platform-offers/dto.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Modify: `apps/api/src/modules/billing/dto.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/src/modules/billing-payments/dto.ts`
- Modify: `apps/api/src/modules/billing-payments/billing-payments.controller.ts`
- Modify: `apps/saas-admin/src/pages/offers/api.ts`
- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Modify: `apps/saas-admin/src/pages/documents/types.ts`
- Modify: `apps/api/test/billing-offer-snapshot.test.ts`
- Modify: `apps/api/test/billing-application-flow.test.ts`
- Modify: `apps/api/test/platform-offers.service.test.ts`
- Modify: `apps/saas-admin/test/billing-flow.test.tsx`
- Modify: `apps/saas-admin/test/offer-editor.test.tsx`

- [ ] **Step 1: Write failing shared fixtures for every existing commercial route**

Include draft/published/paid offers, draft/issued/paid invoices, document states, payment records,
application attempts including `skipped`, and all activation-policy spelling used by the API.

- [ ] **Step 2: Run contract tests and resolve real spelling/nullability mismatches in the shared schema**

Run: `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/commercial.test.ts`

Do not silently normalize a domain value if the backend persists a different enum; make the
backend and contract agree explicitly.

- [ ] **Step 3: Re-export request DTOs and give services named return types**

Example controller boundary:

```ts
const result = await this.billing.get(id);
return parsePlatformResponse(platformCommercialContracts.invoiceDetail.response, result);
```

- [ ] **Step 4: Remove local response schemas from offers and billing clients**

`CreateOfferInput` and `CreateInvoiceInput` become aliases of shared inputs. Preserve UI-only draft
types in `documents/types.ts`; do not put partially valid form state in the API contract package.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/billing-offer-snapshot.test.ts test/billing-application-flow.test.ts test/platform-offers.service.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/billing-flow.test.tsx test/billing-editor.test.tsx test/offer-editor.test.tsx
```

Commit: `refactor(platform-contracts): unify commercial contracts`

---

## Task 5: Unify principal, team, audit, activation, and recovery contracts

**Files:**

- Create: `packages/platform-contracts/src/platform-auth.ts`
- Create: `packages/platform-contracts/test/platform-auth.test.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `apps/api/src/platform-auth/platform-access-policy.ts`
- Modify: `apps/api/src/platform-auth/platform-team.controller.ts`
- Modify: `apps/api/src/platform-auth/platform-audit.controller.ts`
- Modify: `apps/api/src/platform-auth/platform-activation.controller.ts`
- Modify: `apps/saas-admin/src/auth/PlatformAuthBoundary.tsx`
- Modify: `apps/saas-admin/src/pages/team/api.ts`
- Modify: `apps/saas-admin/src/pages/audit/api.ts`
- Modify: `apps/saas-admin/src/pages/auth/ActivatePlatformUser.tsx`
- Modify: `apps/api/test/platform-team.e2e.test.ts`
- Modify: `apps/api/test/platform-auth.e2e.test.ts`
- Modify: `apps/api/test/platform-audit.service.test.ts`
- Modify: `apps/saas-admin/test/auth.test.tsx`
- Modify: `apps/saas-admin/test/platform-pages-api.test.ts`

- [ ] **Step 1: Add failing fixtures for roles, capabilities, 2FA readiness, team states, and audit pagination**

- [ ] **Step 2: Run both contract and current page tests**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run test/platform-auth.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/auth.test.tsx test/platform-pages-api.test.ts
```

- [ ] **Step 3: Implement and consume shared schemas**

Keep API-only authorization helpers in `apps/api`; only the serializable role, capability, principal,
team, activation, and audit shapes belong in the package.

- [ ] **Step 4: Add response parsing without changing the Better Auth transport**

Do not move session cookies or TOTP material into the contract package. Only parse the platform
application endpoints mounted below `/api/platform`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/platform-auth.e2e.test.ts test/platform-team.e2e.test.ts test/platform-audit.service.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/auth.test.tsx test/platform-pages-api.test.ts
```

Commit: `refactor(platform-contracts): unify platform identity contracts`

---

## Task 6: Add request IDs, safe error taxonomy, and panel-local contract failures

**Files:**

- Create: `apps/api/src/platform-http/platform-request-context.middleware.ts`
- Create: `apps/api/src/platform-http/platform-exception.filter.ts`
- Create: `apps/api/src/platform-http/platform-response.ts`
- Create: `apps/api/src/platform-http/platform-http.module.ts`
- Create: `apps/api/test/platform-http-boundary.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/saas-admin/src/api/client.ts`
- Create: `apps/saas-admin/src/api/diagnostics.ts`
- Create: `apps/saas-admin/src/components/PanelState.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/errorMessages.ts`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/api-client.test.ts`
- Create: `apps/saas-admin/test/panel-state.test.tsx`

- [ ] **Step 1: Write failing API boundary tests**

Assert `x-request-id` passthrough or generated UUID, response `{ code, message, requestId }`, and no
echo of a secret-bearing request body. Cover Nest domain exceptions and unexpected failures.

- [ ] **Step 2: Write failing client taxonomy tests**

```ts
await expect(
  platformApiFetch("/tenants", { responseSchema: tenantListResponseSchema }),
).rejects.toMatchObject({
  kind: "contract",
  endpoint: "/tenants",
  issuePath: ["items", 0, "createdAt"],
  requestId: "11111111-1111-4111-8111-111111111111",
});
```

Also cover `network`, `authorization`, and `domain` kinds.

- [ ] **Step 3: Implement the platform-only server boundary**

Mount middleware/filter only for `/platform/*`. Keep existing non-platform error semantics intact.
Set the request ID on the response and audit context. Unexpected errors return a stable
`platform_internal_error` code and are logged without payloads.

- [ ] **Step 4: Implement the schema-aware client and safe diagnostics**

The client signature becomes:

```ts
export async function platformApiFetch<S extends z.ZodType>(
  path: string,
  options: RequestInit & { responseSchema: S },
): Promise<z.output<S>>;
```

Read release SHA from the response header, store only endpoint, issue path, release SHA, and request
ID, and render a retry action plus copyable request ID. Never store the invalid payload.

- [ ] **Step 5: Prove partial-panel behavior and commit**

Add a component test where tenant identity loads, billing readiness fails its contract, and the
identity remains visible. Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/platform-http-boundary.test.ts
CI=true corepack pnpm --filter @markiro/saas-admin exec vitest run test/api-client.test.ts test/panel-state.test.tsx
```

Commit: `feat(saas-admin): report precise platform contract failures`

---

## Task 7: Publish shared schemas in OpenAPI and close the contract slice

**Files:**

- Create: `apps/api/src/platform-http/platform-openapi.ts`
- Create: `apps/api/test/platform-contract-openapi.test.ts`
- Modify: `apps/api/src/modules/platform-tenants/platform-tenants.controller.ts`
- Modify: `apps/api/src/modules/platform-catalog/platform-catalog.controller.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/src/modules/billing-payments/billing-payments.controller.ts`
- Modify: `apps/api/src/platform-auth/platform-team.controller.ts`
- Modify: `apps/api/src/platform-auth/platform-audit.controller.ts`
- Modify: `apps/api/test/openapi-docs.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write a failing OpenAPI inventory test**

For every existing SaaS route, assert an operation, success schema, error schema, and relevant auth
metadata. Compare required response properties against `z.toJSONSchema(sharedSchema)`.

- [ ] **Step 2: Run the inventory and confirm current controllers lack shared success schemas**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/platform-contract-openapi.test.ts`

- [ ] **Step 3: Implement reusable OpenAPI decorators from the shared Zod schemas**

Use `@ApiOkResponse({ schema: platformOpenApiSchema(schema) })` and corresponding 201/204 helpers.
Do not manually duplicate schema property lists in decorators.

- [ ] **Step 4: Document ownership and run the full slice gates**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
CI=true corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
corepack pnpm format:check
git diff --check
```

- [ ] **Step 5: Refresh Graphify and commit the completed foundation**

Run: `graphify update .`

Commit: `docs(architecture): establish platform contract ownership`

## Slice Acceptance

- All existing SaaS routes have shared successful request/response schemas.
- The valid tenant payload that previously produced “Не удалось загрузить тенантов” parses in both
  API and browser tests.
- Contract failures show endpoint context and request ID, never the response body.
- OpenAPI and runtime validation are derived from the same schema objects.
- No new legal-profile, DaData, or visual behavior is introduced in this slice.
