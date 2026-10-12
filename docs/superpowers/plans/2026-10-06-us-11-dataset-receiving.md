# US-11 Dataset Receiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one resumable atomic Receiving stage for any of the 260 regular
six-month demo chains, without installing the full dataset or exposing runtime
entry points.

**Architecture:** Thin immutable intents bind the unchanged chain descriptor to
the installed catalogue receipt. Existing native document/Receiving services
write one stage inside the guarded dataset transaction; a canonical verifier
checks current origin before its bounded receipt commits and on every replay.

**Tech Stack:** Strict TypeScript, Zod, Drizzle/PostgreSQL, Vitest, parsed YAML
workflow contracts, Node24 and repository-declared pnpm through Corepack.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-dataset-receiving-design.md`
(owner-approved). Execution method already selected: separate implementer and
independent reviewer per task, followed by whole-increment review. This written
plan awaits owner approval; no implementation is authorized yet.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`,
  `codex/us-mvp`; preserve the extensive accepted dirty baseline. Do not stage,
  commit, push, open a PR, merge, clean up or deploy.
- Preserve `us-processor-six-month-v1`, `2026-04-01` through `2026-09-30`,
  `America/Los_Angeles`, catalogue/manifest/digest, descriptor bytes and compact
  Scenario A at index259. Migrations0141/0142 and 256 KiB codec limits stay intact.
- No shared-base population, environment/dependency edits, Downloads/archive/
  design-file changes, routes/runtime/CLI/UI registration or customer provisioning.
  No correction/orphan orchestration, Transformation/Cases/Shipping orchestration,
  Plan/Requests, Station, scanning, printing or hosting in this increment.
- Business rows, snapshots, lot source locks, counters, operations and audits
  remain owned by existing services. No fabricated business rows through seed SQL.
- Historic dates are civil business dates; generated event numbers and creation,
  audit/readiness/finalization clocks remain real. No mocked production clock.
- Completed stages verify current origin, not historical acknowledgement alone;
  drift stops with unit/stage context and never adopts, deletes or repairs data.
- Journal mutation isolation remains read committed; explicit locks must protect
  native multi-statement readers. Do not change public authorization, parsers,
  isolation, three-attempt retry, errors, amendment/void or legacy replay.
- Configured tests use only `US_TEST_DATABASE_URL` and owned random child DBs;
  keep `DATABASE_URL` unset. No builds during fixtures; rebuild dependencies only
  when needed, before consumer tests. Unconfigured skips are not DB coverage.

## Review Focus

1. A concurrent capture must reuse the winner's key, not replay another chain or
   silently accept a changed reference dependency; Task4 tests both races.
2. A forged receipt with recomputed digest must not certify foreign or altered
   current state; Tasks1/3 test substitutions and canonical facts independently.
3. An amendment, void or added origin must not race between verification and
   commit; Task3 proves actual lock waits and stable support, not a timing sleep.
4. Legitimate downstream consumption must not invalidate Receiving merely by
   changing technical tokens or stock; Task3 uses real Transformation service.
5. Failed business/receipt writes or lost commit acknowledgements must retain
   one pending intent or one exact completed stage, never partial adoption;
   Task4 tests actual failpoints, restart and no-write replay.

---

## Source map and file boundaries

Read root `AGENTS.md` and API guide (fallback
`/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md` when absent in this worktree).
Read the approved spec, current journal/reference modules, native Receiving
commands/readers and adjacent tests. No local Graphify graph exists; do not
install or build one for this plan.

Create:

- `apps/api/src/modules/traceability/demo/us-dataset-receiving-contract.ts`:
  strict intent/dependency/result identity and stable lot projection.
- `apps/api/src/modules/traceability/demo/us-dataset-receiving-verify.ts`:
  canonical verification and lock protocol; no mutations.
- `apps/api/src/modules/traceability/demo/us-dataset-receiving-seed.ts`:
  capture/recovery, input binding and one atomic native-service application.
- Tests `apps/api/test/us-dataset-receiving-contract.test.ts`,
  `us-dataset-stage-read.e2e.test.ts`, `us-dataset-receiving-verify.e2e.test.ts`,
  `us-dataset-receiving-locks.e2e.test.ts`,
  `us-dataset-receiving-seed.e2e.test.ts`.

