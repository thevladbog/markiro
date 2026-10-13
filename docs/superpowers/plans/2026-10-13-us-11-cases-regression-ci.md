# US-11 Supplemental Cases Regression CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obtain the unchanged eight-file Cases native acceptance on a fresh GitHub runner without replacing any existing gate.

**Architecture:** One additive, read-only workflow executes its own prerequisites and exact native command. Independent raw/parsed ownership contracts recognize only this complete supplemental gate; existing primary ownership counts and historical workflow pins remain unchanged. A bounded read-only catalog helper proves the isolated base is empty before and after execution.

**Tech Stack:** GitHub Actions, Node 24, repository-declared frozen pnpm, PostgreSQL 17, dependency-free Node tests and existing declared `pg` through the DB package.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-cases-regression-ci-design.md`

## Global Constraints

- Work only in the existing `codex/us-mvp` checkout; preserve unrelated files.
- Existing main US workflow/jobs/selectors/budgets/bytes stay unchanged.
- Node24/declared frozenpnpm install/securitypolicies, ubuntu-latest and own PostgreSQL17-alpine service on127.0.0.1:55432. Jobbudget30minutes, existing nativebody/setup/drain deadlines untouched.
- Explicit US_TEST_DATABASE_URL only, DATABASE_URL absent, freshservice/base and actual target/user checks. No namefilters/retry/continue-on-error/timeoutoverride.
- No arbitrary workflow removal, selector ignore, hash rewrite or new blanket duplicate exemption.
- No API/business/test source changes are selected by this CI slice.
- No releases, PR, main/RU/Station, new provider/account/VM, paid resource, dependency or local environment changes.
- No further local Cases native execution: its five-round cap is consumed. Real same-SHA remote execution, not source approval, closes its runtime finding.
- Implementer does not commit, push or spawn agents. Root performs reviewed explicit-path checkpoints and already-authorized scoped US push.

## Review Focus

1. A mutated supplement must remain visible to primary ownership checks even after a pristine inventory was normalized.
2. Equal parsed YAML with different bytes must not authorize a historical exception.
3. Renamed/duplicate workflow or third selector owner must fail, not be normalized away.
4. Failed native execution must still run the post-catalog check; neither failure can be suppressed.
5. Catalog target mismatch, residue or driver failure must close only the helper's own client and fail without repairing the database.

## File map

Create `.github/workflows/us-cases-native.yml` (the additional execution gate), `tools/us-development/verify-cases-fixture.mjs` (bounded read-only CLI and testable probe), `tools/us-development/test/cases-fixture.test.mjs` (fake-client denial/lifecycle tests), `tools/us-development/test/support/cases-regression-owner.mjs` (exact-only immutable inventory normalization), and `tools/us-development/test/dataset-cases-regression-ownership.test.mjs` (independent full workflow literals and mutations).

Modify only `tools/us-development/check-isolation.mjs`, `tools/ci/test/workflow-triggers.test.mjs`, `tools/us-development/test/isolation.test.mjs`, `tools/us-development/test/dataset-regular-ownership.test.mjs`, and `tools/us-development/test/dataset-prepared-services-ownership.test.mjs` for the exact check-only identity/event inventory and primary inventory-boundary integration. If another complete-inventory consumer actually fails, report its precise assertion before proposing a narrow addition. Do not alter any historical normalizer, hash or workflow.

### Task 1: Complete additive native CI gate and strict ownership integration

**Files:** The complete file map above, plus this plan/spec status after actual review.

**Interfaces:**

- `withoutCasesRegressionWorkflow(workflows, rawSources)` takes current parsed filename→workflow and filename→raw string maps and returns a new inventory. Remove exactly `us-cases-native.yml` only when its current parsed representation and raw bytes equal the complete frozen expectation. Missing/malformed entries return unchanged cloned inventory. Never cache authorization of an earlier object, mutate inputs or silently remove a renamed copy.
- `verifyCasesFixture({ env, createClient })` is an exported async helper; CLI calls it only when directly executed. `createClient(config)` yields the ordinary `pg.Client`-compatible `connect/query/end` methods, allowing fake-client tests without native execution. CLI resolves `pg` using `createRequire` rooted at `packages/db/package.json`, which declares it; do not add a dependency or rely on API ownership.
- Reject any nonempty `DATABASE_URL` before creating a client. Require explicit `US_TEST_DATABASE_URL`; reuse/faithfully enforce existing fixture URL restrictions (loopback and port 55432, allowed fixture database/user, no permissive query options). Read the fixture source for exact allowlisted base/user/profile prefix; do not introduce new accepted targets.
- Require a nonempty explicit password in that fixture URL. Before client construction reject inherited PostgreSQL driver overrides in both supplied `env` and actual `process.env`, including `PGOPTIONS`, `PGSSLMODE`, `PGSSLNEGOTIATION` and all other `PG*` keys consumed by the installed driver. Inspect the established no-connection probe in `api-validation-env.mjs`; do not rely on falsey config values defeating driver fallbacks. Test hostile option/SSL inheritance and absent URL credentials without a real connection; assert actual constructor parameters cannot be influenced.
- Configure `connectionTimeoutMillis: 5000`, `query_timeout: 5000`, server `statement_timeout: 5000`, and an independently bounded 5000 ms normal `end()` wait. These are new helper bounds only, not native test changes. Clear bound timers on every branch; propagate connection/query/end failure. If both probe and end fail, preserve both errors using `AggregateError`; never terminate another backend or pretend disposal succeeded. Do not retry.
- The library returns/rejects; only the directly executed CLI owns process termination. On a failed or timed-out normal `end()`, write a safe failure diagnostic and exit nonzero explicitly so a remaining own socket cannot hold the runner indefinitely. This failure exit is not normal-disposal evidence and never closes another backend. Inject the CLI exit/diagnostic seam for tests: a never-settling fake `end()` must invoke a nonzero termination path within its unchanged helper bound, and a successful `end()` must never force exit. Unit tests may use fake clock/short injected deadline to prove this new helper lifecycle; production CLI remains pinned to 5000 ms and native test deadlines remain untouched.
- After `connect`, read `current_database()` and `current_user` and compare with the validated explicit URL, then count public base tables, profile child databases, and other `backend_type = 'client backend'` sessions excluding `pg_backend_pid()`. Require zero for all three; log only safe target identity and counts. No row content, credentials or tokens.

- [x] **Step 1: Write independent failing workflow and probe tests.** Declare the expected filename, full workflow/job/steps, raw bytes and command as literals independent of the normalizer. Test missing/renamed/second workflow, duplicate job, trigger/permissions/defaults/env/timeout mutation, omitted build/prerequisite/catalog step, conditional native step, changed shell, command file omission/duplication/filter/retry, byte-only YAML mutation and third selectors. The whole original inventory must be validated before deriving primary historical views.

```js
const changed = structuredClone(workflows);
changed["us-cases-native.yml"].jobs.cases_native.steps.at(-2).if = "false";
assert.deepEqual(withoutCasesRegressionWorkflow(changed, rawSources), changed);
assert.notStrictEqual(withoutCasesRegressionWorkflow(changed, rawSources), changed);
assert.throws(() => assertSupplementalOwnership(changed, rawSources));
```

Choose explicit step lookup by independently pinned name in the actual test rather than relying on the illustrative positional lookup. Test fake clients with successful zero census, URL rejection before construction, actual target/user mismatch, each nonzero census, connection/query error and failed normal end. Assert no mutation SQL, exact own `end` count and preserved errors.

- [x] **Step 2: Establish actual RED before implementation.**

```sh
node --test tools/us-development/test/dataset-cases-regression-ownership.test.mjs tools/us-development/test/cases-fixture.test.mjs
```

Retain the missing module/workflow or exact assertion output, not an unrelated setup failure.

- [x] **Step 3: Implement workflow and bounded helper.** Copy pinned action SHAs and frozen install/build commands from current existing native job, not external examples. New `cases_native` job has no dependency on the old matrix, `runs-on: ubuntu-latest`, `timeout-minutes: 30`, explicit contents read, own PostgreSQL17 service only at loopback55432, no secrets/environment/reusable job or outputs used as proof. Push branch is exactly `codex/us-mvp`; optional workflow_dispatch has no inputs; separate concurrency group does not cancel original CI. Preserve checkout `persist-credentials: false` and Node24.

Prerequisite order: checkout → pinned pnpm/Node → frozen install → contracts build → existing isolation check → full Node tooling contracts → API dependency/build → pre-catalog → native → post-catalog. Use exact current commands for old prerequisite steps. No migration/seed is run against the base. Catalog commands:

```sh
node tools/us-development/verify-cases-fixture.mjs
```

Set only the explicit synthetic fixture URL on the pre/native/post steps; post has `if: always()` and no continue-on-error. Actual native command is literal:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-case-demo-owned-application.e2e.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts test/us-dataset-regular-seed.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts --maxWorkers=1 --reporter=verbose
```

