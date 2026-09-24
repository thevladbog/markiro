# Station Box Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and safely repair missing server boxes during a long Station shift, at pause, and at close, with details behind the existing synchronization control.

**Architecture:** A station-only API compares bounded per-box identity and effective membership digests with authoritative Postgres state. A device-wide Station worker persists audit requests, uses the existing ingest queue for safe repairs, and exposes counts and hard issues in one synchronization dialog. Local lifecycle transitions continue after a ten-second online budget.

**Tech Stack:** TypeScript, Zod, NestJS, Drizzle/Postgres, Station React/Tauri, SQLite, Vitest, `@markiro/domain`.

**Spec:** `docs/superpowers/specs/2026-09-24-station-box-reconciliation-design.md`

## Global Constraints

- Station remains offline-first; pause and close must finish locally after at most ten seconds of reconciliation work.
- Reconciliation batches contain at most 200 boxes and no raw marking codes.
- Derive tenant and device identity from the station credential; do not trust submitted terminal identity.
- Never overwrite a different non-null pallet link or mismatching contents.
- A repair re-enters the established scan-ingest channel; the reconciliation endpoint does not ingest scans.
- A new server route must have explicit subscription recovery policy, OpenAPI shape, route inventory, device-key documentation, and cross-tenant/device tests.
- SQLite DDL belongs in `packages/db/src/sqlite`; append migrations, preserving applied entries.
- Pooled SQLite multi-statement repairs must use the held-connection `SqlExecutor.atomic` interface and a credential-generation fence.
- Keep `exports/`, `output/`, `screenshots/`, and other unrelated work untouched. Do not commit, push, release, or deploy without user authorization.

## File map

| Unit                                                                                                      | Responsibility                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/domain/src/sync/box-reconciliation.ts` and test                                                 | Pure, versioned digest of sorted effective member hashes.                                            |
| `packages/db/src/sqlite/schema.ts`, `migrations.ts`, DB tests                                             | Reconciliation revisions, journal join keys, durable issues, indexes, append-only migration.         |
| `apps/api/src/modules/station-scans/box-reconciliation.ts` and test                                       | Tenant/device-scoped box comparison and guarded null pallet-link fill.                               |
| `apps/api/src/modules/station-scans/dto.ts`, controller, contract tests                                   | Strict 200-item route and station-only access.                                                       |
| `apps/station/src/lib/box-reconciliation.ts` and test                                                     | Read local facts, verify old/new journal evidence, apply outcomes, atomically queue targeted replay. |
| `apps/station/src/lib/sync.ts`, `use-sync-engine.ts`, tests                                               | Single-flight scheduling, drain coordination, reconnect and restart behavior.                        |
| `apps/station/src/lib/shift-reconciliation-barrier.ts` and test                                           | Ten-second pause/close audit budget and durable trigger.                                             |
| `apps/station/src/ui/SyncDetailsDialog.tsx`, `StatusBar.tsx`, `FloorShell.tsx`, `App.tsx`, i18n, UI tests | Existing sync pill as button and modal with per-shift counters.                                      |
| `docs/device-key-surface.md`, relevant route inventory/OpenAPI tests                                      | Public contract and recovery access record.                                                          |

## Review Focus

1. A lost reply followed by eight extra boxes: Task 6 tests that the eight get fresh replay batches and a later confirmation, while the first six stay untouched.
2. A late response after a pause requested a newer full audit: Task 5 tests that the old response cannot advance `confirmed_revision` to the new value.
3. A historic box whose journal has one missing or ambiguous raw scan: Task 4 tests `replay_evidence_missing` and zero queued partial scans.
4. A box linked to a different non-null pallet or a reused SSCC: Task 3 tests `identity_conflict` with no server write.
5. A device credential replaced mid-request: Task 5 tests that an old response cannot change the new owner's SQLite queue or issue state.

---

### Task 1: Freeze the membership digest

**Files:** Create `packages/domain/src/sync/box-reconciliation.ts`, `packages/domain/test/box-reconciliation.test.ts`; modify `packages/domain/src/index.ts`.

**Interfaces:** `boxMembershipDigestV1(codeHashes: readonly string[]): string` accepts lowercase SHA-256 code hashes and returns a lowercase 64-character digest. Both Station and API use exactly this export. Duplicate hashes are invalid input, not silently removed; an empty box has a defined digest.

- [ ] **Step 1: Write failing digest tests.** Assert identical output for reversed input, different output after one hash changes, rejection of duplicates/invalid hashes, and a pinned empty-set value. Example:

  ```ts
  expect(boxMembershipDigestV1([B, A])).toBe(boxMembershipDigestV1([A, B]));
  expect(() => boxMembershipDigestV1([A, A])).toThrow(/duplicate/);
  ```

- [ ] **Step 2: Run the focused test; expect missing-export failure.** `corepack pnpm --filter @markiro/domain exec vitest run test/box-reconciliation.test.ts`.
- [ ] **Step 3: Implement digest with the domain's existing noble SHA-256 helpers.** Hash UTF-8 bytes of `markiro:box-members:v1\n` followed by sorted hashes joined with `\n`; validate every hash with `/^[0-9a-f]{64}$/`, reject duplicates, and export from `index.ts`.
- [ ] **Step 4: Run focused test, then package build.** `corepack pnpm --filter @markiro/domain exec vitest run test/box-reconciliation.test.ts`; `corepack pnpm --filter @markiro/domain build`.

### Task 2: Persist exact local audit and replay evidence

**Files:** Modify `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `apps/station/src/lib/journal.ts`, the grant-aware scan command SQL under `apps/station/src/lib/offline-grants/` if it writes `scan_events_mirror`; test `packages/db/test/sqlite-schema.test.ts`, `apps/station/test/mirror.test.ts`, `apps/station/test/journal.test.ts` or the closest existing grant-aware journal test.

