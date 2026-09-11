# P1B.1 Device Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every durable Station/handheld evidence channel across credential rejection and authorized re-pairing of the same device.

**Architecture:** An explicit recovery pairing route binds the code to the expected tenant/device/kind. Each client persists a durable owner separately from the current credential generation, fences old asynchronous work, and restores only that owner's queues. Existing subscription/quota/security enforcement remains authoritative.

**Tech Stack:** TypeScript, NestJS, Zod, PostgreSQL/Drizzle, React/Tauri/SQLite, Kotlin/Room/OkHttp/Compose.

**Spec:** [Approved P1B.1 design](../specs/2026-09-11-entitlements-p1b1-device-recovery-design.md).

**Implementation status:** Tasks 1–4 and local acceptance are complete. The
required whole-workspace gate and independent final whole-change review passed.
Publication is handled separately after user authorization; deployment remains a
separate step.

## Global Constraints

- Worktree: `/Users/thevladbog/PRSOME/q/.worktrees/entitlements-p1b`, branch `codex/entitlements-p1b`, base `9da7a5223f9a8807988477c7113c669d615499f2`.
- Node 24+, Corepack pnpm 11.22.0; JDK 17, Android SDK platform 35. No new external dependency is required; a direct workspace dependency on platform-contracts may be added to a consuming app using pnpm.
- Preserve server origin, tenant ID, durable device ID, event ID, sequence, batch identity/digest, snapshots and saved print bytes. Line/operator/current key do not redefine the data owner.
- Old credential rejection blocks that generation; never clear or mutate a newer generation from a late response. Never upload an unresolved/different owner's data.
- Preserve all queues, labels, boxes, exceptions, conflicts, SSCC ranges, close events and inventory. Delivery unknown never triggers automatic printing.
- Revoked secrets remain invalid; roster/operator authentication is cleared while retained evidence remains sealed. New credentials require the existing authorized pairing-code flow.
- Existing `/station/pair` contract and subscription/quota checks remain compatible. No expiry bypass, new commercial entitlement enforcement, transfer to another device or production rollout.
- New recovery route: `POST /station/pair/recovery`; request `{ version: 1, code, expected: { tenantId, deviceId, kind } }`; response `{ version: 1, device, credential, operators, subscription? }` with the existing field meanings.
- `PAIR_RECOVERY_MISMATCH` is a generic 401 without foreign-device details. Existing handshake errors/rate limits stay effective. A mismatched recovery code stays live and no current key is changed.
- Old API 404/405 at the new recovery route means update required, with no fallback to ordinary pairing while data is retained.
- Read root/API/Station/handheld AGENTS as applicable. Append migrations; no rewrites, destructive resets or mutable dependency sharing.
- Write a focused failing regression first, record RED/GREEN evidence, then implement. Rebuild shared dist before consumers.
- User authorized implementation, not publication. Keep source changes uncommitted; do not stage/commit/push/create PR or clean old worktrees. Reviews use saved working-tree diff packages including new files.
- Implementers do not spawn agents. One implementer at a time; controller owns independent review, integration evidence and final acceptance.

## Task 1: Identity-bound recovery pairing API and shared contracts

**Files:**

- Create `packages/platform-contracts/src/station-recovery.ts` and `packages/platform-contracts/test/station-recovery.test.ts`.
- Modify `packages/platform-contracts/src/index.ts`.
- Modify `apps/api/src/modules/station-pairing/{dto.ts,station-pair.controller.ts,station-pairing.service.ts}` and secret-response OpenAPI helper if needed.
- Test `apps/api/test/station-pairing.e2e.test.ts`, subscription route inventory and matching OpenAPI/route coverage tests.

**Interfaces:**

- Export strict `stationRecoveryIdentitySchema`, `stationRecoveryRequestSchema`, `stationRecoveryResponseSchema` and inferred `StationRecoveryIdentity`, `StationRecoveryRequest`, `StationRecoveryResponse`.
- Identity has tenantId (nonempty existing tenant identifier), UUID deviceId, kind `station | handheld`.
- Service adds optional internal `expectedRecoveryIdentity` to `RedeemOptions`; only the new validated route supplies it.
- New route returns the versioned response; old route retains exactly its existing wire shape.

