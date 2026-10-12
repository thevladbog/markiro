# Special Receiving examples implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and verify real correction/orphan Receiving examples with atomic per-stage receipts.
**Architecture:** Dedicated strict codecs, native apply functions, a nonrecursive stage-aware verifier, sequential journal-backed store. Existing regular executors and public policies remain unchanged.
**Tech Stack:** Node24/Corepack pnpm, TypeScript/Zod/Drizzle/PostgreSQL/Vitest, executable YAML Node contracts.
**Spec:** `docs/superpowers/specs/2026-10-09-us-11-special-receiving-design.md`.

## Global Constraints

- Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`, HEAD `f06aaef2b923a7ae902c0fabacfd0c4712c127c3`. Dirty work/index preserved. Absolute apply_patch targets required.
- No stage/commit/push/PR/merge/release/cleanup, dependency/environment/schema/shared-base writes or archive/design edits. Existing recipe/journal/native services/fixtures/policy sources frozen.
- Recipe `us-processor-six-month-v1`, current digest, April–September 2026, `America/Los_Angeles`, correction250/400→300/400 and orphan200/200, exact code-owned reasons/documents/TLCs. No clocks mocked, SQL lifecycle success or fabricated operation/audit evidence.
- Per-stage bounded256KiB receipts/intents. Public retry policy unchanged, native no retry/wrapping. Stage1 replay becomes history-aware only with genuine owned stage2 completion/candidate. No recursive verifier.
- DB only invocation-owned random children of `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`, DATABASE_URL unset, maxWorkers1. Actual work/setup settle before reset/drop; synchronous prior-live-work guard. No builds during DB workers.
- This is Receiving portions only. No corrected downstream executor, full260 generation, artifact, initializer/HTTP/CLI/browser/hosting or dataset-complete claim. Current base stays unseeded.
- User waived approval questions; separate implementer/review per task plus one final most-capable whole-increment review. Capture dirty originals and retain own evidence, no commits/cleanup. Controller owns full API once and final gates.

## Review Focus

1. Completed original falsely rejected after its own correction/void: initial and full replay verify joint canonical history, unchanged198-table hashes (Task2).
2. Candidate final receipt not yet persisted: verifier accepts explicit candidate while lifecycle journal remains pending, and receipt SQL failure rolls back all stage business (Task2).
3. Canonical reads race public mutation under RC: real root/revision/sorted-lot locks block actual public writer through commit; drain workers/barriers independently (Task2).
4. Seed accepts historical operation replay over current drift: extra amendment/void/current-pointer/audit/document/operation drift rejects without repair; legitimate downstream tokens pass (Task2).
5. CI ownership is nominal or previous pins replaced: fresh YAML mutations fail intended assertions and exact complete predecessor remains after removing only new owner (Task3).

## Task 1: Strict special-stage codecs

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-special-contract.ts`, `apps/api/test/us-dataset-special-contract.test.ts` only.
**Consumes:** Existing `UsDatasetContext/Intent/Receipt/StageRow`, `UsDatasetReferenceIdentity/makeUsDatasetReferenceIdentity`, `assertBoundedSyntheticJson`, V2 Receiving/live/document/lot schemas, canonical digest, immutable special recipe.
**Produces:**

```ts
type UsDatasetSpecialKind = "correction" | "orphan";
type UsDatasetSpecialStage = "receiving" | "amend_receiving" | "void_receiving";
type UsDatasetSpecialStageIdentity = Readonly<{
  datasetId: string; unitKey: "correction_0001" | "orphan_0001";
  stage: "receiving"; revision: 2; operationKey: string;
  inputDigest: string; resultDigest: string;
}>;
type UsDatasetSpecialInput = Readonly<{
  codec: "us-dataset-special-receiving-v1";
  version: "us-processor-six-month-v1"; definitionDigest: string;
  kind: UsDatasetSpecialKind; stage: UsDatasetSpecialStage;
  references: UsDatasetReferenceIdentity;
  recipe: UsSixMonthSpecialExamples[UsDatasetSpecialKind];
  receiving: UsDatasetSpecialStageIdentity | null;
}>;
// Discriminated result union uses top-level stage matching input.stage.
// Receiving result: input, documents[{key,record}], created/finalized V2 receipts,
// lots[2]. Lifecycle result additionally embeds that exact original result.
// amendment: started/saved/finalized V2 receipts, predecessor live record, lots[2].
// void: voided V2 receipt, lots[2]. No optional unrelated fields accepted.
makeUsDatasetSpecialInput(kind: UsDatasetSpecialKind, stage: UsDatasetSpecialStage,
  references: UsDatasetReferenceIdentity,
  receiving: UsDatasetSpecialStageIdentity | null): UsDatasetSpecialInput;
parseUsDatasetSpecialInput(raw: unknown): UsDatasetSpecialInput;
parseUsDatasetSpecialResult(raw: unknown): UsDatasetSpecialResult;
makeUsDatasetSpecialStageIdentity(datasetId: string, stage: UsDatasetStageRow):
  UsDatasetSpecialStageIdentity;
usDatasetSpecialRecordIds(result: UsDatasetSpecialResult): readonly string[];
datasetSpecialError(code: UsDatasetSpecialErrorCode, unitKey: string,
  stage: UsDatasetSpecialStage, cause?: unknown): Error;
```