**Interfaces:** `boxes_mirror.reconciliation_revision INTEGER NOT NULL DEFAULT 1`, `confirmed_revision INTEGER NOT NULL DEFAULT 0`, `server_reconciled_at TEXT`; `scan_events_mirror.code_hash TEXT`, `box_id TEXT` for new accepted scans; `box_reconciliation_issues(box_id PRIMARY KEY, shift_id, status, reason_code, local_item_count, server_item_count, checked_at)`.

- [ ] **Step 1: Add failing migration and journal tests.** Migrate a database containing an old acknowledged box; assert revision `1/0` and original ack unchanged. Reapply migrations; assert stable data. Record one newly accepted scan through both legacy and grant-aware paths; assert the journal row contains the same `code_hash` and `box_id` as `codes_mirror`. Verify a rejected/duplicate scan has null join keys.
- [ ] **Step 2: Run focused tests; expect missing columns and assertions to fail.** `corepack pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts`; `corepack pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/journal.test.ts` (substitute the existing exact journal test file if named differently).
- [ ] **Step 3: Append SQLite migration entries and matching Drizzle fields.** Add an index on `(acked_at, reconciliation_revision, confirmed_revision)` and an issue index on `shift_id`. Do not rewrite historical migration entries. Update the one existing scan-event insert in each admission path to include the two join keys on the same business mutation; avoid a later best-effort update.
- [ ] **Step 4: Run focused tests and rebuild DB exports.** `corepack pnpm --filter @markiro/db build`; rerun focused DB and Station tests. Check that `SqlExecutor.atomic` remains available in both Tauri and the test executor.

### Task 3: Add the station-only comparison API

**Files:** Create `apps/api/src/modules/station-scans/box-reconciliation.ts`; modify `apps/api/src/modules/station-scans/dto.ts`, controller, service/module registration; test `apps/api/test/station-box-reconciliation.e2e.test.ts`, `apps/api/test/subscription-route-inventory.test.ts`, relevant OpenAPI/device-key tests; modify `docs/device-key-surface.md`.

**Interfaces:** `POST /station/boxes/reconciliation`, strict body `{ boxes: BoxReconciliationInput[] }`, 1–200 items. Each input has `shiftId`, `boxId`, `sscc`, `closedAt`, `devicePalletId`, `itemCount`, `membershipDigest`, `digestVersion: 1`; response `{ results: { boxId, status, reasonCode, serverItemCount }[] }`, one result per input. Server identity is `(tenantId, authenticated deviceId, shiftId, boxId)`; request has no tenant or terminal field.

```ts
type BoxReconciliationInput = {
  shiftId: string;
  boxId: string;
  sscc: string;
  closedAt: string;
  devicePalletId: string | null;
  itemCount: number;
  membershipDigest: string;
  digestVersion: 1;
};
type BoxReconciliationResult = {
  boxId: string;
  status: "confirmed" | "replay_required" | "content_mismatch" | "identity_conflict";
  reasonCode:
    | "matched"
    | "box_absent"
    | "closure_absent"
    | "pallet_absent"
    | "count_mismatch"
    | "digest_mismatch"
    | "sscc_conflict"
    | "shift_or_device_conflict"
    | "closure_conflict"
    | "pallet_conflict";
  serverItemCount: number | null;
};
```

