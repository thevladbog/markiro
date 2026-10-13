# US-11 durable Trace/Readiness progress implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Persist verified Trace/Readiness progress and compose all 262 dataset units without prematurely declaring the demo complete.

**Architecture:** A per-unit stage wraps the independently accepted read-only proof with existing journal capture/receipt operations. A separate sequential coordinator composes the unchanged native seed and all regular/corrected/orphan stages. Canonical revalidation, not receipt existence, establishes each result.

**Tech Stack:** Node 24, TypeScript, existing PostgreSQL/Drizzle journal and service stores, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-trace-readiness-progress-design.md` and the accepted six-month specification.

## Global Constraints

- Work only in the existing `codex/us-mvp` worktree; no shared-base population or environment edits.
- Preserve recipe identity, existing journal/native contracts, existing assertions and timeouts; no new complete composition budget greater than 900000ms.
- Keep `datasetComplete: false`; Plan/Requests, viewer and hosting are separate uncompleted gates.
- Use only existing authorized journal operations and native/read-model proof; never substitute a receipt for current business evidence or claim one snapshot across independent reads.
- Native tests use owned disposable children of `127.0.0.1:55432/markiro_us_dev`, role `markiro_us`, with `DATABASE_URL` unset and only `US_TEST_DATABASE_URL` supplied.
- No schema, public API, HTTP/UI, dependency, release, credential or CI edits; no commit or push by implementer.

## Review Focus

- Concurrent capture must retain the winner's exact operation identity, not allocate duplicate receipts.
- A persisted pending intent must resume but verify must reject without filling it.
- Source drift with old receipts must fail native proof rather than silently rewriting evidence.
- Original exceptions and unit/stage diagnostics must survive without invented global rollback.
- All-unit result must require 262 actual checked stages; a smaller range cannot masquerade as complete composition.

### Task 1: Durable per-unit stages and full sequential composition

**Files:**

- Create `apps/api/src/modules/traceability/demo/us-dataset-trace-readiness-stage.ts` for guarded journal progress.
- Create `apps/api/src/modules/traceability/demo/us-dataset-trace-readiness-seed.ts` for sequential full composition.
- Create `apps/api/test/us-dataset-trace-readiness-stage.e2e.test.ts` for real stage lifecycle and denial tests.
- Create `apps/api/test/us-dataset-trace-readiness-seed.e2e.test.ts` for complete native composition.
- Modify only the two US progress documents to append actual measured evidence.

**Interfaces:**

Consumes the accepted `UsDatasetTraceReadinessStore.verify(context, unit)`, selector/result types, `UsDatasetJournalStore.read/readStage/captureIntent/recordReceipt` and unchanged `UsDatasetNativeSeedStore.initialize/verify`.

Produces:

```typescript
export class UsDatasetTraceReadinessStageStore {
  constructor(db: Db);
  initialize(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetTraceReadinessResult>;
  verify(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetTraceReadinessResult>;
}
export class UsDatasetTraceReadinessSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext): Promise<UsDatasetTraceReadinessSeedResult>;
  verify(context: UsDatasetContext): Promise<UsDatasetTraceReadinessSeedResult>;
}
```

Seed result has dataset identity, literal state `native_chains_trace_readiness_verified`, false completion and 262 ordered `{ unitKey, resultDigest }` entries. Bound and deeply freeze owned arrays/objects. Stage input codec is `us-dataset-trace-readiness-stage-v1`, with checked identity/selector and exact completed predecessor binding; never accept arbitrary caller-provided proof.

- [ ] Write an actual fresh-stage test after native chain initialization. Assert a new journal `trace_readiness` row has revision 2, the original operation key, exact owned record IDs, native result digest and literal false completion. Run and record meaningful RED before implementation.

```typescript
await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
const result = await stage.initialize(context, { kind: "regular", index: 0 });
const header = await journal.read(context);
if (!header) throw new Error("Missing owned dataset header");
const saved = await journal.readStage(context, header.id, "chain_0000", "trace_readiness");
expect(saved?.revision).toBe(2);
expect(saved?.receipt?.resultDigest).toBe(canonicalExportDigest(result));
expect(saved?.receipt?.recordIds).toEqual([
  ...new Set([...result.lotIds, ...result.currentEventIds]),
]);
const before = await f.snapshot();
expect(await stage.verify(context, { kind: "regular", index: 0 })).toEqual(result);
expect(await stage.initialize(context, { kind: "regular", index: 0 })).toEqual(result);
expect(await f.snapshot()).toEqual(before);
```

- [ ] Implement exact bounded input/predecessor comparison, original pending-key reuse, compatible competing capture reconciliation and complete receipt comparison using the existing journal. Verify never writes; native/read-model errors escape unchanged. New progress conflicts must identify unit and `trace_readiness` stage without masking infrastructure failures.
- [ ] Add native tests for missing/pending stage no-write refusal, explicit pending resume, concurrent compatible initialization, incompatible intent/receipt, correction and orphan receipts, target/tenant/owner denial and supported lifecycle drift. Full-table snapshots establish no repair/no replay writes. Use existing owned asynchronous-work helpers and drain each phase before disposal.
- [ ] Add the sequential full coordinator with no range argument or test-only production seams. Write/read the unchanged native seed first, then units 0..259, correction and orphan. Only after all actual stage proofs return create the bounded immutable summary. Propagate the original error and leave already committed earlier progress intact.
- [ ] Run complete native acceptance in one owned fixture with the same 900000ms per-test budget: actual initialization, exact counts964roots/963current-finalized/785lots/15700boxes/262 completed Trace-Readiness stages, no Plan/Requests, false completion, then full no-write verify and initialize replay. Record measured elapsed phases and actual disposal absence. Do not increase any budget if it fails; diagnose redundant reads and preserve all assertions.
- [ ] Run focused stage tests and adjacent read-only proof/native coordinator regressions. Run API typecheck/lint/build, formatting and `git diff --check`; root owns complete ordinary API validation and later explicit CI ownership.
- [ ] Append truthful evidence to US progress documents. Self-review and report TDD, exact commands/counts/timings, skipped gates and cleanup to the plan workspace. Do not commit/push or spawn nested agents.