- [x] Add schema regressions for version, unknown properties, malformed identity and response compatibility. Add real DB route regressions before implementation:

```ts
const before = await readCredentialAndDevice(tenantId, deviceId);
const response = await postRecoveryPair(code, {
  tenantId,
  deviceId: otherDeviceId,
  kind: "station",
});
expect(response.status).toBe(401);
expect(response.body).toEqual({ code: "PAIR_RECOVERY_MISMATCH" });
expect(await readCredentialAndDevice(tenantId, deviceId)).toEqual(before);
expect(await isCodeLive(code)).toBe(true);
```

These helper names are test-local: implement them through the existing e2e harness queries/request helpers. Also test foreign tenant, wrong kind/client capability, exact same-ID success, old-key denial, lost claim cleanup, malformed request before minting, expired/write-denied subscription and full quota restoration.

- [x] Run focused tests and record the expected missing-route/schema failure.
- [x] Define the Zod shapes; preserve existing operator fields and subscription meanings. Export them and add the new controller method with `Cache-Control: no-store`, documented unauthenticated code boundary and errors.
- [x] In `attemptRedeem`, compare the expected tuple before candidate-key creation, then re-read/recheck device kind and expected identity under the existing quota/device lock before claim. Reuse compensation and audit; no independent tariff engine or extra slot on active same-ID repair.

```ts
if (
  options.expectedRecoveryIdentity &&
  !matchesRecoveryIdentity(station, options.expectedRecoveryIdentity)
) {
  throw new StationPairingException("PAIR_RECOVERY_MISMATCH");
}
```

Implement `matchesRecoveryIdentity` as exact comparison of tenantId/id/kind; repeat against the locked row. Keep client-kind checks independent from the expected identity.

- [x] Update route inventory/OpenAPI tests and run contract package gates, API focused DB tests, typecheck/lint/build. Record any failures in unrelated suites rather than weakening checks.
- [x] Write the task report with explicit RED/GREEN evidence and source paths. Leave changes uncommitted for the task review.

## Task 2: Station durable owner and all-channel same-device recovery

**Files:**

- Create focused `apps/station/src/lib/device-recovery.ts` for persisted owner/transition coordination and matching tests.
- Modify `apps/station/src/lib/{pairing.ts,credential-recovery.ts,credential-reset.ts,sync.ts,inventory-sync.ts,config.ts}` where consumed.
- Modify `apps/station/src/lib/product-labels/{sync.ts,sync-batch.ts,recovery.ts,retention.ts}` and related owner-filtered job operations only as needed to restore the saved owner's work.
- Modify `apps/station/src/App.tsx`, existing pairing/recovery UI and RU/EN i18n.
- Append runtime SQLite migration(s) in `packages/db/src/sqlite/migrations.ts`, schema parity and tests; update Rust config boundary only if required by actual persistent identity loss.

**Interfaces:**

- Consumes Task 1 `StationRecoveryIdentity` and strict versioned response.
- New module exposes `initializeDeviceRecovery(exec, config)`, `sealDeviceRecovery(exec, config, generation)`, `restoreDeviceRecovery(exec, expectedOwner, provisioning, publishConfig)` and an explicit read-only recovery view. Exact runtime types remain local and typed; no secrets are persisted in the SQLite recovery metadata.
- A durable owner is `{ serverOrigin, tenantId, deviceId, kind: "station" }`. Credential ownership hashes remain original; a verified local relation associates prior hashes with that same owner for retained-work recovery.
- An unresolved owner cannot enter ordinary pairing or sync. New generation writes do not rewrite original job/event ownership.

- [x] Add failing SQLite/integration regressions: a product-label batch created under key A survives rejection and can be acknowledged under a verified same-device key B, with exact old bytes/IDs/pin/digest; another owner cannot read/send/ack it.

