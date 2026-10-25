# Post-migration forward recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method already chosen by the owner: sequential implementation in this chat; no concurrent producers, tests, CI dispatches or implementation agents.

**Goal:** Restore the selected Markiro platform on its already migrated physical database, then resume the previously approved release preparation.

**Architecture:** Add separate forward-recovery admission, guarded state/capability, backup and activation coordinators behind two new phases of the existing protected upgrade workflow. Reuse strict dump/restore, configuration, source/image, role/TLS and workload internals without relaxing existing pre-migration paths. Preserve the failed predecessor and never run migration or old-version return from the forward path.

**Tech Stack:** Node >=24, dependency-free ESM host modules and node:test, existing Docker Compose/PostgreSQL 17 ICU backup worker, protected GitHub Actions. No new dependency, application schema migration or product rebuild.

**Spec:** `docs/superpowers/specs/2026-10-25-post-migration-forward-recovery-design.md`, owner-approved 2026-10-25; SHA256 `b99facbe0a4bf455d47b49d647438da033d2c958aba2b4aaf51d3394bc17ea31`.

## Global constraints

- Worktree `/Users/thevladbog/.codex/worktrees/standalone-shift-import/q`, branch `codex/timeweb-explicit-recovery`; preserve unrelated changes, no reset.
- Failed predecessor b793db93-0e6b-4b1c-bb5e-5afc3a16230a, activate run40177697655/attempt1, state SHA256 `4d5d63263a61f00c5e118621c1cca35b767f0bbb57b01ad38831ffc6429de37c`, seq14/api-started/recovery-required/migrationEntered=true. Never rerun or relabel it.
- Product remains `6e32b3bf5970ed8793293bcc7e80aef342836e53`, protected publisher40120442037/attempt1/artifact12584215539. Executor is the eventual newly reviewed main SHA and its exact main CI; automatic publishers do not replace this product selection.
- Preserve original five authorities, all historical state/phase/worker/config trees, installed sources, image evidence, runtime descriptors, backups, encrypted copies, partials and recovery keys. No SQL rollback, restore over current data, journal patch, expiry patch or lock bypass.
- PostgreSQL ID `2f303834612d21cba2896342c69ea43fc1ef53ef7cb54d38c8653b19d0d667b3`, system7698396358009868314; observed202 migrations/schemaSHA `f33c3b37d298f2d2628fc3d26f7eb84b0d899dedb5ef7d8e4bae5185f480670b`, migrationSHA `30628183fd1478c349f5bb8435023f953fa9fad28ac409c2079c92de6e7da8b1`. Fresh observations must match; do not silently update admission baseline.
- Cleanup/fence freshness stays 30000ms. Keep producer, exact resource identity, future timestamp, byte/config/source and late-spawn checks. No automatic retry.
- New phases: `post-migration-prepare`, `post-migration-activate`; existing workflow/main/production-deploy/timeweb-platform-production concurrency, run attempt1 and independent second-account approval remain mandatory.
- Old API/edge are never explicit start/stop/rm targets. Owner allows standard Compose replacement of these two stopped app containers during the forward attempt, including later health failure. PG is never replaced; old-container return is not promised.
- Catalog writers=false, publishers empty, unproved namespaces closed. No DNS, history import, writer epoch or release publication before independent platform acceptance.
- Maintenance remains active; no duration guarantee. Do not upload recovery keys or expose raw errors, argv, stdout/stderr, config, credentials or customer values.

## Review focus

1. A complete count202 can hide a substituted migration or later schema drift: compare the entire ordered product hash/timestamp set and physical/schema baseline at protected boundaries (Tasks3–4,8–9).
2. A crash after index rename but before new ownership durability must retain the common lock; no caller may infer permission from absent index alone (Task5).
3. Long fence/probe or final cleanup observation must not silently refresh timestamps or extend validity; both last real observations must remain <=30000ms at spawn (Tasks1,9).
4. Errors with hostile getters/messages or failing diagnostic persistence must not leak secrets or produce success/permission to retry (Task2).
5. Compose can remove the stopped predecessor before candidate health fails: record its evidence first, clean only exact owned candidates and never start old IDs/replace PG (Tasks6,9,12).

