# Corrected Transformation execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development, a fresh implementer and independent reviewer for each task. Owner waived ordinary approval questions; no commit/push/release authority.

**Goal:** Atomically execute the fixed corrected Transformation after its completed Receiving amendment and verify current native provenance on replay.

**Architecture:** Corrected journal wrapper over existing native services and shared concrete Transformation content helpers; regular identity contracts remain strict.

**Tech Stack:** TypeScript/Zod/Drizzle/Nest services, Vitest and owned disposable PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-09-us-11-corrected-transformation-execution-design.md`.

## Global Constraints

- Work only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`, preserve inherited dirty work. No stage/commit/push/PR/merge/release/deploy/cleanup/env/dependency/schema/runtime/HTTP changes or shared-base writes.
- `us-processor-six-month-v1`, descriptor/recipe, June 11 2026, 300/400 lb → 60 case and Los Angeles timezone unchanged. No Cases/Shipping execution in this increment.
- Existing corrected input shape and original/amended Receiving history remain unchanged. Regular schemas/exports/errors/receipt bytes remain compatible; common proof must not manufacture regular identities.
- All native writes, proof and receipt are atomic; capture remains durable separately. Verify/replay cannot create/adopt/repair. Original errors/causes survive.
- Operation arbitration → Receiving root/revisions → known Transformation root/revisions → sorted union lots → references/documents. Both roots before any lot; private fresh mode only for this actual apply.
- Only `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev` for owned random children; DATABASE_URL unset. Fixture base is administrative entry only; never migrate/populate it. Drain workers before builds.
- Tests first, genuine behavioral RED then GREEN; missing imports/EPERM are not feature RED. No fake timers/retries/deadline increases to hide concurrency failures. No worker subagents. Controller owns package/static/final gates and baseline-byte review packages.
- Expanded CI owner is `Verify special dataset event examples on disposable databases`, original three suites followed by three corrected suites in one direct command, same fixture/worker/build/permissions/budget; all prior literal hash pins remain unchanged.

## Review Focus

- Exotic nested arrays/getters: both corrected entry points/result parsing reject without calling inherited iterators (Task 1).
- Self-consistent forged corrected input mapped to old origin: native proof binds actual current amendment/root/lot rows, not only receipt digest (Task 2).
- Root-before-lot inversion against public lifecycle: PID-observed blocked schedule and drainage, not timer guesses (Task 2).
- Native success with journal commit acknowledgement lost: replay existing winner without another write (Task 2).
- CI printed/guarded/duplicate new tests and predecessor drift: parsed mutations diagnose the precise invariant and preserve old pins (Task 3).

### Task 1: Shared result evidence and corrected result codec

Files:

- Create `apps/api/src/modules/traceability/demo/us-dataset-transformation-content.ts`.
- Modify `.../us-dataset-transformation-contract.ts` by mechanically extracting common business schema, metadata, semantic check and record-ID calculation; retain regular wrappers/exports/error behavior.
- Modify `.../us-dataset-corrected-transformation-contract.ts` only to export its existing safe JSON/error helpers for the new result codec; retain input/factory behavior.
- Create `.../us-dataset-corrected-transformation-result.ts`.
- Create `apps/api/test/support/us-dataset-corrected-transformation-fixture.ts` and `apps/api/test/us-dataset-corrected-transformation-contract.test.ts`.

Interfaces produced (define the types in the common/result modules):

```ts
// Structural content input asserts only a concrete chain, never regular Receiving identity.
type UsDatasetTransformationEvidence = Readonly<{
  input: Readonly<{ chain: UsSixMonthChain }>;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  createInput: CreateTransformationDraftInput;
  finalizeInput: FinalizeTransformationInput;
  created: TransformationDraftRecord;
  finalized: TransformationFinalizedRecord;
  outputLot: TraceabilityLot;
  inputLots: readonly Readonly<{ lineNo: number; lotId: string }>[];
}>;
type UsDatasetCorrectedTransformationResult = UsDatasetTransformationEvidence &
  Readonly<{ input: UsDatasetCorrectedTransformationInput }>;
// Export usDatasetTransformationEvidenceFields, metadata,
// checkUsDatasetTransformationEvidence and usDatasetTransformationEvidenceRecordIds.
function parseUsDatasetCorrectedTransformationResult(
  raw: unknown,
): UsDatasetCorrectedTransformationResult;
function usDatasetCorrectedTransformationRecordIds(
  result: UsDatasetCorrectedTransformationResult,
): readonly string[];
```

