# Offline Grants P1D.3 Selective Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-operator, selective and auditable transition from confirmed strict activation to observe mode without changing commercial state or native client contracts.

**Architecture:** A new rollback aggregate freezes exact active activation facts, then a different platform administrator confirms it after a fresh re-read. Confirmation creates an approved observe policy revision and adds terminal rollback provenance to selected activation rows; runtime policy resolution returns that observe revision until a later separately approved strict activation exists.

**Tech Stack:** TypeScript, NestJS, Drizzle/PostgreSQL, Zod, React, TanStack Query, Vitest, Kotlin compatibility fixtures

**Spec:** `docs/superpowers/specs/2026-09-14-offline-grants-p1d3-rollback-design.md`

## Global Constraints

- Select one to 200 unique active activation UUIDs.
- Prepare never mutates runtime or commercial state.
- Confirm requires a different current platform administrator.
- Exact retries reuse persisted responses; changed input under the same request ID conflicts.
- Rollback changes only selected devices after authenticated configuration refresh.
- Existing compact grants, frozen tasks and recovery evidence remain valid.
- No native wire-contract changes.
- Production deployment and physical acceptance remain separate gates.

---

### Task 1: Shared rollback contracts

**Files:**

- Create: `packages/platform-contracts/src/offline-grant-rollbacks.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Test: `packages/platform-contracts/test/offline-grant-rollbacks.test.ts`

**Interfaces:**

- Consumes: platform UUID/timestamp/role primitives and offline policy records.
- Produces: `platformGrantRollbackContracts` and request, preparation, member and receipt types.

- [ ] Write schema tests for strict objects, unique activation IDs, the 200-item limit, actor/state consistency and confirm/cancel responses.
- [ ] Run the focused contract test and verify failure because the module is absent.
- [ ] Implement protocol `offline-grants-rollback-v1`, states `prepared|confirmed|cancelled|expired|needs_review`, prepare/confirm/cancel/list/detail schemas and inferred types.
- [ ] Export the contracts from the package index and run contract test, typecheck, lint and build.

### Task 2: Rollback persistence and migrations

**Files:**

- Modify: `packages/db/src/schema/device-grant-activations.ts`
- Create: `packages/db/migrations/0155_offline_grant_rollback.sql`
- Create: `packages/db/migrations/0156_validate_offline_grant_rollback.sql`
- Create: `packages/db/migrations/meta/0155_snapshot.json`
- Create: `packages/db/migrations/meta/0156_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/device-grants-schema.test.ts`
- Create: `packages/db/test/offline-grant-rollback-migration.test.ts`

**Interfaces:**

- Consumes: activation, policy, subscription, platform-user and concrete-device keys.
- Produces: rollback preparations/members and constrained terminal rollback provenance on activation rows.

- [ ] Write failing schema and migration tests for request uniqueness, 30-minute expiry, actor separation, member ownership/reservation, all-or-none rollback provenance and validated foreign keys.
- [ ] Add Drizzle tables and activation columns with composite tenant/device references.
- [ ] Add migration 0155 with new tables, indexes, checks and `NOT VALID` activation-table foreign keys; add migration 0156 with `VALIDATE CONSTRAINT`.
- [ ] Generate or reconcile snapshots and journal entries without rewriting migration 0152 or 0153.
- [ ] Apply migrations to a fresh isolated PostgreSQL database and run focused DB tests, package typecheck, lint and build.

### Task 3: Server facts and digest

**Files:**

- Create: `apps/api/src/modules/device-grants/grant-rollback-digest.ts`
- Create: `apps/api/src/modules/device-grants/grant-rollback-facts.ts`
- Test: `apps/api/test/platform-grant-rollback-facts.test.ts`

**Interfaces:**

- Consumes: exact activation IDs plus locked subscription, policy, assignment, device and configuration rows.
- Produces: `readGrantRollbackFacts(tx, activationIds)` and a deterministic canonical rollback digest.

- [ ] Write failing tests for sorted canonical facts, mixed-policy rejection, inactive activation, malformed policy and missing ownership.
- [ ] Implement one bounded SQL/read path that loads all selected facts once and preserves input completeness.
- [ ] Build the snapshot only from server-owned facts and hash it through `entitlementDigest`.
- [ ] Run focused tests and API typecheck.

### Task 4: Two-operator rollback service and routes

**Files:**

- Create: `apps/api/src/modules/device-grants/platform-grant-rollback.service.ts`
- Create: `apps/api/src/modules/device-grants/platform-grant-rollback.controller.ts`
- Modify: `apps/api/src/modules/device-grants/platform-grant-readiness.module.ts`
- Modify: `apps/api/test/platform-route-contracts.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Create: `apps/api/test/platform-grant-rollback.routes.test.ts`
- Create: `apps/api/test/platform-grant-rollback.integration.test.ts`
- Create: `apps/api/test/platform-grant-rollback-errors.test.ts`

**Interfaces:**

- Consumes: rollback contracts/facts, lifecycle policy storage, platform principal and audit service.
- Produces: authenticated candidate/list/detail/prepare/confirm/cancel platform routes.

