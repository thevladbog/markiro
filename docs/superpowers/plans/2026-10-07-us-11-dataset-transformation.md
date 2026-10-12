# US-11 dataset Transformation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use a separate implementer and independent reviewer for each task, followed by final controller verification.

**Goal:** Atomically install and verify one regular six-month synthetic Transformation chain from its actual Receiving prerequisites.

**Architecture:** A strict immutable codec binds the recipe to two prerequisite receipt identities. An internal executor uses existing guarded `runAtomicStage` and native Transformation commands; a canonical verifier prelocks both owned event roots before lots on replay. No runtime, route, bulk generator or deployment is added.

**Tech Stack:** Node 24+, repository Corepack pnpm, TypeScript, Zod, Drizzle, PostgreSQL, Vitest and existing US tooling contracts.

**Spec:** `docs/superpowers/specs/2026-10-07-us-11-dataset-transformation-design.md` (owner-approved 2026-10-07).

Status: owner-approved 2026-10-07; bounded implementation and four task reviews complete; final whole-increment review Approved. Controller configured 34-file gate passed 760/760 without skips. Full unconfigured API gate remains nongreen (eight setup-failed files); no integration or publication performed. Detailed execution evidence and checkbox disposition are retained in `.superpowers/sdd/2026-10-07-us-11-dataset-transformation/progress.md`.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve the accepted dirty baseline and empty index.
- Preserve `us-processor-six-month-v1`, April through September 2026, `America/Los_Angeles`, all recipe quantities/UOM/TLCs and Scenario A.
- Handle regular `chain_0000` through `chain_0259` individually; no correction/orphan execution or full-volume population.
- Both intent and result stay within 256 KiB; no whole-dataset array, larger limit, migration or new receipt table.
- Retain guarded read-committed journal isolation. Native commands neither open nor retry a transaction. Public service isolation and errors remain unchanged.
- Reference installation and same-chain Receiving completion are explicit prerequisites, never installed implicitly or adopted from unrelated rows.
- Preserve actual technical timestamps and event-number year; historic business dates do not backdate clocks.
- No dependency/env changes, stage/commit/push/PR/merge/release, primary checkout writes, archive/design edits, shared-base mutations or hosting.
- Cases, Shipping, Plan/Requests artifacts, viewer and deployment remain subsequent work. Eventual hosted storage/infrastructure remains outside RF.
- Read root/scoped instructions and `docs/us/development-isolation.md` before execution. Graphify graph is absent: use current source without installing tooling.
- Test only owned disposable children of `US_TEST_DATABASE_URL`; leave `DATABASE_URL` unset. Drain mutable fixture workers before shared builds. Database suites run serially with `--maxWorkers=1`.

## Review Focus

1. A completed Receiving from another regular chain must fail before native writes, even if its product set matches (Tasks 1 and 3).
2. Replay racing a public Transformation lifecycle writer must prelock the Transformation root before inbound lots, avoiding root/lot inversion (Task 2).
3. Legitimate downstream consumption must preserve byte-identical replay without pinning stock or mutable basis versions (Tasks 2 and 3).
4. Lost commit acknowledgement or concurrent capture must reuse the winning operation key and original receipt, not create replacements (Task 3).
5. Failure/cancellation before readiness or during an actual PostgreSQL lock wait must release every owned worker/resource without replacing the primary error (Tasks 2 and 3).

## File map and interfaces

Create under `apps/api/src/modules/traceability/demo/`:

- `us-dataset-transformation-contract.ts`: strict raw-safe input/result codecs, dependency identity and owned record IDs.
- `us-dataset-transformation-locks.ts`: receipt-bound root/revision/lot lock ordering, fresh versus replay paths.
- `us-dataset-transformation-verify.ts`: current canonical business evidence, no writes or adoption.
- `us-dataset-transformation-seed.ts`: guarded capture, native application and recovery.

Create tests under `apps/api/test/`:

