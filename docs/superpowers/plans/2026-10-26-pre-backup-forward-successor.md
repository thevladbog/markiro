# Pre-backup Forward Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution remains serial in this chat, with the sole existing independent reviewer.

**Goal:** Continue the release through a canonical successor of the exact failed forward-admission operation, preserving its authority and all data.

**Architecture:** Keep the existing protected prepare/activate phases and outer forward operation kind. Add one strict discriminated admission variant that binds a single failed ordinary forward preparation as its immediate predecessor, plus its complete older upgrade/recovery chain. Resolve those chain nodes explicitly and hand the current index directly to the successor under the existing durable lock; never restore an older index. Add bounded first-failure GitHub read diagnostics without changing acceptance or retries.

**Tech Stack:** Existing Node24 ESM, node:test, private JSON files, existing Python Linux renameat2 bridge, Docker/PostgreSQL and protected GitHub Actions; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-pre-backup-forward-successor-design.md`, owner-approved in chat on2026-10-26. The rejected compensating-index protocol is excluded.

## Global Constraints

- Same worktree and `codex/timeweb-explicit-recovery`; no reset, unrelated edits, concurrent producers or new agents. Current branch safely fast-forwarded to merged mainedd24d389f0986ff3da8d400c46b61abaeb60426.
- Existing failed243 operation and both failed runs40356248549/40357752954 are immutable; no rerun, reprovision, index restoration, lock bypass or app/SQL action during implementation.
- Successor admits only a base-kind forward failure at seq2/admitted/recovery-required/migrationEntered=true with null sourceRuntime/backup/preparation, no retained file, no activation and no uncertainty/producer. A failed successor can never be its own accepted predecessor: depth is exactly one.
- New admission kind `platform-forward-admission-successor`, version1, same outer `platform-forward-recovery-host-operation` and phases. Existing old-kind admission behavior remains unchanged; unknown or mixed variants fail.
- Accepted product6e32/publisher40120442037/artifact12584215539 remain separate from new executor/CI. No migrations, future features, dependency changes or product rebuild substitution.
- Never expose raw URLs/queries, tokens, response bodies, argv, private output, retained Env or raw stacks. New diagnostics report only trusted finite categories.
- Preserve per-process timeouts, byte/redirect limits, expiry/freshness, all mandatory checks, both serial Linux outcomes and cleanup. No automatic read/workflow/operation retry.

## Review Focus

1. A failed successor is presented as another predecessor: deny rather than create a recursive recovery engine (Task2).
2. The current index is correct but an older archived index or prior consumption is swapped: deny before rename and keep all old bytes/metadata (Tasks2–3).
3. Publication fails after intent/rename/fsync: retain the common lock and refuse another operation (Task3).
4. A caller supplies a fake HTTP status/stage/stack or a diagnostic contains a signed URL: ignore untrusted properties, persist only fixed constructor-owned fields (Task1).
5. Backup/source progress, a retained runtime or an unknown child exists despite seq2: deny the successor; do not infer no effects from sequence alone (Tasks2–4).

## File map and fixed interfaces

- New `deploy/platform/host/admission-read-failure.mjs`: `withAdmissionReadStage(stage, action)` creates/propagates trusted bounded failure metadata; `admissionReadFailure(error)` retrieves only metadata held in its WeakMap. Fixed stages: publisher, artifact-metadata, artifact-download, artifact-archive, product-ci, executor-ci, publisher-recheck. Fixed reasons: validation, http, body-limit, redirect, timeout, transport. HTTP status100–599 or null; bounded integer byte/limit/hop fields only. It never retains the error/body/URL/token itself.
- Modify `admission-github.mjs`, `host/command.mjs`, `host/failure-diagnostic.mjs`: tag the actual failed trusted read/validation stage, preserve the first origin across existing wrappers, persist optional strict `admissionRead` metadata. Existing failures without metadata retain their existing shape.
- New `host/forward-successor-admission.mjs`: exports `failedForwardNames`, `readFailedForwardPredecessor(root, operationId, {successorOperationId, indexFromSuccessorArchive=false}={})` and `validateForwardSuccessorAdmission(input, {failedForwardBytes, failedUpgradeBytes, originalPredecessorBytes, productMigrationProof, now})`.
- New `host/forward-history.mjs`: `readForwardHistory(root, admission, {ownIndexArchive}={})` returns explicit `{original, failedUpgrade, failedForward, immediateIndex}` byte records. Only a fixed current global index or the current operation's own fixed predecessor-index may supply immediate ownership. Older upgrade index comes from243's pinned predecessor archive, never masquerades as current.
- Modify `host/forward-state.mjs`, `host/forward-command-runtime.mjs`, `host/upgrade-command.mjs` and `host/target-backup.mjs` to use those strict helpers. Preserve existing capability/guard/freshness/projection/backup boundaries. Add new transitive source files to current HOST/RECOVERY/UPGRADE closure lists as imports require; historical installations retain their own receipt lists.
- Existing `host/forward-index-handoff.py` stays the fixed NOREPLACE rename/fsync bridge; do not replace it with ordinary rename or copying an old index.
- Update existing forward fixtures/rehearsal, focused tests, production runbook and this execution journal. No app/migration/lockfile edits.

Implementation packaging correction: the shared diagnostic module lives in `host/` so the existing closed backup-worker source cohort contains it. The pinned historical cdae executor keeps its original root-level path; its byte closure is never rewritten. Public exports and every diagnostic/acceptance boundary remain unchanged.

### Task 1: Bounded original-stage diagnostics

**Files:** create `host/admission-read-failure.mjs`, `test/admission-read-failure.test.mjs`; modify `admission-github.mjs`, `host/command.mjs`, `host/failure-diagnostic.mjs`, source closure lists and adjacent diagnostic/admission tests.

**Interfaces:** produces the stage wrapper/getter and optional `admissionRead` metadata above. The wrapper's callback is trusted compiled code; untrusted error properties are never copied.

- [ ] RED: transport502,30s timeout classification, body/redirect bound and product/executor CI validation retain distinct fixed stages; a later cleanup error cannot replace the first read origin. Forged properties/getters/URLs/body/argv never enter the diagnostic.
- [ ] Run focused Node tests and retain genuine failing output.
- [ ] Implement the finite WeakMap provenance and trusted call sites. Keep all deadlines/limits/required responses unchanged and never retry.
- [ ] GREEN: focused diagnostic/admission tests and source closure import test; scoped eslint/prettier/diff. Commit explicit paths.

### Task 2: Strict failed-forward predecessor and complete history

**Files:** create `host/forward-successor-admission.mjs`, `host/forward-history.mjs`, `test/forward-successor-fixture.mjs`, `test/forward-successor-admission.test.mjs`; modify only shared fixture exports needed for genuine state construction.

**Interfaces:** new admission retains the current base admission's fields plus mandatory `priorForward:{identity,hashes}` and new kind. `failedForwardNames` is an exact set: state, prepareConsumption, prepareOperation, failure, index, predecessorIndex, handoffIntent, handoffSuccess, installedExecutor, backupRuntime, delivery, executionFence, commandStarted. Fixed readers use the prior UUID and existing paths, excluding the job token. The reader owns a private WeakMap/WeakSet brand for the immutable byte-record and its freshly verified retained/activation absence; JSON/caller records cannot forge that observation. Archive mode accepts only the fixed predecessor-index path of the validated successor UUID. The validator requires this genuine reader record; fixtures create real files and call the reader. The validator verifies base-kind prior admission historically, canonical seq2 journal, exact consumption/dispatch/input/receipt/fence/handoff chain and current typed index; it validates the older upgrade chain separately with the genuine newly extracted product proof.

- [ ] RED fixture creates the prior base-kind forward seq2 through the actual store failure path. Positive successor uses a distinct UUID/executor/run and exact immediate index; no fabricated successful prior state.
- [ ] RED denials: recursive successor predecessor, wrong phase/sequence/status/latch, non-null source/backup/preparation, mixed product/target/config/schema/ledger, swapped old/index/consumption/dispatch, expired new authorization, stale historical authorization revived as new, missing/extra fields, replay/self approval and missing retained-absence proof.
- [ ] Implement exact readers and validator. Validate the common historical upgrade chain through the unchanged old validator only after proving the explicit immediate forward node. Do not publish or substitute an older current index.
- [ ] GREEN all focused old/new admission tests; no weakened old assertions. Independent task review before state integration; commit.

### Task 3: Direct canonical ownership handoff, loader and backup integration

**Files:** modify `host/forward-state.mjs`, `host/forward-command-runtime.mjs`, `host/upgrade-command.mjs`, `host/target-backup.mjs`, source lists; extend state/command/initialization/backup/observation tests.

**Interfaces:** `forwardPhaseReceipt` binds successor prepare to `priorForward.hashes.state`; the current index and handoff intent/success bind `priorForward.hashes.index` and its operation ID. Old-kind receipts/indexes remain byte-compatible. `historicalSources` has a mandatory `priorForwardReceiptSha256` only for the new variant, verified using that executor's own source root/receipt. The new typed index archives CURRENT243 directly and records the immediate predecessor digest. The older archived upgrade node stays inside243's tree.

- [ ] RED genuine locked store: direct243→new ownership succeeds, every original/failed/243 byte stays unchanged, inode/mtime preserved by archive rename and ctime recorded. No old-index republication occurs.
- [ ] RED each intent/rename/archive/state/index/fsync checkpoint failure, foreign owner, mutated prior node and unknown producer: retain lock/refuse another UUID. Verify absence of retained file, activation dir/consumption and any phase past admitted before accepting.
- [ ] Implement branch-specific history resolution in the loader, state checks, initializer and target-local backup. Keep all authority/capability, source, schema, role, TLS, stop, projection and cleanup checks. Historical source closure never uses the expanded current list.
- [ ] GREEN focused old/new state, command, retained, initialization and backup suites; full transitive source import tests. Independent review and scoped commit.

### Task 4: Actual isolated successor outcomes and runbook

**Files:** modify `forward-ci-scenario.mjs`, `forward-ci.mjs`, `test/forward-rehearsal.test.mjs`, affected fixtures and `docs/runbooks/platform-post-migration-forward-recovery.md`; CI ownership tests only if required.

**Interfaces:** the same two mandatory serial namespaces now construct the exact failed base forward admission before the canonical successor. A trusted synthetic read failure creates only seq2; the successor has a distinct run/UUID and complete direct history. Healthy and replacement-failure outcomes remain distinct. Evidence includes the immediate failed-forward state/index digests and preserved chain; no private payload is uploaded.

- [ ] RED protocol/fixture tests prove the new predecessor cannot be skipped, a retained runtime or non-null backup is denied, and diagnostics identify the injected read stage without weakening acceptance.
- [ ] Implement both existing isolated scenarios through the actual new loader/store/backup/activation boundaries. Keep real Docker/Linux handoff, dump/full restore/ten checks, current ledger, TLS and exact owned cleanup. Preserve no-second-migrator/no-old-start assertions.
- [ ] GREEN affected tests and production bundle contracts; run full platform tests serially with actual pass/fail/skip counts. Native full Linux execution remains required in CI when local prerequisites are unavailable.
- [ ] Document exact accepted shape, bounded depth, immutable historical evidence, new protected inputs and explicit unrun production/hardware gates. Commit scoped files.

### Task 5: Whole branch, exact CI and protected release continuation

**Files:** existing source/runbook changes and create-only private operational package after green main.

- [ ] Final scoped lint/global format/diff and required tests; fresh target fetch/full three-dot diff. Sole existing reviewer checks the whole branch and strict no-bypass/diagnostic denial cases serially.
- [ ] Push/create one scoped PR for the owner-approved extension. Observe one exact-head run and all CodeQL/security/reviews; do not call queued/skipped outcomes acceptance. Require both actual namespace outcomes, every check and cleanup true before merge.
- [ ] Authorized merge and exact new main CI/worker provenance. No production source patch, old-run replay, new UUID, input or handoff until green main and concrete independent operator review.
- [ ] Fresh read-only243/older-chain/PG/schema/producer observation; one new successor UUID once. Install exact executor closure/verify new worker provenance and pin the accepted product independently. Preserve every old source/runtime/config/input/token/marker/receipt/partial/copy.
- [ ] New protected prepare with immediate URL but approval withheld until immutable input/loader/readback pass. Distinct second-account approval; new actual backup/restore/cleanup and unique encrypted Mac/Timeweb copies with full decrypt/hash/VersionId/ACL/versioning checks.
- [ ] Fresh key/source/roles/TLS/ledger/projection proofs, separately protected activate; independently verify actual healthy chain/samePG/newIDs/externalTLS/landing/API. Only then DNS/channel/catalog continuation including already issued signed Autonom1.1.0. Windows/device/printer acceptance stays separate.

## Self-review and execution handoff

All spec sections map to Tasks1–5. Review Focus1/2/5 map to Task2,2/3 to Task3,4 to Task1, and5 to the real Task4 scenarios. Signatures/record names are fixed above; old admissions remain unchanged. Any discovered need for a broader predecessor shape is out of scope. Execution method remains serial native implementation in this chat with the sole existing reviewer; no parallel agents/producers. Owner approval of the design and this concrete plan is recorded; execute serially without further planning confirmations.