- [ ] Write behavior-first tests through minimal failing exports, then record expected assertion RED. Test parser strict shape/codec, caller ownership/freezing, bounds/getter/array safety, original versus amended mappings, quantity/UOM/doc/source/native lifecycle/operation/owned-ID mutations. Expected errors are `us_dataset_corrected_transformation_result_invalid`; fixed safe unit/stage and cause retained.
- [ ] Lift current regular `checkResult` verbatim into shared structural evidence check (its `result.input.chain` path still works), common native field schemas and record-ID logic; retain regular input parsing and `US_DATASET_TRANSFORMATION_METADATA` export through re-export. Export the existing local JSON guard as `assertUsDatasetCorrectedTransformationJson(raw)` and fixed-context error construction as `datasetCorrectedTransformationError(code, cause?)`, adding the three spec result/conflict/mismatch codes without changing existing input behavior. Do not weaken any current assertion or broaden regular input. Corrected parser reuses the shared check, then requires exact `inputLots === input.receivingOrigin.inputLots`, canonical lowercase owned IDs/operation keys, and returns a frozen owned clone.
- [ ] Build the native fixture through real references + `UsDatasetSpecialSeedStore.initialize(context,"correction")`. Read actual persisted references/amendment stages, build accepted corrected input/intent; expose `prepareDatasetCorrectedTransformation(db,context)` returning header/stages/parsed lifecycle/stores/input/intent and an independent native `apply(tx)` witness. That witness directly invokes document/create/readiness/finalize/lot-read services in the caller's tx, not the later executor/helper under test. No stage receipt is fabricated as persisted evidence.
- [ ] In one correctly gated native block, parse actual witness result and assert literal 300/400 inputs, 60 case output, date, retained inbound IDs, distinct current/original Receiving identities and four owned IDs; mutate self-consistent root/operation/document/mapping aliases and ensure rejection. Use existing `specialFixture` lifecycle or equivalent registered full-phase drainage; one native skip block and `base` variable for CI inspection.
- [ ] Run exact pure/owned-native new suite, unchanged regular Transformation contracts, current corrected input/special contracts and API typecheck if necessary. Preserve existing warnings; never overlap DB and builds. Self-review/report with RED/GREEN/commands/counts/skips/concerns. No commits.

### Task 2: Shared native proof and corrected durable execution

Files:

- Create `.../us-dataset-transformation-apply-content.ts` and `.../us-dataset-transformation-verify-content.ts`.
- Modify `.../us-dataset-transformation-seed.ts`, `.../us-dataset-transformation-verify.ts`, `.../us-dataset-transformation-locks.ts` only for mechanical common-helper delegation, preserving regular semantics/lock order/errors.
- Create `.../us-dataset-corrected-transformation-prepare.ts`, `.../us-dataset-corrected-transformation-verify.ts`, `.../us-dataset-corrected-transformation-seed.ts` (keep each responsibility focused).
- Create `apps/api/test/us-dataset-corrected-transformation-seed.e2e.test.ts`, `...locks.e2e.test.ts`; extend only own fixture as needed.

Consumes Task 1 structural evidence/result parser and `prepareDatasetCorrectedTransformation`; uses accepted `makeUsDatasetCorrectedTransformationInput`, `verifyUsDatasetSpecial`, existing native operation arbitration and journal supplied transaction.

```ts
class UsDatasetCorrectedTransformationSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext): Promise<UsDatasetCorrectedTransformationResult>;
  verify(context: UsDatasetContext): Promise<UsDatasetCorrectedTransformationResult>;
}
// Internal helpers have concrete chain/bindings/ordered lot inputs, not fake regular identity.
// applyUsDatasetTransformationContent returns Omit<UsDatasetTransformationEvidence,"input">.
// verifyUsDatasetTransformationContent consumes parsed evidence and a trusted output-lot check.
```