- [ ] **Step 1: Add failing DTO and access tests.** Reject 201 items, duplicate box ids, malformed SSCC/digest, station-key requests for another tenant/device, cabinet session, and handheld key. Assert the route uses `TenantGuard`, `StationOnlyGuard`, `SubscriptionAccessGuard`, and `@AllowSubscriptionRecovery("station")`. Assert its OpenAPI request and response schemas and route inventory entry.
- [ ] **Step 2: Run focused API tests; expect 404/schema failures.** `corepack pnpm --filter @markiro/api exec vitest run test/station-box-reconciliation.e2e.test.ts test/subscription-route-inventory.test.ts`.
- [ ] **Step 3: Implement a bounded tenant/device-scoped query.** Resolve submitted shifts under the tenant, fetch boxes by `(shift_id, terminal_id=authenticatedDeviceId, device_box_id)`, and independently look up requested SSCCs for collision detection. Fetch effective `box_items` where `displaced_at IS NULL AND removed_at IS NULL`; compute `boxMembershipDigestV1` and compare count, SSCC, closure, and pallet's `device_pallet_id`. Preserve input order and return one result per box. Hide foreign-device records; a conflicting SSCC is reported only as an opaque conflict reason.
- [ ] **Step 4: Test and implement the safe null-link repair.** With exact identity, SSCC, effective membership, and an existing production pallet under the same tenant/device/shift, update only `boxes.pallet_id IS NULL`, inside a transaction, then re-read. A different non-null link returns `identity_conflict`. If the pallet does not exist yet, return `replay_required` with reason `pallet_absent`, without creating it in this endpoint; closure replay through normal ingest creates the pallet, and the next control check fills the link. Repeat the request to prove idempotency and no changed-row count on the second call.
- [ ] **Step 5: Add the exact incident fixture.** Server has 58 boxes on the pallet; local request names 66, of which eight are absent. Assert exactly eight `replay_required`, 58 `confirmed`, and no mutation before normal ingest. Then feed eight recovered scans and closures through `POST /station/scans`; confirm the next reconciliation reports 66 `confirmed` and the pallet has 66 members. Use valid realistic SSCCs including serial 1575, without user production data.
- [ ] **Step 6: Add safe observability and run contract checks.** Log status and stable reason counts, request size and duration, without raw codes or credentials; test a disagreement log for absence of raw input. Build domain and DB exports first, then focused tests. Update `docs/device-key-surface.md` with this station-key recovery route and its no-raw-code boundary.

### Task 4: Reconstruct and queue a whole box safely

**Files:** Create `apps/station/src/lib/box-reconciliation.ts`, `apps/station/test/box-reconciliation.test.ts`; adjust the Station test executor only if it lacks the native `atomic` behavior already used by grant tests.

**Interfaces:** `readBoxReconciliationBatch(exec, shiftId?: string, limit = 200)`, `applyBoxReconciliationResults(exec, generation, requestRevisionByBox, results)`, `requestFullShiftReconciliation(exec, shiftId)`, `readBoxReconciliationSummary(exec, shiftId?)`. The apply function works only after a sync drain has gone idle and holds a credential commit lease.

