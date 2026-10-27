# Expired Forward Activation Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execution is native and serial in the existing worktree; use only the existing reviewer for read-only gates.

**Goal:** Continue the approved release from the exact expired sequence10 activation without replaying migration or weakening authority.

**Architecture:** A separate `platform-forward-activation-successor` admission binds the failed activation, its exact sequence2 predecessor and original chain. Existing forward prepare/activate phases, lock and durable index handoff remain the execution boundary. Private operator reconciliation preserves the lock and removes only the exact exited owned probe before fresh protected preparation.

**Tech Stack:** Existing Node24 ESM host modules, Python one-shot operator helpers, Docker/PostgreSQL, protected GitHub workflows. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-expired-forward-activation-successor-design.md`; owner-approved private design and actual failure packet remain in the existing preparation package.

## Global Constraints

- Same `codex/timeweb-explicit-recovery` worktree; preserve unrelated work and all historical journals/configuration/copies.
- Exactly two preceding forward operations, then the existing original chain; no implicit widening of sequence2 formats.
- No migration, old-version return, consumed-operation replay, journal patch, lock bypass or expiry extension.
- Old API/edge must remain the exact stopped pre-run containers; same healthy PostgreSQL/system/schema202/ledger.
- Preserve recorded termination uncertainty and separately prove current process absence.
- New normal-lock prepare, actual backup/restore/cleanup, new encrypted copies, fresh activation and independent protected approval.
- No concurrent operations/tests/CI; no new agents. Full-byte checks, freshness, diagnostics and call ordering remain.

## Review Focus

1. Expired but historically valid decision: distinguish historical proof from new execution authority, and refuse all other failure phases/causes.
2. Swapped chain/index/consumption/receipt or additional generation: reject before mutation; preserve original inode/mtime and record rename ctime.
3. PID/container identity reuse or uncertain cleanup: require fresh absence and exact owned exited probe; never remove by name or force.
4. Crash between intent/rename/success: preserve artifacts, keep ownership fail-closed, and never restore an older index.
5. Passing memory tests or fast partial rehearsal: do not infer a safe activation duration; verify the complete202-entry path plus provisioning/approval margin.

---

### Task 1: Bound retained private-file memory

**Files:** Modify `deploy/platform/host/files.mjs`; test `deploy/platform/test/backup-document-capacity.test.mjs` and `host-config.test.mjs`.

**Interfaces:** Preserve `readPrivateFile(root,relativePath,options={}) -> Promise<Buffer>`, caps1/2MiB and safe error behavior. Allocate from checked file size and grow only to cap+1.

- [x] Add a failing32x1KiB retained-buffer budget test; confirm old code retains33554464B and fails.
- [x] Implement bounded zeroed allocation; preserve open flags, private metadata checks before/after, read completion and closing.
- [x] Exercise under-cap and over-cap growth between initial metadata and first read;32focused checks PASS, no skips.
- [x] Compare1000actual8KiB reads against exact main: allocation1048577000→8193000B; retain CPU/wall results without claiming the full production cause.
- [x] Finish the single active serial platform gate, then production bundle contracts, scoped lint/format/diff and review. Commit only explicit reviewed paths.

### Task 2: Exact failed-activation reader and admission

**Files:** Create `deploy/platform/host/forward-activation-successor-admission.mjs`, `deploy/platform/host/forward-activation-reconciliation.mjs`, `deploy/platform/test/forward-activation-successor-fixture.mjs`, `deploy/platform/test/forward-activation-successor-admission.test.mjs`.

**Interfaces:** Export `failedActivationNames`; `readFailedForwardActivationPredecessor(root,operationId,options={}) -> Promise<FrozenByteRecords>` with the existing explicit successor-index-archive option; `validateForwardActivationSuccessorAdmission(input,{failedActivationBytes,failedForwardBytes,failedUpgradeBytes,originalPredecessorBytes,productMigrationProof,now}) -> admission`. Mint nonserializable reader observations; JSON claims alone cannot satisfy them. Bind lock-preservation/probe-cleanup receipts and the exact older genuine reader object.

- [x] Write RED cases: exact canonical sequence10 expired activation with original sequence6; fake reader, changed before/consumption/envelope/dispatch/failure/history/source/receipt, wrong phase/cause, extra generation, running/replaced app, unretired lock and unconfirmed probe cleanup.
- [x] Implement the separate discriminant and full exact-directory/hash/metadata/identity bindings. Validate prior admission with its existing canonical validator and genuine product proof at its historical clock; never treat it as live authority.
- [x] Run only the new admission suite plus existing successor admission suite; require PASS and original rejection semantics unchanged. Review/commit the deliverable.

### Task 3: Typed history, ownership and compiled runtime

**Files:** Modify `deploy/platform/host/forward-history.mjs`, `forward-state.mjs`, `forward-index-handoff.py`, `forward-command-runtime.mjs`, `forward-admission.mjs`, `upgrade-command.mjs`, `deploy/platform/backup/local-runtime.mjs`; create state/command tests beside the new fixture. Update existing source-closure contract fixtures only where required.

**Interfaces:** `forwardImmediatePredecessor` returns the new admission's `priorActivation`; `readForwardHistory` adds `failedForwardActivation` only for this discriminant and retains the exact genuine older `failedForward`. Runtime authenticates recovery, failed-upgrade, prior-forward and failed-activation installed closures. Bundle membership includes the new source module. Existing protected phase names remain unchanged.

- [x] Write RED state/command cases proving exact current-index handoff, canonical newseq6 after real backup, same PostgreSQL/schema, unchanged old journals and no migration path.
- [x] Add controlled intent/rename/success failures and altered metadata/index/extra files; require preserved artifacts and refusal before app commands.
- [x] Implement exhaustive type selection in journal/decision/history/runtime and Python handoff without broadening old formats. Every historical byte must still be re-read and compared at its existing boundary.
- [x] Run new state/command suites and existing forward/successor state/command/observation/backup suites serially; review/commit.

### Task 4: Genuine rehearsal and duration evidence

**Files:** Modify `deploy/platform/forward-ci.mjs`, `deploy/platform/upgrade-ci.mjs`, `deploy/platform/test/forward-rehearsal.test.mjs`, affected CI contract tests and `docs/runbooks/platform-post-migration-forward-recovery.md`.

**Interfaces:** Existing forward native evidence includes the new exact-chain happy and controlled-failure outcomes, full202-entry product proof, cleanup and bounded stage/call-count timings. Evidence remains `productionAdmission:false`.

- [ ] Add RED ownership/evidence assertions: new module/fixtures are shipped; missing either outcome, altered historical Git source, skipped cleanup or incomplete duration budget cannot pass.
- [ ] Seed prior failure through genuine historical9c compiled modules in isolated CI; use any injected clock only as clearly labeled CI fault injection. Bind exact chain and actual SQL bytes; do not mock the predecessor reader or product proof.
- [ ] Measure complete stages and repeated verification counts. Reproduce any remaining dominant cost before optimizing deterministic work; preserve physical freshness checks, errors, diagnostics and call ordering.
- [ ] Run all platform/production contracts, formatting/lint/diff; whole-branch review; inspect complete three-dot diff, publish one scoped PR and require exact-head then merged-main CI/native/artifact evidence.

### Task 5: Reviewed private operations and actual release

**Files:** Only new one-shot scripts/receipts in the existing ignored preparation package and operations journal. Do not edit/replay old scripts or overwrite backups.

**Interfaces:** Fresh concrete packages bind new main/worker/product/source closure, actual failed state/consumption/index/lock/probe and new waiting protected run. New immutable admission binds actual durable preservation and cleanup receipts before READY.

- [ ] Refresh exact current observation, all provenance and worker absence; prepare one-shot lock-preserving/exact-probe cleanup scripts and independent read-only review with SHA receipts.
- [ ] Install verified source/worker side by side, dispatch once and immediately give URL with approval withheld; reconcile under fresh waiting-run/physical guards, provision once, loader/readback READY, then request second-account approval.
- [ ] Require actual new backup/isolated restore/cleanup, independent canonical evidence, unique encrypted Mac/Timeweb copies and fresh activation proof. Prove the complete timing budget including provisioning/queue/approval before dispatch/request.
- [ ] Activate separately after READY approval; exact log/physical diagnostic on failure, no blind retry. On success independently accept actual healthy containers/journal/schema and strict external TLS/admin/API/new landing.
- [ ] Continue already authorized release DNS/catalog/Autonom1.1 publication, full public hashes/signatures and later Yandex retirement. Keep Windows/device/printer acceptance explicitly unrun until exercised.

## Self-review

Spec requirements map to Tasks1–5; each Review Focus case has an explicit owning test in Tasks2–4. Old formats and clocks remain separate from the new discriminant. New predecessor reader observations are genuine capabilities, not serialized flags; receipts and physical conditions are rechecked before mutation. Timings and memory improvement are evidence categories rather than deployment acceptance. The owner already selected native serial execution and explicitly authorized implementation of this design.