- `us-dataset-transformation-contract.test.ts`
- `us-dataset-transformation-verify.e2e.test.ts`
- `us-dataset-transformation-locks.e2e.test.ts`
- `us-dataset-transformation-seed.e2e.test.ts`

Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md` and `docs/us/implementation-plan.md` only in Task 4. Native product services, database schema, recipe and existing Receiving verifier are read-only unless a demonstrated safety gap is reported for a separately approved scoped correction.

The following exported types live in the new contract module. Imported names already exist in `@markiro/platform-contracts`, `us-dataset-contract.ts`, `us-dataset-receiving-contract.ts` and `us-six-month-chains.ts`.

```ts
export type UsDatasetReceivingIdentity = Readonly<{
  datasetId: string;
  unitKey: string;
  stage: "receiving";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
export type UsDatasetTransformationErrorCode =
  | "us_dataset_transformation_input_invalid"
  | "us_dataset_transformation_result_invalid"
  | "us_dataset_transformation_prerequisite_incomplete"
  | "us_dataset_transformation_dependency_conflict"
  | "us_dataset_transformation_conflict"
  | "us_dataset_transformation_mismatch";
export type UsDatasetTransformationInput = Readonly<{
  codec: "us-dataset-transformation-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetReferenceIdentity;
  receiving: UsDatasetReceivingIdentity;
  chain: UsSixMonthChain;
}>;
export type UsDatasetTransformationResult = Readonly<{
  input: UsDatasetTransformationInput;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  createInput: CreateTransformationDraftInput;
  finalizeInput: FinalizeTransformationInput;
  created: TransformationDraftRecord;
  finalized: TransformationFinalizedRecord;
  outputLot: TraceabilityLot;
  inputLots: readonly Readonly<{ lineNo: number; lotId: string }>[];
}>;
```

Arrays are runtime-exact: two distinct documents in recipe order, two distinct inbound mappings with line numbers 1/2, one output. Native record schemas do not carry a command operation key; retained `createInput`/`finalizeInput` are therefore mandatory independently checked evidence, not inferred responses.

## Task 1: Strict descriptor, dependency and result contracts

**Files:** Create contract module and `us-dataset-transformation-contract.test.ts`.

**Consumes:** `makeUsSixMonthRegularChain(index: number): UsSixMonthChain`, `usSixMonthDefinition`, `assertBoundedSyntheticJson`, existing native schemas and `canonicalExportDigest`.

**Produces:** Types above and these exports:

```ts
makeUsDatasetReceivingIdentity(datasetId: string, stage: UsDatasetStageRow): UsDatasetReceivingIdentity;
makeUsDatasetTransformationInput(index: number, references: UsDatasetReferenceIdentity,
  receiving: UsDatasetReceivingIdentity): UsDatasetTransformationInput;
parseUsDatasetTransformationInput(raw: unknown): UsDatasetTransformationInput;
parseUsDatasetTransformationResult(raw: unknown): UsDatasetTransformationResult;
usDatasetTransformationRecordIds(result: UsDatasetTransformationResult): readonly string[];
datasetTransformationError(code: UsDatasetTransformationErrorCode, unitKey: string,
  cause?: unknown): Error & { unitKey: string; stage: "transformation" };
```

- [ ] Write RED tests with independently constructed identities; do not import private fixtures from another test. Example complete input test:

```ts
const datasetId = "00000000-0000-4000-8000-000000000001";
const references: UsDatasetReferenceIdentity = {
  datasetId,
  unitKey: "references",
  stage: "references",
  revision: 2,
  operationKey: "00000000-0000-4000-8000-000000000002",
  inputDigest: "a".repeat(64),
  resultDigest: "b".repeat(64),
};
const receiving: UsDatasetReceivingIdentity = {
  datasetId,
  unitKey: "chain_0259",
  stage: "receiving",
  revision: 2,
  operationKey: "00000000-0000-4000-8000-000000000003",
  inputDigest: "c".repeat(64),
  resultDigest: "d".repeat(64),
};
it("rejects another chain's otherwise valid receipt identity", () => {
  expect(() =>
    makeUsDatasetTransformationInput(259, references, { ...receiving, unitKey: "chain_0258" }),
  ).toThrow();
});
it("preserves the exact recipe rather than accepting quantity drift", () => {
  const input = makeUsDatasetTransformationInput(259, references, receiving);
  const raw = structuredClone(input);
  expect(() =>
    parseUsDatasetTransformationInput({
      ...raw,
      chain: {
        ...raw.chain,
        transformation: {
          ...raw.chain.transformation,
          output: { ...raw.chain.transformation.output, quantity: "101" },
        },
      },
    }),
  ).toThrow();
});
```

- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-transformation-contract.test.ts`; RED must be a missing export/assertion, not setup failure.
- [ ] Implement raw descriptor inspection before traversal, bounded JSON validation before Zod, strict schemas and canonical equality after parsing. Build expected descriptor with `makeUsSixMonthRegularChain`, never normalize stored evidence into acceptance:

```ts
const chain = makeUsSixMonthRegularChain(index);
if (receiving.unitKey !== chain.unitKey || receiving.datasetId !== references.datasetId)
  throw datasetTransformationError("us_dataset_transformation_dependency_conflict", chain.unitKey);
return parseUsDatasetTransformationInput({
  codec: "us-dataset-transformation-v1",
  version: usSixMonthDefinition.version,
  definitionDigest: usSixMonthDefinition.digest,
  references,
  receiving,
  chain,
});
```

- [ ] Pin indices -1/260/fraction/nonfinite; wrong dataset/stage/revision/digests; unknown root/nested fields; getters/symbols/prototype/cycle/nonfinite raw values and boundary bytes. Check raw-safe root descriptors before reading properties. Test 256 KiB at the existing shared guard boundary plus oversize intent/result rejection; do not enlarge native field limits to manufacture a successful oversized result.
- [ ] Pin result rejection for missing/duplicate/reordered mappings, duplicate documents, inbound-as-output IDs, command key/draft/version/digest disagreement, snapshot/document/output mismatches and changed schema-normalized text. Test malformed native responses directly here; valid generated native response round trips belong to Task 3.
- [ ] Derive `recordIds` in document order followed by created/finalized root/event ID and output ID, deduplicated in insertion order; prerequisite/catalog IDs are excluded. Error codes: `us_dataset_transformation_input_invalid`, `result_invalid`, `prerequisite_incomplete`, `dependency_conflict`, `conflict`, `mismatch` with the common prefix. Preserve driver failures instead of translating them to drift.
- [ ] GREEN focused suite, scoped Prettier and `git diff --check`; independent reviewer checks strictness, normalization, payload bounds and interface consistency. No commit.

## Task 2: Joint locks and canonical verification

**Files:** Create locks/verifier modules and verify/locks e2e tests. Read existing Receiving/reference verifiers, Transformation persistence/origin/lifecycle/commands and native transaction lock tests before implementation.

**Consumes:** Task 1 exports; `UsDatasetReceivingStores`; `UsTransformationStore`; `UsDemoTransaction`; existing native getters and verifiers.

**Produces:**

```ts
export type UsDatasetTransformationStores = UsDatasetReceivingStores &
  Readonly<{
    transformation: UsTransformationStore;
  }>;
export type UsDatasetTransformationLockTarget = Readonly<{
  receiving: UsDatasetReceivingResult;
  transformation: UsDatasetTransformationResult | null;
}>;
export async function lockUsDatasetTransformation(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  target: UsDatasetTransformationLockTarget,
): Promise<void>;
export async function verifyUsDatasetTransformation(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetTransformationStores,
  mode: "fresh" | "replay",
): Promise<void>;
```

`fresh` is internal only, called immediately after native writes in the same transaction. It verifies owned roots/lots already held or newly private; it cannot be selected by external callers. Replay uses the public prelock path.

- [ ] Write RED integration tests using `createUsDatasetJournalFixture`, installed references and real Receiving/native Transformation commands, not seed SQL pretending to be product creation. In this task construct intent/result/receipt locally from actual returned records; the next task replaces application duplication with the executor. Register synchronous cleanup immediately after each resource acquisition.
- [ ] Add canonical replay test shape (local `receipt`/`intent` are actual evidence assembled in this test, `stores` contains native stores bound to `f.db`):

```ts
const before = await f.snapshot();
await f.db.transaction(async (tx) => {
  await verifyUsDatasetTransformation(tx, context, intent, receipt, stores, "replay");
});
expect(await f.snapshot()).toEqual(before);
```

- [ ] Run both new e2e files serially with the isolated fixture URL; expected RED from missing verifier/locks or failed comparison, never from loopback EPERM.
- [ ] Implement receipt/dependency validation before acquiring any business locks. Resolve only receipt-owned IDs. Replay locks Receiving root + all its revision rows, Transformation root + all its revision rows, then sorted deduplicated inbound/output lot UUIDs. Reject missing/foreign/wrong-type rows. Fresh preflight locks only Receiving root/revisions/input lots. Implement tenant-scoped Drizzle locks using this existing form, substituting only the actual schema tables/IDs checked in source:

```ts
await tx
  .select()
  .from(schema.traceabilityLots)
  .where(
    and(
      eq(schema.traceabilityLots.tenantId, context.tenantId),
      inArray(schema.traceabilityLots.id, lotIds),
    ),
  )
  .orderBy(asc(schema.traceabilityLots.id))
  .for("update");
```

- [ ] Map every compared mutable row to its actual public writer/lock in test comments and the final evidence: roots/revisions to Receiving/Transformation lifecycle; lots to status/source and consumers; parties/locations/products/profile to their native mutation locks; documents to document writers; origin/genealogy/operations/audits to their native insertion/lifecycle boundaries. Reuse reference verifier's ordered parent/location/product share locks and Receiving verifier only after joint prelocks. Hold document locks through commit. Do not follow extra support to a foreign root. If a writer bypasses protection, stop and report the exact gap instead of silently changing public code/isolation.
- [ ] Verify exact original root/revision state, persisted header/lines/documents/frozen snapshot, original create/finalize command scope/digests/responses and actor/time/request-ID/before/after audits. Require exact active output identity/source/permanent lock, single owned current origin and exactly two input→output genealogy edges. Compare immutable business facts; explicitly exclude current stock, mutable basis/dependency versions and updated clocks from replay equivalence.
- [ ] Add drift tests for pending amendment, finalized amendment, void, archive, product/TLC/source change, altered documents/catalogue, extra origin and genealogy substitution; assert rejection and unchanged full-row snapshot. Add legitimate native downstream consumption and require successful write-free replay.
- [ ] Add real PID-observed contention in both schedules for public lifecycle and lot/reference edits. Inversion-sensitive schedule: hold public Transformation root, start replay, observe replay blocked on that root, prove inbound lots are not yet held by replay, allow the public writer to acquire them and finish, then require verifier to observe drift. Reverse schedule: held replay locks block writer until verification transaction releases. Use `pg_blocking_pids`, not elapsed sleep as proof.
- [ ] Exercise actual test cancellation/failure before barrier and while blocked via `TestContext.signal`; gate release precedes worker drain. Attempt rollback, release/destroy, trigger cleanup and every pool close independently; preserve primary failure identity and verify owned database absence. Reuse the accepted discipline from `us-transformation-transaction-locks.e2e.test.ts`, not success-only chained cleanup.
- [ ] GREEN both suites plus existing Receiving verify/locks and native Transformation locks; independent reviewer checks writer map, root-before-lot scheduling, extra-support rejection and cleanup. No commit.

## Task 3: Atomic native stage application and recovery

**Files:** Create seed module and seed e2e test. Read existing dataset Receiving executor and journal `runAtomicStage` implementation.

**Consumes:** Tasks 1/2 interfaces and native document/Transformation/lot supplied-transaction methods.

**Produces:**

```ts
export class UsDatasetTransformationSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetTransformationResult>;
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetTransformationResult>;
}
```

- [ ] Write RED tests using the real disposable fixture; this complete happy-path test also pins Task 1 valid-result round trips:

```ts
it.each([0, 131, 259])("installs chain %i and replays without writes", async (index) => {
  await new UsDatasetReferenceSeedStore(f.db).initialize(context);
  const receiving = await new UsDatasetReceivingSeedStore(f.db).initialize(context, index);
  const seed = new UsDatasetTransformationSeedStore(f.db);
  const result = await seed.initialize(context, index);
  expect(result.documents).toHaveLength(2);
  expect(result.inputLots.map(({ lotId }) => lotId)).toEqual(receiving.lots.map(({ id }) => id));
  expect(parseUsDatasetTransformationResult(result)).toEqual(result);
  const before = await f.snapshot();
  expect(await seed.verify(context, index)).toEqual(result);
  expect(await seed.initialize(context, index)).toEqual(result);
  expect(await f.snapshot()).toEqual(before);
});
```

- [ ] Run new seed suite serially; record missing implementation/assertion RED independently of setup failures.
- [ ] Implement authorization-first `journal.read(context)`, complete reference/same-chain Receiving reads and deterministic input derivation. Capture durable intent with `randomUUID()` only when absent. On exact `us_dataset_intent_conflict`, reread the winner, compare semantic input and reuse its stored key; do not catch arbitrary failures as successful capture.
- [ ] Use `runAtomicStage` callbacks; apply rereads both dependencies through guarded `readStageInTransaction`, validates identities, prelocks fresh Receiving and verifies its canonical state. Reject pre-existing matching operations/docs/output TLC without adopting them. Create exactly recipe work-order/batch-log through native document commands and resolve issuer/product/processor from installed bindings.
- [ ] Build native create input with two ordered `ftl_lot` lines and one output using recipe values and actual document IDs. Save original command inputs. Call native draft/readiness/finalization once inside the supplied transaction; require complete readiness and use actual returned draft version/input digest. Example finalization boundary:

```ts
const finalized = await stores.transformation.finalizeInTransaction(
  tx,
  context.tenantId,
  context.actorUserId,
  created.id,
  finalizeInput,
  intent.operationKey,
);
```

`finalizeInput.operationKey` and create command key are the winning stage key; command scope separates operations. Read output lot through native getter. Assemble bounded result/record IDs/digest; verify with `fresh` before returning receipt. Callback verification selects `fresh` only for this invocation's successful private application; completed-stage callbacks select `replay`. Never persist a mode flag or infer freshness from an absent operation alone.

- [ ] Assert April/middle/Scenario A exact dates, quantities and UOM, current real event-number year, exactly one original Transformation/output and two edges. Independently assert exact operations/digests and document/output/create/finalize audits, not just row counts. Recipe Scenario A must remain 500 lb + 500 lb → 100 case, without invented conversion/allocation.
- [ ] Assert missing/pending/wrong-chain/wrong-digest dependencies, foreign tenant/user/role/provenance and malformed index authorization order; no implicit prerequisites and no writes on rejection. Verify pure receipt `recordIds` exclude Receiving lots.
- [ ] Inject real transactional failures at documents, draft, output lot, genealogy, audit, operation, verifier and dataset receipt boundaries. Compare all persisted tables before/after excluding only separately captured pending intent; fresh external retry uses identical intent key. Distinguish naturally produced errors from injected SQLSTATE 40001/40P01. Native calls get one attempt; no retry inside aborted transaction.
- [ ] Run concurrent initialize/verify and concurrent capture: one root/output/receipt, identical winning IDs/bytes. Model lost acknowledgement by committing `runAtomicStage` then throwing from its caller-facing boundary, reread and require identical receipt without extra business writes. Do not model lost acknowledgement by rolling back the transaction.
- [ ] Confirm legitimate downstream use succeeds, lifecycle/identity drift fails without repair and replay allocates no counters, clocks, audits or journal revisions. Exercise cancellation/early failure and cleanup invariants from Task 2 for failure-injection workers too.
- [ ] GREEN all four new suites and existing dataset journal/atomic/reference/Receiving regressions; independent reviewer checks atomic boundaries, recovery identity and original evidence. No commit.

## Task 4: CI ownership, documentation and final acceptance

**Files:** Modify workflow, parsed isolation tests, development-isolation and implementation-plan docs listed above.

**Consumes:** Four completed, independently reviewed suites. No new runtime exports.

- [ ] Write RED parsed workflow tests requiring every new suite exactly once in an unconditional check-only serial step after dependency/API builds, with the existing isolated fixture variable. Preserve all earlier suite selections and release locks. Mutation tests remove/duplicate a suite, add a condition, remove serial flag, move before builds and change fixture target; each must fail for the intended assertion.

```js
const suiteNames = [
  "test/us-dataset-transformation-contract.test.ts",
  "test/us-dataset-transformation-verify.e2e.test.ts",
  "test/us-dataset-transformation-locks.e2e.test.ts",
  "test/us-dataset-transformation-seed.e2e.test.ts",
];
assert.equal(suiteNames.length, 4);
```

The assertions belong in the existing YAML-parsed owner tests: count each suite across parsed steps, check the owner step has no `if`, appears after required builds and runs `--maxWorkers=1`; do not replace them with raw substring presence checks.

- [ ] Run `node --test tools/us-development/test/isolation.test.mjs` for RED, then add one serial workflow owner for these four tests; rerun isolation and all US tooling tests.
- [ ] Update docs: bounded per-chain Transformation now implemented; full dataset/Cases/Shipping/artifacts/viewer/deployment still pending. Record tested failure/replay/lock schedules, isolated children and unrun gates without suggesting hosted availability or regulatory acceptance.
- [ ] Controller runs fresh API typecheck/lint/build after all workers drain. Then serial configured new suites plus dataset journal/atomic/reference/Receiving, native Transformation seams/locks and public Transformation lifecycle/current-consumer/HTTP regressions. Record exact selected filenames, passed assertions and skips. Configured skips do not count as database acceptance.
- [ ] Run full API separately with both DB variables unset and necessary local listeners permitted. Report actual failures/skips; prior eight setup-failed files are not automatically benign, and only billing's missing auth/origin configuration was established. Retain existing Vite warning; no unrelated cleanup.
- [ ] Scoped Prettier checks, `git diff --check`, final source-byte inventory versus this task's baseline, unchanged HEAD/index and no unexpected path writes. Do not stage or commit accepted dirty work.
- [ ] Independent final review checks spec coverage, full writer/lock evidence and task-review findings. Report automated versus unrun browser/cloud/remote CI/full-volume/provider/backup/physical gates separately. Remote 30-minute budget remains unmeasured.

## Execution handoff

After owner approval, preserve the selected separate implementer/reviewer method. Each reviewer receives the approved spec, this plan, exact task scope, baseline and test evidence; fixes return to that task before the next begins. Final controller verification uses fresh evidence, not agent success claims. No push or release is included.
