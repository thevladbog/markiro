# US-11 corrected Transformation input implementation

> Required execution: subagent-driven development, fresh task implementer and independent task review, followed by independent whole-increment review.

**Goal:** Bind the corrected chain's future Transformation input to completed Receiving revision 2 without broadening regular-chain contracts.

**Spec:** `docs/superpowers/specs/2026-10-09-us-11-corrected-transformation-input-design.md`.

**Architecture:** A pure strict codec plus factory reuses existing special intent/receipt/result validation. Actual business execution and current-row locking are separate later increments.

**Tech:** TypeScript, existing Zod/domain/contracts, Vitest and the existing disposable US fixture.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve inherited dirty work.
- No stage/commit/push/PR/merge/release/deployment/cleanup, environment/dependency/schema changes or shared-base writes.
- Keep `us-processor-six-month-v1`, descriptor digest, April–September 2026 Los Angeles recipe and regular codecs unchanged.
- New codec `us-dataset-corrected-transformation-input-v1` binds `correction_0001/amend_receiving`, completed journal revision 2 and current event revision 2/lifecycleVersion 4; original receipt is never the prerequisite.
- Validate descriptor-safe bounded JSON before reading caller properties; return deeply frozen owned copies. Errors contain fixed safe unit/stage context, no raw values.
- Preserve all existing test assertions/fixture drainage. The existing owned DB witness uses only explicit `US_TEST_DATABASE_URL`, never `DATABASE_URL`.
- Production source scope is one new contract module. Existing native services, workflow bytes, public/shared schemas and regular contracts remain unchanged.
- Do not dispatch subagents from worker/reviewer tasks. Controller owns broad gates and review packages. Reviews operate on increment baseline bytes, not the inherited dirty branch diff.

### Task 1: Implement corrected input contract with behavioral evidence

Read the linked spec completely and relevant repository/API guides before edits.

Files:

- Create `apps/api/src/modules/traceability/demo/us-dataset-corrected-transformation-contract.ts`.
- Extend `apps/api/test/us-dataset-special-contract.test.ts` only for this contract; preserve original blocks/assertions and fixture lifecycle.

1. Write focused failing behavioral tests before implementation; a missing import alone is not RED. A temporary minimal export skeleton may allow actual assertions to fail for missing validation/derivation. Record the failing command/output.
2. Export `UsDatasetCorrectedTransformationInput`, `parseUsDatasetCorrectedTransformationInput(raw)` and `makeUsDatasetCorrectedTransformationInput(references, amendmentStage)`. Follow the spec's exact shape, codec/error strings, identity relationships and frozen-copy rules. Use existing `parseUsDatasetIntent`, `parseUsDemoReceipt`, `parseUsDatasetSpecialResult`, `usDatasetSpecialRecordIds`, descriptor and bounded JSON helper, avoiding cloned native result validation or generic abstractions.
3. Parser tests use independent literal expectations for 300/400 lb, 60 case, event date 2026-06-11 and origin mappings; test altered recipes/IDs/digests/datasets/stages, alias UUIDs, duplicate mappings/IDs, unknown fields and hostile/oversized JSON. Verify callers remain unfrozen and unchanged. Factory tests distinguish pending prerequisite from invalid/forged dependency.
4. Extend the existing actual native service witness after its genuine amendment result. Construct a strict codec-witness completed row with canonical intent/result digests and record IDs, assert derived amendment identity and current root/event/lot mapping. Mutate operation key, input, record IDs, result digest, references, original/void/unit/stage/revision envelopes and ensure rejection. Clearly label this as a codec witness, not persisted amendment journal evidence. Keep teardown, signal/work drainage and original timer unchanged.
5. Run the full changed suite with both DB variables unset for pure collection, then configured on invocation-owned disposable PostgreSQL after checking no inherited DATABASE_URL. Run adjacent regular Transformation/special contract regressions. Do not rebuild while DB workers are alive. Report commands, exit/counts/skips/warnings and any failure honestly. Controller runs ordinary package/static/build/tooling gates once.
6. Self-review the exact task delta. Write the report in this plan's SDD workspace with RED/GREEN evidence, changed paths and concerns. Do not commit or spawn agents.