Export `UsDatasetSpecialReceivingResult`, `UsDatasetSpecialLifecycleResult` and
`UsDatasetSpecialResult`; ReceivingOperationReceiptV2, ReceivingLiveRecord,
ReferenceDocument, TraceabilityLot use existing contracts. Error codes:
`us_dataset_special_input_invalid`, `us_dataset_special_result_invalid`,
`us_dataset_special_prerequisite_incomplete`, `us_dataset_special_dependency_conflict`,
`us_dataset_special_conflict`, `us_dataset_special_mismatch`. Attach safe unit/stage.

- [ ] Write input codec tests first. Minimal nonfunctional callable scaffolds may throw an explicit missing-behavior error; missing imports are not RED. Literal expected initial/final quantities, dates, unit keys and exact reasons come from hand-checked current recipe, not builder-derived expectations.

```ts
const input = makeUsDatasetSpecialInput("correction", "receiving", refs, null);
expect(input.recipe.initialReceiving.lines.map((l) => l.quantity)).toEqual(["250", "400"]);
expect(input.recipe.correctedChain.receiving.lines.map((l) => l.quantity)).toEqual(["300", "400"]);
expect(input.recipe.initialReceiving.eventDate).toBe("2026-06-10");
expect(() => parseUsDatasetSpecialInput({ ...input, kind: "orphan" })).toThrow(
  "us_dataset_special_input_invalid",
);
```

- [ ] Run genuine RED, implement strict exact descriptor equality and stage/kind/dependency pairing: receiving has null predecessor; amendment only correction; void only orphan; lifecycle binds exact same dataset/unit/reference identity and completed original stage2. Descriptor validation precedes nested schemas/getters/digest; freeze only structured owned copies. Reject extra fields, aliases, unsafe UUID/digest, cycles/accessors/prototypes/symbols/nonfinite/oversize, changed quantities/date/reason/recipe and foreign predecessor identity.
- [ ] Implement result validation using existing strict schemas and semantic identity checks. Require2docs/2unique lots, canonical unique recordIDs, initial originalrev1/draft1→finalizedrev1, same stage key for command-family receipts, exact quantities/UOMs/TLC/source/bindings/docs/actors; correction startsrev2 draft1, savesdraft2, finalizesrev2, rootversion4/currentrev2/no pending, original predecessoramended and frozen250/400, no output identity changes. Orphanvoidrev1 rootversion3/currentpendingnull, frozen200/200 and same lot identities. Reject unrelated receipt/operation keys, substituted original and forged history. Full actual successful result + mutation coverage is delivered by Task2 real-service tests; pure tests do not fabricate acceptance of unexecuted service actions.
- [ ] Add one configured actual-service codec witness in the same assigned test, gated by US_TEST_DATABASE_URL. Use existing owned fixture and real references/native document/Receiving services, no new helper path or fake history. Prove accepted original/amendment/void results and cloned embedded event/root/current/pending UUID aliases rejected. Establish alias RED before codec fix; retain normal operation/record IDs lowercase. Register acquisition and entire async phase; drain before owned child disposal, no next setup while work live. This codec witness does not implement the production seed/verifier or claim dataset completion.
- [ ] GREEN focused codec configured and unconfigured, scoped typecheck/lint/format/diff; report exactRED/GREEN/hashes and freeze2paths. No whole API/build or extra helpers. DB only the configured codec witness on exact owned fixture. Independent Spec+Quality review precedes Task2.

## Task 2: Native application, stage-aware verifier and durable store

**Files:** Create only `apps/api/src/modules/traceability/demo/us-dataset-special-apply.ts`, `us-dataset-special-evidence.ts`, `us-dataset-special-verify.ts`, `us-dataset-special-seed.ts`; `apps/api/test/support/us-dataset-special-fixture.ts`; `apps/api/test/us-dataset-special-seed.e2e.test.ts`, `apps/api/test/us-dataset-special-locks.e2e.test.ts`.
**Consumes:** Accepted Task1 codecs; native Receiving create/readiness/finalize/amend/saveAmendment/void/getLiveRecord/getLotReceivingBasis; native documents/lots/catalog/profile/master; existing reference canonical verifier and dataset journal.
**Produces:** Public internal API from spec `UsDatasetSpecialSeedStore(db)`; `initializeReceiving/verifyReceiving` return original result; `initialize/verify` return lifecycle result. All require typed context/kind, runtime kind validated after authorized journal.read. `UsDatasetSpecialStores` holds existing store instances only. Native apply callback and verify callbacks have exact existing `UsDatasetAtomicStageWork` signatures. Evidence module owns bounded checks of operations/audits/bindings and history projection; verify module owns root/revision/lot locks and joint state, no second writer. No helper API for tests in production.