## File map and fixed data layout

New host modules, each with matching `deploy/platform/test/<name>.test.mjs`:

- `host/forward-ledger.mjs`: pure product migration proof validation and read-only DB comparison.
- `host/forward-product.mjs`: inert pinned-image extraction of migration files; no container start or SQL execution.
- `host/forward-admission.mjs`: immutable failed-chain admission and fresh activation decision.
- `host/forward-state.mjs`: separate journals, target ownership handoff, opaque held capabilities and consumption.
- `host/forward-observation.mjs`: actual post-migration source/candidate identity, schema and writer checks.
- `host/forward-preparation.mjs`: fresh current-data backup/restore coordinator.
- `host/forward-activation.mjs`: forward API/edge start only.
- `host/forward-command-runtime.mjs`: trusted construction and execution adapters.
- `host/failure-diagnostic.mjs`: bounded sanitized first-failure records.

New backup factory in `backup/local-runtime.mjs`; new producer entry in `host/target-backup.mjs`. Existing pre-migration constructors keep their predicates.

For one future UUID selected only after green main:

- Inputs: `/opt/markiro-platform/upgrade-operations/<newUUID>/<post-migration-phase>/operation.json`.
- Journal: `state/forward-recovery-operations/<newUUID>/state.json`, immutable historical phase snapshots and phase consumption receipts beside it.
- Runtime/installed authority: `state/forward-backup-runtime-<newUUID>.json`, `state/forward-installed-executor-<newUUID>.json`.
- Source closure: existing `upgrade-bootstrap/<newExecutorSHA>/`; private operation evidence under `upgrade-workers/<newUUID>/`.
- Common `state/upgrade-index.json` uses strict kind `platform-forward-recovery-index`; old index is preserved under `reconciliations/failed-upgrade-<oldUUID>-to-<newUUID>/` with intent/success receipts.
- Product migration proof is private bounded data bound to the pinned image and new admission; never executable adapters or caller-selected SQL.

## Task 1: Refresh cleanup after the slow fence without changing TTL

**Files:** modify `host/prepared-target.mjs`; test `test/prepared-target.test.mjs`, `test/upgrade-activation.test.mjs`.
**Interfaces:** existing `validatePreparedTarget(input, expected)` and returned synchronous `recheckFreshness()` keep their signatures.

- [ ] Add `slow writer fence is followed by a fresh complete cleanup observation`: advance fake clock31000ms in the fence adapter; require successful validation only when a new actual cleanup measurement and the fence are both fresh. First run must fail on current code.
- [ ] Add assertions that early active/foreign restore rejects before fence invocation; a changed/future/stale second cleanup rejects; a final cleanup taking31000ms rejects the older fence; backup/attestation expiry during either observation still rejects; late spawn still rejects without journal advancement.
- [ ] Extract the existing complete cleanup binding checks into a local observer helper. Keep the first check, perform the slow fence validation, then repeat the full cleanup observation/binding checks; capture the final actual observation in the returned freshness closure. Do not replace adapter timestamps or skip any current predicate.
- [ ] Run `node --test deploy/platform/test/prepared-target.test.mjs deploy/platform/test/upgrade-activation.test.mjs` with the pinned local Node24 toolchain; require0FAIL/0SKIP. Review exact diff, then commit only these files.

## Task 2: Preserve the first safe failure category before cleanup

**Files:** create `host/failure-diagnostic.mjs`, `test/failure-diagnostic.test.mjs`; modify `host/process.mjs`, `host/upgrade-activation.mjs`, `host/upgrade-command.mjs`, `upgrade-transport.mjs`; extend their existing tests.
**Interfaces:** `sanitizeHostFailure(error, {operationId, phase, boundary, commandCategory}) -> frozenRecord`; `writeHostFailure(directory, record) -> Promise<void>`. Exact record keys: version/kind/operationId/phase/boundary/commandCategory/code/errorName/exitStatus/executable/terminationConfirmed/durabilityUncertain. Nullable numeric status/basename, allowlisted literals only.