```ts
expect(await readStoredLabelPayload(exec, eventId)).toEqual(before.payload);
expect(await readStoredPrintBytes(exec, jobId)).toEqual(before.bytes);
expect(await readPendingBatchIdentity(exec)).toEqual(before.batch);
expect(await pendingCountAfterVerifiedRePairAndSync()).toBe(0);
```

Build these on existing actual SQLite fixtures and mock HTTP transport, not a mocked ownership decision. Include scans, box closures, exceptions, close and inventory channel restoration.

- [x] Append SQLite DDL for durable owner, recovery transition and verified prior-owner associations. Initialize from consistent saved device/config context before clearing any secret or starting workers. Preserve unresolved legacy records sealed; never claim history that cannot be established.
- [x] Extend existing generation/commit leases and config transition owner. Persist sealing intent before cleanup; restart completes sealing/restoring idempotently. Account for interrupted config writes with a durable transition rather than multi-connection BEGIN/COMMIT.
- [x] Use the new recovery endpoint for saved data, compare origin + tenant + device + kind before roster/config publication, and retain data on mismatch/404/malformed/lost response.
- [x] Wire owner-authorized recovery across every ownership filter: read/pin/send/ack, interrupted printing, event appends and retention. Keep original bytes and stale-generation fences. Demote interrupted send to unknown, never resend automatically.
- [x] Extend recovery UI using existing components: saved identity, actual per-channel pending summary, unknown-owner state, update-required/mismatch/error copy in RU/EN, and distinct paired vs synced results.
- [x] Run DB SQLite gates and Station focused/package gates after dependency builds; Rust tests if shell changed. Write test-backed task report and leave source uncommitted.

## Task 3: Handheld durable recovery, asynchronous fencing and UI

**Files:**

- Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceRecovery.kt` and owner/state storage types/DAO beside it.
- Append Room migration after version 7 in `core/storage/Migrations.kt`; register in `HandheldDatabase.kt`/`StorageModule.kt`.
- Modify `core/storage/{CredentialStore.kt,DeviceWipe.kt}`, `core/network/{Interceptors.kt,NetworkModule.kt,PairingGateway.kt,PairingClient.kt,Dtos.kt}`, and `feature/pairing/{ProvisioningStore.kt,PairingViewModel.kt,PairingScreen.kt,PairingModule.kt}`.
- Modify `HandheldApp.kt`, `AppShellViewModel.kt`, navigation and generation-sensitive sync/inventory/local write/printing owners as required. Keep changes confined to credential lifecycle.
- Add/extend tests under `core/storage`, `core/network`, `core/sync`, `core/inventory`, pairing and AppShell. Ship RU/EN strings.

**Interfaces:**

- Consumes Task 1 recovery request/response semantics, with Kotlin serialization fixtures that assert exact field names/version and mismatch behavior.
- Retains one durable owner for the operational database; no multiple-tenant DB feature. Owner contains normalized server origin, tenantId, deviceId, kind `handheld`; credential generation is separate and monotonic locally.
- `DeviceRecovery` coordinates initialization, current generation token, generation-bound local work/response commits, sealing, read-only summary and same-owner restore. No API key or operator verifiers in the owner table.
- Network request tags and rejection events identify the exact originating generation. Binding to the currently active credential at response time is forbidden.

- [x] Replace the wipe expectation with a failing regression containing pending rows in every operational channel, including saved label bytes and batch pins. The rejected secret/roster disappear, all retained evidence is byte-identical and the shell cannot enter productive work.

```kotlin
val saved = captureAllPendingEvidence(db)
recovery.reject(oldGeneration)
assertNull(credential.read())
assertEquals(saved, captureAllPendingEvidence(db))
assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
```

Implement the capture helper using real Room queries and exact snapshots. Add late-401-after-new-pair and late-success-before-local-ack tests with controlled deferred responses, not sleeps.

- [x] Add an additive Room migration and boot initialization. Existing consistent config binds the current DB as an observation at upgrade; retained rows without consistent config become owner-unresolved. Complete initialization before starting workers/sign-in and resume interrupted phases safely.
- [x] Implement generation-bound coordination. Close admission immediately, drain/record already-started writes/prints, persist sealing before removing secrets, invalidate operator session, preserve every operational table and idempotency key. SharedPreferences commit failures propagate instead of reporting successful credential publication.
- [x] Replace the unqualified revocation bus with generation-aware rejection; interceptors must not attach the new key to an old in-flight request or accept a late success as a commit under the new generation.
- [x] Fence real local commit owners and workers (scan/box/labels/exceptions/close, inventory, caches/roster) through the same coordinator. Do not rely on navigation, view-model cancellation or checking the key only once before an await. Preserve pending pins and retry bytes on rejected acknowledgements.
- [x] Add same-owner recovery pairing and durable provisioning intent. Validate identity before any roster/credential/config write, retain all old operational config references needed for tasks, and allow only new authorized credentials. No fallback to ordinary pairing for retained data; unknown owner is visible and cannot be silently reassigned.
- [x] Wire Compose recovery state, pending-channel summary and errors in RU/EN; restore safe operator sign-in only after successful same-owner publication. Unknown print results use existing explicit recovery rules.
- [x] Run focused RED/GREEN, then `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` with isolated test setup. Include migration tests from old schema, crash-between-writes, repeated restore, late responses, foreign tenant/device, and per-channel ack. Write report without committing.

## Task 4: Cross-surface acceptance, documentation and final checks

**Files:**

- Extend API real-DB recovery tests and shared fixtures, Station/handheld end-to-end recovery fixtures where a task report identifies a missing cross-boundary case.
- Create `docs/operations/entitlements-p1b1.md`; update `docs/architecture.md`, this plan and approved spec status with actual evidence only.
- Update `tools/ci/affected.mjs` and `.github/workflows/ci.yml` only if the new shared fixture/contract ownership otherwise skips a consumer.

**Interfaces:**

- Consumes Task 1 wire protocol and Tasks 2/3 actual initialized storage/restore paths. Test helpers must invoke production entry points, not reproduce their decisions.
- Produces acceptance evidence distinguishing automated DB/client proof, browser/emulator observations, hardware checks and unexecuted external checks.

- [x] Drive same device through saved pending work → key rejection → restart → recovery pairing → upload/ack, separately for Station and handheld. Preserve original terminal/device/task/sequence/batch/bytes and prove a different owner is refused. Use real DB endpoint tests for server authorization and real client storage with captured server-shaped replies for client continuity; state their boundary explicitly.
- [x] Exercise old route/new route compatibility, API-before-client and client-before-API deployments, response loss, expired subscription, revoked restoration at full quota, and unknown-owner migration.
- [x] Validate UI normal/narrow Station RU/EN and handheld recovery screens in a browser/emulator when available; capture reviewable images. If an environment is unavailable, preserve exact limitation rather than asserting visual acceptance.
- [x] Run affected package gates after builds, API DB tests against a dedicated task DB, Android gates, full formatting and diff checks. Investigate unrelated wider-run failures and record evidence.
- [x] Write operations guide with recovery steps, expected refusal states, no automatic deletion/print replay, rollout compatibility order, unresolved-owner support limitation and explicit no commercial activation.
- [x] Perform independent whole-change review, resolve consequential findings and rerun covering checks. Mark task completion only after reports and evidence support it; leave commits/publication for the user's separate instruction.

## Plan self-review

The spec's API, local ownership, generation fencing, all-channel persistence,
migration, UI and compatibility requirements map to Tasks 1–4. The wire shape
above is common to both clients. Task 3 includes worker/commit integration with
its storage foundation because a wipe-only change cannot be independently safe.
Task 4 checks cross-boundary behavior rather than reimplementing local decisions.
Runtime files are independently installed/built in this worktree; no old worktree
cleanup or application deployment belongs to this plan.