- [ ] **Step 1: Write failing local-state tests.** Confirmed marks only the checked revision; hard statuses persist issues without mutating content; the next confirmed result resolves an issue. A full-shift trigger increments all closed box revisions in one SQL statement while offline. A 201-box shift yields batches of 200 and 1 in stable order.
- [ ] **Step 2: Write failing historical replay tests.** For an acknowledged closed 20-item box classified `box_absent`, create real `scan_events_mirror` rows and `codes_mirror` rows with null legacy join keys. Canonicalize and hash each raw journal payload, require a one-to-one match on hash, shift and scanned-at, retain original terminal/operator, then queue 20 `outbox` rows and clear only that box's `acked_at`. Assert a missing, duplicate, wrong-hash, or mismatched-timestamp journal row produces `replay_evidence_missing`, with zero new `outbox` rows and original ack intact. For `closure_absent` and `pallet_absent`, assert no scan is queued and only the closure is requeued.
- [ ] **Step 3: Run focused Station test; expect missing module failure.** `corepack pnpm --filter @markiro/station exec vitest run test/box-reconciliation.test.ts`.
- [ ] **Step 4: Implement local fact queries and response validation.** Compute local effective hashes from `codes_mirror` by box, excluding codes removed by current local exception/release rules. Include current revision with each request. Verify response box ids are distinct, requested, and complete before applying; ignore a stale response whose revision or credential generation changed.
- [ ] **Step 5: Implement one held-connection replay transaction.** For `box_absent`, build the entire old/new scan evidence list before mutation. Under `SqlExecutor.atomic`, insert all replay scans into `outbox`, set only the target `boxes_mirror.acked_at=NULL`, and leave its `confirmed_revision` behind `reconciliation_revision`. For `closure_absent` or `pallet_absent`, clear only that closure ack. Use conditional `expectedChanges` or equivalent current-row predicates so a concurrent state change aborts the whole transaction. The sync worker must not overlap this transaction. Do not add new productive unit counts or physical print jobs.
- [ ] **Step 6: Test crash and retry boundaries.** Fail the native atomic call before commit and assert no partial outbox insert. Restart after commit and prove the queued box drains once. Repeat `replay_required` before control confirmation and prove it cannot enqueue a second replay for the same box. Verify fresh batch identity and no mutation of neighboring boxes.
- [ ] **Step 7: Run focused Station and DB tests.** Include a test where the local member digest changes while a response is in flight: that response cannot confirm or replay the now-different box.

### Task 5: Schedule reconciliation without breaking existing sync ownership

**Files:** Modify `apps/station/src/lib/sync.ts`, `apps/station/src/lib/use-sync-engine.ts`; create `apps/station/src/lib/shift-reconciliation-barrier.ts`; test `apps/station/test/sync.test.ts`, `apps/station/test/use-sync-engine.test.tsx`, `apps/station/test/shift-reconciliation-barrier.test.ts`.

**Interfaces:** Extend `SyncEngine` with `reconcileNow(shiftId?: string): Promise<void>` and `requestFullShiftAudit(shiftId: string): Promise<void>`. Extend the hook with stable wrappers. `runShiftReconciliationBarrier(shiftId, engine, deadlineMs = 10_000)` persists the full-audit request before waiting and returns `{ complete: boolean; hardIssues: number }` without throwing on network timeout.

- [ ] **Step 1: Add failing scheduling tests.** A two-minute clock triggers reconciliation for an active shift; online restoration nudges it immediately; three simultaneous timer/manual/lifecycle requests coalesce; one device-wide worker continues after WorkScreen unmount. An old credential-generation response cannot commit after re-pairing.
- [ ] **Step 2: Add failing lifecycle tests.** Pause and close each persist full-audit intent before any network call. One ten-second deadline bounds drain, reconciliation, replay and control check together. Offline/timeout yields `complete:false`, retains due revisions, and allows local transition. A late response for revision 1 cannot satisfy a newly requested revision 2.
- [ ] **Step 3: Run focused tests; expect missing methods/module failure.** `corepack pnpm --filter @markiro/station exec vitest run test/sync.test.ts test/use-sync-engine.test.tsx test/shift-reconciliation-barrier.test.ts`.
- [ ] **Step 4: Integrate a single-flight reconciliation loop with the existing engine.** Use its `idle()` boundary and existing backoff/connectivity signals. Serialize any ack-clearing repair with batch assembly, network delivery, and ack commit. Do not call `pauseAndWaitForIdle()` before the reconciliation request; that method pauses sync. Control checks begin only after targeted outbox work is acknowledged. Publish pending, retry, repairing, confirmed and hard-issue counts from durable SQLite state.
- [ ] **Step 5: Make restart and post-close recovery explicit.** On engine construction, scan durable due boxes across all shifts, including locally paused/closed ones. Keep ordinary periodic work bounded and backoff-respecting. A full audit still checks confirmed boxes by incremented revision.
- [ ] **Step 6: Run focused tests.** Verify `sync_pending_box_ceiling` and batch signatures still fence retries while a new recovered box is queued.

### Task 6: Wire pause/close and the synchronization dialog