- [ ] RED: a known canonical rejection and nonzero child retain safe phase/boundary/category/name/status/basename through wrappers; malicious getters, multiline messages, tokens, argv, stdout/stderr and env never appear in JSON or public output. Test exclusive file creation, bounded size, symlink/wrong owner denial and persistence failure.
- [ ] Implement plain own-data-property sanitization; never stringify an error/request, invoke getters or persist a raw stack. Add trusted fixed categories for validation, probe, image check, API-up, edge-up and smoke. Preserve existing error codes/flags and denied outcomes.
- [ ] Capture first failure before cleanup into create-only private `failure.json` in the consumed phase directory. Diagnostic failure must remain nonzero; retain lock on uncertain durability, and use canonical store.fail only when durability permits. Cleanup must not overwrite the first failure. Do not replay b793 to gain a better log.
- [ ] Run focused diagnostics/process/upgrade activation/transport tests serially; require secret sentinel absence and existing rejection tests unchanged. Commit explicit files after review.

## Task 3: Bind the complete current migration ledger to the pinned product

**Files:** create `host/forward-ledger.mjs`, `host/forward-product.mjs`, `test/forward-ledger.test.mjs`, `test/forward-product.test.mjs`.
**Interfaces:** `buildProductMigrationProof({productSha, imageId, imageReference, files}) -> proof`; `validateProductMigrationLedger(rows, proof) -> frozenRows`; `observeForwardMigrationLedger({postgresId, proof, runProcess}) -> evidence`; `extractProductMigrationProof({identity, root, verifySources, runProcess}) -> proof`.

- [ ] RED: exact ordered hashes/timestamps pass; missing/extra/duplicate/reordered/substituted hash or timestamp rejects despite equal count. Reject forged image/source proof, oversize, unsafe names, links and SQL bytes not named by the Drizzle journal.
- [ ] Derive proof from `/app/node_modules/@markiro/db/migrations` in the exact accepted API image, whose pinned reference/config ID are independently verified. Use a uniquely labelled inert container with network=none/read-only/cap-dropALL/no-new-privileges/log-drivernone; never start it. Read bounded tar bytes with `docker cp`, accept regular files only (16MiB total/2MiB per file), compute SHA256 from original SQL and journal timestamps; do not execute this SQL. Remove only the exact verified stopped extraction container, retaining private proof bytes; unknown cleanup blocks further work.
- [ ] Query only hash/created_at from `drizzle.__drizzle_migrations`, ordered by created_at/id, under read-only/time-limited psql. Require exact full set and order; independently bind system ID and the full observed schema/migration digest from `upgradeSchemaQuery`. Do not accept count or a supplied digest alone.
- [ ] Run the two new suites plus `upgrade-schema.test.mjs`; require0FAIL/0SKIP. Commit explicit files.

## Task 4: Authenticate the terminal failed predecessor and new admissions

**Files:** create `host/forward-admission.mjs`, `test/forward-admission.test.mjs`, `test/forward-fixture.mjs`.
**Interfaces:** `readFailedUpgradePredecessor(root, oldOperationId) -> buffers`; `validateForwardAdmission(value, {failedBytes, originalPredecessorBytes, productMigrationProof, now}) -> admission`; `validateForwardDecision(value, {priorBytes, prior, now}) -> decision`.

- [ ] RED: accept the full canonical seq14 post-migration failure chain; reject pre-migration/healthy/entered/unknown phase, mismatched prior/consumption/input/approval/physical target/schema/product/config/source, substituted product migrations, same run/UUID and expired activation decision.
- [ ] Bind failed state, before-activate, prepare/activate consumptions and original prepare/activate operations by exact bytes; validate all existing canonical structures and original five predecessor authorities. Historical expiry authenticates historical shape only. New admissions use current time, exact main CI/product provenance and distinct new dispatch attempt1.
- [ ] Use new kind `platform-upgrade-forward-recovery`, newUUID and both explicit phase names; retain migrationEntered=true. Bind baseline schema, complete product migration proof digest, old stopped container evidence, failed predecessor tree hashes, old/candidate configurations, original authority hashes and reviewed plan digest. TTL <=1h; never rewrite failed data or widen old admission enums.
- [ ] Run new admission suite and existing upgrade admission/phase suites; commit explicit files after review.

