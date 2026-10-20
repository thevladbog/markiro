# US-11 Dataset Request Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Create and verify the three fixed dataset Request packages through the real durable worker and the existing owned Plan.

**Architecture:** A caller-owned native Prepare seam makes queued-run creation atomic with dataset identity. Closed dataset adapters verify prescribed native sources, persist bounded intents, invoke the exact-run worker and verify actual private publication. An artifact-only coordinator composes Plan and Requests without declaring the entire demo complete.

**Tech Stack:** Strict TypeScript, NestJS, Drizzle/PostgreSQL, Zod, Vitest, existing native Plan/Request services, private conditional storage fixtures and Node CI ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-20-us-11-dataset-request-packages-design.md`

## Local execution checkpoint — 2026-10-20

Task 1 is implemented and independently approved for spec compliance and quality,
with no findings. Its native PostgreSQL checks pass 41/41 (17 new transaction
cases and 24 unchanged Prepare regressions), with zero skips. Ownership checks
pass 10/10, including 467 owner and 504 fixture mutations. API typecheck, lint,
build and focused formatting/diff checks pass. Four exact new-suite child
databases were normally disposed and independently verified absent. The existing
Vite config warning remains visible.

Task 2's actual native run exposed the frozen Transformation V1 KDE gap; it is
preserved but blocked, not GREEN. Prerequisite Tasks 4–6 below execute before
resuming Task 2, then Task 3. The final ordinary API invocation and new-source
GitHub acceptance are still pending. This checkpoint proves neither a generated
dataset Request package nor full demo completion. Detailed recovery evidence is
in the ignored plan ledger.

Prerequisite Task 4 is independently Approved: domain 1,442 and contracts 1,028
tests pass without skips; both package gates and API/admin typechecks pass.
Task 5 is independently Approved: 190 native checks and 193 tooling tests pass
without skips; DB typecheck/lint/build and formatting pass. The additive 0145
checks strict V2 facts while preserving V1 guards/history. Native API emission
and downstream readers (Task 6), then actual Request packages (Tasks 2/3), remain
unaccepted. No CI or Ready acceptance is inferred from the SQL-only gate.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve unrelated `docs/us/demo-hosting-options.md`.
- Keep `us-processor-six-month-v1`, its definition digest, 500 selected revision / 16 MiB native snapshot / 256 KiB journal bounds unchanged.
- Preserve every existing assertion, timeout, phase budget, worker lease/retry policy and release lock. No blind retry, timer increase, fake Ready, fabricated frozen facts or truncation.
- No schema/migration changes except the explicitly specified Transformation V2 contract and additive `0145_us_transformation_structured_snapshot.sql` prerequisite in Tasks 4–6. No public route/request/UI, global worker sweep, production clock rewrite, RU/main/Station, PR, release, deployment, provider/dependency policy or environment-file changes.
- Use actual native services, trusted synthetic owner, exact source closure and the one owned synthetic Plan. No caller-supplied source proof, IDs, Ready callback or adoption by business name.
- Request receipt time is captured once at actual creation; preserve its native 24-hour deadline on every resume. Completed initialize/verify must make zero DB/provider writes.
- Root owns commits/push after independent review. Implementers do not stage, commit, push or dispatch agents. Both commit author and committer must be Vlad Bogatyrev <47273232+thevladbog@users.noreply.github.com> via per-commit environment, verified afterward.
- Native tests use only `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`, with `DATABASE_URL` unset, normal owned-child drain/drop/catalog-absence proof. Never stop unknown processes or delete unknown DBs.
- Use `PATH=/opt/homebrew/opt/node@24/bin:$PATH` and Corepack pnpm. Build shared API dependencies before consumers; no installation or mutable output sharing.
- Iterate with focused tests. The controller runs one final ordinary full API suite, not one broad run per task. Existing complete Trace/Readiness and Cases acceptance remains a distinct exact-SHA CI gate.

## Review Focus

- A same-tenant unowned lot with the same TLC must not enter a supposedly owned package; compare exact native selected identities and revisions, not just counts.
- A committed run with a lost reply must remain owned and resume without another run, deadline renewal or unrelated queue claim.
- A revoked original owner, changed source revision or changed effective Plan must fail before work can be adopted or repaired.
- Missing/corrupt private artifact bytes after Ready must fail completed replay without PUT, DELETE or DB repair.
- A live concurrent initializer or worker contender must not cause a duplicate Request/run or a falsely completed receipt.

## File boundaries

Keep native Prepare in its existing module. Dataset contract contains only strict
bounded value parsing; selection module owns native source/snapshot binding;
verification module owns actual Request/run/publication and private byte checks;
seed module orchestrates the two journal stages and exact worker; the small
artifact coordinator composes Plan and recipe Request units. Test-only fault and
storage helpers remain under `test/support`.

---

### Task 1: Caller-owned native Prepare transaction

**Files:**

- Modify `apps/api/src/modules/traceability/requests/us-request-prepare.ts`.
- Create `apps/api/test/us-request-prepare-transaction.e2e.test.ts`.
- Modify `.github/workflows/us-development.yml`, `tools/us-development/test/support/prepared-services-owner.mjs` and `tools/us-development/test/dataset-prepared-services-ownership.test.mjs` only for additive exact ownership of this new native filename.

**Interfaces:**

```ts
UsRequestPrepareStore.prepareCommandInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  requestId: string,
  input: unknown,
  build: UsExportBuildIdentity,
  httpRequestId: string | null = null,
): Promise<typeof schema.traceExportRuns.$inferSelect>;
```

Consume the existing strict `usRequestPrepareHttpBodySchema` and shared private
`prepareWithinTransaction` body with expected-revision/digest checking enabled.
Do not open a transaction or run rejection auditing outside the caller's boundary.
Existing public `prepare` and `prepareHttp` keep their behavior unchanged.

- [x] Read this task, Global Constraints, the spec's atomic-run section, current Prepare body, `us-request-create-transaction.e2e.test.ts`, ordinary Prepare tests and native fixture helpers. Read applicable AGENTS including `/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md` (the US worktree has no nearer API guide).
- [x] Build shared API dependencies using `corepack pnpm turbo build --filter '@markiro/api^...'`; record success and correct Node/pnpm before native checks.
- [x] Write a real disposable-PG test calling the new seam inside a caller transaction, then throwing. Assert no native run or prepared success audit persists; Request validation remains unchanged. First RED must be the missing method, not infrastructure failure.
- [x] Implement the narrow public seam delegating to the existing body. Keep fresh authorization, locking, current source/Plan capture, all bounds, validation-digest checks, evidence-checked replay and exact audit.
- [x] Add commit/replay, strict extra-key/malformed input, stale revision/digest, cross-tenant and revoked-role denial. Verify exact prepared/replay audit actor/tenant/target/request metadata, transaction rollback including a companion caller write and no leaked standalone rejection audit. Use existing actual Prepare source fixtures; do not fabricate Ready.
- [x] Add the one new filename to the prepared-services owner/helper/independent pins, preserving older mutation checks and all budgets. Behavioral ownership tests must reject omission and duplicates.
- [x] Run focused native and existing Prepare regressions (single worker), the ownership Node test, API typecheck/lint/build, focused Prettier and diff check. Record actual counts/skips, RED/GREEN, owned DB disposal and any failures.
- [x] Self-review, leave source unstaged and write the report. Root supplies the independent review; no nested agents or commits.

### Task 2: Owned Request/run adapter with real publication

**Files:**

- Create `apps/api/src/modules/traceability/demo/us-dataset-request-contract.ts`.
- Create `apps/api/src/modules/traceability/demo/us-dataset-request-selection.ts`.
- Create `apps/api/src/modules/traceability/demo/us-dataset-request-verify.ts`.
- Create `apps/api/src/modules/traceability/demo/us-dataset-request-seed.ts`.
- Create `apps/api/test/us-dataset-request-seed.e2e.test.ts` and `apps/api/test/support/us-dataset-request-fixture.ts`.
- Modify the same three prepared-services CI ownership files only to add this native filename.

**Interfaces:**

```ts
type UsDatasetRequestUnitKey = "request_scenario_a" | "request_april" | "request_september";
type UsDatasetRequestServices = Readonly<{
  planArtifacts: UsPlanArtifactStore;
  packageArtifacts: UsRequestPackageArtifactStore;
  execution: UsRequestWorkerExecutionIdentity;
}>;
class UsDatasetRequestSeedStore {
  constructor(db: Db, services: UsDatasetRequestServices);
  initialize(
    context: UsDatasetContext,
    unitKey: UsDatasetRequestUnitKey,
  ): Promise<UsDatasetRequestResult>;
  verify(
    context: UsDatasetContext,
    unitKey: UsDatasetRequestUnitKey,
  ): Promise<UsDatasetRequestResult>;
}
```

Export these types from the contract/seed modules. `UsDatasetRequestResult` is a
strict immutable bounded result: dataset/version/definitionDigest/unit identity,
state `request_package_verified`, `datasetComplete: false`, actual Request ID,
revision/receivedAt/dueAt, actual run ID/revision/frozen input and scope digests,
owned Plan ID/SHA and exact immutable winning artifact descriptors/digest. The
builder chooses compact field layout, but never stores bytes/private object keys.
Contract parsing alone grants no authority.

Consume Task 1's exact transaction method. Internally construct native worker
services from concrete dependencies; do not inject a worker/fake Ready provider.

- [ ] Read the spec and native dataset Plan pattern, journal prepare/runAtomicStage, terminal projection verifier, Request snapshot/validation/Prepare/run evidence, worker lifecycle and real private storage fixture. Follow the spec for strict original-owner guard, source closure, native Plan/PDF and bounded journal ownership.
- [ ] Create a tracked real fixture for Scenario A through native seed services and owned Plan. Write a RED test asserting a native Ready run and exact published byte/ZIP proof, not a mocked worker result. Keep expensive prerequisites in existing bounded setup hooks.
- [ ] Implement strict fixed recipe selection using existing native terminal projections and exact snapshot identities/revisions/relations; compare the real selected complete closure and Plan pin before persistence. Derive TLCs, never accept arbitrary scope/IDs. Preserve native 500/16 MiB checks. Reject every warning/error; preserve native informational findings in frozen/report/manifest evidence, without suppression or acknowledgement.
- [ ] Implement Request creation plus pending identity atomically with `prepareStageIntent`; freeze actual once-only receipt/deadline, body and source digest. Record its receipt through guarded actual-row verification. No lookup/adoption of an unowned existing request number.
- [ ] Invoke native Validate only for pending work and require frozen semantic digest. In the package prepare-intent callback call Task 1 with stable key/revision/digest/export_ready, returning the actual new run identity atomically. Preserve native run evidence; source drift is a conflict, not silent revalidation/adoption.
- [ ] Verify ownership before `runScoped`, run only the owned scope outside journal locks, and leave non-Ready outcomes incomplete. Reproduce and verify real payloads, Plan PDF, checkpoint/expectation/publication, each private object/hash and ZIP; final guarded transaction must recheck verified bindings before recording package receipt.
- [ ] Completed initialize/verify must bypass all commands and provider writes. Add exact DB snapshot and PUT/DELETE equality assertions, fixed receivedAt/dueAt, cross-tenant/revoked owner, same-TLC foreign-source injection, native source/Plan/Request/run drift, missing/corrupt private bytes, malformed selector/accessor denial and unrelated queued-run equality.
- [ ] Add SQL fault tests for Request+intent rollback and run+package-intent rollback, committed reply-loss before receipt and final publication receipt loss, and live concurrent initializers. Use existing DB transport fault and clock helpers only where required by native policy; no production test hooks, blanket catches or sleeps proving contention.
- [ ] Add the exact new native filename to the same CI owner/pins. Run this native suite, relevant native Request transaction/worker regressions once, ownership Node checks and API static/build/format/diff. Record precise evidence and owned cleanup; do not run all 260 chains locally per task.
- [ ] Self-review and report source unstaged with exact selected fixture scope, all failure details and remaining integration acceptance. Root performs independent task review.

### Task 3: Compose the Plan and three real packages

**Files:**

- Create `apps/api/src/modules/traceability/demo/us-dataset-artifact-seed.ts`.
- Create `apps/api/test/us-dataset-artifact-seed.e2e.test.ts`.
- Extend `apps/api/test/support/us-dataset-request-fixture.ts` only for actual required-chain composition, not fabricated proof.
- Modify the same three CI ownership files additively for the new native filename.
- Update `docs/us/implementation-plan.md` and this plan's local acceptance section with measured boundaries.

**Interfaces:**

```ts
class UsDatasetArtifactSeedStore {
  constructor(db: Db, services: UsDatasetRequestServices);
  initialize(context: UsDatasetContext): Promise<UsDatasetArtifactResult>;
  verify(context: UsDatasetContext): Promise<UsDatasetArtifactResult>;
}
```

`UsDatasetArtifactResult` contains dataset/version/definitionDigest,
state `plan_request_artifacts_verified`, `datasetComplete: false`, one
`UsDatasetPlanResult`, and the three `UsDatasetRequestResult` values in recipe
order. Compose existing Plan and Task 2 stores only; do not reseed all chains or
edit the existing Trace/Readiness coordinator to claim complete demo acceptance.

- [ ] Build a fixture with the 25 distinct recipe chains using real native services. Share one owned Plan and concrete private stores. Use bounded grouped setup phases rather than enlarge an existing test or hook timeout; if a phase cannot fit the preserved envelope, report timings before choosing a structural fix.
- [ ] Write RED asserting actual native rows: exactly one effective owned synthetic Plan and three Ready `export_ready` runs with the literal recipe references and respective 1/12/12 owned connected chain selections. All frozen revisions remain below 500 and frozen bytes below 16 MiB. No production result helper may compute the test's expected selections.
- [ ] Implement the small artifact-only coordinator. Verify all private Plan/package artifacts and return only immutable honest partial-dataset evidence.
- [ ] Add completed initialize/verify equality and full DB/provider no-write assertions. Prove failed/missing middle-unit prerequisites never produce a falsely completed three-package result; existing pending unit can resume without duplicates. Record actual generated private PDF/ZIP evidence and limits.
- [ ] Assign this native test an exact prepared-services owner, run the actual three-package native suite and behavioral ownership checks, API static/build, tooling and focused format/diff. Do not duplicate a full ordinary API run; root performs that final gate once.
- [ ] Update current roadmap/status to distinguish artifact adapter acceptance from CLI/viewer/browser, full-volume CI and hosting. No claim of complete US-11/demo/deployment from this task. Report exact evidence, counts, cleanup, limitations and leave source unstaged for review.

### Task 4: Strict versioned Transformation contracts and captured-only export

Execute this prerequisite before resuming Task 2.

**Spec:** `docs/superpowers/specs/2026-10-20-us-11-transformation-structured-snapshot-design.md` (read fully).

**Files:**

- Modify `packages/platform-contracts/src/traceability/transformation-records.ts`, `transformation-genealogy.ts`, `export-core.ts` and `packages/platform-contracts/src/index.ts`.
- Modify `packages/domain/src/traceability/export/rows.ts` and the exact Transformation supported-version branch in `validation.ts`. Preserve registry fields/hash and all required-field/severity rules.
- Extend `packages/platform-contracts/test/us-transformation-records.test.ts`, `us-transformation-genealogy.test.ts` and appropriate existing export contract tests.
- Extend `packages/domain/test/us-export-rows.test.ts` and `us-export-workbook.test.ts` with hand-checked V2 facts and unchanged literal V1 missing-field expectations.
- A shared schema-only module beside transformation-records is allowed only if needed to avoid duplication/circular initialization; report exact interface and rationale.

**Interfaces:** Export `transformationFinalizationSnapshotV2Schema`, `TransformationFinalizationSnapshotV2`, `transformationFinalizationSnapshotSchema` and `TransformationFinalizationSnapshot`. Preserve original V1 exports/behavior. V2 adds `product.kdes`, `processor.kdes`, `source.kdes` using existing strict product/location snapshot schemas and exact nested/outer ID binding. Versioned finalized-record/genealogy/export envelopes consume the union; domain's structural source type and projection branch on the captured version, never current master data.

- [ ] Read the prerequisite spec, affected code/tests and package manifests. First write executed failing tests for V2 acceptance and captured-only split KDE projection. Observe missing new export or unsupported-version failure before implementation; retain raw RED.
- [ ] Implement strict schemas sharing common refinements without duplicating the entire V1 rule block or weakening V1. Assert exact output source/processor KDE equality, nested product/location identity, reference semantics, coverage, unknown versions/missing/extra fields and quantity/line/lifecycle invariants.
- [ ] Extend versioned envelopes and project V2 structured KDEs with existing context helpers, retaining original display columns. Literal legacy V1 still leaves unavailable split fields blank and reports the same missing KDEs. No guessing from opaque strings or changing validation severity/registry requirements.
- [ ] Test forged product/location IDs, output processor mismatch, wrong/missing KDEs and post-capture master-like values that must not enter captured projection. Keep info findings visible, not filtered.
- [ ] Run focused RED/GREEN, full domain and platform-contracts tests/typecheck/lint/build in dependency order, then API/admin typecheck for union compatibility. Make no runtime API capture/reader changes in this task; report any actual type-only cross-surface blocker for controller ruling.
- [ ] Self-review, raw evidence and concise report; no stage/commit/push or agents. No broad native/API run for this pure task. Root reviews independently before Task 5.

### Task 5: Additive native database enforcement for Transformation V2

Execute after Task 4 review and before Task 6.

**Spec:** `docs/superpowers/specs/2026-10-20-us-11-transformation-structured-snapshot-design.md`.

**Files:**

- Create `packages/db/migrations/0145_us_transformation_structured_snapshot.sql` and its generated migration journal/snapshot metadata through the existing Drizzle custom migration path; do not hand-edit applied SQL.
- Create `packages/db/test/us-transformation-structured-snapshot-migration.e2e.test.ts`.
- Update `packages/db/test/runtime-migrate.test.ts` only for actual new inventory effects, preserving every old migration check.
- Update old migration-count fixtures only when the additive migration actually invalidates a last-migration count; preserve their exact older function/ACL/behavior assertions and assert the new exact inventory delta.
- Modify the three existing prepared-services CI owner files additively so its DB invocation runs both `test/us-owner-provenance-migration.test.ts` and the new migration suite, with independent omission/duplicate/fixture denial tests. Preserve job/step budgets and every prior owner.

**Interfaces:** The current `transformation_finalization_guard()` accepts only V1. The additive guarded replacement accepts exactly V1 or V2, retaining every existing header/source/line/coverage/output/genealogy/revision/immutability check. V2 requires strict new fields, same tenant and equality with actual frozen-at-finalization product/profile/location facts; use the existing receiving SQL snapshot matchers where semantically identical. Future API capture may emit V2 only after this gate passes.

- [ ] Read DB instructions, drizzle config, migrations 0131/0132 and receiving snapshot matchers, runtime migration packaging and native fixture helpers. Use actual predecessor function shape; no speculative global SQL replacements.
- [ ] Write an executed native RED for valid V2 SQL finalization with known captured structured facts, plus malicious missing/forged/wrong-tenant cases. Assert exact success/23514 rejection and full transaction rollback, not just parser outcomes. Use literal expected fields from native fixture data, not an unchecked production projection.
- [ ] Generate the custom additive migration and implement guarded predecessor replacement plus complete V2 checks. Assert expected replacement cardinality/shape and fail closed if predecessor differs. Keep legacy V1 acceptance and immutable historical rows untouched; do not revalidate old facts against current data.
- [ ] Verify fresh migration, prefix upgrade, runtime no-op replay, unaltered historical V1 bytes and existing V1 rejection/identity/coverage/output/revision checks. Test street/coordinates and direct/reference sources with exact native matcher parity. Drain/drop only owned children and prove exact catalog/backend absence.
- [ ] Add exact native DB filename ownership without changing release locks or any timeout/phase cap. Run new DB native suite and affected old Transformation original/revisions migration suites, DB package test/typecheck/lint/build and focused ownership/tooling checks. API artifacts require rebuilt DB before later consumers.
- [ ] Self-review and report exact source/test evidence and metadata changes, then leave unstaged for root independent review. No full API/260-chain run at this task.

### Task 6: Capture V2 natively and accept it in current read paths

Execute after Tasks 4/5 review, then resume the original Task 2 implementer.

**Spec:** `docs/superpowers/specs/2026-10-20-us-11-transformation-structured-snapshot-design.md`.

**Files:**

- Modify `apps/api/src/modules/traceability/transformation/us-transformation-snapshot.ts` and `us-transformation-genealogy-query.ts`.
- Modify `apps/api/src/modules/traceability/trace/us-trace-evidence.ts`, `us-readiness-evidence.ts` and `us-lot-card.ts`.
- Modify additional actual persisted-snapshot consumers only when a concrete direct V1-only parser/type blocks V2; report each named call site and keep the change to version-aware parsing.
- Create `apps/api/test/us-transformation-structured-snapshot.e2e.test.ts`; extend actual finalization/amendment/trace/readiness/genealogy/lot-card/export regressions as needed to preserve separate V1 and new V2 proof.
- Remove only the unused mutated master clone in `packages/domain/test/us-export-rows.test.ts` identified by Task 4's Minor review finding; retain its literal captured-cell assertions. Actual post-finalization master-data drift must be proved by the new native test, not this unused object.
- Add only this new native filename to the existing prepared-services owner/helper/pins. Preserve all other selectors, assertions and budgets.

**Interfaces:** `planTransformationSnapshot` emits `TransformationFinalizationSnapshotV2` from the same locked context/builders and same display-string algorithm. Runtime persisted readers use Task 4's strict union; SQL Readiness candidate selection includes V2, while malformed/unknown versions remain invalid. Native saved V1 command receipts still replay exactly; amendments create new V2 revisions without changing output identity or predecessor bytes.

- [ ] Write an actual native failing test demanding snapshotVersion 2 and exact product/processor/source kdes from locked fixture facts, then observe RED before changing the emitter. Keep explicit V1 fixtures and legacy replay assertions separate from new-emitter expectations.
- [ ] Capture each builder's existing snapshot as kdes without rereads. Emit V2 for new originals/amendments; preserve IDs, strings, quantities/UOMs, coverage, reference values, output identity, audit and native transaction/lock ordering.
- [ ] Upgrade actual readers/candidate filters to strict versioned parsing. Preserve V1 evidence checks and missing-field semantics; a narrow shared readiness lens may be used only after strict version validation. Never declare malformed V2 complete or read current data to fill it.
- [ ] Test actual source/master changes after finalization: frozen V2 KDEs/export stay unchanged. Verify old V1 receipt replay, V1 predecessor → V2 amendment, native Readiness/Trace/genealogy/lot-card and real Request capture/export with no missing KDEs. Numeric info findings remain visible. No Ready shortcut.
- [ ] Run the new native suite and affected finalization/amendment/read-model/Request-source regressions with unchanged budgets; fresh API/admin static/build, ownership/tooling and focused format/diff. Report exact test counts/skips and owned cleanup. Root still owns one final ordinary API/full CI acceptance after the resumed adapter and composition.
- [ ] Self-review and report, no agents/stage/commit/push. On independent approval, hand exact new union/capture/DB semantics back to Task 2; do not edit its preserved source yourself.

## Controller final gates

- [ ] Independent spec/quality review after each task; root resolves findings through the implementer and scoped re-review.
- [ ] Run one full ordinary API invocation via `node tools/us-development/run-api-validation.mjs full` with correct Node PATH. Keep its opt-in skips separate from new native zero-skip evidence.
- [ ] Run all tooling checks, focused formatting, static/build/isolation and final diff review; obtain most-capable selected-plan whole-increment review.
- [ ] Scoped user-authored/committed US push if verified; inspect exact new-SHA job logs for actual native execution and full Trace/Cases gates. Running/queued is not green. No release/deployment.
- [ ] Preserve ignored verification evidence/ledger for recovery rather than deleting it. Final report names remaining CLI, final viewer/browser and hosting work; do not conflate source/CI with deployed demo acceptance.
