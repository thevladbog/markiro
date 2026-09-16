# Device Replacement Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete prepared Station/handheld replacements through verified drain or controlled emergency cutover while preserving evidence, enforcing one working-device slot and supporting recovery of old local data.

**Architecture:** Extend the current preparation aggregate with durable readiness intents/reports and a recoverable execution state machine. Reuse credential epochs, offline-grant readiness, device recovery ownership, working-device quota locks and existing pairing rather than introduce another identity system. Cabinet and platform clients consume the same strict contracts; Station and handheld persist and retry device-side intents.

**Tech Stack:** Node 24, pnpm 11.22.0, NestJS, Drizzle/PostgreSQL, strict Zod contracts, React/TanStack Query, Station React/SQLite, Android Kotlin/Room/Compose, Vitest, Gradle and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-device-replacement-execution-design.md`

## Global Constraints

- One implementation branch and one final PR; keep reviewable commits per task.
- `prepared` alone must not change current admission. Only `draining`, `executing` and transferred source state restrict new work.
- Never delete or rewrite local journals, outboxes, print facts, conflicts or historical server rows.
- The target never receives operational authority before the old cloud credential is confirmed revoked.
- Emergency `newWorkAllowedAt` is derived from server grant facts; client time cannot shorten it.
- Recovery credentials are deny-by-default and cannot create work or obtain new offline grants.
- Preserve tenant composite keys, fresh cabinet/platform authorization, actor identity and exact audit receipts.
- Pairing plaintext is returned once and never stored. A lost response is recovered by issuing a new code, not replaying a secret.
- Existing commercial creation remains independent of lifecycle-policy presence.
- Build `@markiro/db` and `@markiro/platform-contracts` before consumer tests.

---

### Task 1: Lock the Existing Admission Boundary and Define Strict Contracts

**Files:**

- Modify: `packages/platform-contracts/src/device-replacements.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Modify: `packages/platform-contracts/test/device-replacements.test.ts`
- Modify: `apps/api/src/modules/device-grants/grant-admission.ts`
- Create: `apps/api/test/device-replacement-admission.test.ts`

**Interfaces:**

- Produces `deviceReplacementDrainRequestSchema`, `deviceReplacementExecutionPreviewRequestSchema`, `deviceReplacementExecuteRequestSchema`, `deviceReplacementEmergencyPreviewRequestSchema`, `deviceReplacementRecoveryCodeRequestSchema`, `deviceReplacementRecoveryCloseRequestSchema`, `deviceReplacementReadinessRequestSchema` and their response schemas.
- Extends preparation state with `draining | ready | executing | completed` and adds `execution`, `readiness` and `recovery` projections.

- [ ] **Step 1: Write the failing contract tests**

  Add strict-schema cases that reject unknown fields, duplicate active tasks, negative counters, mismatched source/intent IDs, client timestamps used as authority, emergency execution without a trimmed reason and recovery close without an expected revision. Assert a completed receipt includes stable `targetDeviceId`, `mode`, `newWorkAllowedAt` and `recoveryState`.

  ```ts
  expect(
    deviceReplacementReadinessRequestSchema.safeParse({
      requestId,
      intentId,
      credentialEpoch: 4,
      reportSequence: 7,
      clientBuild: "station-2.0.0",
      storageRevision: 1,
      pending: {
        scans: 0,
        inventories: 0,
        shiftClosures: 0,
        productLabels: 0,
        boxes: 0,
        exceptions: 0,
      },
      conflicts: 0,
      unknownPrints: 0,
      activeTasks: [],
      installedGrants: [],
      journal: { digest: "a".repeat(64), highestSequence: 42 },
      extra: true,
    }).success,
  ).toBe(false);
  ```

- [ ] **Step 2: Add the admission regression before changing implementation**

  Prove a merely `prepared` project does not make `grantPoolDenial` return `not_entitled`; prove `draining` and a released source do. This test must fail against the current query that blocks every prepared row.