## Task 5: Guard new state and preserve the previous ownership index durably

**Files:** create `host/forward-state.mjs`, `test/forward-state.test.mjs`; modify write-entry guards in `host/state.mjs`, `host/recovery-state.mjs`, `host/recovery-activation-state.mjs`, `host/upgrade-state.mjs` with corresponding existing suites.
**Interfaces:** `withForwardPreparationState(root, admission, action, {now})`; `withForwardActivationState(root, decision, action, {now})`; `withHeldForwardState(capability, action)`; `validateForwardJournal(state, prior?)`; `forwardPhaseReceipt(decision)`.

- [ ] RED: reject forged/ordinary/legacy/expired/drained/cross-operation caps and concurrent producers; reject changed failed history/index/config/physical baseline, duplicate consumption, retry/new attempt and wrong target. Exercise every handoff crash/fsync/readback point and ensure lock retention and no subsequent action.
- [ ] Preparation graph: admitted/source-held/backup-verified, entered+completed sequence1..6. Activation graph: activation-admitted/api-started/edge-started/healthy, sequence7..14. Every state has migrationEntered=true; no migration/return phase exists. Preserve archived phase predecessors and exact canonical receipts/index pointers.
- [ ] Under existing `withHostState`/guardPersistence, verify all authority before durable handoff intent; rename only the exact old index with LinuxRENAME_NOREPLACE, fsync both parents, verify full metadata/hash, record resulting ctime and durable success. New journal/index ownership must be fully durable before exposing a capability. Any exception after intent through success/new ownership confirmation is durability-uncertain and retains the shared lock. Absent index alone never grants admission or retry.
- [ ] Recheck held authority before/after callbacks and drain async capabilities before release. Keep old per-op trees and original5 authorities at their paths unchanged. Existing legacy write-entry methods must deny a forward index instead of ignoring it; keep shared lock acquisition and read-only held authority available to the new constructor. Do not add a blanket rejection inside withHostState that would block the forward store itself.
- [ ] Run new state suite plus upgrade/ordinary/recovery state suites serially; commit scoped paths.

## Task 6: Observe the stopped migrated source and subsequent candidates

**Files:** create `host/forward-observation.mjs`, `test/forward-observation.test.mjs`; reuse current host observer primitives.
**Interfaces:** `createForwardObservers({oldOperation, candidateOperation, retainedIds, baseline, productMigrationProof, policy}, dependencies) -> {inspectSource, inspectCandidate, inspectSchema}`; each method consumes only a Task5 capability.

- [ ] RED: exact PG/volume/networks/schema/ledger plus stopped old apps pass; reject a running old/foreign app, recreated PG, unexpected migrator/probe, changed source/config/schema/ledger, whole-authority mixing and forged capabilities. After start accept only new exact candidate IDs; stopped predecessor is allowed only before its replacement stage.
- [ ] Bind actual source to the migrated PG and retained old app metadata using full old/candidate recipe selection. Reuse canonical inventory and PostgreSQL admin checks; repeat Task3 ledger verification at pre-start boundaries. Never claim old app runtime represents the new DB schema.
- [ ] Assert only postgres active for preparation; candidate API/edge become allowed stage by stage. Record retained old IDs/config/image evidence before Compose replacement; deny old-ID start/stop/rm and PG replacement.
- [ ] Run new observation and existing upgrade observation/phase/workload suites; commit explicit files.

## Task 7: Issue a separate post-migration backup capability

**Files:** modify `backup/local-runtime.mjs`, `host/target-backup.mjs`; create `test/forward-backup-runtime.test.mjs`, `test/forward-target-backup.test.mjs`.
**Interfaces:** `withForwardBackupRuntime(capability, action)` issues a private runtime token only from Task5 backup-verified entered state after canonical source-held completion; `createHeldForwardBackup(input, capability, admission, options)` reuses `produceTargetBackup` internals.

