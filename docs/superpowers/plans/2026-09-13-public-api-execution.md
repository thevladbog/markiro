# Public API execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Provide scoped public-key execution for product reads and the full inventory preparation/start/read cycle, independently of native device credentials.

**Architecture:** A public principal and request admission boundary wrap existing domain owners. The owners retain their locks, idempotency and audit; explicit API-key actors replace any temptation to impersonate a cabinet user. Existing commercial shadow admission stays shadow outside this new public surface.

**Tech Stack:** Node 24, NestJS, Drizzle/Postgres, Zod, React, Vitest, pnpm 11.22.0.

**Spec:** `docs/superpowers/specs/2026-09-13-public-api-offline-grants-design.md`

## Implementation status

Completed and independently reviewed on 2026-09-14. The final workspace gates
and additional native/browser checks are recorded in
[the acceptance report](../../acceptance/offline-device-grants.md). Production
policy values, strict activation and physical pilot acceptance remain separate P1D
work.

## Global Constraints

- Public namespace is `/public/v1`; tenant identity comes from a verified `configId=public`, `metadata.kind=public` key.
- Scopes: `catalog.products.read`, `inventory.read`, `inventory.prepare`, `inventory.start`. Unscoped legacy keys have no execution scopes.
- Native Station, handheld, kiosk, Signer and CommerceML do not acquire a publicApi dependency.
- No additional lifecycle policy may block creation of tariffs, subscriptions, services, quotes or invoices.
- Public requests require current publicApi and applicable module permission; unknown facts do not authorize new public execution.
- Mutations require Idempotency-Key; changed payload conflicts, exact retries preserve results and audit identity.
- Public audit actor is the key, never a fabricated cabinet user; historical actors remain intact after revocation.
- No publication, deployment, production policy activation, credential disclosure or cleanup is authorized by this implementation plan.
- Serialize migration generation and shared index exports with the P1C plan. Never hand-edit an applied migration or pnpm lockfile.
- Keep working changes uncommitted until the user's publication request. Review packages include tracked and new files.

## File and interface ownership

`packages/platform-contracts/src/public-api.ts` owns scopes, key DTOs and strict public request contracts; `index.ts` exports them. `apps/api/src/modules/public-api/` owns authentication, request identity, read projections and controllers. Inventory actor adapters stay in `apps/api/src/modules/inventories/`. Durable public-key identities and request receipts live in `packages/db/src/schema/public-api.ts`; actor columns extend `inventory.ts` only where public writes occur. Cabinet key editing remains in `ApiKeysPanel.tsx` and integrations `api.ts`.

### Task 1: Scoped public keys and executable authentication boundary

**Files:**

- Create `packages/platform-contracts/src/public-api.ts`, `packages/platform-contracts/test/public-api.test.ts`.
- Modify `packages/platform-contracts/src/index.ts`.
- Create `apps/api/src/modules/public-api/public-api-auth.service.ts`, `public-api.guard.ts`, `public-api.types.ts` and `public-api.module.ts`.
- Modify `apps/api/src/modules/api-keys/api-keys.controller.ts`, `api-keys.service.ts`, `api-keys.module.ts`.
- Create `apps/api/test/public-api-auth.test.ts`; extend `apps/api/test/api-keys.e2e.test.ts`.

**Interfaces:**

- Produces `PUBLIC_API_SCOPES`, `PublicApiScope`, `publicApiScopesSchema`, `publicApiKeyCreateSchema`, `publicApiKeyUpdateSchema`.
- Produces server-only `PublicApiPrincipal = { kind: "public_api"; tenantId: string; keyId: string; scopes: PublicApiScope[] }` and `PublicApiAuthService.authenticate(rawKey: string): Promise<PublicApiPrincipal>`.
- Produces `PublicApiAuthService.assertCurrent(tx, principal, requiredScope): Promise<void>` for use under a business transaction. `tx` uses the existing DB transaction type, not an independent pool connection.
- Management update input contains a complete scope set. Missing legacy scopes parse as `[]`; invalid metadata or duplicate/unknown scope values never become broad access.

- [x] Add strict schema tests before production implementation:

```ts
expect(publicApiScopesSchema.safeParse(["inventory.start", "inventory.start"]).success).toBe(false);
expect(
  publicApiKeyCreateSchema.safeParse({ name: "ERP", scopes: ["inventory.prepare"] }).success,
).toBe(true);
expect(publicApiKeyCreateSchema.safeParse({ name: "ERP", scopes: ["*"] }).success).toBe(false);
```

