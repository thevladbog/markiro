# Accepted Recovery Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans sequentially in the existing worktree. Steps use checkbox (`- [ ]`) syntax. Do not launch competing builders/tests/CI.

**Goal:** Safely deploy the approved read-only release catalog onto the existing accepted Timeweb recovery, with a checked return to the exact old runtime before migration.

**Architecture:** Separate protected upgrade orchestration binds retained recovery authority, old configuration and candidate configuration. A target-wide durable upgrade index and per-operation journal share the existing host lock. Preparation stops only owned old apps, produces fresh restore-verified backups and independent copies; activation and pre-migration return consume mutually exclusive fresh admissions.

**Tech Stack:** Existing Node 24 dependency-free platform modules, Docker, PostgreSQL, GitHub protected workflows, Corepack pnpm 11.22.0. No dependency change.

**Spec:** `docs/superpowers/specs/2026-10-24-accepted-recovery-upgrade-design.md`.

## Global Constraints

- Start product implementation only after this plan is reviewed; preserve the user's sequential execution method. Finish PR795 exact-head CI/merge and exact-main CI before publishing the upgrade change. No cancellation of healthy CI merely to append plan documents.
- Preserve original ordinary/recovery/preparation/consumption/operation/runtime bytes and their locations. No reset, fake healthy journal, blank replacement state root or rerun of historical scripts.
- Target-wide `.deploy.lock` serializes ordinary/recovery/upgrade actions. Unknown durability or undrained producers retain it; no lock bypass.
- Old and candidate authority are separately byte-bound. Full environment/mount equality remains strict. Never select authority by image ID alone.
- Prepare cannot migrate/start candidate apps. Candidate catalog writers remain disabled and all unproven namespaces remain closed.
- Original stopped API/edge containers remain intact until migration. Return starts only their exact IDs after all old-authority and schema checks.
- Write/fsync monotonic `migrationEntered` before any migrator spawn; after that latch, automatic or protected old-runtime return is forbidden.
- Before production: rehearse return in an owned isolated environment, then agree the maintenance window with the user. Each phase has fresh immutable input and protected approval; no self approval.
- Fresh source is current Timeweb PostgreSQL, never deleted Yandex resources. No live database restore, backup overwrite, secret logs, signing key upload, public release or DNS change in implementation tasks.
- Keep this plan's ignored evidence workspace and old catalog evidence. One final independent whole-change review, then one independently checked concrete operation package before live execution.

## Review Focus

1. Same images with changed environment/mounts: phase and exact container identity must choose one complete authority (Task2).
2. Host/process failure between external action and durable result: a second UUID or retry must not bypass uncertainty (Tasks1/3).
3. Expired activation while old apps are stopped: fresh protected return remains possible only with proved untouched DB/containers (Tasks3/4).
4. Migration spawn fails after its durable latch: old-runtime return must still be refused (Tasks3/4).
5. Rehearsal accidentally reaches production DB/storage/mail or shares its mounts: deny before any app process starts (Task6).

## File boundaries

New modules live beside existing host orchestration, each responsible for admission, persistence, observation selection, preparation, activation, return, or command delivery. Existing ordinary and recovery validators retain their accepted input shapes. New workflow `upgrade-platform.yml` uses the existing production concurrency/environment; it does not overload historical `recover-platform.yml` phases. Reuse pure artifact, backup, restore, process and file-verification helpers; expose a narrow held-runtime factory only where required, never serialized callbacks.

### Task 1: Accepted predecessor and durable upgrade authority

**Files:** Create `deploy/platform/host/upgrade-admission.mjs`, `upgrade-state.mjs`; test `deploy/platform/test/upgrade-admission.test.mjs`, `upgrade-state.test.mjs`. Read existing `state.mjs`, `state-validation.mjs`, `recovery-activation-admission.mjs`, `files.mjs`; modify held-state primitives only if required without changing existing semantics.

**Interfaces:** `validateUpgradeAdmission(input, {predecessorBytes, now}) -> immutable admission`; predecessorBytes contains exact buffers for original, acceptedRecovery, preparation, consumption and activationOperation. `withUpgradeState(root, admission, callback, options) -> callback result` issues a lifetime-bound store `{read, guard, enter, complete, fail}` under `withHostState`. Data-only admission binds schema1/kind platform-accepted-recovery-upgrade, new identity, predecessor hashes/identity, old configuration hash, candidate configuration hash, executor CI, dispatch, reviewedPlanSha256 and expiresAt (fresh, at most one hour).