- [ ] Read current implementations/fixtures and write real original→amend/void seed assertions before executor logic, using new fixture wrapping existing owned dataset fixture. Track complete async test/setup phase, preserve setup acquisition outcome, synchronous beforeEach guard before starting tracked setup, drain prior work before disposal. New test budgets30s/hook60s; old timer/source files untouched. No fake service mocks or clock override. Minimal throwing callable scaffold allowed for genuine RED after real references initialized.

```ts
await new UsDatasetReferenceSeedStore(f.db).initialize(context);
const s = new UsDatasetSpecialSeedStore(f.db);
const corrected = await s.initialize(context, "correction");
expect(corrected.stage).toBe("amend_receiving");
if (
  corrected.stage !== "amend_receiving" ||
  corrected.finalized.record.content.kind !== "finalized" ||
  corrected.original.finalized.record.content.kind !== "finalized"
)
  throw new Error("Expected actual correction");
expect(corrected.finalized.record.revision).toBe(2);
expect(corrected.finalized.record.lifecycle.lifecycleVersion).toBe(4);
expect(corrected.finalized.record.content.snapshot.items.map((l) => l.quantity)).toEqual([
  "300",
  "400",
]);
expect(corrected.original.finalized.record.content.snapshot.items.map((l) => l.quantity)).toEqual([
  "250",
  "400",
]);
expect(corrected.lots.map((l) => l.id)).toEqual(corrected.original.lots.map((l) => l.id));
const before = await f.snapshot();
expect(await s.initializeReceiving(context, "correction")).toEqual(corrected.original);
expect(await s.verify(context, "correction")).toEqual(corrected);
expect(await f.snapshot()).toEqual(before);
```

- [ ] Implement orchestration without changing journal: authorized read→references identity→strict input→read/capture exact intent with only existing precise conflict arbitration→runAtomicStage→strict stored result. Original-stage verify inspects owned lifecycle completed receipt if present; final apply requires original canonical finalized state, then passes explicit candidate to verifier before journal completion. Full initialize runs both stages sequentially; verify never captures or writes.

```ts
await journal.runAtomicStage(context, header.id, stage.revision, stage.intent, {
  apply: (tx, checked, intent) => applyUsDatasetSpecial(tx, checked, intent, stores),
  verify: (tx, checked, intent, receipt) =>
    verifyUsDatasetSpecial(tx, checked, intent, receipt, stores),
});
// apply original: reject any matching unowned op/TLC/document; create docs via native
// service, create draft, readiness complete/no exempt review, finalize, read actuallots.
// apply amendment: verify original, native amend(root,reason/version/key), parse actual
// draft, change ONLY items[0].quantity="300", native save(expected versions), fresh
// readiness, native finalize, read post-transition predecessor and retained lots.
// apply void: verify original, native void(root,exact reason/version/key), read retainedlots.
```