- [x] **Step 4: Integrate primary checks at their current-input boundary.** Add only the exact new filename to the check-only allowlist and exact event inventory. Apply immutable exact-only normalization inside actual primary ownership assertion entrypoints, including mutated inventories, not just once during pristine loading. Retain all original count-one assertions, hash literals, old mutation inputs and intended errors. Tests must run malformed supplemental mutations through the actual primary assertions, with updated raw input where applicable, and reject a third owner outside both recognized scopes. Missing supplement fails the independent validator, but must not introduce an unconditional early assertion masking older primary mutants. Export narrowly scoped assertion helpers only if required to exercise actual functions; do not duplicate weaker copies in tests.

- [x] **Step 5: Run focused GREEN and full tooling; inspect exact old workflow bytes.**

```sh
node --test tools/us-development/test/dataset-cases-regression-ownership.test.mjs tools/us-development/test/cases-fixture.test.mjs tools/us-development/test/isolation.test.mjs tools/us-development/test/dataset-regular-ownership.test.mjs tools/us-development/test/dataset-prepared-services-ownership.test.mjs tools/ci/test/workflow-triggers.test.mjs
corepack pnpm turbo build --filter '@markiro/platform-contracts...'
node --test tools/us-development/test/*.test.mjs tools/ci/test/*.test.mjs
node tools/us-development/check-isolation.mjs
git diff --check
git diff --exit-code 787a23f00 -- .github/workflows/us-development.yml
```