- [ ] **Step 3: Run RED**

  Run:

  ```bash
  corepack pnpm --filter @markiro/platform-contracts test -- device-replacements
  corepack pnpm --filter @markiro/api exec vitest run test/device-replacement-admission.test.ts
  ```

  Expected: schemas/fields are absent and prepared admission is denied incorrectly.

- [ ] **Step 4: Implement contracts and correct the prepared-only denial**

  Use discriminated unions for readiness eligibility and execution mode. Keep response objects `.strict()`. Change `grantPoolDenial` to consult an active drain/execution projection, not the existence of a saved preparation.

- [ ] **Step 5: Run GREEN and package gates**

  ```bash
  corepack pnpm --filter @markiro/platform-contracts test
  corepack pnpm --filter @markiro/platform-contracts typecheck
  corepack pnpm --filter @markiro/platform-contracts lint
  corepack pnpm --filter @markiro/platform-contracts build
  corepack pnpm --filter @markiro/api exec vitest run test/device-replacement-admission.test.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add packages/platform-contracts apps/api/src/modules/device-grants/grant-admission.ts apps/api/test/device-replacement-admission.test.ts
  git commit -m "fix(entitlements): separate prepared replacement from admission"
  ```

### Task 2: Add Durable Replacement Readiness and Execution Persistence

**Files:**

- Modify: `packages/db/src/schema/device-replacements.ts`
- Modify: `packages/db/src/schema/device-licensing.ts`
- Modify: `packages/db/src/schema/platform.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: next migrations after current journal head, including generated snapshots and `_journal.json`
- Modify: `packages/db/src/runtime-migrate.ts`
- Modify: `packages/db/test/device-replacements-schema.test.ts`
- Create: `packages/db/test/device-replacement-execution-migration.test.ts`

**Interfaces:**

- Produces `workingDeviceReplacementReadinessIntents`, `workingDeviceReplacementReadinessReports` and `workingDeviceReplacementExecutions`.
- Adds release reason `replacement_transferred`, pairing purpose `normal | replacement_recovery`, and the working-device event actions listed in the spec.

- [ ] **Step 1: Write migration/schema RED tests**

  Assert tenant/source/preparation composite foreign keys, one active intent per preparation, one execution/target per preparation, unique tenant/request identities, positive epochs/sequences, bounded JSON objects and correlated execution/recovery fields. Seed legacy prepared/cancelled rows before migration and byte-compare them after migration.

  ```ts
  await expect(insertSecondExecution(preparationId)).rejects.toMatchObject({ code: "23505" });
  expect(await legacyRows()).toEqual(before);
  expect(await constraint("working_device_replacement_reports_payload_check")).toMatchObject({
    convalidated: true,
  });
  ```

- [ ] **Step 2: Generate and inspect forward migrations**

  ```bash
  corepack pnpm --filter @markiro/db db:generate
  ```

  Review SQL for tenant keys, indexes used by `(tenant_id, device_id, received_at)`, finite timestamps, JSON validity and no table rewrite. Add large-table checks as `NOT VALID`; validate them in the following migration transaction.

- [ ] **Step 3: Implement schema types and runtime ordering**

  Keep reports append-only. Store normalized counters as bounded JSON plus indexed identity columns; never store pairing plaintext or API keys. Ensure the runtime migrator includes both migration files in order.

- [ ] **Step 4: Run DB tests and gates**

  ```bash
  corepack pnpm --filter @markiro/db exec vitest run test/device-replacements-schema.test.ts test/device-replacement-execution-migration.test.ts
  corepack pnpm --filter @markiro/db test
  corepack pnpm --filter @markiro/db typecheck
  corepack pnpm --filter @markiro/db lint
  corepack pnpm --filter @markiro/db build
  ```

  Report a database-backed skip explicitly if `DATABASE_URL` is absent.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/db
  git commit -m "feat(db): persist device replacement execution"
  ```

### Task 3: Implement Device Drain and Readiness Reporting API

**Files:**