- [x] Run `pnpm --filter @markiro/platform-contracts exec vitest run test/public-api.test.ts`; capture expected RED. Implement a closed Zod enum, unique scope array and strict create/update objects. Preserve name-only legacy issuance as a key with zero execution scopes; expose explicit scopes in management responses.
- [x] Test actual authentication against public and station configurations, revoked/expired/disabled keys, wrong metadata, absent scopes, tenant mismatch and database errors. A DB outage must be unavailable, not invalid credentials or allow. Inspect installed Better Auth verification semantics and existing hash helper before selecting the verification path; enforce the current public rate limit once per request, not again during owner revalidation.
- [x] Implement separate public guard, rejecting requests that would rely on cabinet or device credentials. Store only the verified principal on the request. Public route scopes are explicit metadata; undeclared scope fails closed. Revalidation serializes against scope changes/revoke using the same key-row lock order as mutation management.
- [x] Expose a cabinet-only scope update with current CREDENTIALS_MANAGE authorization and exact audit before/after scope sets. Preserve one-time secret reveal and repeated revoke behavior. Test concurrent scope update/revoke without resurrecting a key.
- [x] Run focused API auth/key tests and platform-contracts test/typecheck/lint/build; rebuild affected shared outputs before consumer checks. Save RED/GREEN evidence and diff for task review.

### Task 2: Public actor persistence and transactional inventory owners

**Files:**

- Create `packages/db/src/schema/public-api.ts`; modify DB schema exports and `drizzle.config.ts`.
- Modify `packages/db/src/schema/inventory.ts`; generate one forward migration plus metadata.
- Create `packages/db/test/public-api-schema.test.ts` and migration assertions.
- Create `apps/api/src/modules/inventories/inventory-actor.ts`.
- Modify `inventories.service.ts`, `inventory-snapshot.service.ts`, `inventory-lifecycle.service.ts` and affected DTO projections/tests.
- Create `apps/api/src/modules/public-api/public-api-request.service.ts`, `public-api-admission.service.ts`.
- Create `apps/api/test/public-api-inventory-owners.integration.test.ts`.
- Modify `packages/platform-contracts/src/entitlements.ts` and registry/fingerprint tests for explicit public execution mappings; coordinate with offline Task 3.

**Interfaces:**

- Consumes `PublicApiPrincipal` and `assertCurrent` from task 1.
- Produces `InventoryActor = { domain: "cabinet"; userId: string } | { domain: "api_key"; keyId: string }`.
- Existing cabinet callers retain their string actor entry compatibility through a single normalization helper, or are updated explicitly without changing their behavior.
- Produces public owner entry points for create/import/fix/start with verified actor, request identity and admitted transaction context. Existing storage I/O and snapshot semantics remain owned by their services.
- Receipt identity: tenantId, stable keyId, operation, idempotencyKey; content identity additionally includes canonical validated request and raw file SHA-256. Response and success audit commit with the effect; ongoing/unknown attempts recover by durable request identity.

- [x] Write DB-backed tests demonstrating api_key creation/import/snapshot/start attribution, cabinet attribution preserved, stable identity after key deletion, invalid cross-tenant identity rejection and startedAt/actor consistency.

```ts
expect(stored.createdByUserId).toBeNull();
expect(stored.createdByPublicKeyId).toBe(keyId);
expect(audit.after).toMatchObject({ actorDomain: "api_key", actorId: keyId, inventoryId });
```

- [x] Run tests for RED. Add a durable tenant-owned public-key identity record independent of the deletable secret row. Backfill existing public key identities and retain them on revoke. Add explicit public-key actor columns to inventory creation, imports, snapshots and start, with XOR/completion constraints and composite tenant keys. Keep old cabinet history unchanged. Generate migration via Drizzle, review SQL, then test real migration application and rebuild DB dist.
- [x] Refactor only selected domain owner entry points to accept verified actor and transaction-owned admission. Keep tenant/resource checks, existing frozen snapshots, import object provenance, leases and replay before new effects. Do not pass keyId through user FK fields.
- [x] Implement durable request receipts and current entitlement checks at the owner boundary. Use the authoritative entitlement calculation with explicit api_key_scope operation mappings. Existing cabinet-only registry IDs must not silently become public bindings; preserve historical source operation scopes. Public inventory requests must require publicApi and inventory also for reads of this new integration surface; retained-data cabinet access remains unchanged. Add registry/version/fingerprint tests and document stale-preview compatibility when registry changes. Persist decision provenance. Key row and entitlement revision locks must have one documented order shared by all public mutations; avoid resolver work on another connection while holding owner locks.
- [x] Write and run concurrency tests: exact create retries create one row; changed payload returns conflict; import transport interruption retains/reconciles existing staged object; start retry returns stored manifest; revoke/scope change and entitlement revision races cannot authorize an effect after their serialized boundary. Preserve original business errors and existing successful replay semantics.
- [x] Run DB package gates, focused inventory owner tests and all affected existing inventory suites against an isolated test database. Record migration and test evidence; package task diff for independent review.