Modify only `us-dataset-journal.ts` for the native reader;
`.github/workflows/us-development.yml`,
`tools/us-development/test/isolation.test.mjs`,
`docs/us/development-isolation.md` and `docs/us/implementation-plan.md` for
check-only ownership/status. Preserve current business services, schema, recipe,
reference verifier, fixture acquisition/disposal and existing test bodies.
Any required additional file or changed public behavior needs an explicit ruling.

## Task 1: Immutable Receiving intent and result contract

**Files:** Create contract module and `us-dataset-receiving-contract.test.ts`.
**Consumes:** `UsDatasetIntent/Receipt/StageRow/Context` from dataset contract,
`UsSixMonthChain/makeUsSixMonthRegularChain`, `UsDatasetReferenceResult`,
`UsDemoTransaction`, shared response types/schemas from platform-contracts.
**Produces:** These interfaces, exported from the contract module:

```ts
type UsDatasetReferenceIdentity = Readonly<{
  datasetId: string;
  unitKey: "references";
  stage: "references";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
type UsDatasetReceivingInput = Readonly<{
  codec: "us-dataset-receiving-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetReferenceIdentity;
  chain: UsSixMonthChain;
}>;
type UsDatasetReceivingResult = Readonly<{
  input: UsDatasetReceivingInput;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  created: ReceivingOperationReceiptV2;
  finalized: ReceivingOperationReceiptV2;
  lots: readonly TraceabilityLot[];
}>;
makeUsDatasetReferenceIdentity(datasetId: string, stage: UsDatasetStageRow):
  UsDatasetReferenceIdentity;
makeUsDatasetReceivingInput(index: number, references: UsDatasetReferenceIdentity):
  UsDatasetReceivingInput;
parseUsDatasetReceivingInput(raw: unknown): UsDatasetReceivingInput;
parseUsDatasetReceivingResult(raw: unknown): UsDatasetReceivingResult;
usDatasetReceivingRecordIds(result: UsDatasetReceivingResult): readonly string[];
usDatasetReceivingLotIdentity(lot: TraceabilityLot): Readonly<Record<string, unknown>>;
datasetReceivingError(code: UsDatasetReceivingErrorCode, unitKey: string, cause?: unknown):
  Error & { unitKey: string; stage: "receiving" };
```

`ReferenceDocument`, `ReceivingOperationReceiptV2` and `TraceabilityLot` are
existing platform-contract types. Error codes are exactly
`us_dataset_receiving_input_invalid`, `us_dataset_receiving_result_invalid`,
`us_dataset_receiving_prerequisite_incomplete`,
`us_dataset_receiving_dependency_conflict`, `us_dataset_receiving_conflict` and
`us_dataset_receiving_mismatch`.

- [ ] **Step1 — write pure RED tests with owned JSON fixtures.** Build valid
      reference-stage fixtures from a strict `UsDatasetReferenceResult` using the
      exact catalogue; no arbitrary fake profile shapes. Build response fixtures
      with the existing schemas. Assert regular indices0,131,259, rejected -1/260/
      fractional indices and correction/orphan unit substitution. Example:

```ts
const input = makeUsDatasetReceivingInput(259, identity);
expect(input.chain).toEqual(makeUsSixMonthRegularChain(259));
expect(input.chain.receiving.lines.map((x) => x.quantity)).toEqual(["500", "500"]);
expect(parseUsDatasetReceivingInput(input)).toEqual(input);
expect(() => parseUsDatasetReceivingInput({ ...input, codec: "other" })).toThrow();
```

Fixture variables `identity` and valid result are locally defined using the
exported builders/shared schemas. Mutations cover wrong recipe/digest/unit,
dependency revision1/no receipt, UUID substitutions, unknown fields, accessors,
symbols, cyclic JSON, nonfinite values and >256 KiB raw bodies.