- [ ] Implement joint verifier without recursion. Lock same-tenant root, revisions ordered UUID, sorted owned lots before canonical multi-statement reads; reference/document locks follow existing verifier. Check exact event-count/state/root-current/pending/nextRevision, actual saved inputs and immutable snapshots against own receipts, source/catalog/document bindings and identities, all actualoperationrows under each capturedkey and canonical audit tuples (actor/tenant/action/target/result/request/before/after). Initial receiving can be current only before its lifecycle receipt exists; only valid bound candidate/ownedreceipt permits plannedamended/void state. No unexpected extra revisions or future arbitrary amendments accepted. Ignore legitimate lot/basis technical tokens only; preserve business/status/source locks. No SQL success writes.
- [ ] Prove actual stage counts: correction1root2revisions2lots2docs, five operations across initial2/lifecycle3; orphan1root1revision2lots2docs, three operations initial2/void1. Audits exact current canonical service payloads, not only counts. Basis supports currentcorrectionrev2; absent for orphan; originals frozencontent250/400 and200/200. No Transformation/Shipping/case rows produced. Actual wrong downstream consumption is rejected without persisted extra draft; real correction downstream consumption changes technicaltokens yet special replay remains no-write.
- [ ] Prove transaction failure/recovery using actual test-owned SQL triggers at original and lifecycle business/audit/operation/receipt insertion. Compare all198 persisted-table hashes against captured pending-stage baseline, expected original remains when laterstagefails. Remove each owned trigger/function independently in finally after actualwork drain. Rerun recovers exact pendingkey once; thrown infrastructure cause propagates unchanged. Simulate acknowledgement lost AFTER real journal commit (test-only prototype boundary), then retry verifies exact committed receipt/IDs/no new audit without hiddenreplaywriter.
- [ ] Add drift/mutation tests with cloned actualresults and real owned DB negative mutations: unsafeinput, substituted docs/lots/keys/reference/predecessor, receipt digest/recordIDs, changed immutable snapshot/line/reason, extra actualpublicamendment or void, missing/altered audit/operation, archivedreference/lot; mismatch leaves all tables unchanged from pre-call state. Wrong actor/tenant/provenance/database/kind rejected beforewrites/inputgetter; preserve secondtenant rows. Missing/pending verify makes no writes.
- [ ] Lock suite proves actualpublicwriter waiting on seed verification locks through commit, and concurrent seed initializations with one canonicalwinner/no duplicates, barrier released before allSettled workers drainage. No sleep-only concurrency proof. Tests run with exactfixture maxWorkers1; do not build concurrently. Cover at least initial and corrected/void joint states; deliberately violated current origin never accepted from saved receipt.
- [ ] GREEN three new suites plus unchanged lifecycle38, regular Receiving contract/seed/verify/locks and atomicstage/reference regression suites on owned fixtures. Report each actual run counts/skips separately; no invented union. Scoped typecheck/lint/format/diff after all DB work drains. Freeze7paths with complete report, RED chronology, ownedchild absence and hashes; independent Spec+Quality review before Task3. Controller owns broader API/build gates.

Task 2 review clarification: orphan-only support absence covers Transformation
input/output rows, Shipping items, case-link history and genealogy in both
directions, including draft/historical support. Check under held lot locks for
candidate completion and every original/lifecycle replay entry point. Add actual
owned negative mutations and no-write rejection; public void policy is unchanged.

## Task 3: Check-only CI ownership and factual handoff

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `tools/us-development/test/dataset-regular-ownership.test.mjs`, `tools/us-development/test/receiving-lifecycle-ownership.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`; create `tools/us-development/test/dataset-special-ownership.test.mjs`.
**Consumes:** Frozen3newtestpaths and accepted store; **produces:** exact one dedicated owner:

```yaml
- name: Verify special dataset Receiving examples on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-special-contract.test.ts test/us-dataset-special-seed.e2e.test.ts test/us-dataset-special-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Capture current complete predecessor YAML bytes and parsedsteps/workflow AST/hashes beforeedit. Missing-owner executableRED in newNodefile beforeaddingowner after successfuldomain/APIbuilds. All priorliteralpins unchanged; oldthreeNodefiles ONLY exclusion of exactnewowner in preservationfilters. Newtest owns allnewassertions/mutations.
- [ ] Verify exactunconditionaldirectserialfixtureowner; globaluniqueexplicit3paths, aggregateAPIallowed and realnewDBskip predicates. Reject freshYAML omission/duplicates/aliases/quotes/split/nonexecution/conditions/suppression/redirect/background/shell override/DBfallback/extraenv, missinglateconditionalignoredbuilds, and priorcommands/settings/release/budget drift with intendedAssertionError/messages. Removeonlynewowner to restore complete actualpredecessor bytes/AST, including AST-neutral comments/newlines. Never repin oldhashes or relaxchecker.
- [ ] Append to docs truthful actualReceiving-stage evidence/historyaware replay/failureresume and open correcteddownstream/fullvolume/artifact/runtime/browser/hosting gates. Preserve entire prior docs chronology. No full-demo completion, cloudcost or regulatory claims; fullAPI failures/skips explicitly separate.
- [ ] FocusedRED/GREEN then fullsafe `node --test tools/us-development/test/*.test.mjs` once, checker, scoped Node lint/sevenpathformat/diff. Report exact commands/results/mutations/preservation/hashes and freeze7paths, no DB/API/build. Independent Spec+Quality review.

## Controller finish

- [ ] Fresh exact configured3suitegate; APItypecheck/lint/build after DBdrain; fullpackageAPI once withbothDBvarsunset/localHTTPpermission, retain all failures/skips; safeNode/checker/format/diff/inventory. No broader red silently discarded.
- [ ] One most-capable final whole-increment review using exactcaptured dirty originals, all taskreports/rulings/limits. Preserve local evidence; no publication/cleanup. Exhaustively report rulings and their costs, scopechanged/checks/unrun gates and next correcteddownstream stage.
