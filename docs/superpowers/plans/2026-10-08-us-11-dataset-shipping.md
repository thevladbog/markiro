# Regular dataset Shipping implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically install and truthfully verify one regular chain's recipe Shipping stage.
**Architecture:** Preserve the journal and native Shipping boundaries. Strict frozen
result evidence precedes a narrowly proven native status compatibility helper,
then explicit locks and actual stores execute/verify the stage.
**Tech Stack:** Node24/Corepack pnpm, TypeScript/Zod/Drizzle/PostgreSQL/Vitest, YAML Node contracts.
**Spec:** `docs/superpowers/specs/2026-10-08-us-11-dataset-shipping-design.md`

## Global Constraints

- Work only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`, HEAD `f06aaef2b923a7ae902c0fabacfd0c4712c127c3`; preserve inherited dirtywork/index.
- No commit/push/PR/merge/release/deploy/cleanup/env/dependency/schema/migration/runtime/CLI/shared-base seeding changes. Existing business method semantics, recipe and journal isolation remain unchanged; one additive guarded header-read seam is allowed below.
- Node24/Corepack installed dependencies; no database workers during builds.
- DB tests only invocation-owned disposable US children from `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`; DATABASE_URL unset, `--maxWorkers=1`, exact disposal.
- All business reads/writes use supplied transaction, real stores/current target/owner authorization; no fakeDb/store adapters/test hooks/hidden inner transaction or retry.
- Existing256KiB descriptor-safe JSON guard; owned frozen copies; honest current vs historical/forecast facts. Preserve primary SQL/domain error identity and cause.
- Actor/tenant/action/target/outcome/requestId/before/after audit assertions exact. Explicit read-committed locks/rechecks required; native RR tests alone not this executor's proof.
- Owner preapproves implementation/waives approval questions; separate implementer and independent spec+quality review per task; controller full API once final with both DB vars unset. Known broad8failed files/old Cases timeouts/CJS/scan fixture gaps remain separately reported.

## Review Focus

1. Captured but incomplete Shipping intent must not adopt native writes already present — Task3 pending conflict test and inventory assertions.
2. A zero-stock manual `shipped` edit must not masquerade as a native effect — Task2 manual/effect/audit/foreign denial tests.
3. Second shipment failure must roll back first shipment/docs/counters/effects too — Task3 trigger failures plus exact public-table hashes.
4. Upstream or public writer waiting on the same output must not create a mixed committed verification — Task3 real independent pool/PID barriers, original errors and fresh retry.
5. A named CI owner may exist yet not execute the suites — Task4 executable YAML alias/suppression/order/condition mutations.

## Task 1: Frozen Shipping result and deterministic operations

**Files:** Modify `apps/api/src/modules/traceability/demo/us-dataset-shipping-contract.ts` only by adding result/key/error APIs; create `apps/api/test/us-dataset-shipping-result.test.ts` and `apps/api/test/support/us-dataset-shipping-result-fixture.ts`.
**Consumes:** existing input/parser/plan; full Shipping draft/finalized schemas, document/lot schemas.
**Produces:**

```ts
type UsDatasetShippingShipmentResult = Readonly<{
  shipmentNo: number; operationKey: string; requestId: string;
  documents: readonly Readonly<{key:string;record:ReferenceDocument}>[];
  createInput: CreateShippingDraftInput; finalizeInput: FinalizeShippingInput;
  created: ShippingDraftRecord; finalized: ShippingFinalizedRecord;
}>;
type UsDatasetShippingResult = Readonly<{
  input: UsDatasetShippingInput; originLot: TraceabilityLot;
  outputLotAfter: TraceabilityLot;
  shipments: readonly UsDatasetShippingShipmentResult[];
}>;
// exported from the existing Shipping contract module:
usDatasetShippingOperationKey(operationKey: string, shipmentNo: number): string;
parseUsDatasetShippingResult(raw: unknown): UsDatasetShippingResult;
usDatasetShippingRecordIds(result: UsDatasetShippingResult): readonly string[];
datasetShippingError(code: UsDatasetShippingErrorCode, unitKey: string, cause?: unknown): Error & {unitKey:string;stage:"shipping"};
```

- [ ] Write a real failing pure fixture assertion first. Static collection failure is not RED:

```ts
expect(
  parseUsDatasetShippingResult(fixture(0)).shipments.map(
    (s) => s.finalized.snapshot.items[0]?.quantity,
  ),
).toEqual(["22", "23"]);
expect(usDatasetShippingRecordIds(fixture(0))).not.toContain(fixture(0).originLot.id);
```

- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-shipping-result.test.ts --maxWorkers=1`; record genuine missing/coherence-boundary RED.
- [ ] Add full strict native response shapes, bounded validation before any getter, canonical input/commands/snapshot agreement and actor/time/lifecycle identity. Require initial revision1/draftVersion1/root self, lifecycle1 draft→2 final, no amendments/voids/pending successor. Documents/events/derived operation UUIDs distinct across shipments; exact count/order; unchanged origin fields except proven planned status/revision in outputLotAfter.
- [ ] Implement operation UUID derivation exactly:

