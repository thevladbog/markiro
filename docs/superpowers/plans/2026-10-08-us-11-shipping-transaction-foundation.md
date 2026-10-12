# US-11 Shipping transaction foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Owner selected separate implementer and independent review per stage; execute continuously without approval questions.

**Goal:** Compose existing Shipping commands/readers inside a caller-owned transaction without changing public behavior.

**Architecture:** Extract one native body per operation; retain current public retry wrappers. Verify database rollback/current authorization/actual lock schedules before a later dataset orchestration plan.

**Tech Stack:** Node24/Corepack pnpm,NestJS,Drizzle,PostgreSQL,Vitest,parsed YAML Node tests.

**Spec:** `docs/superpowers/specs/2026-10-08-us-11-shipping-transaction-foundation-design.md`

## Global Constraints

- Work only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`, preserve accepted dirty baseline/empty index.
- Owner expressly waived intermediate design/plan approval questions2026-10-08; keep artifacts/self-review and independent implementation reviews.
- No staging/commit/push/merge/PR/release/cleanup,env/dependency/install/schema changes or shared-base population.
- Preserve `us-processor-six-month-v1`,April–September2026,America/Los_Angeles,260chains/440shipments,Scenario A and256KiB journal limits.
- Native methods use supplied UsMasterDataTransaction,no pool read/nested tx/inner retry/commit; public wrapper stays repeatable read with established3attempt policy.
- Keep public signatures/schema/commandVersion1digests/replay/authorization/HTTP behavior unchanged; no source flag.
- Minimal extraction only; save/amend/void/balance/history helpers unchanged unless a demonstrated extraction dependency is reported.
- Test only invocation-owned disposable US PostgreSQL via US_TEST_DATABASE_URL; DATABASE_URL unset; maxWorkers1; drain workers before builds.
- Reuse installed Node24/Corepack pnpm dependencies. Full API once at final controller gate,both DBvariables unset; failures/skips reported separately.
- Dataset orchestration/initializer/fullpopulation/browser/artifacts/hosting/backup/hardware/regulatory acceptance are subsequent scopes; future hosted storage outsideRF.

## Review Focus

- Replay after membership/capability loss must deny before malformed business input:Task1 authority matrix.
- Finalization at exactly zero may write lot status/effect/audit beyond event rows:Task1 zero-stock rollback proof.
- A raw driver error wrapped in cause must remain original and get one native attempt:Task1 boundary injections.
- Existing public writers bypass dataset journal locks:Task2 actual PID schedules,not blanket read-committed claim.
- CI command alias/ignored failure may silently omit required checks:Task3 fresh parsed YAML mutations.

## Interfaces and file ownership

Task1 modifies only `apps/api/src/modules/traceability/shipping/us-shipping-draft.ts` and `us-shipping-finalization.ts`; creates `apps/api/test/us-shipping-transaction-seams.e2e.test.ts` and `support/us-shipping-transaction-fixture.ts`.
Task2 creates `apps/api/test/us-shipping-transaction-locks.e2e.test.ts`, may extend only the new fixture.
Task3 modifies `.github/workflows/us-development.yml`,`tools/us-development/test/isolation.test.mjs`,`docs/us/development-isolation.md`,`docs/us/implementation-plan.md`.

```ts
// Methods on existing UsShippingStore; no new constructor dependency.
createDraftInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, input: unknown, requestId: string): Promise<ShippingDraftRecord>;
checkReadinessInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, eventIdInput: unknown, queryInput: unknown): Promise<ShippingReadiness>;
getRecordInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, eventIdInput: unknown): Promise<ShippingHistoricalRecord>;
finalizeInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, eventId: unknown, input: unknown, requestId: string): Promise<ShippingFinalizedRecord>;
// Exported from us-shipping-finalization.ts, used by class/native and public wrapper.
finalizeShippingInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown, input: unknown, requestId: string): Promise<ShippingFinalizedRecord>;
```

All types exist in platform-contracts except UsMasterDataTransaction from master-data support. Fixture module is test-only; use existing createUsProfileTestDatabase/seedShippingLifecycle and its owned pool/disposal primitives, no runtime test hooks.

## Task 1: Native operations and atomic service composition

**Files:** two Shipping modules,new seams suite/new fixture only.
**Consumes:** existing store/public functions,readiness/history/status effects/reference-document native methods.
**Produces:** four class methods/exported finalizer with exact signatures above.

- [ ] Write real native composition test first, using owned disposable fixture and real100-case origin. Assert native entry exists, call real document/create/readiness/finalize/read inside caller transaction,20cases/80remaining literal; before implementation failure must name missing native boundary,not environment/typing setup.

```ts
await fixture.db.transaction(
  async (tx) => {
    const draft = await store.createDraftInTransaction(
      tx,
      tenantId,
      actorUserId,
      { operationKey: createKey, draft: shippingDraft },
      requestId,
    );
    const ready = await store.checkReadinessInTransaction(tx, tenantId, actorUserId, draft.id, {
      expectedDraftVersion: draft.draftVersion,
    });
    expect(ready.state).toBe("complete");
    const result = await store.finalizeInTransaction(
      tx,
      tenantId,
      actorUserId,
      draft.id,
      {
        operationKey: finalizeKey,
        expectedDraftVersion: draft.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      requestId,
    );
    expect(result.snapshot.items[0]?.quantity).toBe("20");
    expect(await store.getRecordInTransaction(tx, tenantId, actorUserId, draft.id)).toEqual(result);
  },
  { isolationLevel: "repeatable read" },
);
```

- [ ] Run configured new suite with maxWorkers1 before implementation,record exact RED. Reuse real fixture lifecycle,dispose exact owned child on failed setup/earlyfailure; loopback denial is not RED.
- [ ] Extract existing create/readiness/record bodies into native methods. Public methods delegate through unchanged shippingTransaction. Extract finalizer body into exported async finalizeShippingInTransaction, public finalizeShipping delegates unchanged wrapper; class native forwards only.

```ts
createDraft(tenantId: string, actorUserId: string, input: unknown, requestId: string) {
  return shippingTransaction(this.db, (tx) =>
    this.createDraftInTransaction(tx, tenantId, actorUserId, input, requestId));
}
```

- [ ] Assert exact original operation digest/result and native/public replay bytes; reauthorize current membership for all4entries before parsing/replay, tenant/capability denial, revoked replay/malformed IDs/input and foreign event/reference/lot. Public retry behavior remains existing; test actual body side effects not trivial forwarding alone.
- [ ] Throw sentinel after actual finalization including same-tx document writes; compare complete consistent persisted-table hashes before/after for counters/eventroots/revisions/children/documents/operations/audits/lotdependency/status/effects. Repeat quantity100 to hit shipped transition; assert full exact status audit and rollback. Test overshipping101/source-UOM mismatch blocked with no partial writes.
- [ ] Inject40001/40P01 at realwrite/audit/operation boundaries via controlled fixture triggers; assert original driver/cause identity,oneattempt, full rollback and explicit fresh caller retry. Label injections,not induced deadlocks. No test-only production methods/fake Db/transaction override/global clock mocking.
- [ ] Configured new suite + all10current Shipping suites serial,scoped lint/typecheck/format/diff after workers drain. Self-review/frozenreport; independent reviewer before Task2. No commit.

## Task 2: Actual contention and cleanup proofs

**Files:** new locks suite,new fixture extension only; no production behavior change.
**Consumes:** Task1 exact native interfaces and genuine fixture; existing public finalization/lifecycle/currentbalance/origin writers.
**Produces:** documented lock schedules and cancellation/disposal evidence,not a dataset lock protocol.

- [ ] Map operation→ownroot/header→sortedaffectedlots→references/status locks against current public finalize/amend/void/manual lot status and Receiving/Transformation origin changes. Use real Receiving and Transformation origins in coverage; record which schedules require caller RR/prelocks. No upstream-root-after-held-lot choreography.
- [ ] Test actual native/public same operation contention and independent shipments on same100-case lot:one80-case finalize then conflicting30-case must not overship. Separate backend PIDs,pg_blocking_pids/query-state observed,barrier-controlled release,exact commits/rollback/audits/balance; do not use elapsed sleeps as evidence.

```ts
const blocked = await observer.query<{ blocked: boolean }>(
  "select $2::int = any(pg_blocking_pids($1::int)) as blocked",
  [waiterPid, blockerPid],
);
expect(blocked.rows[0]?.blocked).toBe(true);
```

- [ ] Exercise read/lifecycle contention without claiming arbitrary RC snapshot consistency; verify public amendment/void/status effects and frozen history unaffected. When a suspected gap needs changed lock semantics,report exact source/schedule to controller before editing product.
- [ ] Real TestContext.signal cancellation before readiness and while PID-observed waiting. Release all barriers before awaiting actual workers; original signal reason/primaryexception survives independent cleanup failure. Ordinary following proof checks intended phase,rejection/rollback and exact owned backend absence. Dispose exactchild,never historical/globalresources; no new deadlines.
- [ ] Run two new suites plus10oldShipping suites serial; scopedformat/lint/typecheck after drain. Independent spec/quality review; preserve raw errors/publicregressions. No commit.

## Task 3: CI ownership and accurate checkpoint

**Files:** exact four CI/docs paths named above.
**Consumes:** Task1/2frozen suites and reviewed evidence.
**Produces:** one unconditional serial check-only owner,negative mutations,partial acceptance docs.

- [ ] RED actual parsed owner absence; then add exact owner `Verify Shipping native transaction foundation on disposable databases` after existing shared/domain/API builds:

```yaml
- name: Verify Shipping native transaction foundation on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-shipping-transaction-seams.e2e.test.ts test/us-shipping-transaction-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Fresh YAML mutation tests pin missing/duplicate owner,suite omission/split/quoted and ./test aliases across workflows; workflow/job/step conditions,continue-on-error/shellsuppression,wrongserial/fixture/primaryfallback at every scope,missing/reordered/conditional/suppressedbuilds,oldpermissions/services/settings/commands30min drift. Assert intended AssertionError/message,not genericthrow.
- [ ] Remove only new owner to restore actual preincrement steps hash `d3144c04106e7bd4e176ec210aee5351c30aab869b625c8969c0f29251a3e8b3` and workflow hash `849380f0b1b156fa2c7294ab8b7eadaabac2fc36582b2b1329f22836e56feebe`;recheck beforeediting. Add only new-owner exclusions to oldpreservation filters,never repin oldbaselines. Preserve current Cases owner/newalias semantics.
- [ ] Append actual counts/native semantics/lock boundary/prooflimits to bothdocs. No placeholder-green/fullpopulation/remoteCIclaim. Run isolation suite,all safe Node *.test.mjs,checker,scopedlint/format/diff;independentreview.
- [ ] Controller fresh APItypecheck/lint/build afterworkersdrain,configured12files (2new+10old) serial fixture-only,then onefullAPIbothDBvarsunset withlocaltestlisteners permitted. Record exact errors/skips/causes;do notfixunrelatedRU/env. Finalformat/diff/allsourcehashes/HEAD/index and wholeincrementreview. No push/commit/deploy/cleanup.

## Execution handoff

Owner preapproved implementation and waived further questions. Self-review spec/plan,execute all3tasks using separate implementer+independentreview method. Generic commits/workspace cleanup/install instructions are overridden. Keep evidence in this plan's ignored workspace. Final deliverable is foundation only; next dataset Shipping orchestration has its own scoped design/plan but needs no human confirmation under the same delegated authority.