- [ ] First add failing owned-DB tests for the real output and persisted journal receipt. Prerequisites must already be installed by the fixture, not executor recursion. Assertions include real Receiving current event revision2/root lifecycle4, unchanged original250/400, actual Transformation300/400→60, docs2, outputlot1, genealogy2, exact native command/audit tuples and current basis. RED must reach real assertions, not missing import or socket denial.
- [ ] Extract regular native apply from post-prerequisite checks through document/create/readiness/finalize/lot read. Keep conflict checks for create/finalize operations, recipe document duplicates and TLC/source before native writes. Extract regular proof's existing native rows/genealogy/documents/command/audit body into shared verifier; wrappers retain prerequisite checks, locking and error translation. Existing regular output status checker runs at its original proof position via a narrow internal callback; corrected checks immutable lot identity instead. Do not copy large verification blocks or introduce public policy selectors.
- [ ] Extract root/revision/sorted-lot SQL into a reusable internal row-lock helper in the existing locks module. Corrected callers arbitrate create/finalize first, then lock original Receiving root/all revisions, known Transformation root/all revisions on replay, then union sorted lots. Fresh mode has no preexisting Transformation root. After these locks validate persisted references + completed original/amendment and rebuild exact corrected input, then call `verifyUsDatasetSpecial` for actual current/history state.
- [ ] Implement durable intent capture/winner reconciliation and one `runAtomicStage` application/proof/receipt. Corrected result parse wraps shared body and exact input. Apply-success-local boolean controls fresh mode; all other calls replay. Context annotations fixed correction/transformation without replacing primary errors. Native calls start no nested transaction/retry/pool read.
- [ ] Add no-write full-table snapshot tests for repeat initialize/verify, missing/pending prerequisites, wrong owner/tenant/DB/profile, orphan envelope, forged/different stage/digests, stale/pending/void origins and business drift. Verify fails absent/pending without capture. Preexisting unreceipted documents/operation/output conflicts cannot be adopted. Legitimate downstream consumption changing only technical tokens remains accepted; use real native consumer and rollback deliberate invalid orphan attempt, not persisted filler drafts.
- [ ] Inject actual owned SQL failpoints at document/business/audit/operation/receipt writes; compare whole-table rollback except durable captured intent, then resume same key successfully. Test concurrent initializer winner and ambiguous post-commit acknowledgement recovery. Raw retryable SQL cause identity preserved, one native attempt, no internal retry. Test helper functions only create/drop unique invocation-owned triggers on its child DB.
- [ ] Write PID-observed public/native lifecycle lock schedules in both orders. Exercise corrected replay holding Receiving root/revisions while public Receiving amendment waits. Preserve existing lifecycle semantics: amendment start may create a pending draft even with downstream consumers; subsequent corrected replay must reject the changed lifecycle, while incompatible amendment finalization/void is downstream-blocked. Also exercise Transformation void/amend against current replay and the inversion-sensitive Receiving/Transformation root-before-input-lot case. Register work before continuations; release gates in finally before draining observed workers; no acquisition or setup overlap after timeout. Compare concrete outcomes and actual current state, not mocked locks or sleeps. One native gate/base variable per suite.
- [ ] Run new three suites configured serially plus regular Transformation contract/verify/seed/locks, existing special seed/locks and regular Shipping status regressions. Keep root package/static/build gates controller-owned. Self-review exact task delta and report honest ordinary/expected cancellation counts, skips/warnings and timing. No commits or worker subagents.

### Task 3: Expand existing special CI ownership and document evidence

Files:

- Modify `.github/workflows/us-development.yml` only its current special owner.
- Modify `tools/us-development/test/dataset-special-ownership.test.mjs` to own the expanded six suites and exact prior-owner reconstruction.
- Modify historical preservation filters only in `tools/us-development/test/isolation.test.mjs`, `...dataset-regular-ownership.test.mjs`, `...receiving-lifecycle-ownership.test.mjs` by retaining old exclusion and adding the new owner name. Keep all existing literal pins unchanged.
- Append bounded actual checkpoint to `docs/us/development-isolation.md` and `docs/us/implementation-plan.md`; do not overwrite chronology or make unsupported claims.

Exact owner and ordered command:

```yaml
- name: Verify special dataset event examples on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-special-contract.test.ts test/us-dataset-special-seed.e2e.test.ts test/us-dataset-special-locks.e2e.test.ts test/us-dataset-corrected-transformation-contract.test.ts test/us-dataset-corrected-transformation-seed.e2e.test.ts test/us-dataset-corrected-transformation-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Snapshot actual current owner/full workflow byte and AST hashes in own report before editing. Add failing parsed ownership test expectations/new-suite missing/quoted duplicate/guarded/printed/wrong-fixture/missing-build mutations, before workflow change. Reuse current executable ownership grammar and mutation helper; no copied parallel validation implementation.
- [ ] Rename existing owner and append corrected suites after original three, without adding a step/job/service or changing any other command/build/permissions/budget/lock. Update its Node ownerName/files/raw expanded owner block. Existing removal must still restore all unchanged historical pre-special-owner pins; historical filters gain only new name exclusion and retain old names.
- [ ] Add byte+AST assertion that replacing exactly the expanded owner with captured original three-suite block reconstructs this increment's entire current predecessor workflow. Preserve actual comments/newlines, diagnose AST-neutral byte drift. Existing mutation loop must exercise all six explicit selections, global aliases/duplicate inclusion and actual unconfigured native predicates under aggregate collection. Keep original literal pins/sequences intact; no blanket relaxation/checker change.
- [ ] Run safe Node `node --test tools/us-development/test/*.test.mjs`, checker, scoped ESLint/Prettier and diff checks. Verify only owned workflow block and allowed filter edits differ. Report command/counts/mutation diagnostics; no remote CI claim or dispatch.
- [ ] Append evidence provided by approved Tasks 1/2 and controller only, clearly labelled separate snapshots/runs. Record corrected current-origin execution, retained history, atomic recovery, local fixture-only population; Cases/Shipping/full dataset/artifacts/CLI/browser/hosting remain next. Preserve prior full-package nongreen causes, Vite warning and wider shared-walker limit. No unsupported counts/timings.

## Controller final gates

Fresh baseline bytes per task and complete source manifest; independent task spec/quality reviews before next task. Run exact expanded six-suite configured command and proportionate affected regressions without overlap, API typecheck/lint/build, unfiltered package command with both DB vars unset, safe tooling/checker, formatting and diff checks. Report missing-configuration/skip failures by name, not fabricated green totals. Then one most-capable whole-increment review and at most one scoped final fix wave. Retain ignored evidence because Git commit/cleanup is unauthorized. No branch integration or release action.