- [ ] RED: reject all foreign/fake/drained caps, wrong phase/baseline/descriptor/worker provenance, any active writer or changed schema/ledger. Assert existing `withUpgradeBackupRuntime` still rejects migrationEntered=true.
- [ ] Read only a new `forward-backup-runtime-<newUUID>.json`, bind its exact bytes and executor to new admission, preserve original/recovery/failed-upgrade descriptors and failed authority. Use post-migration observed schema/ledger, not the historical197 baseline.
- [ ] Reuse actual snapshot/dump/inventory/roles-ACL/isolated restore/10-check cleanup pipeline including catalog rows+private journal and existing document bounds. No reduced backup, reuse/relabel of b793 copy or schema restore over live data.
- [ ] Run new suites plus existing upgrade/target backup and backup catalog/runtime suites; commit scoped files.

## Task 8: Coordinate a fresh post-migration preparation

**Files:** create `host/forward-preparation.mjs`, `test/forward-preparation.test.mjs`.
**Interfaces:** `executeForwardPreparation({root, admission, configuration}, adapters, options) -> identity`; adapters are trusted executable constructors using Tasks5–7.

- [ ] RED: source drift at every boundary, pending foreign producer, wrong ledger/config and uncertain backup termination must deny progression. Verify no app start/stop/migrator/restore-over-live request can occur; verify unchanged baseline before and after backup.
- [ ] Admit new ownership, prove source-held, execute fresh backup/restore under capability, independently validate canonical proof/cleanup and persist backup-verified. No return-old path or app start in this coordinator.
- [ ] Preserve the first safe failure before canonical fail/owned cleanup. Unknown producer or durability retains lock and blocks any next phase.
- [ ] Run new preparation plus admission/state/backup suites; commit explicit files.

## Task 9: Start the accepted candidates without any migrator

**Files:** create `host/forward-activation.mjs`, `test/forward-activation.test.mjs`.
**Interfaces:** `executeForwardActivation({root, dockerConfig, decision, configuration, preparedTarget, preparedPolicy}, adapters, options) -> identity`.

- [ ] RED: prove successful trace API-up/edge-up/smoke only; reject any requested run/migrate/PG-up/old-ID action, changed migration proof/schema/PG/config/source/copies/keys/fence/projection or wrong approval. Include Task1 slow observations and late-spawn rejection. Fail after old container replacement and assert only exact owned candidates are cleanup targets.
- [ ] Require current new seq6 prepared state, fresh independently approved decision, real source hold and current backup/key/offhost proofs. Reuse strict prepared boundary and fixed canonical Compose files/environment; sample fresh observations after slower read-only checks and recheck synchronously at actual spawn.
- [ ] Verify full schema/ledger immediately before first candidate start. Normal Compose up may replace only retained stopped API/edge; never execute migrator or touch PG. Start API with health wait, then edge, verify recipes/new IDs and smoke before terminal healthy. Do not compare unchanged retained-job projection after accepted candidate writers have started; still verify it immediately before API-up.
- [ ] On failure persist first safe diagnostic; canonical failed state and exact-owned probe/candidate cleanup only when termination/durability are known. No old starts, blind retry, automatic new UUID or automatic return.
- [ ] Run forward activation/prepared boundary/upgrade activation/process suites serially; commit explicit files.

## Task 10: Load and construct only trusted forward recovery runtime

**Files:** create `host/forward-command-runtime.mjs`, `test/forward-command.test.mjs`; modify `host/upgrade-command.mjs`; update `test/upgrade-source-closure.test.mjs` and applicable loader fixtures.
**Interfaces:** `validateForwardOperation(loaded, options) -> verifyAuthority`; `executeForwardOperation(loaded, options)`; existing loader routes only strict new kind `platform-forward-recovery-host-operation` with the two new phases.

- [ ] RED: undeclared/changed/omitted closure file, forged kind/phase, JSON callback/ambient override, moved/changed historical source, expired decision and bad target/product fail before executable imports. Historical old bundles remain authenticated by their own executors; never reinterpret them as the new closure.
- [ ] Add every new transitively imported host/backup module to current `UPGRADE_BUNDLE_FILES` and closure fixtures. Validate strict new record keys/source receipt before importing Task10 runtime; construct Tasks3–9 adapters locally, never from JSON. Preserve existing operation kinds and their pre-migration predicates.
- [ ] Bind new runtime/config/proof bytes and all original/failed authority on every protected child boundary; ensure exact product registry config IDs/digests and current PG identity. No historic runtime source replacement.
- [ ] Run forward command, upgrade command/source closure and ordinary/recovery loader tests; commit scoped files.

