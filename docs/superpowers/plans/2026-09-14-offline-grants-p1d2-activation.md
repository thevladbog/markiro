# Offline Grants P1D.2 Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-operator prepare/confirm flow that activates `strict` offline grants for an exact readiness-approved device cohort without changing customer subscriptions or commercial history.

**Architecture:** Persist an immutable preparation snapshot, re-read every server-owned readiness fact at confirmation, then atomically create an approved rollout policy revision and device-scoped activation bindings. Runtime configuration overlays the rollout policy only for exact activated devices; all other devices and all existing commercial records retain their current behavior.

**Tech Stack:** Node.js 24+, TypeScript, NestJS, Drizzle ORM, PostgreSQL, Zod, React, TanStack Query, Vitest, Testing Library, repository i18n and production contract tests.

**Spec:** `docs/superpowers/specs/2026-09-14-offline-grants-p1d2-activation-design.md`

## Global Constraints

- Existing `tenant_subscriptions.plan_version_id`, catalog versions, prices, terms, offers, invoices and entitlement quantities must remain byte-equivalent.
- Devices outside an exact confirmed activation continue in `observe`.
- An activated device changes mode only through its next authenticated configuration refresh.
- Prepare never changes policy, activation or configuration state.
- Confirm must be performed by a different current platform user from the preparer.
- `offlineGrants.activate` belongs only to `platform_admin`; every mutation also requires `tenants.read`, `catalog.read` and `catalog.write`.
- Every request body is strict, every mutation has a UUID request identity, and changed input under the same identity conflicts.
- A preparation expires exactly 30 minutes after its original `preparedAt`; retries never extend it.
- Confirmation rechecks base policy, subscription, assignment, credential epoch, readiness report, verified grant and signing keyset at one server `asOf`.
- The rollout policy copies `maxOfflineMs`, `maxCompletionMs` and `taskBounds` exactly from the base policy and differs only by its `rollout` value.
- Existing native Station, Handheld and kiosk request and response contracts do not change.
- Recovery, frozen-task completion, evidence ingestion, saved print bytes and already queued work remain available.
- Migration `0152_offline_grant_activation` is additive and must run before code reads activation tables.
- Physical hardware, production deployment, cohort selection and customer acceptance remain P1D.3 evidence gates.

---

### Task 1: Freeze activation contracts, authority and canonical digests

**Files:**

- Create: `packages/platform-contracts/src/offline-grant-activations.ts`
- Modify: `packages/platform-contracts/src/platform-auth.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Test: `packages/platform-contracts/test/offline-grant-activations.test.ts`
- Test: `packages/platform-contracts/test/platform-auth.test.ts`

**Interfaces:**

- Consumes: `platformGrantReadinessRowSchema`, `offlineGrantPolicyRecordSchema`, `platformUuidSchema`, `platformTimestampSchema`.
- Produces: `platformGrantActivationContracts`, `PlatformGrantActivationPrepareRequest`, `PlatformGrantActivationConfirmRequest`, `PlatformGrantActivationCancelRequest`, `PlatformGrantActivationPreparation`, `PlatformGrantActivationReceipt`, `GrantActivationState`, and capability `offlineGrants.activate`.
- The API service in Tasks 3–5 must parse every response through these exported schemas.

- [ ] **Step 1: Write failing strict-schema tests**

Add cases proving 1 and 200 unique device IDs pass, 201 IDs fail, duplicates fail, unknown fields fail, hashes require 64 lowercase hexadecimal characters, cancellation reasons are trimmed to 1–1000 characters, and every response rejects missing actor, policy or state fields.

```ts
const prepare = {
  protocol: "offline-grants-activation-v1",
  previewRequestId: crypto.randomUUID(),
  previewDigest: "a".repeat(64),
  policyId: crypto.randomUUID(),
  deviceIds: [crypto.randomUUID()],
  decisionReference: "CAB-2026-0914",
  requestId: crypto.randomUUID(),
};

expect(platformGrantActivationContracts.prepare.body.parse(prepare)).toEqual(prepare);
expect(() =>
  platformGrantActivationContracts.prepare.body.parse({
    ...prepare,
    deviceIds: [prepare.deviceIds[0], prepare.deviceIds[0]],
  }),
).toThrow();
expect(() =>
  platformGrantActivationContracts.confirm.body.parse({
    protocol: "offline-grants-activation-v1",
    preparationDigest: "a".repeat(64),
    requestId: crypto.randomUUID(),
    extra: true,
  }),
).toThrow();
```

- [ ] **Step 2: Write the failing capability test**

Assert that `platform_admin` contains `offlineGrants.activate`, while `support` and `accountant` do not. Continue deriving principal fixtures from `platformCapabilitiesForRole`.

```ts
expect(platformCapabilitiesForRole.platform_admin).toContain("offlineGrants.activate");
expect(platformCapabilitiesForRole.support).not.toContain("offlineGrants.activate");
expect(platformCapabilitiesForRole.accountant).not.toContain("offlineGrants.activate");
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run \
  test/offline-grant-activations.test.ts test/platform-auth.test.ts
