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

Tasks 2/3, the final ordinary API invocation and new-source GitHub acceptance are
still pending. This checkpoint proves neither a generated dataset Request package
nor full demo completion. Detailed recovery evidence is in the ignored plan ledger.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve unrelated `docs/us/demo-hosting-options.md`.
- Keep `us-processor-six-month-v1`, its definition digest, 500 selected revision / 16 MiB native snapshot / 256 KiB journal bounds unchanged.
- Preserve every existing assertion, timeout, phase budget, worker lease/retry policy and release lock. No blind retry, timer increase, fake Ready, fabricated frozen facts or truncation.
- No schema, migration, public HTTP/UI, global worker sweep, production clock rewrite, RU/main/Station, PR, release, deployment, provider/dependency policy or environment-file changes.
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

- [ ] Read this task, Global Constraints, the spec's atomic-run section, current Prepare body, `us-request-create-transaction.e2e.test.ts`, ordinary Prepare tests and native fixture helpers. Read applicable AGENTS including `/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md` (the US worktree has no nearer API guide).
- [ ] Build shared API dependencies using `corepack pnpm turbo build --filter '@markiro/api^...'`; record success and correct Node/pnpm before native checks.
- [ ] Write a real disposable-PG test calling the new seam inside a caller transaction, then throwing. Assert no native run or prepared success audit persists; Request validation remains unchanged. First RED must be the missing method, not infrastructure failure.
- [ ] Implement the narrow public seam delegating to the existing body. Keep fresh authorization, locking, current source/Plan capture, all bounds, validation-digest checks, evidence-checked replay and exact audit.
- [ ] Add commit/replay, strict extra-key/malformed input, stale revision/digest, cross-tenant and revoked-role denial. Verify exact prepared/replay audit actor/tenant/target/request metadata, transaction rollback including a companion caller write and no leaked standalone rejection audit. Use existing actual Prepare source fixtures; do not fabricate Ready.
- [ ] Add the one new filename to the prepared-services owner/helper/independent pins, preserving older mutation checks and all budgets. Behavioral ownership tests must reject omission and duplicates.
- [ ] Run focused native and existing Prepare regressions (single worker), the ownership Node test, API typecheck/lint/build, focused Prettier and diff check. Record actual counts/skips, RED/GREEN, owned DB disposal and any failures.
- [ ] Self-review, leave source unstaged and write the report. Root supplies the independent review; no nested agents or commits.

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
- [ ] Implement strict fixed recipe selection using existing native terminal projections and exact snapshot identities/revisions/relations; compare the real selected complete closure and Plan pin before persistence. Derive TLCs, never accept arbitrary scope/IDs. Preserve native 500/16 MiB checks and no unexpected finding acknowledgement.
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

## Controller final gates

- [ ] Independent spec/quality review after each task; root resolves findings through the implementer and scoped re-review.
- [ ] Run one full ordinary API invocation via `node tools/us-development/run-api-validation.mjs full` with correct Node PATH. Keep its opt-in skips separate from new native zero-skip evidence.
- [ ] Run all tooling checks, focused formatting, static/build/isolation and final diff review; obtain most-capable selected-plan whole-increment review.
- [ ] Scoped user-authored/committed US push if verified; inspect exact new-SHA job logs for actual native execution and full Trace/Cases gates. Running/queued is not green. No release/deployment.
- [ ] Preserve ignored verification evidence/ledger for recovery rather than deleting it. Final report names remaining CLI, final viewer/browser and hosting work; do not conflate source/CI with deployed demo acceptance.
