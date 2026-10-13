# US-11 dataset Trace/Readiness verification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prove completed six-month chain units are correctly exposed by the existing Trace and Readiness read models.

**Architecture:** A read-only internal verifier authorizes the pinned dataset target, verifies native predecessors, then consumes existing Trace/Readiness and history services. It returns stable owned bounded evidence without claiming complete dataset acceptance or installing prerequisites.

**Tech Stack:** Node 24, TypeScript, existing Drizzle/PostgreSQL stores, Zod and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-dataset-trace-readiness-design.md`; parent `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve unrelated work.
- Keep `datasetComplete: false`; no Plan/Request or hosted acceptance is implied.
- Use pinned period `2026-04-01` through `2026-09-30` and existing Trace/Readiness services and rules.
- No recipe/schema/public contract/dependency/release edits, timeout increases, assertion weakening or shared-base writes.
- Native tests receive only `US_TEST_DATABASE_URL`; `DATABASE_URL` stays unset. Use randomized owned child databases and existing lifecycle helpers.
- Follow TDD with real native integration evidence, then independent spec and quality review. Do not spawn nested agents.

## Review Focus

- A forged journal receipt is not current business evidence: native stage verification must reject actual drift.
- The corrected old revision must not appear as current; verify superseded history using actual IDs.
- The orphan's expected missing origin is required, not suppressed to obtain clean readiness.
- New assessment timestamps must not change semantic evidence digests; all other readiness facts remain included.
- Partial or unauthorized verification must never initialize or repair records; compare full-table hashes and drain owned work on all paths.

### Task 1: Read-only native unit verifier and acceptance

**Files:**

- Create: `apps/api/src/modules/traceability/demo/us-dataset-trace-readiness.ts` (selector validation, native prerequisites and service-owned proof).
- Create if needed: `apps/api/src/modules/traceability/demo/us-dataset-trace-readiness-evidence.ts` (focused deterministic evidence validation/projection only).
- Create: `apps/api/test/us-dataset-trace-readiness.e2e.test.ts` (real disposable DB integration).
- Modify: `docs/us/development-isolation.md` and `docs/us/implementation-plan.md` (truthful scoped evidence after validation).

**Interfaces:**

Consumes `UsDatasetJournalStore.read(context)`, existing regular/corrected Shipping and special Receiving verifiers, and `UsTraceStore.read/readiness/history` from current code. Use existing checked Receiving/Transformation receipts when deriving exact event-line expectations.

Produces:

```typescript
export type UsDatasetTraceReadinessUnit =
  | Readonly<{ kind: "regular"; index: number }>
  | Readonly<{ kind: "correction" }>
  | Readonly<{ kind: "orphan" }>;

export class UsDatasetTraceReadinessStore {
  constructor(db: Db);
  verify(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetTraceReadinessResult>;
}
```

Result fields: `datasetId`, `version`, `definitionDigest`, `unitKey`, literal `state: "trace_readiness_verified"`, literal `datasetComplete: false`, ordered `lotIds`, ordered `currentEventIds`, and ordered per-lot `evidence` with `lotId`, `traceDigest`, `readinessDigest`, `historyDigest` and `originGap`. Arrays and nested records must be deeply frozen independent copies. Bound the result with `assertBoundedSyntheticJson`.

- [ ] Write the focused native test first; use `createUsDatasetJournalFixture`, `runDatasetCasesFixtureBody` and the existing work ownership helpers. The initial observable assertion is:

```typescript
await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
const before = await f.snapshot();
const result = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
  kind: "regular",
  index: 0,
});
expect(result).toMatchObject({
  unitKey: "chain_0000",
  state: "trace_readiness_verified",
  datasetComplete: false,
});
expect(result.lotIds).toHaveLength(3);
expect(result.currentEventIds).toHaveLength(4);
expect(result.evidence.every((row) => row.originGap === false)).toBe(true);
expect(await f.snapshot()).toEqual(before);
```

- [ ] Run the test and record the expected RED before implementation. Do not count a missing import or broken fixture as a meaningful behavioral RED; a minimal unavailable verifier may be used to establish the assertion failure.
- [ ] Implement the minimal real verifier. Validate selectors strictly after authorization, use native `verify` only, read exact three-lot/event/quantity expectations from checked service evidence, call `UsTraceStore` and reject limited/unrelated/mismatched current evidence. For each lot read pinned-period readiness and applicable actual excluded history. Hash all semantics except `assessedAt`; never strip findings or counts.
- [ ] Add real integration tests for regular index 1 and Scenario A 259, corrected chain, orphan retained lots, incomplete stages, malformed selectors, wrong tenant/owner/database and drift. Check no-write snapshots on success, replay, denial and drift. Test output ownership/bounds and repeat evidence despite advancing assessment time. Derive expected quantities from hand-checked recipe facts/native record IDs independently of the new verifier.
- [ ] Run focused tests with Node 24 in the API cwd using the existing native test setup. All native assertions must actually run, not silently skip. Use the fixture's existing budgets and report lifecycle cleanup; do not edit old tests or global timeouts.
- [ ] Run API typecheck/lint/build, changed-file formatting and `git diff --check`. Root controller owns the subsequent complete API package gate; avoid concurrent heavy DB gates and do not trigger package reinstall while other tools use dependencies.
- [ ] Append truthful scoped implementation evidence to the two US progress documents, preserving old checkpoints.
- [ ] Self-review, then report full TDD/native/static evidence to the plan workspace. Do not commit, push or change CI ownership in this task; root controller stages only reviewed explicit paths after final checks.

## Follow-on boundary

After this independently reviewed slice, integrate durable `trace_readiness`
receipts and bounded all-unit orchestration, then Plan/Request artifact stages and
the explicit complete-dataset initializer. These are not represented as finished
by this plan. External hosting must retain US-only storage and the dedicated
release boundary rather than enabling inherited RU destinations.