```ts
const hex = canonicalExportDigest({
  namespace: "us-dataset-shipping-operation-v1",
  operationKey,
  shipmentNo,
})
  .slice(0, 32)
  .split("");
hex[12] = "5";
hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
const value = hex.join("");
return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
```

Validate lowercase UUID and shipmentNo1/2 first. Metadata carrierReference null, notes `Synthetic six-month demo shipment.`; request ID `dataset-shipping:<stage-key>:<shipmentNo>`. Pure parser extracts the same root UUID from every request ID and checks exact native key derivation; executor also binds it to the journal key.

- [ ] Test split partial0/full1/single258/full259, literal key goldens, source/product/TLC/location/issuer/metadata/quantity/doc order/revision/time/actor/root/command/duplicate/normalization drift, getter/prototype/custom arrays and256KiB/depth; frozen non-aliasing. Retain readiness digest, never invent old balance.
- [ ] GREEN plus existing Shipping input and six-month/pure Receiving/Transformation/Cases suites, scoped lint/format/APItypecheck. Controller owns broad full gate. Report frozen source hashes/TDD/errors/results in own task report; no commits.

## Task 2: Proven Shipping status compatibility

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-shipping-origin-status.ts`, `apps/api/test/us-dataset-shipping-origin-status.e2e.test.ts`, `apps/api/test/support/us-dataset-shipping-fixture.ts`; modify only output-lot comparison in `apps/api/src/modules/traceability/demo/us-dataset-transformation-verify.ts` and add only the guarded header-read method below to `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`.
**Consumes:** Task1 APIs plus existing real journal/Reference/Receiving/Transformation/Cases stores and fixture utilities.
**Produces:**

```ts
// Additive method on UsDatasetJournalStore: checkedTransactionContext first,
// then stored(tx, checked); no nested transaction, pool read or changed isolation.
readHeaderInTransaction(tx: UsDemoTransaction, raw: UsDatasetContext): Promise<UsDatasetHeader | null>;
verifyUsDatasetShippingOriginStatus(
  tx: UsDemoTransaction, context: UsDatasetContext,
  journal: UsDatasetJournalStore,
  expected: UsDatasetTransformationResult, current: TraceabilityLot,
): Promise<void>;
// test-only fixture prepares real completed prerequisites and captures Shipping intent:
type UsDatasetJournalFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
type UsDatasetShippingFixturePrepared = Readonly<{
  datasetId:string;input:UsDatasetShippingInput;intent:UsDatasetIntent;
  references:UsDatasetStageRow;receiving:UsDatasetStageRow;
  transformation:UsDatasetStageRow;cases:UsDatasetStageRow;
}>;
prepareDatasetShippingFixture(f: UsDatasetJournalFixture, context: UsDatasetContext, index:number): Promise<UsDatasetShippingFixturePrepared>;
```

- [ ] RED: real native complete Shipping writes under captured Shipping intent followed by existing `UsDatasetTransformationSeedStore.verify` and `UsDatasetCasesSeedStore.verify` rejects legitimate shipped output. Record exact mismatch, not infrastructure failure.
- [ ] Guard actual target and current owner through `readHeaderInTransaction` before inspecting raw expected/current evidence. Existing stage reads require a dataset ID and therefore cannot provide this ordering without reading caller evidence first. Use the returned header ID; test unauthorized evidence getters remain untouched.
- [ ] Native operations store finalize digest/result, not historical readiness input. Before publication, verify finalize key/command/event/result and digest shape, and recompute exact create digest. With a completed Shipping receipt, compare finalize digest to frozen finalizeInput. Task3 must compare exact fresh/frozen finalize digest before completion; pending status proof alone cannot detect a well-formed finalize-digest substitution and never permits adoption. Report this boundary explicitly.
- [ ] Keep exact unchanged identity fast path. For alternate status require native dataset proof specified by spec: expected active/revision1, current shipped/revision2, unchanged ID/product/TLC/source/source-lock/created facts, canonical captured Shipping intent with same dependencies/output; derived operation receipts for every recipe shipment/current finalized roots/lines; known balance exact recipe supply/used/remaining0; one uncompensated effect owned by last shipment; exact successful native status audit actor/tenant/target/request/before/after/origin/clocks. No new root lock after lots; caller already holds origin roots/union lots.
- [ ] Replace only this existing comparison with the new proof, not generic Receiving identity helper or native status code:

```ts
await verifyUsDatasetShippingOriginStatus(
  tx,
  context,
  stores.journal,
  result,
  await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, result.outputLot.id),
);
```

- [ ] Fixture uses actual stores/native commands and deterministic keys, never fake receipts/business inserts. Pure-shaped result builder is test-only, native values retained. All exact child disposal/worker drain registered before body.
- [ ] Tests unchanged active path, full split/single upstream replay, manual recall/active/shipped status, source/lot identity drift, missing/foreign/wrong-owner/compensated effect, wrong native command/amount/actor/event/root/pending origin/extra consumer/audit mismatch. Assert exact table hashes no verification writes. Controlled pending native evidence proves only status, never stage adoption; no completed receipt falsely asserted.
- [ ] GREEN configured test + existing Transformation/Cases verify/seed and Shipping status/void suites serial, no base changes. APItypecheck/scopedlint/format after DBdrain. Report actual locks/source writer map/proof limits; no broad API duplication.

## Task 3: Atomic Shipping application, locks and replay verification

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-shipping-seed.ts`, `us-dataset-shipping-prepare.ts`, `us-dataset-shipping-locks.ts`, `us-dataset-shipping-verify.ts` in the same demo directory; create `apps/api/test/us-dataset-shipping-seed.e2e.test.ts`, `us-dataset-shipping-verify.e2e.test.ts`, `us-dataset-shipping-locks.e2e.test.ts`; extend only Task2's new Shipping fixture if needed.
**Consumes:** Tasks1/2 frozen APIs; actual existing stores/journal/current native Shipping entries.
**Produces:**