- [ ] **Step2 — run pure suite before implementation.**

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-receiving-contract.test.ts --maxWorkers=1
```

Genuine RED is a missing new export/failed contract assertion, not fixture or
dependency-build failure.

- [ ] **Step3 — implement strict bounded schemas and semantic checks.** Use
      `assertBoundedSyntheticJson` before schema traversal, `.strict()`, existing
      document/lot/receipt schemas, and raw-vs-parsed canonical digest equality.
      Infer index from exact `chain_0000` through `chain_0259`; compare complete
      descriptor to its builder. Require exactly two Receiving document numbers
      resolving once each, correct symbolic bindings/order and distinct document/
      lot IDs. Creation command is `receiving.create`, finalization is
      `receiving.finalize`; both receiptVersion2, same operation/event/root identity,
      original revision1, finalized snapshotVersion3 and lifecycleVersion2. Require
      two distinct lot IDs in ordered snapshot line mapping. Compare date/quantities
      and internal document/product/source identity consistency against saved draft
      and finalization evidence. Thin identity alone contains no catalogue bindings:
      Task3 must separately compare actual parent/product/source IDs to the verified
      reference result's bindings; Task1 must not invent UUIDs from symbolic keys.
      Header recipe/dependency mismatches are not normalized into valid data.

```ts
const ids = [
  ...new Set([
    ...result.documents.map((x) => x.record.id),
    result.created.record.lifecycle.rootId,
    result.created.eventId,
    ...result.lots.map((x) => x.id),
  ]),
];
```

Pin that existing nested root property in tests; never add a fabricated field.
Record IDs deduplicate the legitimate root/event alias only, not document/lot
collisions. Lot stable projection includes ID/product/TLC/source/assignment/
status/revision/sourceLockedAt/createdBy/createdAt, excluding mutable
technical counters and modification actor/time. Final snapshot/receipts remain
full immutable bytes, not this projection.

- [ ] **Step4 — GREEN, package typecheck and scoped formatting.** Add result
      mutations with recomputed outer digest to prove structural checks do not rely
      on digest alone. Include byte-size tests and lot projection tests that ignore
      technical modification but reject archive/source/TLC changes. Save exact RED/
      GREEN evidence and get independent spec/quality review; no commit.

## Task 2: Guarded native cross-unit stage reader

**Files:** Modify `us-dataset-journal.ts`; create stage-read configured test.
**Produces:**

```ts
readStageInTransaction(tx: UsDemoTransaction, context: UsDatasetContext,
  datasetId: string, unitKey: string, stage: UsDatasetStage):
  Promise<UsDatasetStageRow | null>;
```

- [ ] **Step1 — real PostgreSQL RED.** Reuse
      `createUsDatasetJournalFixture` with its real `provision()` context and
      `UsDatasetReferenceSeedStore.initialize`. Read the complete reference stage
      from an outer transaction and compare to public `readStage`. Test absent row,
      wrong header, outsider/original-owner replacement, revoked membership, wrong
      database/user/profile and malformed IDs; compare all-table hashes before/after.

```ts
const before = await f.snapshot();
const value = await f.db.transaction((tx) =>
  journal.readStageInTransaction(tx, context, header.id, "references", "references"),
);
expect(value).toEqual(await journal.readStage(context, header.id, "references", "references"));
expect(await f.snapshot()).toEqual(before);
```

- [ ] **Step2 — run configured suite with fixture URL; confirm missing-method
      RED with zero configured skips.** Never count loopback EPERM as feature RED.
- [ ] **Step3 — extract shared checked transaction context.** The native reader
      runs actual `current_database/current_user`, existing raw-context validation,
      `assertUsDemoTarget`, required header and unit checks in the supplied tx; it
      uses private `stage/parseRow`. Delegate the public reader without changing its
      repeatable-read wrapper. No nested `db.transaction`, pool read, new seed lock,
      transaction cast or exposed unguarded private reader.
- [ ] **Step4 — GREEN and journal/reference regressions.** Test own uncommitted
      stage visibility and outer abort using existing journal callbacks, then assert
      public read/disposal unchanged. Rebuild API only after fixtures close. Gate
      independently before later tasks consume this method.

## Task 3: Canonical current-state verifier and lock evidence

**Files:** Create verify module and verify/locks configured tests.
**Consumes:** Task1 contract; Task2 native reader; existing reference verifier,
document getter, Receiving live/basis getters and lot getter. Define:

```ts
type UsDatasetReceivingStores = Readonly<{
  journal: UsDatasetJournalStore;
  master: UsMasterDataStore; catalog: UsCatalogStore;
  profiles: UsProductProfileStore; documents: UsReferenceDocumentStore;
  receiving: UsReceivingStore; lots: UsLotStore;
}>;
verifyUsDatasetReceiving(tx: UsDemoTransaction, context: UsDatasetContext,
  intent: UsDatasetIntent, receipt: UsDatasetReceipt,
  stores: UsDatasetReceivingStores): Promise<void>;