Use focused Prettier check on only changed tracked paths; do not format historical workflow bytes. No Vitest native, container/service/process operations, dependency install, workflow dispatch or push during this task.

- [x] **Step 6: Report and independent review.** Write actual RED/GREEN commands, counts, output evidence, self-review, changed paths, unchanged workflow hashes, no-native statement and residual runtime gates to `task-1-report.md` in this plan's SDD workspace. Root packages the complete selected diff for a fresh reviewer. Correct real findings through the bounded task loop; source/static approval is not execution acceptance.

## Root-only remote acceptance after source review

- [ ] Stage only this reviewed CI slice and its spec/plan; inspect staged diff and commit. Push reviewed checkpoints to `origin codex/us-mvp` under the existing explicit authorization. No PR/release. Original automatic US CI remains intact and may still fail Trace.
- [ ] Inspect actual supplemental run at the pushed SHA. Require all prerequisites, pre/post zero census, 234 results with zero skips and all four expected failures, eight actual child normal-disposal/independent-absence records. Preserve raw failure logs and exact job/source SHA. Any timeout/setup/cancellation/missing record remains open; do not rerun unchanged or increase limits merely for green.
- [ ] Only actual complete acceptance closes Cases runtime finding4. Then proceed to separately approved Shipping batching and unit composition; unchanged full262/fault/resume/verify/replay and complete same-SHA CI remain mandatory. No deployment-readiness claim follows from a supplemental pass.

## Self-review

One coherent task owns workflow, read-only helper and complete ownership integration. All seven architect obligations map to its steps1–6 and root acceptance. Each review-focus condition has explicit tests. Production/fixture authorities and historical pins are untouched. The extra CI run and potential original red Trace job are costs of the recorded remote-prerequisite ruling, not evidence of completion.