- Create: `apps/api/src/modules/device-licensing/device-replacement-readiness.service.ts`
- Create: `apps/api/src/modules/device-licensing/device-replacement-readiness.controller.ts`
- Modify: `apps/api/src/modules/device-licensing/device-replacement.service.ts`
- Modify: `apps/api/src/modules/device-licensing/device-licensing.module.ts`
- Modify: `apps/api/src/subscriptions/subscription-access-policy.ts`
- Modify: `apps/api/src/subscriptions/subscription-access.guard.ts`
- Create: `apps/api/test/device-replacement-readiness.integration.test.ts`
- Modify: API route/OpenAPI inventory tests

**Interfaces:**

- Produces `requestDrain(tenantId, preparationId, request, actor)`, `currentIntent(identity)` and `report(identity, body)`.
- `report` is idempotent by tenant/device/epoch/request ID and returns the server eligibility projection.

- [ ] **Step 1: Write RED integration and trust-boundary tests**

  Cover: prepared project creates one intent; another tenant/device cannot read it; changed retry conflicts; credential epoch mismatch is unauthorized; stale report remains stored but ineligible; a fresh all-zero report becomes ready; pending/unsupported/active-task/grant cases remain draining; later blocked report regresses ready to draining.

- [ ] **Step 2: Implement drain with existing lock order**

  Acquire quantitative quota locks, timeline, station rows, licensing facts and entitlement revision in the same order as `lockGrantFacts`. Persist intent, increment preparation revision, write exact event/audit and return its receipt atomically.

- [ ] **Step 3: Implement device routes and server evaluation**

  Authenticate through station identity for both `station` and `handheld`. Derive tenant/device/credential epoch from the principal. Compare installed grants with issuance/configuration facts from the server; do not trust the client `notAfter` as the authority.

- [ ] **Step 4: Update policies and inventories**

  Add explicit licensing operations for drain/execute/recovery. Classify device readiness report as bounded recovery-capable device traffic, not general write access. Update subscription route inventory, platform route contracts and OpenAPI snapshots.

- [ ] **Step 5: Run focused and API gates**

  ```bash
  corepack pnpm --filter @markiro/api exec vitest run test/device-replacement-readiness.integration.test.ts test/subscription-route-inventory.test.ts test/platform-contract-openapi.test.ts
  corepack pnpm --filter @markiro/api test
  corepack pnpm --filter @markiro/api typecheck
  corepack pnpm --filter @markiro/api lint
  corepack pnpm --filter @markiro/api build
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add apps/api
  git commit -m "feat(api): collect replacement drain readiness"
  ```