```ts
class UsDatasetShippingSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext,index:number):Promise<UsDatasetShippingResult>;
  verify(context: UsDatasetContext,index:number):Promise<UsDatasetShippingResult>;
}
type UsDatasetShippingStores = UsDatasetTransformationStores & Readonly<{shipping:UsShippingStore}>;
type UsDatasetShippingPrepared = Readonly<{
  input:UsDatasetShippingInput;intent:UsDatasetIntent;shipping:UsDatasetStageRow;
  references:UsDatasetStageRow;receiving:UsDatasetStageRow;
  transformation:UsDatasetStageRow;cases:UsDatasetStageRow;
}>;
prepareUsDatasetShipping(tx:UsDemoTransaction,context:UsDatasetContext,datasetId:string,unitKey:string,
  phase: "application"|"verification",stores:UsDatasetShippingStores):Promise<UsDatasetShippingPrepared>;
// Prepared contains input/intent/current Shipping stage and all four validated prerequisite stages.
verifyUsDatasetShipping(tx:UsDemoTransaction,context:UsDatasetContext,
  intent:UsDatasetIntent,receipt:UsDatasetReceipt,stores:UsDatasetShippingStores,
  mode:"fresh"|"replay"):Promise<void>;
```

- [ ] RED first initialize returns two real finalized rows and stage revision2; nonexistent executor behavior cannot satisfy this test. Both commands/request/doc audits must come from native stores.
- [ ] Before index/raw evidence, reauthorize actual target/current owner using journal read. Require References/Receiving/Transformation/Cases receipts, derive same current input from captured native evidence. Capture stable stage intent, reconcile concurrent capture only by equal saved input; never recursively install prerequisites. Verify-only missing/pending fails without writes.
- [ ] `runAtomicStage` supplies the sole transaction. Preparation verifies current guarded dependencies, obtains dataset/header/stage and case/native operation locks before business roots; replay locks known Shipping roots/revisions before sorted union lots; fresh roots private. Existing upstream verifiers execute only after their required locks already held. Add explicit source-backed writer lock map and actual PID races; no blanket RC claim.
- [ ] Application refuses any preexisting create/finalize operations for derived keys or exact recipe documents. Initial stock known case, exact supply,used0. Resolve symbolic IDs from verified References bindings; two docs per shipment; actual native loop:

```ts
const created = await stores.shipping.createDraftInTransaction(
  tx,
  tenantId,
  actorUserId,
  createInput,
  requestId,
);
const ready = await stores.shipping.checkReadinessInTransaction(
  tx,
  tenantId,
  actorUserId,
  created.id,
  { expectedDraftVersion: created.draftVersion },
);
if (ready.state !== "complete") throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
const finalizeInput = {
  operationKey,
  expectedDraftVersion: created.draftVersion,
  expectedInputDigest: ready.inputDigest,
};
const finalized = await stores.shipping.finalizeInTransaction(
  tx,
  tenantId,
  actorUserId,
  created.id,
  finalizeInput,
  requestId,
);
```

Later readiness sees preceding writes. After loop capture real outputLotAfter; strict result/recordIds/digest; fresh verification before stage receipt, no fake current-stock snapshot.

- [ ] Verifier current target first, journal result/input identities, upstream/current roots/origin/case support/links, all native drafts/finalized reads/headers/children/operation digests/document metadata/issuers, exact audit payloads/clocks, current recipe balance and status proof. Reject any extra current output consumer, void/amended/pending revisions, data/status/source/manual link drift. No historical readiness recalculation. Explicit fresh mode only for this invocation's private writes, not existing pending writes.
- [ ] Real DB tests0/1/258/259, no-write initialize/replay/verify, concurrent initializer convergence, missing prerequisites/current owner/tenant denial, stable input/different intent, pending operation/doc conflicts. Trigger fail after first/second shipment/final audit/receipt, exact full public-table hashes rollback including counters/effects; stage intent stays revision1; fresh retry succeeds. Actual public Shipping/void/manual status/origin/case writers race via independent pools and PID barriers; errors retain original SQL identity, no hidden retry. Release barriers before awaiting workers; owned cancellation work drains before disposal without claiming production abort signal support.
- [ ] GREEN all new configured suites plus Task2 and relevant old dataset/Shipping regressions serial, then scopedlint/typecheck/format after drain. Freeze/report detailed TDD/results/errors/exact owned disposal and limits.

## Task 4: Mandatory US CI and accurate checkpoint

**Files:** Modify only `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
**Consumes:** Reviewed Task1–3 exact suite filenames and source hashes.
**Produces:** One unconditional owner after shared/domain/API builds:

```yaml
- name: Verify regular dataset Shipping on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-shipping-contract.test.ts test/us-dataset-shipping-result.test.ts test/us-dataset-shipping-origin-status.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts test/us-dataset-shipping-verify.e2e.test.ts test/us-dataset-shipping-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Capture actual parsed predecessor steps/workflow hashes before editing; new missing-owner parsed RED first. Preserve all old SHA pins; add only new-owner exclusions to preservation filters. Removing only new owner reconstructs actual whole previous workflow/steps and unchanged30min budget.
- [ ] Mandatory exact globally unique command/suites/env; deny workflow/job/step conditions, continue-on-error, run/shell suppression, redirects, quoted/./ duplicates/split owners across workflows, wrong serial/fixture/DATABASE fallback, missing/reordered/conditional/suppressed builds, prior permissions/services/settings/owner drift. Each fresh YAML mutation must fail intended AssertionError/message.
- [ ] Append docs with actual verified per-chain behavior, status compatibility and remaining full-volume/CLI/runtime/artifact/hosting work. Local checks not remote CI timing or shared DB population. No private motivation text.
- [ ] Run isolation/all safe tools *.test.mjs/checker/scopedlint/format/diff. Independent review; controller fresh configured6new suites + bounded old regressions after staticworkersdrain; APItypecheck/lint/build, fullAPIonce bothDBvarsunset, finalformat/diff/sourceinventory/HEAD/index and wholeincrementreview.

## Controller handoff

Self-review spec/plan against actual interfaces and exact task ownership. Use own
ignored SDD workspace, byte originals and source inventories instead of commits.
No generic skill instruction permits staging/install/push/cleanup in this scope.
All four tasks execute under existing user approval; do not ask to continue.
Final report must separate accepted per-chain execution from remaining full-data
population and all external/manual validation. Final review has at most one
consolidated fix wave and one scoped rereview; retain evidence workspace.
