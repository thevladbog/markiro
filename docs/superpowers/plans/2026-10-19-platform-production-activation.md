# First Platform Production Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit the explicitly approved first production startup without falsifying isolated-rehearsal facts.

**Architecture:** Keep prepared-target v1 unchanged and add strict v2 production authorization. Reuse existing host contexts, physical observers and backup proofs; add a finite read-only retained-intent projection before first API startup. Preserve the 32-file executor bundle and published product image.

**Tech Stack:** Node 24, native PostgreSQL 17 SQL, existing host process/files/state helpers; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-platform-production-activation-design.md`.

## Global Constraints

- Local branch only; no server/source/GitHub mutation, commit or push before root review.
- V1 isolation remains unchanged; v2 is first activation only, legacy queues disabled.
- Real source-off is an identified operator attestation with bound fresh evidence, never fabricated measurement or target SSH callback.
- Fixed review asOf, finite counts/hashes, no tenant payload output; optional missing/present-empty job tables equivalent.
- Existing backup/TLS/role/configuration/fence/cleanup checks remain mandatory; no new runtime flags/image or executor bundle entries.

## Review Focus

1. Missing/unknown mode must not enable production in old records.
2. Cross-operation/backup/review/source evidence must fail before API.
3. An expiry crossed during async observation must still stop API.
4. New empty pg-boss tables and elapsed wall time must not invalidate a fixed review, while existing jobs remain visible.
5. Post-start normal workers may mutate reviewed queues; no prior-healthy bypass or edge startup on failure.

### Task 1: Strict production authorization and finite review

**Files:** modify `deploy/platform/host/prepared-target.mjs`; test `deploy/platform/test/prepared-target.test.mjs` and a focused activation fixture/test file.

**Interfaces:** export strict production review/authorization validation helpers from the existing prepared-target module. Version 2 retains all common identity/snapshot/fence checks and requires live-source. Review contains exact operation/target/executor/configuration/fence/snapshot/archive/restore identities, fixed asOf/observedAt and finite projection. Validate bounded source-held operator evidence and authorization expiry again after asynchronous observations.

- [x] Write v2 happy and binding/mode/expiry negatives; observe RED against v1-only implementation.
- [x] Add minimal strict version 2 branch, retaining v1 acceptance unchanged.
- [x] Run `node --test deploy/platform/test/prepared-target.test.mjs deploy/platform/test/production-activation.test.mjs`; expected all pass.

### Task 2: Measure projection and gate first API command

**Files:** modify `deploy/platform/host/command.mjs`, `deploy/platform/host/deploy.mjs` only for the prior-healthy guard; test host command integration/fixtures and focused projection tests. Keep HOST_BUNDLE_FILES unchanged.

**Interfaces:** fixed read-only SQL projection from peer-authenticated PostgreSQL; output only six finite table summaries with counts/hash/pending/expired. Optional job table existence is inspected before selecting it. Read the reviewed fixed asOf; API diagnostics cutoff uses UTC month subtraction. Existing inspectTarget context triggers equality checks only on api-started entry/command before API starts.

- [x] Add failing integration tests proving changed review/expiry blocks API and edge; unchanged review completes and post-start mutation is accepted.
- [x] Implement finite measurement in existing command module and first-activation-only guard.
- [x] Exercise real-shaped SQL responses including missing/present-empty/nonempty pg-boss and fixed asOf; reject malformed/oversized responses.
- [x] Run focused host/activation tests, then `node --test deploy/platform/test/*.test.mjs`; expected all pass.

### Task 3: Operational interface and review

**Files:** update `docs/runbooks/timeweb-platform-preparation.md` and this plan; preserve actual private PG candidate separately.

- [x] Document exact measured and operator-attested inputs, activation expiry/protected-approval timing, first-start-only projection and final-source-held responsibility.
- [x] Run production bundle contracts, scoped formatting and `git diff --check`; expected pass.
- [x] Root independently reviews complete branch and applicable tests. No commit/push until that review.

Progress: spec/plan saved before code. Execution method and design already approved by root; no further permission pause. Root owns final independent review. Commit steps deliberately deferred under explicit root instruction.

Verification so far: Task 1 RED->GREEN, old/new validator 62 tests pass. Changed-intent integration reproduced actual API-start RED before gate, then PASS with API/edge absent. Successful production integration passed with deliberate post-start queue mutation. Prior-healthy regression RED->GREEN. Root independently executed the actual SQL on disposable exact AMD64 PG 17 image 79bd7c99... with network none/tmpfs/no ports/512 MiB: empty digest parity, optional missing/present-empty, fixed-asOf repeat, existing/pending jobs, retention counts and state-change hash all pass; owned container removal/absence verified, no persistent volume. This is native local SQL proof, not production acceptance.

Final verification: frozen candidate passed all 540 platform tests (0 failures/skips), all 592 production bundle contracts (0 failures/skips), scoped ESLint/Prettier and diff-check. Independent review found and fixed expiry crossing the final asynchronous configuration check; the behavioral regression now prevents API startup. Root reviewed the complete runtime diff and final evidence before publication. Server activation and real final backup/restore remain separate pending gates.