## Task 11: Deliver both phases through existing protected workflow

**Files:** modify `.github/workflows/upgrade-platform.yml`, `upgrade-transport.mjs`, `upgrade-dispatch.mjs`; extend `test/upgrade-transport.test.mjs`, `test/upgrade-dispatch.test.mjs` and source-closure fixtures.
**Interfaces:** existing workflow inputs/dispatch authorization stay; strict phase registry maps post-migration-prepare/activate to Task10 loader and safe outcome strings. No alternate workflow or unprotected endpoint.

- [ ] RED: invalid kind/phase pairing, rerun attempt, self approval, wrong main executor/CI, product/tooling confusion, incomplete/expired artifact, missing/new marker and duplicate delivery deny. A failed post-migration input can never fall through to legacy activate/return.
- [ ] Extend phase registry in receive/execute/host-command/expected output checks consistently. Preserve private stdin credential transport, independently installed byte closure, durable delivery/fence/command-started once-only markers, existing concurrency/environment and exact independent authorization.
- [ ] Run dispatch/transport/loader suites and workflow contract tests; commit explicit files. Do not dispatch a production run yet.

## Task 12: Rehearse actual post-migration forward recovery in isolation

**Files:** create `forward-ci.mjs`, `test/forward-rehearsal.test.mjs`; reuse `upgrade-ci-guards.mjs` isolation/ownership primitives without weakening existing old-return rehearsal.
**Interfaces:** `rehearseForwardRecovery(args, {writeResult, ...trustedLocalDependencies}) -> safeEvidence`; CLI `node deploy/platform/forward-ci.mjs --local-ci`.

- [ ] RED contract tests: reject external route/network/host socket/shared mount/foreign daemon volume or cleanup ID; diagnostic/private artifacts cannot enter safe evidence. Trusted failure injection exists only as a local test dependency, never in production envelopes.
- [ ] In a fresh uniquely labelled DIND namespace with generated data/credentials, stage required images, detach the staging network and prove no IPv4/IPv6 default route and denied real TCP egress before apps. Apply actual candidate migrations once, inject failure before API-up, preserve failed journal and verify DB ledger/schema. Execute the new preparation with real dump/isolated restore/cleanup and new forward activation on that same isolated PG. Prove no second migrator and no old app start. Exercise failure after replacement and owned cleanup too.
- [ ] Emit only safe stage/category/image/source/container/schema/ledger/check/cleanup evidence; synthetic approvals are labelled and never count as production authorization. Owned outer container/volume cleanup must pass; unknown cleanup leaves failure and preserved private diagnostics.
- [ ] Run focused rehearsal tests, then one serial full isolated rehearsal where local prerequisites exist. If unavailable, state it explicitly and require the actual CI job before merge; no fake PASS or reduced replacement. Commit scoped files.

## Task 13: Required CI ownership, runbook and exact whole-branch review

**Files:** modify `.github/workflows/ci.yml`, `docs/runbooks/platform-accepted-recovery-upgrade.md`; create `docs/runbooks/platform-post-migration-forward-recovery.md`; modify `tools/ci/affected.mjs` and its tests only if current deploy/platform rules do not already select all needed jobs.

- [ ] Add a required serial production-bundle forward rehearsal after the existing return rehearsal, with unique private root/owned namespace and create-only safe evidence artifact. Keep all existing checks and evidence; no uploaded private roots/config/DB/keys.
- [ ] Pin tests that every new production module/workflow change selects both platform-contracts and production-bundle. Verify source/worker artifact generation includes exact new closure. Document fresh operator inputs, old-ID replacement, current ledger vs old backup distinction, no return/retry after latch and independent release acceptance gates.
- [ ] Run focused tests during iteration; final once: `env -u COMPOSE_PROJECT_NAME node --test deploy/platform/test/*.test.mjs`, `pnpm test:production-bundle:contract`, scoped eslint/prettier and `git diff --check`. Record actual pass/fail/skip counts and external prerequisites; no production environment in tests.
- [ ] Review full three-dot diff against freshly fetched origin/main, source closure and denial cases independently. No concurrent implementation/review producers. Preserve unrelated work and current branch; if main moved, non-reset merge and relevant revalidation.
- [ ] Commit explicit paths; push scoped branch and create/update one PR. Verify exact-head required CI/CodeQL/security/review, then authorized merge. Verify exact new main CI+CodeQL and actual forward-rehearsal evidence. No duplicate runs or replacing the accepted product publisher.

