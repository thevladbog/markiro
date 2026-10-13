# US-11 Prepared Services Native CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Give four already-tested native service suites explicit isolated CI ownership without weakening existing gates.

**Architecture:** One additive job and strict exact-job normalization preserve every historical workflow invariant. Independently pinned ownership and negative mutants prove selection and failure propagation.

**Tech Stack:** GitHub Actions, PostgreSQL 17, Node 24, pnpm/Corepack, Node test runner, TypeScript AST, js-yaml.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-prepared-services-ci-design.md`

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`.
- Preserve the six original matrix segments, all 82 original steps, existing Trace job, release guards, pinned actions, deadlines and assertions.
- The new job's timeout is 30 minutes. No timeout increase, retries, filters, skips or failure bypass.
- No backend semantics, native test bodies, migrations, package/dependency configuration, RU/main/Station, releases, PR or deployment changes.
- Root owns scoped commits/push and CI observation after independent review; implementer must not commit, push, spawn agents or rerun heavy native suites.

## Review Focus

- A malformed new job must remain visible to historical assertions, not disappear under permissive normalization.
- A correct job copied into another workflow must fail global unique ownership.
- Reversed dependency build order must fail before native suite execution is accepted.
- A gate alias bound to a different environment or nested/shadowed binding must fail source validation.
- A byte-only change to existing matrix or Trace must fail unchanged historical pins.

---

### Task 1: Additive job, strict normalization and native ownership proof

**Files:**

- Modify `.github/workflows/us-development.yml` (append only).
- Create `tools/us-development/test/support/prepared-services-owner.mjs`.
- Create `tools/us-development/test/dataset-prepared-services-ownership.test.mjs`.
- Modify `tools/us-development/test/support/parallel-segments.mjs` and `tools/us-development/test/dataset-trace-readiness-ownership.test.mjs` only to compose strict addition removal.
- Optional create `tools/us-development/test/support/native-fixture-gate.mjs` if used by both owners without weakening old Trace checks.

**Interfaces:**

- Consume existing `withoutTraceReadinessOwner(workflow)` and `withoutTraceReadinessOwnerBytes(source)` unchanged.
- Produce `withoutPreparedServicesOwner(workflow)` and `withoutPreparedServicesOwnerBytes(source)` with exact complete-job checks and non-mutating clone semantics.
- Produce independently pinned real-workflow ownership assertions, including negative mutations and native fixture gating proof.

- [ ] Read the spec and affected owner/normalizer/tests; record predecessor parsed and byte hashes from HEAD. Do not edit historical predecessor pins.
- [ ] Write a meaningful missing-job RED first:

```js
test("prepared services have an explicit native owner", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  assert.ok(
    workflow.jobs.dataset_prepared_services,
    "prepared services dedicated native job is present",
  );
});
```

- [ ] Run `node --test tools/us-development/test/dataset-prepared-services-ownership.test.mjs`; capture the expected missing-owner assertion failure separately from setup errors.
- [ ] Append the exact job defined by the spec, implementing a complete object/raw block helper. Native command and fixture must use the spec's literal values. Use exact deep equality, unique block count and EOF matching; never remove a merely similarly named job.
- [ ] Compose strict prepared removal before strict Trace removal in existing predecessor checks. Keep the actual full workflow available for global duplicate-selection checks. Include executable assertions that exact removal restores the complete pre-task workflow byte/hash and that malformed prepared additions are retained.
- [ ] Add literal independent selectors/command, full job proof and negative variants for every Review Focus and spec denial category. Use `assert.throws` with the intended assertion reason, rather than permitting unrelated setup failure to count as denial.
- [ ] For each native suite parse its source and require one exact `describe.skipIf(!fixture)` gate, unique top-level const binding to `process.env.US_TEST_DATABASE_URL` or the direct expression; evaluate missing/present environments. Exercise changed environment, mutable binding, duplicate/shadowed binding and extra gate negative mutants. Preserve aggregate API collection without the fixture.
- [ ] Run focused owner tests, then all Node tools:

```sh
node --test tools/us-development/test/dataset-prepared-services-ownership.test.mjs tools/us-development/test/dataset-trace-readiness-ownership.test.mjs
node --test tools/us-development/test/*.test.mjs
node tools/us-development/check-isolation.mjs
git diff --check
```

- [ ] Run repository Prettier check on exactly changed workflow/JS/spec/plan files using existing Corepack dependencies; no reinstall or lockfile change. Capture checks and exact mutant/test counts in the report.
- [ ] Self-review the complete diff against scope. Report source completion separately from actual remote native CI; hand off unstaged scoped changes for root commit and independent review.

### Root review and remote acceptance

- [ ] Generate one exact Task 1 review package and obtain independent spec-compliance and quality verdicts; address Important findings through the implementer.
- [ ] Obtain most-capable complete selected-plan source review. Do not turn its approval into runtime acceptance.
- [ ] Wait for the already-running predecessor CI to settle, retaining its original Shipping and full 262-chain evidence. Do not cancel it by pushing a newer SHA mid-run.
- [ ] Authorized scoped commit/push only to US branch after checks and review. Observe exact new SHA's CI; inspect any actual failure logs before corrections.
- [ ] Close native coverage only after the new job actually executes all four suites successfully without skips. Keep full dataset/Requests/viewer/browser/hosted acceptance separate.