### Task 4: Make Station Drain Durable and Retry-Safe

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/src/sqlite/migrations.ts`
- Create: `apps/station/src/lib/device-replacement.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/lib/offline-grants/store.ts`
- Modify: Station RU/EN localization and persistent state UI
- Create: `apps/station/test/device-replacement.test.ts`
- Modify: `apps/station/test/App.test.tsx`

**Interfaces:**

- Produces `prepareReplacementReadiness`, `drainReplacementReadiness` and `reportReplacementReadiness` using one durable SQLite intent/outbox row.
- Normalizes Station queues into the shared readiness request without exporting raw journal data.

- [ ] **Step 1: Write SQLite and restart RED tests**

  Seed scan, inventory, close, label, box, exception, conflict and unknown-print rows. Assert exact normalized counts. Simulate response loss and remount; the same request ID/body must be retried. Assert a new intent replaces only a fully acknowledged old intent.

- [ ] **Step 2: Add authoritative SQLite DDL and parity schema**

  Add a single current intent/outbox table with JSON validity, owner/credential hash, request ID and acknowledgement fields. Use a single-statement command/trigger where local grant retirement and intent persistence must be atomic.

- [ ] **Step 3: Integrate drain into admission and UI**

  Once the authenticated server returns an intent, persist it before sealing new-work grants. Block task entry locally, keep sync/close/recovery engines running, and show a persistent drain screen with live blocking counters. Restart must return to drain before floor entry.

- [ ] **Step 4: Test grant and credential races**

  Prove a delayed configuration response cannot reinstall new-work authority after drain; a replaced credential cannot acknowledge the old intent; report cancellation rethrows `AbortError`/cancellation instead of converting it to readiness failure.

- [ ] **Step 5: Run Station gates**

  ```bash
  corepack pnpm turbo run build --filter='@markiro/station^...'
  corepack pnpm --filter @markiro/station exec vitest run test/device-replacement.test.ts test/App.test.tsx test/offline-grants-store.test.ts
  corepack pnpm --filter @markiro/station test
  corepack pnpm --filter @markiro/station typecheck
  corepack pnpm --filter @markiro/station lint
  corepack pnpm --filter @markiro/station build
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add packages/db/src/sqlite apps/station
  git commit -m "feat(station): drain safely for device replacement"
  ```

### Task 5: Make Handheld Drain Durable and Retry-Safe

**Files:**

- Create: Room entity/DAO/migration under `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/`
- Create: `core/replacement/ReplacementReadiness.kt`, `ReplacementTransport.kt`, `ReplacementCoordinator.kt`
- Modify: `core/network/StationApi.kt`
- Modify: `feature/hub/HubViewModel.kt` and Compose screen
- Modify: RU/EN `strings.xml`
- Create: Kotlin migration, transport, coordinator and UI tests

**Interfaces:**

- Mirrors the Station contract and persists one intent/outbox per owner/credential generation.
- Uses structured coroutine cancellation and the existing `DeviceRecovery` commit boundary.

- [ ] **Step 1: Write RED Room/transport tests**

  Cover every normalized queue, active task, unknown print, restart, lost response, changed owner and epoch. Verify `CancellationException` is rethrown and identical pending intent retries preserve request identity.

- [ ] **Step 2: Add Room migration and storage revision**

  Add the entity/DAO, bump the database version, test upgrade from every supported fixture version and keep existing recovery rows byte-equivalent.

- [ ] **Step 3: Implement coordinator and admission UI**

  Poll intent only while authenticated, persist before disabling new-work grants, allow existing sync workers to drain, and expose exact counters. The hub must not navigate into new work while drain is active.

- [ ] **Step 4: Run Android checks**

  ```bash
  cd apps/handheld
  ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
  ```

  Record that emulator/unit checks do not prove vendor scanner or physical TSD behavior.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/handheld
  git commit -m "feat(handheld): drain safely for device replacement"
  ```

### Task 6: Implement Recoverable Normal and Emergency Cutover

**Files:**

- Create: `apps/api/src/modules/device-licensing/device-replacement-execution.service.ts`
- Create: `apps/api/src/modules/device-licensing/device-replacement-execution-repair.service.ts`
- Modify: cabinet/platform replacement controllers
- Modify: `apps/api/src/modules/station-devices/station-devices.service.ts`
- Modify: `apps/api/src/modules/station-pairing/station-pairing.service.ts`
- Modify: `apps/api/src/modules/device-grants/grant-issuer.service.ts`
- Create: `apps/api/test/device-replacement-execution.integration.test.ts`
- Create: `apps/api/test/device-replacement-execution-repair.test.ts`

**Interfaces:**

- Produces `previewExecution`, `executeNormal`, `previewEmergency`, `executeEmergency` and `repairExecution`.
- Returns a stable receipt; pairing code issuance remains a separate action on `targetDeviceId`.

- [ ] **Step 1: Write RED happy-path and invariant tests**

  Assert ready normal execution releases source with `replacement_transferred`, creates exactly one target/reserved assignment, preserves usage, creates no pairing plaintext, revokes source credential first and writes exact events/audit. Assert prepared/draining/stale projects cannot execute normally.

- [ ] **Step 2: Write RED emergency-boundary tests**

  Create active device/task grants and assert `newWorkAllowedAt` equals the maximum authoritative boundary. When exact issuance is unavailable, assert the configured policy maximum is used. Verify paired target admission and grant issuance remain denied before the boundary and allowed after it.