- [ ] Write RED tests for exact accepted recovery, each changed predecessor, failed/incomplete sequence, mismatched activation hash/dispatch/preparation/identity, same operation UUID, foreign target, invalid/expired new admission. Historical expiry cannot authorize or invalidate a structurally accepted predecessor by itself.
- [ ] Run `node --test deploy/platform/test/upgrade-admission.test.mjs`; expected FAIL for missing implementation. Implement strict shapes and full byte/structural links, then expect PASS.
- [ ] Write RED crash tests for exclusive `upgrade-index.json`, fixed `upgrade-operations/<uuid>/state.json`, prepare consumption and journal fsync. Index is durable before commands; same/different UUID cannot bypass existing entered/failed/uncertain/terminal first-upgrade state. Old files stay byte-identical. Inject each write/sync failure and forgotten async producer; preserve shared lock uncertainty.
- [ ] Implement journal transitions `admitted → old-stopped → backup-verified → activation-admitted → migration-entered → migrated → api-started → edge-started → healthy`, with separate pre-migration `return-admitted → old-api-started → old-edge-started → returned-old`. Exact entered/completed sequence validation; failures terminal. No public arbitrary phase or journal replacement API.
- [ ] Run both new suites plus existing host-state/recovery-state suites located via `rg --files`; expected PASS, zero skip. Commit explicit Task1 paths.

### Task 2: Exact old/candidate observation boundaries

**Files:** Create `deploy/platform/host/upgrade-observation.mjs`, test `deploy/platform/test/upgrade-observation.test.mjs`; modify `host/observe.mjs` only to factor a pure strict observation authority, retain all existing callers and tests.

**Interfaces:** `createUpgradeObservers({oldOperation, candidateOperation, predecessorContainers, policy}, dependencies)` produces `inspectOld`, `inspectStoppedOld`, `inspectCandidate`, `inspectReturnEligibility`; each consumes a live Task1 guard context. `oldOperation` carries verified retained configuration/source/image authority, never candidate substitutions.

- [ ] RED cases: candidate adds catalog variables/mounts while old apps run; same image with different configuration; stopped old app; mixed old/new env; foreign container; changed mount/network/port/entrypoint; changed PG system/volume identity.
- [ ] Run `node --test deploy/platform/test/upgrade-observation.test.mjs`; expected FAIL. Implement phase-specific selection of a complete authority and exact retained IDs. Existing observer equality, ownership, process and output bounds remain.
- [ ] GREEN new suite and all existing host-observe/platform catalog mount tests; expected PASS. Commit scoped changes.

### Task 3: Protected preparation and actual-source backup

**Files:** Create `host/upgrade-preparation.mjs`, test `test/upgrade-preparation.test.mjs`; modify `host/target-backup.mjs` and `backup/local-runtime.mjs` only for a non-forgeable held-upgrade runtime; add corresponding runtime tests.

**Interfaces:** `executeUpgradePreparation(input, adapters) -> prepared proof`; consumes Task1 store and Task2 observers. `createHeldUpgradeBackup(input, capability, admission, options)` reuses actual backup/isolated-restore producers, binds new op/fence and exact old source, preserves all old runtime records. Returned proof binds backup/archive/inventory/restore hashes, old authority, stopped IDs, schema/migration fingerprint, fence and new admission.

- [ ] RED: no stop before durable admission; exact stop order and ownership; old API/edge retained; fresh physical fence; no migration/candidate start; changed source before/after backup; forged/expired capability; backup/restore failure retains evidence and return eligibility facts.
- [ ] Run `node --test deploy/platform/test/upgrade-preparation.test.mjs`; expected FAIL. Implement using fixed trusted adapters; never restore into active PG or alter old backup-runtime.
- [ ] Actual isolated PG backup/restore test verifies schema, roles/ACLs, inventory and catalog ledger evidence when present. External producer drain/fsync failures must preserve lock. Run new tests and affected backup/runtime suites sequentially with owned test DB; expected PASS zero required skips. Commit scoped paths.

### Task 4: Mutually exclusive activation and pre-migration return

**Files:** Create `host/upgrade-activation.mjs`, `upgrade-return.mjs`; test `test/upgrade-activation.test.mjs`, `upgrade-return.test.mjs`.

**Interfaces:** `executeUpgradeActivation(input, adapters)` consumes separately protected fresh activation bound to prepared proof, independent-copy/key/fence evidence, candidate config and dispatch. `executeUpgradeReturn(input, adapters)` consumes fresh return admission tied to same prepared/failed-before-migration state and current safe-return observations. Both use Task1 store and target lock.