- [ ] Write failing route tests for `PlatformAuthGuard` ownership and exact capability requirements.
- [ ] Write a DB-backed integration test that activates two devices, prepares one activation for rollback, denies same-operator confirmation, confirms with a second operator and proves the other device remains strict.
- [ ] Add replay, changed-input, expiry, drift, overlapping reservation, concurrent confirmation and exact-constraint error tests.
- [ ] Implement prepare as a no-mutation repeatable-read transaction with durable response identity.
- [ ] Implement confirm with fresh fact comparison, advisory policy-version lock, approved observe policy creation, terminal activation provenance and same-transaction audit.
- [ ] Implement active-candidate, preparation list/detail pagination, cancellation and exact SQLSTATE 23505 request-constraint mapping.
- [ ] Register the controller/service only in the platform-auth-loaded module and update OpenAPI/route inventories.
- [ ] Run focused API tests, typecheck, lint and build.

### Task 5: Runtime observe overlay

**Files:**

- Modify: `apps/api/src/modules/device-grants/grant-policy.ts`
- Modify: `apps/api/src/modules/device-grants/grant-rollout.ts`
- Modify: `apps/api/test/grant-policy.test.ts`
- Modify: `apps/api/test/public-api-offline-grants-workflow.test.ts`
- Modify: `apps/api/test/device-grants-routes.test.ts`

**Interfaces:**

- Consumes: confirmed rollback provenance and approved observe policy.
- Produces: effective observe policy/configuration for rolled-back devices while active strict rows retain priority.

- [ ] Write failing tests for selected observe rollback, unselected strict continuity, later strict reactivation priority and malformed rollback fail-safe behavior.
- [ ] Update effective-policy loading to return a hash-verified observe rollback policy when no active strict activation exists.
- [ ] Persist a new observe configuration with rollback decision provenance and no strict activation ID.
- [ ] Prove existing frozen task authority and evidence recovery still reconcile after rollback.
- [ ] Run focused workflow, policy and route tests.

### Task 6: SaaS Admin selective rollback flow

**Files:**

- Create: `apps/saas-admin/src/pages/catalog/offline-grant-rollback-api.ts`
- Create: `apps/saas-admin/src/pages/catalog/offline-grant-rollback-state.ts`
- Modify: `apps/saas-admin/src/pages/catalog/OfflineGrantActivationPanel.tsx`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Create: `apps/saas-admin/test/offline-grant-rollback-api.test.ts`
- Create: `apps/saas-admin/test/offline-grant-rollback.test.tsx`

**Interfaces:**

- Consumes: cursor-paginated active activation candidates and rollback platform contracts.
- Produces: exact member selection, prepare/confirm/cancel UI and durable uncertain-attempt cache keys.

- [ ] Write failing API-client tests for every route and JSON body.
- [ ] Write failing DOM tests for exact subset selection, second-operator guard, notice recovery, pagination and dirty state for uncertain prepare/confirm/cancel.
- [ ] Add rollback query/mutation helpers with parsed responses and authorization/domain/uncertain error classification.
- [ ] Add accessible selection and preparation cards to the activation workspace using existing UI components and both locales.
- [ ] Preserve request identity after ambiguous failures and automatically load all pages containing actionable rollback records.
- [ ] Run focused SaaS tests, typecheck, lint and build.

### Task 7: Cross-surface compatibility and operations

**Files:**

- Modify: `apps/station/test/offline-grants-recovery.test.ts`
- Modify: `apps/kiosk/test/offline-grants-recovery.test.ts`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/grants/GrantTransportTest.kt`
- Modify: `docs/operations/offline-device-grants.md`
- Create: `docs/acceptance/offline-grants-p1d3.md`
- Modify: `deploy/production/test/offline-grant-readiness-contract.test.mjs`
- Modify: `tools/ci/affected.mjs` only if classification misses an affected surface.

**Interfaces:**

- Consumes: complete rollback behavior.
- Produces: native compatibility, deployment ordering and an evidence ledger.

- [ ] Prove all three native clients accept the unchanged observe configuration after a prior strict configuration and retain pending recovery intents across restart.
- [ ] Document migration ordering, two-operator operation, selective effect, ambiguous-response recovery and later reactivation.
- [ ] Record automated checks separately from production cohort, Windows, scanners, printers, kiosk hardware and customer acceptance.
- [ ] Verify representative changed paths schedule contracts, DB, API, SaaS Admin, Station, kiosk, Handheld and production bundle jobs.
- [ ] Run focused Station, kiosk, Handheld and production contract gates.

### Task 8: Final verification and review preparation

**Files:**

- Modify only files required by failures caused by Tasks 1 through 7.
- Update: `docs/acceptance/offline-grants-p1d3.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: a clean review branch with exact proof and external boundaries.

- [ ] Rebuild shared dependencies in graph order with `corepack pnpm turbo run build --filter='@markiro/api^...' --filter='@markiro/saas-admin^...' --filter='@markiro/station^...' --filter='@markiro/kiosk^...'`.
- [ ] Run `corepack pnpm turbo lint typecheck test build --concurrency=1 --force` with isolated test infrastructure and record skips.
- [ ] Run Android `testDebugUnitTest lintDebug assembleDebug` and Station Cargo host tests; keep real hardware explicitly separate.
- [ ] Run `corepack pnpm test:production-bundle:contract`, `corepack pnpm format:check` and `git diff --check`.
- [ ] Run `graphify update .`, inspect the complete three-dot diff against fresh `origin/main`, and reconcile migration numbering if main advanced.
- [ ] Update the acceptance ledger with exact commands, counts, skips and unrun external checks.
