# Prepared-services isolated CI partition implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the implementation and independent task review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish every existing prepared-services native gate within unchanged per-job time limits by splitting the sequential workload across three isolated jobs.

**Architecture:** Keep the original prepared-services job for transaction/Plan/Request/artifact checks and both DB migration suites. Add two explicitly selected jobs for terminal readers and unit composition; each owns its own hosted runner/PostgreSQL service. Extend exact parsed/raw ownership recognition and independent mutation tests for the entire partition, retaining historical predecessor pins.

**Tech Stack:** Existing GitHub Actions YAML, Node24/Corepack pnpm11.22.0, dependency-free existing Node tests/js-yaml and unchanged native Vitest suites.

**Spec:** The user's explicit request in this chat: split `dataset_prepared_services` into isolated CI jobs, preserve checks/timeouts, push only the US branch and obtain green CI without releases. Exact cancellation evidence is preserved in `.superpowers/sdd/2026-10-20-us-11-dataset-request-packages/ci-terminal-report.md` and raw job logs; this is a CI-only change, not a product architecture change.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`, base `e47b3dfd880ec103ee58f6725258fb157bd220e6`.
- Preserve unrelated untracked command-policy source/test, its design/plan and `docs/us/demo-hosting-options.md`; do not stage, commit or develop them in this task.
- Preserve all 24 existing explicit API suites and both DB suites exactly once across the partition; no suite file/assertion/fixture/timeout/budget change, no selectors/globs/test-name filtering/retries/skips/failure suppression.
- Each partition job keeps `timeout-minutes: 30`, `needs: isolation`, `runs-on: ubuntu-latest`, the exact pinned actions, install/build/Poppler ordering, PostgreSQL17-alpine service/health/loopback endpoint, per-native-step `US_TEST_DATABASE_URL` and `--maxWorkers=1`.
- Preserve the entire original six-way isolation matrix and full Trace job including its previously approved45-minute job limit/900000ms phase caps. Do not change operational workflows, release locks, permissions, triggers, concurrency, package/dependency/env policy or primary/main.
- Root alone stages explicit paths, commits and pushes. Every author AND committer must be Vlad Bogatyrev <47273232+thevladbog@users.noreply.github.com>, using four per-commit environment variables and verified readback; no Git config/history rewrite/PR/release/deploy.
- Preserve ignored recovery evidence. Focused local Node ownership/tooling/format/isolation checks suffice for the CI-only edit; actual native acceptance is the new exact-SHA GitHub jobs. Do not rerun broad local API/SQL/260-chain suites merely to repeat existing evidence.

## Review Focus

- A relocated suite can disappear from its former command without appearing in another: assert independent literal union/disjointness/once-only selectors (Task1).
- An unsafe new job can disappear behind historical normalization: exact all-or-nothing parsed and raw-byte recognition for all three jobs, with malformed/missing/AST-neutral mutants per job (Task1).
- A partition can inherit the wrong DB, larger timeout, conditional/bypassed step or worker count: apply the full existing safety mutation categories to each group (Task1).
- A duplicate suite can hide under a filename/path alias or another workflow: retain global explicit-selector denial and old fixture-gate mutants for every suite (Task1).
- The CI can look green while a group or migration never ran: require every exact-SHA job completed successfully and inspect actual native file counts/zero skips, artifact proof and normal disposal (root acceptance).

## Fixed partition

Filenames below are relative to `apps/api/test/`; execute with their original `test/` prefix and in listed order. Each file remains whole.

