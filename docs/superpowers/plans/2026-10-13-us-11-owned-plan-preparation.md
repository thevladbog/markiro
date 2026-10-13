# US-11 guarded owned Plan preparation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Create and resume exactly one service-owned synthetic Plan with its
actual immutable PDF, without treating draft preparation as completion.

**Architecture:** A guarded journal transaction captures a missing intent and
service-created draft together. A Plan adapter then uses the existing approval
service and verifies live published evidence/private bytes before its final
receipt. Verify and completed replay do not write.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-owned-plan-preparation-design.md`.

## Global constraints

- Existing isolated US worktree; separate implementer and independent review.
- Accept the Plan draft native seam first. Full dataset integration waits for
  actual green Trace/Readiness CI, not merely source review or a queued job.
- Do not change immutable recipe/manifest, stage sequences, schemas, public
  HTTP/UI, dependencies, release workflows or existing assertions/timeouts.
- Draft/audit/pending intent commit together; pending is not completed.
- Provider I/O must not occur while a journal transaction/tenant lock is held.
- Stable original identity on resume; no unowned adoption, reset or silent repair.
- Only actual owned US test children with DATABASE_URL unset, normal disposal
  and absence proof. No shared-base/environment/process cleanup.
- Implementers do not commit, push, dispatch nested agents or edit public
  progress claims before review. Reports distinguish source from runtime proof.

### Task 1: Guarded atomic intent preparation

**Files:**

- Modify `apps/api/src/modules/traceability/demo/us-dataset-journal.ts` minimally.
- Extend `us-dataset-atomic-stage-contract.ts` with a trusted preparation callback.
- Create `apps/api/test/us-dataset-prepared-intent.e2e.test.ts`.

Expose the internal `prepareStageIntent(context, datasetId, address, prepare)`
operation. Address contains `unitKey`, `stage`, `operationKey`; `prepare` receives
the guarded native transaction and checked context and returns an intent. The
journal owns the transaction and validates returned address/key/body/digest.

- [ ] Native RED for the missing method using real service-created Plan draft.
- [ ] Guard actual target/original owner, mutation advisory lock, exact dataset
      header and unit eligibility before any preparation callback. Hold header
      and addressed-stage locks; preserve existing lock order.
- [ ] An existing addressed stage returns its original parsed identity without
      calling preparation. Check collisions before any missing-stage callback.
      Reuse existing capture/collision/predecessor/insertion/parser logic.
- [ ] Native tests assert exact draft/audit/pending-intent commit, rollback of
      all three on forced SQL failure and invalid returned intent, one-winner
      concurrency, collision/target/owner/eligibility denials before callbacks,
      completed and pending replay with no creation or writes.
- [ ] Run unchanged dataset journal and relevant Plan transaction tests, API
      typecheck/lint/build and formatting/diff checks. Report RED/GREEN counts,
      skips and normal child cleanup, then independent review.

### Task 2: Service-owned Plan stage and immutable PDF verification

**Files:**

- Create focused modules under `apps/api/src/modules/traceability/demo/` for
  Plan content/contract and `UsDatasetPlanSeedStore` orchestration/verification.
- Create `apps/api/test/us-dataset-plan-seed.e2e.test.ts` and narrowly scoped
  fixture support only if existing real Plan/provider fixtures cannot suffice.
- Append truthful evidence to the two existing US progress documents after
  independent review.

Expose `UsDatasetPlanSeedStore(db, artifacts).initialize(context)` and
`.verify(context)`, returning a bounded deeply frozen result with dataset identity,
state `plan_verified`, `datasetComplete:false`, exact Plan identity, approved
evidence digest and immutable artifact descriptor.

- [ ] Read current owned references through the real reference verifier. Define
      a bounded separately versioned `us-six-month-plan-v1` English synthetic
      section descriptor using existing validators; no manifest mutation.
- [ ] Native RED: a meaningful missing-stage failure, not environment failure.
- [ ] Use Task1 preparation to create draft/audit/intent together through the
      Plan seam. Capture exact reference digest, content, generated draft
      identity/revision/creator and stable approval key. Check unowned Plan
      absence under the organization lock before creation. No Plan SQL writes.
- [ ] Pending recovery branches draft versus already-effective owned version;
      never parse the published recovery case as a draft. Reject unowned
      versions, supersession, content/revision/identity drift and mismatched
      approval. Read exact scoped persisted creator/status/key/request hashes
      inside the guarded dataset transaction and compare domain hashes of the
      captured request/key, plus creator/approver independently. Do not rely on
      the public projection or lifecycle-masking retry response alone.
- [ ] Approve through the real service, with actual timestamp, original key and
      synthetic confirmations; no provider I/O inside journal transactions.
- [ ] Validate live effective published Plan/evidence/ownership and actual bytes
      with `readVerified`, then record the exact completed receipt. No public
      audited download calls or historical re-rendering in verification.
- [ ] Actual native/provider-boundary tests: stable synthetic PDF/audit; SQL
      interruption before/after preparation and after publication before receipt;
      original-key resume preserving IDs/time/bytes; unowned and tenant/role/owner
      denial; exact content/key/evidence/artifact drift, nonempty stored key and
      request-hash replacement, same-key other-actor approval and supersession;
      provider faults;
      completed replay/verify full-table hashes and no provider writes.
- [ ] Run relevant existing Plan/journal tests, API typecheck/lint/build and
      formatting/diff checks, normal child cleanup, separate review and final
      most-capable source review. Do not claim full dataset or hosted acceptance.