## Controller acceptance

Capture current source bytes before dispatch. Review Task 1 independently against its brief/report/delta. Resolve concrete findings through the implementer and scoped re-review. Verify unchanged CI ownership/workflow bytes; run fresh API typecheck/lint/build, full API test command with primary DB unset, safe isolation tooling, formatting and diff checks. Record the full API's actual failures/skips separately. Update only this increment's documentation with actual results and remaining native executor scope. Run most-capable whole-increment review on all new/changed increment files. Retain ignored evidence because no commits/cleanup are authorized; do not offer branch integration or declare the overall US MVP complete.

## Local execution checkpoint

Task implementation passed independent spec/quality review. Whole-increment review subsequently found exotic array prototypes could reach inherited iterator getters through the shared bounded walker and canonical digest. Actual compiled helper/digest reproduction confirmed that path. One scoped final fix adds a descriptor-only local guard to this new contract; parser/factory regressions reproduced getter calls before the fix and assert zero calls after it. The scoped source re-review marks the finding addressed without new breakage; final acceptance is recorded in the local execution report.

Final controller three-suite run selects the changed special contract suite plus unchanged regular Transformation and regular-range contracts: **115/115**, zero skips, 6.56 s, with the explicit US fixture URL. The genuine native amendment witness ran in its own disposable child; base URL is only the fixture administration entry, not its business database. The initial controller attempt was rejected pending this proof, then the identical command was permitted after tracing `createUsDatasetJournalFixture` → `createUsDemoJournalFixture` → `createUsProfileTestDatabase`. No shared-base business writes occurred.

The worker's final changed-suite checks were pure **26 passed / 1 native skip**, configured **27/27**, and separate adjacent pure contracts **114 passed / 1 native skip**. These are covering runs, not additive unique-test totals. Original assertions, acquisition/drainage and timers remain unchanged. Existing Vite CommonJS/native-loader warning is retained, not suppressed.

The ordinary full API run occurred **before the final array-guard repair**, with both database variables unset: exit1 in 494.53 s; 474 files (8 failed, 213 passed, 253 skipped); 7179 tests (2711 passed, zero assertion failures, 4468 skipped). Failed files: `billing-accounts.e2e.test.ts`, `exchange-credentials.e2e.test.ts`, `exchange-import.e2e.test.ts`, `exchange-orders.e2e.test.ts`, `exchange-protocol.e2e.test.ts`, `integrations-delete.e2e.test.ts`, `integrations.e2e.test.ts`, `subscription-route-inventory.test.ts`. Setup fails at `loadEnv` for missing auth/origin/pepper settings; seven also lack `DATABASE_URL`. Exchange import/orders/protocol have secondary cleanup failures on undefined `db.delete`. The full run's changed-suite subset was 24 passed/1 skipped. It is not a full final-source gate or configured database coverage. That broad run was not repeated after the local repair; covering contracts and static/build gates are repeated, with no full-package green claim.

The existing workflow and native/regular/public sources retain captured baseline bytes. CI already selects the changed suite after shared/API builds; no owner/command/permission/release-lock change was needed. Local safe Node tooling passed **83/83**, zero skips; isolation checker and repository formatting passed. These checks do not verify remote CI or hosted settings.

After the final native fixture drained, fresh whole API typecheck, lint and build all exited0. Final four-path Prettier check, isolation checker and `git diff --check` exited0 after the documentation checkpoint; the earlier repository-wide formatting gate also passed. No build overlapped a database worker.

No server executor, result receipt codec, current-row lock protocol, corrected Transformation/Cases/Shipping business data, runtime/CLI/HTTP registration, full population, Plan/Request artifacts, browser/manual/external-provider/hardware or deployment acceptance is supplied by this pure foundation. No Git publication, shared-base initialization, dependency/env/schema or infrastructure change occurred. Next increment is native corrected Transformation application and canonical current-state verification.
