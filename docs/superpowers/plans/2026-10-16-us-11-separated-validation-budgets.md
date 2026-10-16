# US-11 separated validation budgets implementation plan

**For agentic workers:** use subagent-driven development, one implementer per task
and an independent task-scoped review; final controller verification and review.

**Spec:** `docs/superpowers/specs/2026-10-16-us-11-separated-validation-budgets.md`.
User approval is already granted; do not request it again.

## Global constraints

Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch
`codex/us-mvp`. Preserve the three unrelated untracked documents. No release,
deployment, main/RU/Station, production code, SQL, schema, fixture, env, dependency
or lockfile changes. All original assertions and sequential public calls remain.
No extra seeding or cross-test state. Only the approved aggregate budgets grow.
Implementers never dispatch subagents or push. Stage explicit task paths only.

## Preflight interfaces and ordering

| Task | Interface/output                                                         | Dependencies/conflicts                             |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 1    | Test-only phase-budget validator; unchanged-order measured API scenarios | First; measurement helper reused by full seed test |
| 2    | Exact CI budget ownership and mutation regressions                       | After task 1; workflow and tooling only            |

### Task 1: enforce independent phase caps without changing scenarios

Read this task first; it contains the full implementation requirements. Read the
root instructions and API scoped guide (`/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md`
if absent in this old worktree), existing affected code/tests and recent commits.

Files:

- Create `apps/api/test/support/us-validation-phase-budgets.ts`.
- Add pure behavioral tests outside the PostgreSQL-skipped describe in
  `apps/api/test/us-dataset-composition-measurements.e2e.test.ts`; this existing
  whole file is already owned by prepared-services CI. No new test file/owner.
- Update only M05/M06 integration in that file, C17 in
  `apps/api/test/us-dataset-unit-coordinator.e2e.test.ts`, and the full scenario in
  `apps/api/test/us-dataset-trace-readiness-seed.e2e.test.ts`.

Write focused failing behavioral tests before implementing the validator.
Pure helper API should accept total elapsed, a list of measured performance
durations and the two phase caps; require exactly one window and return both
durations/caps on success. Reject NaN, Infinity, negative durations, owner > total,
nonpositive/nonfinite caps, missing/multiple windows. No rounding or clamping.
Literal test cases must prove 5001+0 and 0+5001 fail independently below a 10000
aggregate, 5000+5000 passes, fractional overrun fails, and invalid inputs fail.
Do not use fake clocks or compute expected results from the helper itself.

For M05/M06 measure exactly the selected owner.verify/initialize call inside the
existing measurement callback (exclude oracle/logging), cap each phase at 5000 ms,
and use 10000 ms outer timeout only for these two cases. Correctness is complete
original body elapsed minus that window. Leave all setup/hooks/other cases alone.

For C17 measure exactly the actual coordinator command inside existing invoke
counting (not logging/assertions), retain its intentional SQL fault/observed-error
identity, and enforce 5000 ms per phase / 10000 ms outer only for C17. Total must
include `withOwnedWork` cleanup: validate after that successful await in the body
wrapper, not inside the C17 callback. Require exactly one selected window.

For the full seed test preserve its entire original call/assertion order: real
partial failure, refusal and no-write snapshot, pending intent identity, resumed
262 units, 4 native boundary verifications, exact 964 roots / 963 finalized /
785 lots / 15700 boxes census, no Plan/Requests, freeze/size, all-table baseline,
full verify, full replay, identities and no-write hashes. Measure exactly resumed
initialize (exclude adjacent phase log); performance/correctness caps 900000 ms
each; outer 1800000 ms. All other tests/hooks unchanged.

Check budgets only after original scenario+owned cleanup succeed. Never throw new
budget errors in finally or mask original errors. Print both exact phase durations
and caps while retaining original diagnostics. No zero fallback for missing timing.

Run pure tests first RED then GREEN (record why RED failed), then the two complete
small files against canonical synthetic PostgreSQL at 127.0.0.1:55432 using
US_TEST_DATABASE_URL from the tooling owner fixture, --maxWorkers=1. Escalation for
local DB access is authorized. Verify normal drain/DROP/absence, no forced cleanup.
No full 262 duplication locally: exact full gate will run in GitHub CI after review.
Run focused formatting/typecheck as useful; report full package gates deferred to
controller. Map every original assertion/call to its retained location in the
report. Commit explicit four task paths only. No push, no agents.

Write detailed report to the task brief's sibling `task-1-report.md`: changes,
TDD evidence, commands/log paths/results, assertion preservation, concerns. Return
only status, commit SHA, one-line checks summary and concerns.

### Task 2: pin the expanded full-suite CI budget without relaxing ownership

Read root instructions and this task's affected tooling/tests. Task 1 provides
separate full 900000+900000 ms caps and 1800000 ms outer test; do not change them.
No release or deployment; no new agent or push.

Files: `.github/workflows/us-development.yml`,
`tools/us-development/test/support/trace-readiness-owner.mjs`,
`tools/us-development/test/dataset-trace-readiness-ownership.test.mjs`, and only
necessary adjacent strict historical fixture/ownership tests if actual failures
demonstrate a compatibility need. No new test-file ownership: Task 1 pure tests
are in the existing measurement file outside its opt-in DB describe.

Test-first: behaviorally mutate the reviewed workflow and assert strict rejection
of nonapproved full-suite limits 30/44/46, and acceptance only of 45. Exercise the
real isolation/ownership validator rather than source-text presence assertions.
Preserve existing command/filter/order/freshness/permissions/service pins.

Change only dataset_trace_readiness timeout-minutes from 30 to 45 in the workflow
and both parsed/exact-byte owner pins. Other job limits remain 30. Historical
snapshots must retain meaningful strict comparison; do not allow arbitrary limits
or strip a changed job globally. Add tests that wrong other-job limits or command
filters remain visible/rejected, as appropriate in existing suite. Update history
fixtures only if necessary and explain exact scope.

Run complete `node --test tools/us-development/test/*.test.mjs`, isolation validator,
formatting and git diff --check; all must pass. Record RED/GREEN logs and exact
results in sibling `task-2-report.md`. Commit explicit task paths only, no push.
Return status, commit SHA, one-line checks summary and concerns.

## Controller final gates

Resolve independent task reviews and perform one final scoped whole-change review.
Run API test/typecheck/lint/build, complete US Node contracts, format/check and
isolation; distinguish opt-in skips from the native runs and CI. Push explicit
US branch only, then follow exact-SHA GitHub US Development and US Cases Bridge
to completed green. Inspect exact failing logs if needed; do not re-run unchanged
code as a remedy. Report actual evidence, no deployment claims.