- [ ] RED activation tests: missing/changed copies, key proof, fence, expiry at every await/spawn boundary; wrong artifact/configuration; prepare alone cannot migrate; migrationEntered must be durably written before spawning migrator; candidate API then edge only after successful migration/role verification.
- [ ] RED return tests: exact original API then edge IDs start and pass old health/TLS; missing/recreated/changed container or DB/schema change refuses; migration latch refuses even when spawn failed; unknown termination/durability refuses; activate/return race has only one winner; lost response yields read-only terminal reconciliation, never second start.
- [ ] Run new suites; expected FAIL. Implement fixed command construction/phase admissions, no automatic SQL restore or post-migration rollback. Once a migrator may have run, failure remains terminal with applications held safely and evidence retained.
- [ ] Run all four new preparation/observation/activation/return suites plus existing ordinary and recovery orchestrator suites; expected PASS. Commit explicit paths.

### Task 5: Pinned delivery, protected workflow and CI ownership

**Files:** Create `.github/workflows/upgrade-platform.yml`, `deploy/platform/upgrade-transport.mjs`, `host/upgrade-command.mjs`, `host/upgrade-command-runtime.mjs`, `test/upgrade-transport.test.mjs`, `test/upgrade-command.test.mjs`; modify `tools/ci/affected.mjs`, its focused tests and CI script inventory only as required.

**Interfaces:** Workflow accepts phase prepare/activate/return-old, executor SHA and exact successful main CI, product publisher identity/artifact ID, operation UUID. Host records live at fixed `upgrade-operations/<uuid>/<phase>/operation.json`; executable source at fixed `upgrade-bootstrap/<executorSha>`. `loadUpgradeOperation(directory, options)` verifies the complete byte closure before dynamic import; transport verifies exact workflow/run/attempt/actor/environment approval and installed code/artifact provenance at each delivery.

- [ ] RED tests: wrong phase/path/ref/workflow/SHA/run attempt/artifact/source/approval; existing input overwrite; partial closure; source change after await; secret argv/logs; expired/reused dispatch; original recovery transport unmodified. assert production concurrency and environment, least permissions, pinned actions and empty child environment.
- [ ] Run new delivery/workflow/affected tests; expected FAIL. Implement reusing current transport's pure verification helpers, with explicit new validators; do not clone a bypass or accept synthetic proof in production.
- [ ] Run new/affected transport, closure, workflow, CI ownership and production bundle contracts sequentially; expected PASS. Commit scoped paths.

### Task 6: Return rehearsal, runbook, review and live preparation

**Files:** Create `deploy/platform/upgrade-ci.mjs`, `deploy/platform/test/upgrade-rehearsal.test.mjs`, `docs/runbooks/platform-accepted-recovery-upgrade.md`; update required CI/script ownership. Operational scripts/evidence stay in this plan's ignored workspace.

**Interfaces:** Isolated rehearsal consumes reviewed old image digests/source closure plus isolated restored DB, generated test credentials and owned networks/volumes. It returns hash-bound proof of stop/return behavior, health checks, denied egress and cleanup with explicit differences from production. Production operation package additionally binds actual retained container IDs and fresh DB schema/migration fingerprint.

- [ ] RED rehearsal test rejects public network, production DB endpoint/credentials/mounts, wrong labels/volume or reused resource names before launch; exact owned cleanup never removes shared resources. Run focused test; expected FAIL, then implement and expect PASS.
- [ ] Run one serial Docker/PG rehearsal: retained old test containers stop, then exact IDs start through return module; unchanged schema, full old config and health verified. Fault branches cannot start after migration latch. Preserve proof and inspect owned cleanup; no production claims.
- [ ] Run all new suites and affected ordinary/recovery/backup/production contracts plus lint/format/diff. Inspect full three-dot diff after fetching main. One independent whole-change review; material findings get reproducing tests, no blanket retries. Publish scoped PR, require exact-head CI then authorized merge and exact-main CI.
- [ ] Prepare concrete production inputs and independently review the exact operator package, including readonly predecessor/schema observation, capacity, key/IAM/lifecycle/OIDC checks, immutable installation, fresh backup/copy pipeline and tested return workflow. Agree maintenance window and protected prepare approval only now; provide URL and clear planned downtime/return-approval requirement.
- [ ] Follow spec prepare/copies/activate sequence. On a safe pre-migration failure or expired activation, present ready protected return URL; require its fresh approval, then verify actual old health/TLS. Do not mutate to force recovery. On success, continue catalog Task10 history/resolver/public byte/TLS/DNS gates. No new release or writer activation without its own existing acceptance.

## Self-review

Authority and durable predecessor/index: Task1. Dual configuration and exact stopped identities: Task2. Current-Timeweb backup/restore/copies inputs: Task3. Migration latch and checked return: Task4. Protected provenance and closure: Task5. Isolated availability proof, review, maintenance agreement and live gates: Task6. All five Review Focus cases have named negative tests. Existing catalog history/signing/device gates remain unchanged; no future upgrade/reset framework is included.