- [ ] **Step 3: Write failure-window tests**

  Place barriers before/after credential revoke and before/after transfer commit. Simulate process death and ambiguous commit. `repairExecution` must converge on one target/assignment/receipt; it must never reactivate the old full credential or allocate another slot.

- [ ] **Step 4: Implement the execution state machine**

  Persist `executing` before invoking auth credential deletion. Recheck the deletion result, then enter the ordered quota/timeline transaction. Create target with the existing Station/handheld kind validation and transition helpers. Increment decision revisions and preserve source rows.

- [ ] **Step 5: Integrate admission and pairing**

  Pairing before `newWorkAllowedAt` may publish the target credential but server and local grant admission expose waiting state. Normal pairing code issuance works on the new reserved target. Existing devices without a replacement remain unchanged.

- [ ] **Step 6: Run concurrency and API gates**

  ```bash
  corepack pnpm --filter @markiro/api exec vitest run test/device-replacement-execution.integration.test.ts test/device-replacement-execution-repair.test.ts test/station-pairing.test.ts
  corepack pnpm --filter @markiro/api test
  corepack pnpm --filter @markiro/api typecheck
  corepack pnpm --filter @markiro/api lint
  corepack pnpm --filter @markiro/api build
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add apps/api
  git commit -m "feat(api): execute working device replacement"
  ```

### Task 7: Add Restricted Evidence Recovery

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Modify: `apps/api/src/modules/station-pairing/dto.ts`
- Modify: `apps/api/src/modules/station-pairing/station-pairing.service.ts`
- Modify: `packages/platform-contracts/src/station-recovery.ts`
- Create: API recovery policy decorator/guard helper under device licensing
- Modify: station scan/inventory/close/label/exception upload controllers to opt into the explicit recovery policy
- Modify: Station and handheld pairing/recovery clients
- Create: `apps/api/test/device-replacement-recovery.integration.test.ts`
- Modify: Station and handheld recovery tests

**Interfaces:**

- Produces `issueReplacementRecoveryCode` and `closeReplacementRecovery`.
- Recovery principal carries `purpose = replacement_evidence_recovery` and `executionId`; route access is an explicit allowlist.

- [ ] **Step 1: Write deny-by-default RED tests**

  Redeem a recovery code and attempt every station route class. Only identity/config needed for recovery, existing evidence upload/ack and replacement readiness may succeed. Task creation, pairing-code issuance, catalog mutation and offline grant issuance must return authorization denial.

- [ ] **Step 2: Implement purpose-bound pairing**

  Hash and expire the code through the existing mechanism. Require exact old owner identity supplied by sealed Station/handheld recovery state. Put purpose/execution binding in credential metadata; leave the source device revoked and assignment released.

- [ ] **Step 3: Complete or close recovery**

  A fresh zero report transitions `required → completed` and revokes the recovery credential. Administrative `evidence_unavailable` close requires reason, revision and audit and never fabricates a zero report.