```

- [ ] **Step1 — compose a real stage fixture before RED.** In this test's local
      helper, use the native-service composition from
      `us-receiving-transaction-seams.e2e.test.ts` (number lookup, real bound parents,
      original draft, readiness-v4, commandVersion2 finalization), not business-row
      inserts. Build Task1 result and exact deterministic `recordIds/resultDigest`.
      Use `journal.runAtomicStage` to exercise verifier inside its guarded tx.
      Task3 tests can apply this helper directly; it is test data, not runtime code.
- [ ] **Step2 — verifier RED and adversarial fixtures.** Assert success on
      real data, then independently tamper each document/lot/parent/source/snapshot/
      receipt/audit fact. Recompute receipt digest where applicable. Call real public
      amend and void commands; reject pending amendment, finalized replacement,
      archived lot and additional current Receiving support without repairs. Use
      real services for supported mutations; SQL tampering is limited to negative
      fixture corruption, never creating accepted events/snapshots.

```ts
const before = await f.snapshot();
await expect(
  journal.runAtomicStage(context, header.id, stage.revision, stage.intent, {
    apply: failUnexpectedApply,
    verify: (tx, c, i, r) => verifyUsDatasetReceiving(tx, c, i, r, stores),
  }),
).rejects.toThrow("us_dataset_receiving_mismatch");
expect(await f.snapshot()).toEqual(before);
```

Define `failUnexpectedApply` locally to throw immediately; completed replay
must never enter application. Expected wrong-current-state failures precede
historical replay acceptance.

- [ ] **Step3 — implement protection and exact comparison.** Parse intent/
      result/digests first under target guard. Require stage `receiving`, intent
      unitKey equal to result.input.chain.unitKey, canonical intent.input equal
      to result.input, both command keys equal to intent.operationKey and exact
      recordIds/resultDigest. Include recomputed-digest key/unit substitution
      tests. Lock owned root FOR UPDATE, then its
      revision rows by ID, then two owned lots by sorted ID FOR UPDATE. Check tenant,
      root original/current identity, pending null, revision1/current finalized,
      exact expected lifecycle and no supersession before other reference locks.
      Never lock unknown foreign roots; extra support is a mismatch. Use native
      cross-unit reader and compare all Task1 dependency fields, then
      `verifyUsDatasetReferences(tx,context,referenceIntent,referenceReceipt,stores)`.
      Lock owned documents FOR SHARE in ID order; compare full document records and
      recipe-derived parents. Read live Receiving, require exact recorded finalized
      record/snapshot; read each lot and compare stable projection. Read complete
      basis count with limit10/offset0; require present/supportCount1/hasMorefalse
      and exact root/event/revision/line. Do not compare `basisVersion`.
      Inspect tenant-scoped immutable Receiving operation rows and exact six native
      audits (two documents, draft, two lots, finalization): actor/action/target/
      outcome/request ID/before/after match saved command evidence. Driver failures
      propagate; only known missing/invalid business evidence becomes mismatch.
- [ ] **Step4 — map and test public writer locks.** Inspect
      `us-receiving-revision-finalization.ts`, `us-receiving-lifecycle.ts`,
      `us-receiving-reference-context.ts`, document/profile/lot stores and existing
      Receiving concurrency tests before implementing tests. Root→event→sorted lot
      order matches lifecycle/finalization; catalogue verifier holds parties,
      locations, products share locks, and profile writers serialize on products.
      Documents are share-locked. Current document store has create/get only, no
      supported public edit command: document-change contention uses a tenant-scoped
      fixture-only UPDATE on an already real-service-created row and is explicitly
      negative database evidence, not a new API or supported-edit claim. Audit/
      operation rows are immutable service writes. The guarded reference stage is
      immutable once completed and seed writers serialize on existing advisory lock.
      If any actual public writer bypasses these protections, stop for a scoped
      ruling rather than changing business behavior or journal isolation.

```ts
const blocking = await f.pool.query<{ blocked: boolean }>(
  "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
  [verifierPid, writerPid],
);
expect(blocking.rows[0]?.blocked).toBe(true);
```

Obtain PIDs on dedicated fixture connections and use explicit promise barriers
around transaction release; bounded polling is allowed only to observe actual
server lock state. No sleep-based correctness assertion. Exercise public amend,
void, new support, fixture-only document UPDATE and public product-profile edit
while verifier tx is held;
writer must wait until release. Writer-first tests verify afterward sees changed
state and rejects. Close only owned connections even on failure.

- [ ] **Step5 — legitimate downstream GREEN.** Use
      `UsTransformationStore` with recipe inputs/output and real readiness/finalize
      calls from adjacent Transformation tests. Show tokens change and consumption
      exists, yet unchanged Receiving verifies with no writes. Add independently
      created reference and show verifier ignores it. Test all locks/negative cases,
      run relevant public concurrency regressions and get independent review.

## Task 4: Atomic chain store and resumable application

**Files:** Create seed module and seed configured test.
**Produces:**

```ts
class UsDatasetReceivingSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetReceivingResult>;
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetReceivingResult>;
}
```

- [ ] **Step1 — public internal boundary RED.** Install references in fixture
      setup only; assert initialize for0,131,259 produces one complete receiving
      stage each, two docs/two lots/one root each and no downstream stages. Check
      exact dates/UOM/TLC/source, command receipts, counters and six audit payloads.
      Snapshot completed replay and `verify` to prove no writes. Missing references
      or dataset fail without initialization side effects; reject invalid indices,
      correction/orphan unit substitution and wrong owner/tenant before application.
- [ ] **Step2 — implement capture and dependency binding.** Read existing
      guarded header and complete reference row; build Task1 identity/input and
      capture random operation key once. Recover capture conflict only if reread
      winner has identical canonical input; use winner's complete intent/key.
      Changed dependency/descriptor is a conflict. `verify` requires completed stage
      and never captures or applies. No calls to reference `initialize` in this class.
- [ ] **Step3 — implement native application.** Inside atomic callback reread
      shared stage and compare dependency before writes, run existing full catalogue
      verifier, then reject existing command rows for this key and conflicting doc
      identities/TLC-source identities. Check only intended chain records, not all
      business records. All conflicts stop without adoption/repair.
      Resolve exactly one descriptor per Receiving document number and exactly one
      catalogue binding per key. Create docs through native store, build draft as
      in the existing seam test, create with `{operationKey,draft}`, check actual
      complete readiness, finalize with the stored key and actual readiness values.

```ts
const command = {
  commandVersion: 2,
  operationKey: intent.operationKey,
  expectedDraftVersion: ready.draftVersion,
  expectedLifecycleVersion: ready.expectedLifecycleVersion,
  previousRevisionId: ready.previousRevisionId,
  expectedInputDigest: ready.inputDigest,
  reviewedExemptLines: [],
};
```

Recipe profiles are verified covered; require no exempt-review lines rather
than automatically approving any new exemption. Require modern V2 receipts.
Gather real created documents/acknowledgements/lots into Task1 result and
return bounded receipt; journal invokes Task3 verifier before persistence and
on completed replay. Fresh roots/lots are transaction-private; verifier may
reacquire its own row locks without exposing a reference→existing-root cycle.

- [ ] **Step4 — actual rollback and restart tests.** Parameterize owned PostgreSQL
      trigger failures at second document, draft audit, first/second lot audit,
      finalization audit, create/finalize operation and dataset receipt UPDATE.
      Compare all-table snapshots after captured intent, not before intent exists.
      Remove only owned trigger/function and retry outer stage; same intent/key
      completes once. Inject verification failure after actual writes using fixture
      corruption/trigger so receipt cannot commit; no mocked successful verifier.
      Real40001/40P01 must propagate without retrying the failed supplied tx.
- [ ] **Step5 — capture/commit races and malicious adoption tests.** Concurrent
      same-chain initializers yield byte-identical winner result, one operation key,
      one stage/two docs/two lots/one root. Different units remain independent.
      Alter dependency identity between capture and execution; reject no writes.
      Deliberately precreate operation/document/TLC conflicts through real services
      and assert no adoption. Simulate lost acknowledgement after committed
      `runAtomicStage` in test transport wrapper, then construct a fresh seed store;
      replay verifies one completed stage without duplication. No operational hook
      or production failpoint API added.
- [ ] **Step6 — GREEN and independent review.** Persist exact test results,
      including configured skips, fixture disposal and failures. Preserve all earlier
      journal/reference/Receiving public regressions; no reset/cleanup/commit.

## Task 5: Parsed CI ownership, factual handoff and final gates

**Files:** Four workflow/isolation/docs paths listed in source map.

- [ ] **Step1 — parsed ownership RED.** Require pure contract once with existing
      pure dataset contracts, and four configured new suites once in a new check-only
      dataset Receiving step after shared/API builds, exact fixture URL and
      `--maxWorkers=1`. Preserve all existing command matrices/order and release locks.
      Add fresh-workflow mutations for omission/duplication/conditions/ignored failure/
      shell suppression/wrong URL/DATABASE_URL fallback/missing builds/parallel workers.

```js
assert.equal(
  executions.filter((x) => x === "test/us-dataset-receiving-seed.e2e.test.ts").length,
  1,
);
assert.equal(owner.if, undefined);
assert.equal(owner["continue-on-error"], undefined);
assert.equal(owner.env.DATABASE_URL, undefined);
assert.ok(owner.run.trim().split(/\s+/).includes("--maxWorkers=1"));
```

Derive `executions/owner/build index` from parsed executable tokens using
established helpers, not source grep. Run Node suite before workflow edit.

- [ ] **Step2 — GREEN ownership and factual docs.** Add only these check owners,
      no release credentials/runtime entry. Append implemented one-chain contract/
      representative tests and remaining full-generation/downstream/correction/CLI/
      artifact/browser/cloud boundaries. Do not claim demo populated or CI remotely
      passed. Run all tooling Node tests and isolation checker.
- [ ] **Step3 — final API gates after all fixtures close.** API build/typecheck/
      lint, then configured new5files plus dataset atomic/journal/reference/recipe
      and prior13Receiving regressions, maxWorkers1. Keep fixture URL explicit and
      DATABASE_URL unset. Full API once with both DB vars unset; retain all failed/
      skipped file names and output, do not weaken assertions or broaden fixes.

```sh
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-receiving-contract.test.ts test/us-dataset-stage-read.e2e.test.ts test/us-dataset-receiving-verify.e2e.test.ts test/us-dataset-receiving-locks.e2e.test.ts test/us-dataset-receiving-seed.e2e.test.ts --maxWorkers=1
node --test tools/us-development/test/*.test.mjs
node tools/us-development/check-isolation.mjs
git diff --check
```

Invoke full API `corepack pnpm --filter @markiro/api test` with both DB vars
unset; local HTTP listening needs approved permissions, otherwise EPERM is
infrastructure failure. Previously eight persistent failed files were
billing-accounts, exchange-credentials/import/orders/protocol,
integrations-delete/integrations and subscription-route-inventory. Only billing
missing auth/origin variables is established. Eleven additional HTTP files
passed63/63 with permitted loopback; that did not clear the full-package gate.
Preserve Vite warning and profile-mismatch503 as separate limitations.

- [ ] **Step4 — final review and safe handoff.** Scoped Prettier on all created/
      modified files, empty index and unchanged HEAD, byte-baseline comparison proving
      no unrelated edits, independent Task5 review and whole-increment review.
      Report code/test evidence separately from unrun browser, complete260-chain
      generation, remote CI, artifacts/cloud/backup/deployment/hardware acceptance.
      Do not claim merge/deploy readiness while full API is nongreen. Retain ignored
      execution evidence and existing worktree; no authorized cleanup or commit.

## Self-review and next boundary

Spec sections1–4 map to Task1 and Task4; guards/capture/recovery section5 to
Tasks2/4; current-origin section6 to Task3; lock section7 to Task3 real writer
tests; errors section8 to every contract/negative test; acceptance/limitations
sections9–10 to Task5. All five Review Focus items have explicit owning tests.
Native methods retain supplied transaction types; no public schema/OpenAPI or
database migration change is required. Interfaces above are the task handoff.

This plan makes a regular Receiving stage usable and testable, not a complete
demo installation. Later plans cover Transformation/Cases/Shipping orchestration,
stage-aware correction/void, Plan/Requests, explicit initializer and measured
full-volume/viewer/artifact acceptance. No implicit permission to execute those
plans, populate a shared DB or deploy follows from this plan's acceptance.