```

Expected: failure because the activation exports and capability do not exist.

- [ ] **Step 4: Implement the exact contract surface**

Define strict Zod schemas with these discriminants and states:

```ts
export const grantActivationStateSchema = z.enum([
  "prepared",
  "confirmed",
  "cancelled",
  "expired",
  "needs_review",
]);

export const grantActivationPrepareRequestSchema = z
  .object({
    protocol: z.literal("offline-grants-activation-v1"),
    previewRequestId: platformUuidSchema,
    previewDigest: digestSchema,
    policyId: platformUuidSchema,
    deviceIds: uniqueDeviceIdsSchema,
    decisionReference: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();

export const grantActivationConfirmRequestSchema = z
  .object({
    protocol: z.literal("offline-grants-activation-v1"),
    preparationDigest: digestSchema,
    requestId: platformUuidSchema,
  })
  .strict();

export const grantActivationCancelRequestSchema = z
  .object({
    protocol: z.literal("offline-grants-activation-v1"),
    reason: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();
```

Expose list, detail, prepare, confirm and cancel contracts. The preparation response must contain exact device members, base policy identity, preview identity, preparation digest, actors, timestamps, state and nullable result policy. The receipt must contain the confirmed policy and exact activation IDs.

- [ ] **Step 5: Add the capability without weakening role equality**

Append `offlineGrants.activate` to `platformCapabilitySchema` and only to `platformCapabilitiesForRole.platform_admin`. Update assertions that enumerate platform-admin capabilities; do not hard-code new fixture arrays outside the shared role map.

- [ ] **Step 6: Run package gates**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
```

Expected: all pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add packages/platform-contracts/src/offline-grant-activations.ts \
  packages/platform-contracts/src/platform-auth.ts \
  packages/platform-contracts/src/index.ts \
  packages/platform-contracts/test/offline-grant-activations.test.ts \
  packages/platform-contracts/test/platform-auth.test.ts
git commit -m "feat: define offline grant activation contracts"
```

### Task 2: Add constrained activation persistence and migration

**Files:**

- Create: `packages/db/src/schema/device-grant-activations.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/schema/device-grants.ts`
- Create: `packages/db/migrations/0152_offline_grant_activation.sql`
- Create: `packages/db/migrations/meta/0152_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/device-grant-activation-migration.test.ts`
- Test: `packages/db/test/device-grants-schema.test.ts`
- Modify: `deploy/production/test/offline-grant-readiness-contract.test.mjs`

**Interfaces:**

- Consumes: `entitlementLifecyclePolicies`, `tenantSubscriptions`, `platformUsers`, station device ownership, kiosk ownership and existing composite tenant keys.
- Produces: `offlineGrantActivationPreparations`, `offlineGrantActivationMembers`, `offlineGrantDeviceActivations` and their Drizzle row types.
- Task 3 owns state creation; Task 4 owns confirmed transitions and runtime reads.

- [ ] **Step 1: Write the failing schema and migration assertions**

Assert exports, table names, request uniqueness, exact 30-minute finite interval support, distinct confirmation actor constraint, member owner constraint, composite tenant/subscription foreign key, base/rollout policy foreign keys, one active activation per concrete device and JSON object/hash checks.

```ts
expect(schema).toHaveProperty("offlineGrantActivationPreparations");
expect(schema).toHaveProperty("offlineGrantActivationMembers");
expect(schema).toHaveProperty("offlineGrantDeviceActivations");
expect(sqlText).toContain("offline_grant_activation_confirm_actor_check");
expect(sqlText).toContain("confirmed_by_platform_user_id <> prepared_by_platform_user_id");
expect(sqlText).toContain("offline_grant_device_activations_station_active_uq");
expect(sqlText).toContain("offline_grant_device_activations_kiosk_active_uq");
```

- [ ] **Step 2: Run the focused DB tests and verify RED**

```bash
corepack pnpm --filter @markiro/db exec vitest run \
  test/device-grant-activation-migration.test.ts test/device-grants-schema.test.ts
```

Expected: missing schema exports and migration.

- [ ] **Step 3: Define focused tables**

Use a dedicated schema module. The preparation owns prepare/confirm/cancel request identity and saved response envelopes:

```ts
type ActivationState = "prepared" | "confirmed" | "cancelled" | "needs_review";

export const offlineGrantActivationPreparations = pgTable(
  "offline_grant_activation_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").$type<ActivationState>().notNull().default("prepared"),
    basePolicyId: uuid("base_policy_id").notNull(),
    rolloutPolicyId: uuid("rollout_policy_id"),
    previewRequestId: uuid("preview_request_id").notNull(),
    previewDigest: text("preview_digest").notNull(),
    preparationDigest: text("preparation_digest").notNull(),
    prepareRequestId: uuid("prepare_request_id").notNull().unique(),
    prepareRequestHash: text("prepare_request_hash").notNull(),
    prepareResponse: jsonb("prepare_response").notNull(),
    decisionReference: text("decision_reference").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    preparedByPlatformUserId: text("prepared_by_platform_user_id").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmRequestId: uuid("confirm_request_id").unique(),
    confirmRequestHash: text("confirm_request_hash"),
    confirmResponse: jsonb("confirm_response"),
    confirmedByPlatformUserId: text("confirmed_by_platform_user_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelRequestId: uuid("cancel_request_id").unique(),
    cancelRequestHash: text("cancel_request_hash"),
    cancelResponse: jsonb("cancel_response"),
    cancelledByPlatformUserId: text("cancelled_by_platform_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
  },
  activationPreparationConstraints,
);
```

Members use one row per device and include tenant, subscription, owner kind,
concrete device column, credential epoch, assignment/configuration/report/grant/keyset
identities, entitlement revision and `reservationState: "prepared" | "released"`.
Partial unique indexes on each concrete device column apply while
`reservationState = 'prepared'`. Device activations reference the preparation,
base policy and rollout policy and duplicate the exact owner identity needed for
an indexed runtime lookup. Add nullable `activationId` to
`device_grant_configurations`, referencing the activation table, so configuration
history records rollout provenance without changing the native response.

- [ ] **Step 4: Generate and review migration 0152**

Run:

```bash
corepack pnpm --filter @markiro/db db:generate
```

Rename only the newly generated migration to `0152_offline_grant_activation.sql` if Drizzle generated a descriptive suffix. Preserve generated metadata alignment. Review SQL for tenant foreign keys, partial unique indexes, finite timestamps, request hashes, JSON bounds and actor state constraints. Do not edit migration 0151.

- [ ] **Step 5: Add a legacy-to-current migration test**

Create a temporary database, migrate through 0151, insert representative policy, subscription, Station/Handheld/kiosk device and readiness rows, then apply 0152. Assert all legacy rows are byte-equivalent and all three new tables are empty. Apply the complete migration set again and assert no duplicate objects or activation rows.

- [ ] **Step 6: Update the production migration contract**

Extend the existing offline-grant production contract to require 0152 before API startup and assert that the migration contains no `INSERT` into activation or lifecycle policy tables.

- [ ] **Step 7: Build and run DB gates**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
```

Expected: all pass; database-backed test reports its real PostgreSQL execution rather than a skip.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/db/src/schema/device-grant-activations.ts packages/db/src/schema.ts \
  packages/db/src/schema/device-grants.ts \
  packages/db/migrations/0152_offline_grant_activation.sql \
  packages/db/migrations/meta/0152_snapshot.json packages/db/migrations/meta/_journal.json \
  packages/db/test/device-grant-activation-migration.test.ts \
  packages/db/test/device-grants-schema.test.ts \
  deploy/production/test/offline-grant-readiness-contract.test.mjs
git commit -m "feat: persist prepared offline grant activations"
```

### Task 3: Prepare an immutable cohort from current readiness facts

**Files:**

- Create: `apps/api/src/modules/device-grants/grant-activation-digest.ts`
- Create: `apps/api/src/modules/device-grants/grant-activation-facts.ts`
- Create: `apps/api/src/modules/device-grants/platform-grant-activation.service.ts`
- Modify: `apps/api/src/modules/device-grants/platform-grant-readiness.service.ts`
- Test: `apps/api/test/platform-grant-activation.integration.test.ts`
- Test: `apps/api/test/platform-grant-readiness.integration.test.ts`

**Interfaces:**

- Consumes: `readGrantReadinessFacts`, `classifyGrantReadiness`, `parseApprovedGrantPolicy`, `entitlementDigest`, P1D.1 preview audit facts and Task 2 tables.
- Produces: `readGrantActivationFacts(tx, input, asOf)`, `grantActivationPreparationDigest(snapshot)`, and `PlatformGrantActivationService.prepare(principal, body)`.
- Task 4 extends the same service with confirm/cancel/list/detail.

- [ ] **Step 1: Write failing prepare tests against PostgreSQL**

Cover exact successful preparation, no writes to policies/configurations/subscriptions, replay returning byte-equivalent response, changed body under one request ID, missing preview audit, mismatched preview digest, missing device, blocked device, stale client report, policy mismatch, multi-tenant device ownership and concurrent overlapping preparations.

```ts
const result = await service.prepare(preparer, request);
expect(result.state).toBe("prepared");
expect(result.expiresAt).toBe("2026-09-14T12:30:00.000Z");
expect(await policyRows()).toEqual(beforePolicies);
expect(await subscriptionRows()).toEqual(beforeSubscriptions);
expect(await configurationRows()).toEqual(beforeConfigurations);
expect(await service.prepare(preparer, request)).toEqual(result);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.integration.test.ts
```

Expected: missing activation service and fact reader.

- [ ] **Step 3: Extract one canonical readiness snapshot builder**

Move the P1D.1 preview canonical row mapping into an exported deterministic helper used by both preview and activation preparation:

```ts
export function canonicalGrantReadinessFacts(rows: readonly PlatformGrantReadinessRow[]) {
  return rows.map((row) => ({
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    deviceKind: row.deviceKind,
    credentialEpoch: row.credentialEpoch,
    assignmentId: row.assignmentId,
    configurationId: row.configuration?.id ?? null,
    clientReportId: row.clientReport?.id ?? null,
    keysetRevision: row.signing.keysetRevision,
    eligibility: row.eligibility,
  }));
}
```

Keep preview digest compatibility exact. Add a regression assertion using a fixed fixture digest before and after extraction.

- [ ] **Step 4: Implement bounded activation fact loading**

`readGrantActivationFacts` must load all requested IDs in bounded SQL, reject missing IDs, resolve each current subscription/base policy, and return sorted facts. It must not execute one tenant-wide query per device. Include the entitlement revision and concrete owner identity needed by confirm.

```ts
export interface GrantActivationFacts {
  asOf: Date;
  basePolicy: ApprovedGrantPolicy;
  rows: PlatformGrantReadinessRow[];
  members: GrantActivationMemberSnapshot[];
}
```

- [ ] **Step 5: Implement prepare with idempotency first**

Before reading mutable facts, look up `prepareRequestId`. If found, compare `entitlementDigest(body)` with `prepareRequestHash`; replay the parsed saved response on equality and return `409 GRANT_ACTIVATION_REQUEST_CONFLICT` otherwise.

For a new request, verify the P1D.1 preview audit's action, target policy, request ID and digest. Re-read facts at one clock value, require all eligible, compute the preparation digest, and insert preparation plus members in one transaction. Set `expiresAt = preparedAt + 30 * 60 * 1000` with an overflow-safe clock check.

- [ ] **Step 6: Enforce overlap without false serialization**

Use the member table's partial device unique indexes while
`reservationState = 'prepared'` as the final concurrency authority. Translate
their named violations to `409 GRANT_ACTIVATION_DEVICE_ALREADY_PREPARED` with
sanitized conflicting preparation IDs obtained by a tenant-scoped follow-up
query. Confirmation and cancellation change every member reservation to
`released` in their own atomic transaction. Do not take fleet-wide locks.

- [ ] **Step 7: Record exact prepare audit**

Record `offline_grant.activation.prepared` atomically with actor, role, request ID, base policy, preview digest, preparation digest, tenant/device counts and expiry. Exclude JWS, credentials and full readiness payloads.

- [ ] **Step 8: Run focused and API package gates**

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.integration.test.ts \
  test/platform-grant-readiness.integration.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

Expected: all pass.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/api/src/modules/device-grants/grant-activation-digest.ts \
  apps/api/src/modules/device-grants/grant-activation-facts.ts \
  apps/api/src/modules/device-grants/platform-grant-activation.service.ts \
  apps/api/src/modules/device-grants/platform-grant-readiness.service.ts \
  apps/api/test/platform-grant-activation.integration.test.ts \
  apps/api/test/platform-grant-readiness.integration.test.ts
git commit -m "feat: prepare strict offline grant cohorts"
```

### Task 4: Confirm with fresh facts and resolve exact runtime overlays

**Files:**

- Modify: `apps/api/src/modules/device-grants/platform-grant-activation.service.ts`
- Modify: `apps/api/src/modules/device-grants/grant-activation-facts.ts`
- Modify: `apps/api/src/modules/device-grants/grant-policy.ts`
- Modify: `apps/api/src/modules/device-grants/grant-rollout.ts`
- Modify: `apps/api/src/modules/device-grants/grant-issuer.service.ts`
- Test: `apps/api/test/platform-grant-activation.integration.test.ts`
- Test: `apps/api/test/device-grants-policy.test.ts`
- Test: `apps/api/test/device-grants-issuer.test.ts`

**Interfaces:**

- Consumes: preparation/member rows from Task 2 and fact/digest helpers from Task 3.
- Produces: `PlatformGrantActivationService.confirm`, `.cancel`, `.list`, `.detail`, and `loadEffectiveGrantPolicy(tx, owner, subscriptionId)`.
- `resolveGrantRollout` receives an effective policy with activation provenance rather than trusting caller-supplied mode.

- [ ] **Step 1: Add failing confirmation and cancellation tests**

Test successful dual-control confirm, self-confirm denial, expired/cancelled/stale preparations, exact replay, changed request, concurrent confirms, next-version allocation, rollback of partial writes, cancellation replay and cancellation racing confirmation.

```ts
await expect(service.confirm(preparation.id, preparer, confirm)).rejects.toMatchObject({
  response: { code: "GRANT_ACTIVATION_SECOND_OPERATOR_REQUIRED" },
});

const receipt = await service.confirm(preparation.id, confirmer, confirm);
expect(receipt.state).toBe("confirmed");
expect(receipt.rolloutPolicy.offlineGrant.rollout?.deviceIds).toEqual([...deviceIds].sort());
expect(await readSubscriptionPlanVersions()).toEqual(beforePlanVersions);
```

- [ ] **Step 2: Add failing runtime resolution tests**

Cover selected Station, selected Handheld, selected kiosk, unselected device, wrong tenant, wrong subscription, changed base policy, invalid rollout hash, device omitted from rollout payload, absent signing configuration, repeated refresh and last-delivered-strict downgrade protection.

```ts
expect(await resolveFor(selectedOwner)).toMatchObject({ mode: "strict" });
expect(await resolveFor(unselectedOwner)).toMatchObject({ mode: "observe" });
expect(await resolveFor(foreignTenantOwner)).toMatchObject({ mode: "observe" });
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.integration.test.ts \
  test/device-grants-policy.test.ts test/device-grants-issuer.test.ts
```

Expected: confirm/cancel and overlay resolution cases fail.

- [ ] **Step 4: Implement confirmation under ordered locks**

Lock preparation, base policy, affected subscription rows, device authority rows and activation rows in the repository's established order. Re-read facts and recompute the digest. Return a typed stale response and move the preparation to `needs_review` only when the fresh facts differ; infrastructure exceptions leave it `prepared`.

Acquire `pg_advisory_xact_lock(hashtextextended(policyKey, 0))`, read the maximum existing version, and insert `version + 1`. Set `createdByPlatformUserId` to the preparer, `approvedByPlatformUserId` to the confirmer and both approval fields in the same transaction.

- [ ] **Step 5: Create exact activation bindings atomically**

Insert one activation for each saved member. Require the member's current tenant, subscription, device, assignment and base policy to match. Save the rollout policy ID and preparation ID. Update the preparation to confirmed only after every insert succeeds.

- [ ] **Step 6: Implement explicit policy overlay loading**

Keep `loadApprovedGrantPolicy` as the base subscription reader. Add:

```ts
export interface EffectiveGrantPolicy {
  policy: ApprovedGrantPolicy | null;
  activationId: string | null;
  basePolicyId: string | null;
}

export async function loadEffectiveGrantPolicy(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  subscriptionId: string,
): Promise<EffectiveGrantPolicy>;
```

Load at most one exact active binding through composite tenant/device and subscription predicates. Parse and hash-check both policies. Require equal durations and task bounds, exact base-policy identity and membership in the rollout. Any invalid overlay returns the base policy with no activation; it never broadens strict authority.

- [ ] **Step 7: Persist activation provenance in configuration**

Use the nullable `activationId` column added by Task 2. Include it in transition
equality and persisted configuration. Do not change the native response schema.

```ts
const effective = await loadEffectiveGrantPolicy(tx, owner, subscription.id);
const configuration = await resolveGrantRollout(
  tx,
  owner,
  effective.policy,
  signingConfigured,
  effective.activationId,
);
```

- [ ] **Step 8: Implement cancel, list and detail**

Cancel only `prepared` or `needs_review`, preserve exact response replay and release overlap ownership through the state predicate. List uses cursor pagination and bounded rows. Detail returns the complete sanitized member snapshot only after platform authorization.

- [ ] **Step 9: Record atomic confirmation/cancellation audits**

Use actions `offline_grant.activation.confirmed` and `offline_grant.activation.cancelled`. Assert exact preparing and confirming actors, request IDs, base/rollout hashes, activation digest, cohort counts and state transitions.

- [ ] **Step 10: Run focused and API package gates**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.integration.test.ts \
  test/device-grants-policy.test.ts test/device-grants-issuer.test.ts
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

Expected: all pass; database-backed cases do not skip.

- [ ] **Step 11: Commit Task 4**

```bash
git add apps/api/src/modules/device-grants/platform-grant-activation.service.ts \
  apps/api/src/modules/device-grants/grant-activation-facts.ts \
  apps/api/src/modules/device-grants/grant-policy.ts \
  apps/api/src/modules/device-grants/grant-rollout.ts \
  apps/api/src/modules/device-grants/grant-issuer.service.ts \
  apps/api/test/platform-grant-activation.integration.test.ts \
  apps/api/test/device-grants-policy.test.ts apps/api/test/device-grants-issuer.test.ts
git commit -m "feat: confirm offline grant pilot activation"
```

### Task 5: Expose guarded platform routes and OpenAPI ownership

**Files:**

- Create: `apps/api/src/modules/device-grants/platform-grant-activation.controller.ts`
- Modify: `apps/api/src/modules/device-grants/platform-grant-readiness.module.ts`
- Modify: `apps/api/test/platform-route-contracts.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `apps/api/test/device-grants-routes.test.ts`
- Test: `apps/api/test/platform-grant-activation.routes.test.ts`

**Interfaces:**

- Consumes: `platformGrantActivationContracts` and `PlatformGrantActivationService`.
- Produces: five guarded `/platform/offline-grants/activations` routes registered only when `setup.platformAuth` loads `PlatformGrantReadinessModule`.

- [ ] **Step 1: Write failing metadata and route tests**

Assert read routes require `tenants.read` and `catalog.read`; mutation routes additionally require `catalog.write` and `offlineGrants.activate`. Start the application without platform auth and assert all five routes return 404.

```ts
expect(
  Reflect.getMetadata(PLATFORM_ACCESS_POLICY, PlatformGrantActivationController.prototype.confirm),
).toEqual({
  mode: "capabilities",
  capabilities: ["tenants.read", "catalog.read", "catalog.write", "offlineGrants.activate"],
});
```

- [ ] **Step 2: Run route tests and verify RED**

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.routes.test.ts test/device-grants-routes.test.ts
```

Expected: controller and route inventory entries are absent.

- [ ] **Step 3: Add the controller using established platform helpers**

Use `PlatformApiProtectedOk`, `ZodValidationPipe`, `parsePlatformResponse` and `RequestWithPlatformPrincipal`. Never access `request.platformPrincipal` without the platform-auth-only module boundary.

```ts
@ApiTags("platform-offline-grants")
@Controller("platform/offline-grants/activations")
export class PlatformGrantActivationController {
  constructor(private readonly activations: PlatformGrantActivationService) {}

  @Post(":id/confirm")
  @HttpCode(200)
  @RequirePlatformCapabilities(
    "tenants.read",
    "catalog.read",
    "catalog.write",
    "offlineGrants.activate",
  )
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body(new ZodValidationPipe(platformGrantActivationContracts.confirm.body))
    body: PlatformGrantActivationConfirmRequest,
  ) {
    return parsePlatformResponse(
      platformGrantActivationContracts.confirm.response,
      await this.activations.confirm(id, request.platformPrincipal!, body),
    );
  }
}
```

Use the same pattern for list, detail, prepare and cancel, with UUID parameter parsing.

- [ ] **Step 4: Register service and controller only in the platform module**

Add both to `PlatformGrantReadinessModule.forRoot(env)`. Do not add them to `DeviceGrantsModule` or any always-loaded module.

- [ ] **Step 5: Extend OpenAPI and subscription route inventories**

Add exact methods, paths, bodies and responses to `CURRENT_SAAS_ROUTES`; add controller/service providers to the isolated OpenAPI test. Classify every activation route as platform-only and absent from subscription policy enforcement.

- [ ] **Step 6: Run route, OpenAPI and API gates**

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/platform-grant-activation.routes.test.ts \
  test/device-grants-routes.test.ts \
  test/platform-contract-openapi.test.ts \
  test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

Expected: all pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/api/src/modules/device-grants/platform-grant-activation.controller.ts \
  apps/api/src/modules/device-grants/platform-grant-readiness.module.ts \
  apps/api/test/platform-route-contracts.ts \
  apps/api/test/platform-contract-openapi.test.ts \
  apps/api/test/subscription-route-inventory.test.ts \
  apps/api/test/device-grants-routes.test.ts \
  apps/api/test/platform-grant-activation.routes.test.ts
git commit -m "feat: expose guarded offline grant activation routes"
```

### Task 6: Add recoverable prepare and second-operator confirmation UX

**Files:**

- Create: `apps/saas-admin/src/pages/catalog/offline-grant-activation-api.ts`
- Create: `apps/saas-admin/src/pages/catalog/offline-grant-activation-state.ts`
- Create: `apps/saas-admin/src/pages/catalog/OfflineGrantActivationPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/OfflineGrantReadinessPanel.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/test/offline-grant-activation-api.test.ts`
- Test: `apps/saas-admin/test/offline-grant-activation.test.tsx`
- Modify: `apps/saas-admin/test/offline-grant-readiness.test.tsx`
- Modify: `apps/saas-admin/test/catalog.test.tsx`

**Interfaces:**

- Consumes: Task 1 contracts and the existing readiness preview response.
- Produces: API methods `listOfflineGrantActivations`, `getOfflineGrantActivation`, `prepareOfflineGrantActivation`, `confirmOfflineGrantActivation`, `cancelOfflineGrantActivation`; persisted uncertain-request intent helpers; activation panel callbacks.

- [ ] **Step 1: Write failing API serialization tests**

Record method, URL and parsed JSON body for every API helper. Assert value-based equality, UUID preservation, strict response parsing and typed 409/401/403 envelopes.

```ts
expect(JSON.parse(recorded.body)).toEqual({
  protocol: "offline-grants-activation-v1",
  preparationDigest,
  requestId,
});
```

- [ ] **Step 2: Write failing workflow tests**

Cover eligible preview → prepare, same operator disabled, second operator confirm, expiry, stale result, cancellation, uncertain prepare/confirm retry with original request ID, successful retry clearing old notice, dirty close protection and RU/EN accessible labels.

```tsx
expect(screen.getByRole("button", { name: "Подтвердить strict" })).toBeDisabled();
expect(
  screen.getByText("Подтверждение должен выполнить другой администратор платформы"),
).toBeVisible();
```

- [ ] **Step 3: Run focused SaaS tests and verify RED**

```bash
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/ui build
corepack pnpm --filter @markiro/saas-admin exec vitest run \
  test/offline-grant-activation-api.test.ts \
  test/offline-grant-activation.test.tsx \
  test/offline-grant-readiness.test.tsx test/catalog.test.tsx
```

Expected: missing helpers, panel and actions.

- [ ] **Step 4: Implement strict API helpers and stable attempts**

Parse outgoing bodies before sending and responses after receiving. Store an attempt per operation using this shape:

```ts
export interface GrantActivationAttempt<TRequest, TResponse> {
  request: TRequest;
  response: TResponse | null;
  notice: "uncertain" | "stale" | null;
}
```

An uncertain attempt blocks edits that would change the body and retries the same identity. Successful retry clears both attempt and old notice after server state has been loaded.

- [ ] **Step 5: Add Prepare pilot to the preview**

Show the action only when `aggregates.blocked === 0`, `canActivate` is true and a preview exists. Pass exact `preview.requestId`, `preview.previewDigest`, `preview.policyId` and `preview.items.map(item => item.deviceId)`; never rebuild selection from the current paginated table.

- [ ] **Step 6: Implement confirmation workspace**

Render policy, exact cohort grouped by tenant/kind, timestamps, expiry, actors, decision reference and current state. Disable confirm for the preparing actor and show the translated reason. On stale response, keep the preparation visible and link back to create a new readiness preview.

- [ ] **Step 7: Preserve accessibility and dirty state**

Use existing `Alert`, `Button`, `Input`, `StatusChip`, `Table` and drawer patterns. Provide semantic headings, labelled controls, visible focus and non-color status. Report dirty state for decision reference, active uncertain attempts and unconfirmed cancellation input; clear it with a cleanup-only unmount effect.

- [ ] **Step 8: Add exact RU/EN copy**

Use these primary labels:

```text
RU: Подготовить пилот / Подтвердить strict / Отменить подготовку
EN: Prepare pilot / Confirm strict / Cancel preparation
```

Explain that tariffs and current work are unchanged, that only exact devices switch on configuration refresh, and that confirmation requires another platform administrator.

- [ ] **Step 9: Run focused and package gates**

```bash
corepack pnpm --filter @markiro/saas-admin exec vitest run \
  test/offline-grant-activation-api.test.ts \
  test/offline-grant-activation.test.tsx \
  test/offline-grant-readiness.test.tsx test/catalog.test.tsx
corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
```

Expected: all pass. Record that DOM tests are not visual browser confirmation.

- [ ] **Step 10: Commit Task 6**

```bash
git add apps/saas-admin/src/pages/catalog/offline-grant-activation-api.ts \
  apps/saas-admin/src/pages/catalog/offline-grant-activation-state.ts \
  apps/saas-admin/src/pages/catalog/OfflineGrantActivationPanel.tsx \
  apps/saas-admin/src/pages/catalog/OfflineGrantReadinessPanel.tsx \
  apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json \
  apps/saas-admin/test/offline-grant-activation-api.test.ts \
  apps/saas-admin/test/offline-grant-activation.test.tsx \
  apps/saas-admin/test/offline-grant-readiness.test.tsx \
  apps/saas-admin/test/catalog.test.tsx
git commit -m "feat: add offline grant pilot confirmation workspace"
```

### Task 7: Prove compatibility, operations and production ownership

**Files:**

- Modify: `apps/api/test/public-api-offline-grants-workflow.test.ts`
- Modify: `apps/api/test/device-grants-routes.test.ts`
- Modify: `apps/station/test/offline-grants-recovery.test.ts`
- Modify: `apps/kiosk/test/offline-grants-recovery.test.ts`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/grants/GrantTransportTest.kt`
- Modify: `docs/operations/offline-device-grants.md`
- Create: `docs/acceptance/offline-grants-p1d2.md`
- Modify: `deploy/production/test/offline-grant-readiness-contract.test.mjs`
- Modify: `tools/ci/affected.mjs` if the new files are not already owned by API, SaaS, DB and all native jobs.

**Interfaces:**

- Consumes: the complete API/runtime/UI implementation.
- Produces: cross-surface regression evidence and an operational deployment/rollback record.

- [ ] **Step 1: Write the cross-surface compatibility regression**

Create two eligible devices on one base policy and one legacy client without readiness. Confirm strict for exactly one eligible device. Assert:

```ts
expect(selectedConfiguration.mode).toBe("strict");
expect(unselectedConfiguration.mode).toBe("observe");
expect(legacyConfiguration.mode).toBe("observe");
expect(afterSubscription).toEqual(beforeSubscription);
expect(afterCatalogVersion).toEqual(beforeCatalogVersion);
```

Then restrict the subscription and prove new strict work is denied while an existing frozen task and retained evidence can still reconcile.

- [ ] **Step 2: Run the workflow regression and verify RED or missing coverage**

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/public-api-offline-grants-workflow.test.ts \
  test/device-grants-routes.test.ts
```

Expected before the assertions are implemented: failure at exact activation mode or missing compatibility fixture.

- [ ] **Step 3: Add native no-contract-change regressions**

Use existing saved configuration fixtures to prove Station, kiosk and Handheld parse the same response shapes before and after server activation work. Add no new native DTO fields. Verify pending readiness/evidence intents survive restart and keep original request identities.

- [ ] **Step 4: Update operational documentation**

Document migration 0152, platform routes, two-operator flow, 30-minute preparation expiry, exact device overlay, configuration-refresh activation, stale recovery, explicit rollback boundary and proof categories. Correct the remaining readiness deployment reference that says migration 0149 to migration 0151.

- [ ] **Step 5: Add an acceptance ledger**

Map each P1D.2 completion criterion to contract, DB, API, SaaS and native tests. Mark production cohort selection, deployed configuration delivery, physical Windows/station hardware, vendor Handheld scanner, kiosk device and customer acceptance as `NOT RUN`.

- [ ] **Step 6: Verify CI ownership**

Run the affected classifier against representative paths. Ensure contract/schema changes schedule platform contracts, DB, API, SaaS Admin, Station, kiosk and Handheld. Modify `tools/ci/affected.mjs` only if an affected surface would otherwise skip.

- [ ] **Step 7: Run focused cross-surface gates**

```bash
corepack pnpm turbo run build --filter='@markiro/station^...'
corepack pnpm --filter @markiro/station exec vitest run test/offline-grants-recovery.test.ts
corepack pnpm --filter @markiro/kiosk exec vitest run test/offline-grants-recovery.test.ts
cd apps/handheld
./gradlew --no-daemon testDebugUnitTest --tests '*GrantTransportTest'
cd ../..
corepack pnpm test:production-bundle:contract
```

Expected: all pass; report Android or production dependencies explicitly if unavailable.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/api/test/public-api-offline-grants-workflow.test.ts \
  apps/api/test/device-grants-routes.test.ts \
  apps/station/test/offline-grants-recovery.test.ts \
  apps/kiosk/test/offline-grants-recovery.test.ts \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/grants/GrantTransportTest.kt \
  docs/operations/offline-device-grants.md docs/acceptance/offline-grants-p1d2.md \
  deploy/production/test/offline-grant-readiness-contract.test.mjs tools/ci/affected.mjs
git commit -m "test: verify offline grant activation compatibility"
```

### Task 8: Run complete verification and prepare the reviewable branch

**Files:**

- Modify only files required to fix failures caused by Tasks 1–7.
- Update: `docs/acceptance/offline-grants-p1d2.md` with exact commands, counts, skips and evidence boundaries.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: a clean, scoped branch with current-source verification and a complete acceptance record.

- [ ] **Step 1: Rebuild shared dependencies in graph order**

```bash
corepack pnpm turbo run build --filter='@markiro/api^...' \
  --filter='@markiro/saas-admin^...' --filter='@markiro/station^...' \
  --filter='@markiro/kiosk^...'
```

Expected: all selected builds pass.

- [ ] **Step 2: Run the broad workspace gate serially**

Load only the isolated test environment and run:

```bash
corepack pnpm turbo lint typecheck test build --concurrency=1 --force
```

Expected: all applicable tasks pass. Record database and external-service skips separately; do not count them as proof.

- [ ] **Step 3: Run Android and Station host gates**

```bash
cd apps/handheld
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
cd ../..
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: all pass. These commands do not prove vendor scanner, Windows installation, printer or factory behavior.

- [ ] **Step 4: Run production and formatting gates**

```bash
corepack pnpm test:production-bundle:contract
corepack pnpm format:check
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Update Graphify and inspect the final diff**

```bash
graphify update .
git fetch origin main
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Confirm the range contains only the P1D.2 spec, plan, implementation, tests and operational evidence. If `origin/main` advanced, merge it without rewriting applied migrations; resolve the new migration number and metadata from the current journal.

- [ ] **Step 6: Complete the acceptance record**

Record exact successful task/test counts, database execution, browser checks, Android/Cargo results and CI ownership. Keep production deployment, physical devices, printers, scanners and customer pilot marked `NOT RUN` until separately exercised.

- [ ] **Step 7: Commit verification-only documentation changes**

```bash
git add docs/acceptance/offline-grants-p1d2.md
git commit -m "docs: record offline grant activation acceptance"
```

- [ ] **Step 8: Stop before external publication**

Report the final branch, commits, checks and unrun gates. Push and create or update a PR only when already authorized by the user. Production activation, deployment and cohort selection require separate explicit authorization and are not implied by implementation completion.