- [ ] **Step 4: Run focused cross-client checks**

  Run API recovery integration, Station device-recovery and Android DeviceRecovery/RecoveryWire tests. Exercise wrong tenant, target device, reused code, expired code, changed generation and lost acknowledgement.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/api apps/station apps/handheld packages/db packages/platform-contracts
  git commit -m "feat(devices): recover evidence after emergency replacement"
  ```

### Task 8: Complete Cabinet and SaaS Replacement Workspaces

**Files:**

- Modify: both `DeviceReplacementPanel.tsx`
- Modify: both `replacement-api.ts` and `replacement-state.ts`
- Modify: RU/EN localization in both apps
- Modify: both replacement fixture/API/component test suites
- Modify: equipment visual scenario/snapshots if tracked

**Interfaces:**

- Consumes strict list/readiness/preview/execute/recovery receipts.
- Preserves uncertain request identity in TanStack Query cache and never assumes a lost pairing-code response can be replayed.

- [ ] **Step 1: Write RED UI tests for the full state matrix**

  Cover prepared, draining with each blocker, ready, executing, normal complete, emergency waiting boundary, recovery required/completed/unavailable, read-only platform user and authorization loss. Assert values as well as labels.

- [ ] **Step 2: Write RED retry tests**

  Lost drain/execute/emergency/recovery responses retain exact request IDs and locked intent. Domain stale/conflict clears only the invalid preview and refreshes facts. Pairing-code loss shows “issue a new code” and does not claim the old secret.

- [ ] **Step 3: Implement workflow UI**

  Replace the unconditional unavailable-reasons list with factual readiness rows and state-specific actions. Use shared `@markiro/ui` components/tokens, semantic fieldsets/dialogs, keyboard focus and non-color status copy. Emergency dialog requires reason and checkbox.

- [ ] **Step 4: Run both web-app gates**

  ```bash
  corepack pnpm --filter @markiro/admin exec vitest run test/device-replacement-api.test.ts test/device-replacement.test.tsx
  corepack pnpm --filter @markiro/saas-admin exec vitest run test/device-replacement-api.test.ts test/device-replacement.test.tsx test/platform-pages-api.test.ts
  corepack pnpm --filter @markiro/admin test
  corepack pnpm --filter @markiro/admin typecheck
  corepack pnpm --filter @markiro/admin lint
  corepack pnpm --filter @markiro/admin build
  corepack pnpm --filter @markiro/saas-admin test
  corepack pnpm --filter @markiro/saas-admin typecheck
  corepack pnpm --filter @markiro/saas-admin lint
  corepack pnpm --filter @markiro/saas-admin build
  ```

- [ ] **Step 5: Browser-check RU/EN desktop and narrow widths**

  Exercise normal ready and emergency/recovery fixtures in both authenticated apps. Store only repository-approved snapshots; automated DOM tests remain separate from visual confirmation.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/admin apps/saas-admin
  git commit -m "feat(ui): complete device replacement workflow"
  ```

### Task 9: Operations, Compatibility and Final Verification

**Files:**

- Modify: `docs/operations/entitlements-p1b2.md`
- Modify: `docs/architecture.md`
- Create: `docs/acceptance/device-replacement-execution.md`
- Modify: production bundle/route contract tests when required
- Update this plan checklist with actual evidence only

**Interfaces:**

- Documents rollout order, minimum client versions, repair commands/observability, emergency consequences and physical acceptance limits.

- [ ] **Step 1: Add compatibility and deployment tests**

  Verify old clients receive no unsupported drain intent, old preparation rows parse, inactive tenants are unchanged, migrations precede code reading new tables and API/web image mapping includes all changed services.

- [ ] **Step 2: Run focused dependency-ordered gates**

  ```bash
  corepack pnpm --filter @markiro/platform-contracts build
  corepack pnpm --filter @markiro/db build
  corepack pnpm --filter @markiro/ui build
  corepack pnpm turbo lint typecheck test build --concurrency=1 --force
  corepack pnpm format:check
  corepack pnpm test:production-bundle:contract
  git diff --check
  ```

  Record DB-backed skips, test counts and any infrastructure not exercised.

- [ ] **Step 3: Run Android and Station final gates once after integration**

  ```bash
  corepack pnpm --filter @markiro/station test
  corepack pnpm --filter @markiro/station typecheck
  corepack pnpm --filter @markiro/station lint
  corepack pnpm --filter @markiro/station build
  cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
  ```

- [ ] **Step 4: Perform local browser acceptance**

  Validate both admin surfaces and device drain screens. Do not claim Windows, scanner, printer or physical TSD acceptance without those devices.

- [ ] **Step 5: Review the complete PR range**

  Fetch `origin/main`, inspect `git log origin/main..HEAD` and `git diff --stat origin/main...HEAD`, run `git diff --check`, and confirm the branch contains no unrelated files, environment values, secrets or generated caches.

- [ ] **Step 6: Commit documentation and evidence**

  ```bash
  git add docs deploy/production
  git commit -m "docs: add device replacement operations and acceptance"
  ```

- [ ] **Step 7: Push and open one PR only after explicit user authorization**

  PR description must distinguish automated, browser, production and physical checks and must not claim deployment before the protected workflows complete.