## Task 14: Prepare a fresh operational package after green main

**Files:** create-only private operation package under `/tmp/markiro-release-preparation-20261024`; append the existing operations progress journal. No production phase execution until its own approval.

- [ ] Fresh read-only observation: exact failed full chain/metadata, original authority, PG/system/schema/full product ledger, source/config/images, stopped app IDs, no other container/DB writers/process/workflow and capacity. Compare with approved baseline; a mismatch stops packaging. Choose one new UUID once; do not precreate its state journal directory.
- [ ] Verify exact main source closure/ICU worker artifact/Git recipe+bases; install side by side and load only the verified worker. Derive product migrations from the already accepted pinned API image through Task3. Independently review/hash-bind installation, new descriptor/config/source/admission, ownership handoff and copy operators before execution. Preserve all old runtimes/bootstrap/config/copies/partials.
- [ ] Prepare full immutable input for a single new post-migration-prepare run using current approved baseline/plan digest. At dispatch immediately provide URL with approval withheld; provision immutable input, inspect canonical loader/source/approval boundary and separately read back exact bytes/expiry while GH waiting. Ownership handoff itself occurs only within the approved canonical prepare execution under the shared lock.
- [ ] Request distinct second-account approval only after ready. Observe exact run once. On success independently verify fresh actual backup/10 restore checks/cleanup/current state, then fresh encrypted Mac and Timeweb unique children with authenticated full decrypt/hash and exact VersionId/full GET/ACL/versioning checks. No key upload/overwrite/relabel/retry.

## Task 15: Activate and accept the platform, then resume release gates

- [ ] With fresh accepted backup/copies, repeat actual key probe, canonical PG/TLS/roles/full product-ledger checks, retained-intent projection and source hold; prepare independent immutable activation admission with enough remaining lifetime. Review/hash-bind operator package and approved independent readback before dispatch.
- [ ] Dispatch exactly one post-migration-activate attempt1, provide URL immediately while withholding approval, provision and verify inputs/loader/exact waiting state, then request the second account. No stale input patch, self/admin bypass or automatic redispatch.
- [ ] After success independently verify actual new terminal healthy state, full predecessor chain/source/schema/ledger/consumptions, same physical PG, exact new API/edge IDs/images/config/network/roles and strict external TLS/admin/API checks against both intended IP and DNS. Only then mark maintenance closed.
- [ ] On failure preserve first private diagnostic, current journal/index/lock, process/daemon outcome and exact candidate state. No return, SQL rollback, journal/index patch, blind retry or competing cleanup. Further recovery needs a separately reviewed terminal predecessor.
- [ ] Resume the original release-hosting runbooks: releases DNS/TLS/read-only resolver, full history import/reservations with real protected authorization/fence, pinned readback/technical byte-swap, then separately approved writer epochs/publications. Preserve original Autonom1.0.0;1.1.0 candidate is not published/signed by CI alone. Station/handheld real-device acceptance remains separate.

## Plan self-review and execution boundary

The five Review Focus cases map to explicit failing tests above. All design requirements map to Tasks1–15; existing pre-migration paths are not relaxed. Implementation choices made here: separate journal/capability/kinds; ordinary fixed project replacement instead of a second app project; migration proof from the exact inert product image; fixed bounded diagnostic schema; existing protected workflow/concurrency reused. No new production UUID/run/action or implementation code is created by writing this plan.

Owner execution method is preserved: implement serially in this chat using executing-plans, with independent required reviews. Await owner confirmation that this concrete plan captures the approved design before implementation, as required by writing-plans execution handoff. Actual new phase approvals remain separate after code/rehearsal/CI and immutable inputs are ready.