| Job                         | API suites                                                                                                                                                                                                                                                                                                                                                                                   | Measured planning basis (old partial CI, not a runtime promise)                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataset_prepared_services` | `us-plan-draft-transaction.e2e.test.ts`, `us-dataset-prepared-intent.e2e.test.ts`, `us-dataset-plan-seed.e2e.test.ts`, `us-dataset-request-seed.e2e.test.ts`, `us-dataset-artifact-seed.e2e.test.ts`, `us-request-create-transaction.e2e.test.ts`, `us-request-prepare-transaction.e2e.test.ts`, `us-request-worker-scoped.e2e.test.ts`, `us-transformation-structured-snapshot.e2e.test.ts` | Existing Request335.5s, Plan53.1s, scoped worker81.3s; composition still needs full execution. Keep BOTH original DB suites after API in this job. |
| `dataset_terminal_readers`  | `us-owner-provenance-procedure.e2e.test.ts`, `us-owner-provenance-procedure-locks.e2e.test.ts`, `us-owner-provenance-adapter.e2e.test.ts`, `us-terminal-native-readers.e2e.test.ts`, `us-terminal-verification-routing.e2e.test.ts`, `us-terminal-closed-reader.e2e.test.ts`, `us-dataset-corrected-terminal-reader.e2e.test.ts`, `us-dataset-native-final-reader.e2e.test.ts`               | Closed reader197.8s, corrected115.0s, other measured completed files small; actual full group is a CI gate.                                        |
| `dataset_unit_composition`  | `us-case-demo-owned-application.e2e.test.ts`, `us-dataset-journal-reader.e2e.test.ts`, `us-dataset-shipping-prerequisites.e2e.test.ts`, `us-dataset-unit-composition.e2e.test.ts`, `us-dataset-unit-composition-semantics.e2e.test.ts`, `us-dataset-unit-coordinator.e2e.test.ts`, `us-dataset-composition-measurements.e2e.test.ts`                                                         | Semantics380.2s, measurements103.3s, coordinator73.6s, shipping prerequisites72.2s; leaves headroom without raising30min.                          |

The union is exactly the existing24suite inventory (9+8+7); both DB files remain
`test/us-owner-provenance-migration.test.ts` and
`test/us-transformation-structured-snapshot-migration.e2e.test.ts` under @markiro/db.
No cross-job artifact/data dependency or shared DB/volume is introduced.

### Task 1: Partition workflow and prove complete exact ownership

**Files:**

- Modify `.github/workflows/us-development.yml` only at the existing prepared-services suffix.
- Modify `tools/us-development/test/support/prepared-services-owner.mjs` and `tools/us-development/test/dataset-prepared-services-ownership.test.mjs`.
- Other existing ownership tests/helpers may receive only necessary compatibility changes for the new complete-owner interface; preserve every old safety scenario/historical hash. No new generic framework or unrelated cleanup.
- Documentation: this plan records scope/evidence; no other public roadmap update is needed just to rerun CI.

**Interfaces:** Keep existing helper exports where practical for existing consumers; `preparedServicesJobId` remains the original job. Add exact multi-job maps/IDs/commands as needed. `preparedServicesFiles` still denotes the whole24suite inventory. `hasExactPreparedServicesOwner`, `withoutPreparedServicesOwner` and `withoutPreparedServicesOwnerBytes` now recognize/remove only the complete exact three-job partition. No missing/malformed partition may normalize away. Remaining predecessor AST/raw pins stay unchanged.

- [x] Add independent literal partition tests first and run them against the old workflow for actual behavioral RED (missing isolated jobs/incorrect distribution), not missing-import/collection error. Record the raw log before workflow/helper changes.
- [x] Implement the fixed three jobs and exact helper representation. Factor genuinely common job construction if useful; independent test expectations must not be derived from helper exports. Keep the whole original workflow prefix byte-identical.
- [x] Adapt existing primary ownership checks/mutants to find each suite's actual owner; apply all old job/step/environment/build-order/action/permission/budget/failure/fixture/global-selector mutation categories to every partition. Keep old24fixture-gate mutation coverage and existing AST-neutral raw tamper/historical predecessor proofs, including mutations of either new supplemental job. Do not replace detailed failure expectations with generic passes or remove cases because the old singleton layout changed.
- [x] Run focused `node --test tools/us-development/test/dataset-prepared-services-ownership.test.mjs` while iterating, then the whole `node --test tools/us-development/test/*.test.mjs tools/ci/test/*.test.mjs`. Build shared contracts before tooling if required; use existing isolated dependencies, no install/env changes. Check workflow isolation, focused lint/Prettier and `git diff --check`; retain each failed invocation distinctly.
- [x] Self-review exact selector inventory, all old timeout values, build/native order, no protected-source edits and no unrelated untracked files touched. Report raw RED/GREEN/results/counts/warnings and every changed path, leave unstaged for root independent task review.
- [ ] Root performs independent task review and most-capable whole scoped increment review, then explicit-path stage/inspect/commit as user and scoped push. No implementation agent commits/pushes.

## Root exact-source acceptance

- [ ] Record new SHA and all resulting US/Cases run IDs; do not call running/queued green or restart CI with status-only commits.
- [ ] All three partition jobs, all original matrix jobs, full Trace and Cases must complete successfully on that exact SHA. Inspect actual whole-file execution/zero skips in the three new partitions and both migration suites. New Prepare17, Request31 together, Transformation7, artifact composition7, structured migration117 remain explicit required gates.
- [ ] Inspect actual composition stdout for complete1/12/12 selections, private PDF/ZIP/all bytes/hashes/bounds and exact normal owned child disposal. Inspect full Trace260+2, verify/replay/budgets/disposal; Cases ordinary passes distinct from its4intentional expected failures. Existing preserved tests are not rerun locally solely to duplicate remote gates.
- [ ] For failure read exact step/log first, make only demonstrated scoped corrections with independent review and unchanged assertions/timeouts, and follow the new exact source. No blind retry, unrelated repair or release.
- [ ] Retain ignored evidence/ledger, report actual CI result and remaining demo boundary. If continued waiting needs a heartbeat, update the existing paused monitor to the exact new SHA/run IDs/partition requirements; quiet while unchanged. The task is not complete until actual green evidence exists.