### Task 3: Public controllers and complete integration workflow

**Files:**

- Create `apps/api/src/modules/public-api/public-products.controller.ts`, `public-inventories.controller.ts`, `public-api-read.service.ts`, `public-api.dto.ts`.
- Modify `public-api.module.ts` and `apps/api/src/app.module.ts`.
- Extend shared public DTO contracts without duplicating existing field semantics.
- Create `apps/api/test/public-api.e2e.test.ts`; extend `subscription-route-inventory.test.ts`, applicable public OpenAPI/access inventories.
- Modify `docs/device-key-surface.md`; create `docs/operations/public-api.md`.

**Interfaces:**

- Consumes task 2 owner entry points; outputs the exact `/public/v1` paths in the approved spec.
- Results response is a paginated public projection, not raw internal entities. A continuation cursor must retain tenant/task/filter identity and validate its shape.
- All mutation actions carry Idempotency-Key. Header and input schemas are included in OpenAPI; authorization/retry/domain errors use the existing valid error envelope.

- [x] Write HTTP e2e for a real public key without a cabinet cookie:

```ts
const task = await publicClient.createInventory(input, "create-1");
const imports = await publicClient.importAllRequiredStatuses(task.id, sourceFiles);
await publicClient.fixSnapshot(task.id, imports, "snapshot-1");
await publicClient.start(task.id, "start-1");
expect((await publicClient.inventory(task.id)).status).toBe("running");
expect((await publicClient.results(task.id)).items).toEqual([]);
```

`publicClient` is a test fixture over actual HTTP routes; it must not implement production decisions. Use existing production-like inventory import fixtures and isolated Postgres/object-storage harnesses.

- [x] Run RED, then implement thin public controllers using guards and owners. Product reads reuse existing tenant filtering through a public response projection. Inventory import uses existing supported file formats, selected inputs and size limits. Snapshot/start are distinct actions; no remote scan execution, cancellation/closure or regulatory submission routes are added.
- [x] Add e2e cases for every scope, missing publicApi/inventory, unknown rights, wrong credential kind, cross-tenant IDs, malformed idempotency and conflicting replay. Assert exact actor audit; test native requests after publicApi removal to establish independence.
- [x] Add progress/results pagination and privacy tests covering multiple pages, malformed cursor, a cursor reused for another task/tenant and absence of operator credentials/private internal metadata.
- [x] Update OpenAPI, route inventory and operator guide with example key scopes, file preparation order, retries, errors and retained-data cabinet fallback. Run focused and affected API suites, package typecheck/lint/build; report infrastructure skips explicitly.

### Task 4: Cabinet key scopes and combined public acceptance

**Files:**

- Modify `apps/admin/src/pages/integrations/ApiKeysPanel.tsx`, `api.ts`, `apps/admin/src/i18n/en.json`, `ru.json`.
- Extend `apps/admin/test/integrations-api-keys.test.tsx` and integration client tests.
- Update `docs/operations/public-api.md` and approved design implementation status.

**Interfaces:**

- Consumes shared management DTOs from task 1.
- Issue and scope edit submit explicit complete scope sets; stale/error responses preserve the user's draft. A saved unscoped legacy key is visibly distinguished from an execution-ready key.

- [x] Add component tests selecting catalog read and inventory prepare scopes, verifying the actual submitted payload; edit existing scopes and preserve draft after failure. Ensure secret reveal remains one-time and revoke remains credential recovery.

```ts
expect(JSON.parse(recordedRequest.body)).toEqual({
  name: "ERP",
  scopes: ["catalog.products.read", "inventory.prepare"],
});
```

- [x] Run RED and implement with existing UI components, translated labels, keyboard operation and current cabinet capabilities. Show scopes in key list and explain no execution rights for legacy unscoped keys. Do not expose secrets in cache/logs.
- [x] Run admin package test/typecheck/lint/build and API management contracts. Perform browser interaction checks for issuance, scope editing and revoke under supported screen widths; distinguish automated DOM evidence from browser evidence.
- [x] Run final API package gates against isolated services, shared package gates, format:check, git diff --check, applicable CI/production contracts. Review whole public diff against spec with task reports and unresolved findings. Keep publication separate.