**Files:** Modify `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/App.tsx`, `apps/station/src/ui/StatusBar.tsx`, `apps/station/src/ui/FloorShell.tsx`, `apps/station/src/i18n/ru.json`, `en.json`; create `apps/station/src/ui/SyncDetailsDialog.tsx`; test `apps/station/test/App.test.tsx`, `status-bar.test.tsx`, `floor-shell.test.tsx`, `work-screen.test.tsx` if present, `sync-details-dialog.test.tsx`.

**Interfaces:** `StatusBar` receives `onOpenSyncDetails` and `syncAttention` alongside existing sync state. `SyncDetailsDialog` receives summary, selected shift, issues, last checked/next retry times, and `onReconcileNow`. WorkScreen receives `onPauseShift` and uses the existing close callback to invoke the bounded barrier after scan admission is fenced and before navigation.

- [ ] **Step 1: Write failing accessibility and layout tests.** The existing `Синхр.` pill is one semantic button with visible focus and an accessible issue name; no new header row/counter appears. Pending offline work has no hard-issue marker. Clicking opens the dialog; Escape/Close returns focus to the button.
- [ ] **Step 2: Write failing dialog-state tests.** Active shift shows five exact counters; outside a shift, show device totals and rows for unresolved shifts. Show SSCC and reason for hard issues, but no raw code, batch id, credential or SQL error. `Сверить сейчас` calls the single-flight worker once. Include `replay_evidence_missing` in the issue list.
- [ ] **Step 3: Run focused UI tests; expect absent control/dialog failures.** `corepack pnpm --filter @markiro/station exec vitest run test/status-bar.test.tsx test/floor-shell.test.tsx test/App.test.tsx test/sync-details-dialog.test.tsx`.
- [ ] **Step 4: Implement the modal with existing `@markiro/ui` primitives and i18n.** Keep the current header width and collapsed behavior; reuse the current sync value and busy treatment. Use the five counter labels and non-blocking pause/close notice from the spec.
- [ ] **Step 5: Wire pause and close after WorkScreen's queue settles.** `requestExit` and the product-label pause branch must call the same bounded audit path. The close path must first settle its open-pallet choice, then run the barrier, then call the existing `closeShiftOffline*` owner. A timeout or hard issue cannot prevent local pause/close; a local persistence error still must surface as an error.
- [ ] **Step 6: Run focused UI/lifecycle tests.** Exercise duplicate taps, open pallet confirmation, offline restart, post-close dialog access, and delayed responses after leaving the shift.

### Task 7: Contract, regression, and release-readiness gate

**Files:** Update the changed tests and docs above; inspect `tools/ci/affected.mjs` and `.github/workflows/ci.yml` for affected-job ownership. No deployment file change unless an existing contract test proves it is required.

- [ ] **Step 1: Run the exact incident regression across Station and API fixtures.** Simulate six server-applied boxes plus eight local-acked absent boxes, followed by reconciliation, 8-box replay, control confirmation, and final 66-member pallet. Assert no new physical print action and no mutation of the first 58 boxes. Separately test one unavailable historic scan as a visible issue.
- [ ] **Step 2: Run package gates in dependency order.** Build `@markiro/domain` and `@markiro/db`; then run relevant package `test`, `typecheck`, `lint`, `build` for `@markiro/domain`, `@markiro/db`, `@markiro/api`, and `@markiro/station`. Run `corepack pnpm format:check` and `git diff --check`. Record database-backed skips explicitly.
- [ ] **Step 3: Review the final diff and contracts.** Verify the route is in device-key documentation and OpenAPI; inspect the complete changed-file list for unrelated generated output, raw marking codes, or secret-bearing fixtures. Run `graphify update .` after code changes because the local graph exists.
- [ ] **Step 4: Separate deployment acceptance.** A green local suite does not prove Station installer delivery, real Windows SQLite behavior, factory connectivity, printer output, or the live `SEP26-021` pallet. Preserve a cold Station DB snapshot before any live recovery. After an authorized release, verify the exact deployed build, server box identities 1575–1582, 20 effective items each, correct pallet link, and server total 66 before calling the incident recovered.

## Execution notes

The implementation order is deliberate: Task 1 pins a shared digest, Task 2 preserves replay evidence, Task 3 establishes the server comparison contract, Task 4 makes repair durable, Task 5 schedules it, and Task 6 exposes it without crowding the header. Task 7 checks the complete failure path. The repository's `AGENTS.md` reserves commits, pushes, PRs, releases and deployment for separately authorized scope, so these task checkpoints end with tests and review rather than automatic commits.
