# US-11 Atomic Demo Receiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and canonically verify Scenario A's first finalized Receiving and its two real inbound lots, using the accepted reference seed and authoritative Receiving services.

**Architecture:** Extract transaction-scoped command/read entry points without changing existing public Receiving behavior. One guarded journal atomic stage creates the draft, computes current revision readiness, invokes the current v3 finalizer, verifies the actual current event/lots and commits their ordinary audits/operation receipts together with the demo receipt. A completed invocation is canonical verification only; no independently committed intermediate draft exists.

**Tech Stack:** Node24+, Corepack pnpm11.22.0, TypeScript, Drizzle/PostgreSQL, existing Zod/domain/platform-contracts, Vitest. No dependency or migration.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-single-tenant-demo-seed-design.md`, owner approved. Prerequisites: accepted foundation and `docs/superpowers/plans/2026-10-06-us-11-demo-reference-seed.md`, all tasks independently reviewed and whole increments approved. This is the Receiving subproject of the business chain, not the complete chain.

## Global Constraints

- Work remains in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve unrelated and accepted uncommitted work.
- No staging, commit, push, PR, merge, release, primary-database mutation, old fixture cleanup, dependency installation, personal environment-file write or local archive/design file change is included.
- Tests use owned disposable U.S. databases; they never populate the shared base database implicitly.
- Existing organization name, slug, metadata and owner audit are not repurposed as the dataset journal.
- Runtime code must not import from `apps/api/test` or mutable fixture transports. No fake Db or transaction-to-Db cast.
- No deletion, reset, password reset, MFA reset or role restoration command is included.
- No machine/authentication/audit clock override or silent deadline extension is allowed. Civil event date is `2026-09-14`; actual IDs, event-number year and audit/finalization times remain service-owned.
- No passwords, MFA keys, tokens, cookies, signed URLs, requester payloads or storage credentials in output/logs.
- Do not loosen runtime edition/loopback enforcement or worker build checks, or publish the dirty checkout.
- Preserve `US_DEMO_VERSION`, accepted descriptor/digest, reference recipe/receipt, migration0141, compact codec limits and existing journal method semantics.
- Receiving uses two inputs `500 lb` each, TLCs `OSS-260914-A1` and `OSS-260914-A2`; no implicit packaging conversion. Transformation/output `100 case`, cases, Shipping, Plan/package, viewer and deployment are subsequent subprojects.
- No UI/auth-policy/HTTP contract change. Existing normal role/capability and public legacy/versioned command behavior remains authoritative.
- Separate implementer and independent reviewer per task, then whole-increment review. Use byte checkpoints and explicit path manifests, not commit ranges. Retain uncommitted evidence.

## Review Focus

1. A transaction seam must not replace repeatable-read public wrappers/retry handling with a read-committed public path: Task1 public compatibility/concurrency regressions.
2. A saved historical finalization acknowledgement is not current origin: Task2 real amendment/void/pending-amendment tests must reject replay without repairing or resubmitting commands.
3. A committed result lost to the caller must reuse exact generated event/lot IDs and audit facts: Task2 real discarded-return and concurrent initializer tests.
4. Later legitimate consumption may change dependency tokens without changing Receiving identity: Task2 basis/lot verifier must distinguish technical tokens from immutable quantities/source and current lifecycle, rather than freeze the whole SQL lot row forever.
5. Failure after draft creation, first lot/audit or demo receipt persistence must leave only the separately committed pending intent: Task1/2 real trigger/outer-abort rollback tests.

## Inspected sources and file map

Current create bridge in `receiving/us-receiving-draft-commands.ts` owns authorization, key locks, draft insertion, counters, audit and operation receipts. `receiving/us-receiving-revision-finalization.ts` is the current compatible finalizer: it writes v3 snapshots and preserves old receipts. Do not seed through the legacy v1/v2 writer in `us-receiving-finalization.ts`. Readiness for that writer is `readReceivingRevisionContext` / `checkRevisionReadiness`, rule `receiving-readiness-v4`, not legacy checkReadiness. `receivingTransaction` remains the existing public repeatable-read retry wrapper. `lockReceivingRoot` establishes root-before-event lock ordering. Lot responses exclude receiving/consumer dependency tokens; basis responses expose complete current support count.

| Path                                                                                                         | Responsibility                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `apps/api/src/modules/traceability/receiving/us-receiving-draft-commands.ts`                                 | Shared creation implementation on supplied native transaction           |
| `apps/api/src/modules/traceability/receiving/us-receiving-revision-finalization.ts`                          | Shared current finalization implementation on supplied transaction      |
| `apps/api/src/modules/traceability/receiving/us-receiving-store.ts`                                          | Internal create/finalize/readiness/live/basis transaction entry points  |
| `apps/api/src/modules/traceability/lots/us-lot-store.ts`                                                     | Shared tenant-authorized exact lot read                                 |
| `apps/api/test/us-receiving-transaction-seams.e2e.test.ts`                                                   | Native composition, public parity and rollback                          |
| `apps/api/src/modules/traceability/demo/us-demo-receiving-recipe.ts`                                         | Exact bound draft, strict intent/result schemas                         |
| `apps/api/src/modules/traceability/demo/us-demo-receiving-verify.ts`                                         | Canonical current original Receiving, owned lots and basis verification |
| `apps/api/src/modules/traceability/demo/us-demo-receiving-seed.ts`                                           | Guarded atomic Receiving initialize/verify, no CLI/startup              |
| `apps/api/test/us-demo-receiving-seed.e2e.test.ts`                                                           | Real stage initialization/no-op/mismatch/concurrency/failure            |
| `.github/workflows/us-development.yml`, `docs/us/implementation-plan.md`, `docs/us/development-isolation.md` | Check-only ownership and factual partial-chain status                   |

## Task 1: Native transaction Receiving command/read seams

**Files:** Modify the four existing source paths above; create `apps/api/test/us-receiving-transaction-seams.e2e.test.ts`. Reuse genuine `createUsDemoJournalFixture` and accepted `UsDemoReferenceSeedStore`, not hand-written final-state fixtures. No fixture-policy change.

**Consumes:** `UsMasterDataTransaction`, existing command parsers/operation serializers, current v3 finalizer/readiness/live/basis readers, existing public stores.

**Produces:** Additional internal methods on the named stores:

```ts
// UsReceivingStore, tx: UsMasterDataTransaction first, then existing tenant/actor:
createDraftCommandInTransaction(tx, tenantId: string, actorUserId: string,
  input: unknown, requestId: string): Promise<ReceivingCreateResult>;
finalizeCommandInTransaction(tx, tenantId: string, actorUserId: string,
  id: unknown, input: unknown, requestId: string): Promise<ReceivingFinalizeResult>;
checkRevisionReadinessInTransaction(tx, tenantId: string, actorUserId: string,
  id: unknown, query: unknown): Promise<ReceivingRevisionReadiness>;
getLiveRecordInTransaction(tx, tenantId: string, actorUserId: string,
  id: unknown): Promise<ReceivingLiveRecord>;
getLotReceivingBasisInTransaction(tx, tenantId: string, actorUserId: string,
  lotId: unknown, query: unknown): Promise<ReceivingBasis>;
// UsLotStore:
getLotInTransaction(tx, tenantId: string, actorUserId: string,
  id: unknown): Promise<TraceabilityLot>;
```

Types above are existing platform-contracts exports. Export `createReceivingDraftCommandInTransaction` from the draft-command module with the same arguments as its current implementation except `tx` replaces `db`, and an explicit existing format argument. Export `finalizeReceivingCommandInTransaction` from revision-finalization with `tx` replacing db and compatible output parser; revision-only public entry remains unchanged. Each operation has one SQL/audit implementation; new methods start no transactions/retries/pools. Public wrappers retain exact isolation, bounded retries, parse/authorization order and legacy/versioned receipt semantics. Revision mode and compatible mode share existing implementation rather than duplicate the finalization branch.

- [ ] **Step 1 — write failing configured tests.** Provision genuine owner/reference prerequisites in an owned child. One outer transaction creates a full Receiving draft, checks v4 revision readiness, finalizes through the compatible v3 command and reads both generated lots/live root/basis on that same transaction. Assert current root lifecycle2, draftVersion1/revision1, snapshotVersion3 and two created bindings; complete quantities/source/documents; exact audit facts (draft creation, two lot creates, finalization) and two operation receipts. Throw after finalization and assert `f.snapshot()` unchanged, including counters/roots/children/lots/audits/operations. Test real audit trigger failure, current QA allowed/Auditor denied, foreign IDs, malformed input precedence, stale readiness, exact command retry and conflict. No fake database or production test-only cleanup.

```ts
await f.db.transaction(async (tx) => {
  const created = await receiving.createDraftCommandInTransaction(
    tx,
    c.tenantId,
    c.actorUserId,
    createInput,
    operationKey,
  );
  if (!("receiptVersion" in created)) throw new Error("Expected fresh versioned create");
  const ready = await receiving.checkRevisionReadinessInTransaction(
    tx,
    c.tenantId,
    c.actorUserId,
    created.eventId,
    { expectedDraftVersion: 1 },
  );
  expect(ready.ruleVersion).toBe("receiving-readiness-v4");
  expect(ready.state).toBe("complete");
  await receiving.finalizeCommandInTransaction(
    tx,
    c.tenantId,
    c.actorUserId,
    created.eventId,
    {
      commandVersion: 2,
      operationKey,
      expectedDraftVersion: 1,
      expectedLifecycleVersion: ready.expectedLifecycleVersion,
      previousRevisionId: ready.previousRevisionId,
      expectedInputDigest: ready.inputDigest,
      reviewedExemptLines: [],
    },
    operationKey,
  );
  throw new Error("synthetic_receiving_abort");
});
```

The test wraps this in rejects.toThrow and compares before/after full-row hashes. The same UUID is valid for create/finalize: current operation identity is tenant + command + key, not key alone. Do not change that schema or infer command success from this fact.

- [ ] **Step 2 — run RED.** Explicit owned US URL, primary DATABASE_URL unset: `corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=1`. Connectivity EPERM is not RED; repeat the exact safe configured command with loopback approval. Record missing-method behavior failures before source edits.
- [ ] **Step 3 — extract shared implementations.** Keep original public create format transaction selection and `receivingTransaction` around public finalization. Move their callback bodies into supplied-transaction helpers. Conflict mapping for lot uniqueness remains identical and throws, never continuing an aborted transaction. A supplied-transaction method cannot retry a partially failed transaction; only its owning caller can retry the entire unit. Public retries remain where they currently live. Read methods reuse their current authorizer/parser/reader on tx; ordinary public read isolation remains unchanged. Do not alter legacy writer, save/amend/void or command schemas.
- [ ] **Step 4 — run GREEN and compatibility.** New seam suite plus `us-receiving-draft-command-bridge.e2e.test.ts`, `us-receiving-finalization-command-bridge.e2e.test.ts`, `us-receiving-original-command.e2e.test.ts`, `us-receiving-revision-finalization.e2e.test.ts`, `us-receiving-revision-finalization-concurrency.e2e.test.ts`, `us-lot.e2e.test.ts`, `us-demo-reference-seed.e2e.test.ts`. Configured DB suites no new skips; typecheck/lint/affected formatting. Record owned target disposal. Exact command:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-transaction-seams.e2e.test.ts test/us-receiving-draft-command-bridge.e2e.test.ts test/us-receiving-finalization-command-bridge.e2e.test.ts test/us-receiving-original-command.e2e.test.ts test/us-receiving-revision-finalization.e2e.test.ts test/us-receiving-revision-finalization-concurrency.e2e.test.ts test/us-lot.e2e.test.ts test/us-demo-reference-seed.e2e.test.ts --maxWorkers=1
```

- [ ] **Step 5 — independent checkpoint/review.** No commit. Byte manifest, exact RED/GREEN and public wrapper isolation/retry compatibility must be accepted before Task2.

## Task 2: Receiving recipe, atomic seed and current-origin verifier

**Files:** Create the three Receiving demo modules and new seed test in the map; modify only workflow/two docs for check-only coverage. Existing descriptor/reference/journal/Task1 code remains preserved unless a separately reviewed defect requires an explicit ruling.

**Consumes:** Accepted `UsDemoJournalStore.runAtomicStage`, exact reference receipt and `verifyUsDemoReferences(tx, context, intent, receipt, actualStores)`, Task1 native services, existing `lockReceivingRoot`, v3/live/basis/lot schemas.

**Produces:** Types/functions exported from recipe module and seed store:

```ts
type UsDemoReceivingStores = Readonly<{
  receiving: UsReceivingStore;
  lots: UsLotStore;
  references: UsDemoReferenceStores;
}>;
type UsDemoReceivingInput = Readonly<{
  recipeVersion: 1; seedId: string; definitionDigest: string;
  referencesIntent: UsDemoIntent; referencesReceipt: UsDemoReceipt;
  draft: ReceivingDraft;
}>;
type UsDemoReceivingResult = Readonly<{
  recipeVersion: 1; eventId: string;
  lotIds: readonly [string, string];
  createReceipt: ReceivingOperationReceiptV2;
  finalizeReceipt: ReceivingOperationReceiptV2;
  record: ReceivingLiveRecord;
  lots: readonly [TraceabilityLot, TraceabilityLot];
}>;
makeUsDemoReceivingInput(seedId: string, referencesIntent: UsDemoIntent,
  referencesReceipt: UsDemoReceipt): UsDemoReceivingInput;
parseUsDemoReceivingResult(raw: unknown): UsDemoReceivingResult;
// Required typed actual services supplied explicitly; no hidden Db/global:
verifyUsDemoReceiving(tx: UsDemoTransaction, context: UsDemoJournalContext,
  intent: UsDemoIntent, receipt: UsDemoReceipt, stores: UsDemoReceivingStores): Promise<void>;
// new UsDemoReceivingSeedStore(db: Db)
initialize(context: UsDemoJournalContext): Promise<UsDemoReceivingResult>;
verify(context: UsDemoJournalContext): Promise<UsDemoReceivingResult>;
```

`UsDemoReceivingStores` is a readonly object containing actual `UsReceivingStore`, `UsLotStore` and the four reference store instances. Instantiate from genuine Db once. Result codec reuses existing schemas, requires exact tuple sizes/order/unique IDs, rejects extra keys and noncanonical normalized output. Receipt.recordIds is exactly `[eventId, ...lotIds]`; rootID equals eventID, not a fourth distinct record. No configurable caller draft.

### Fixed draft and evidence

Use receipt-bound reference IDs only: inbound product, processor receiving location, previous_source source/previous-source location and documentIds `[receiving_asn, receiving_bol]`. Civil date `2026-09-14`; `receivedAtNote: null`, `notes: null`. Two lines in descriptor order: `lotLinkMode: "create_on_finalize"`, `lotId: null`, TLC `OSS-260914-A1`/`OSS-260914-A2`, `quantity: "500.000"`, `unitOfMeasure: "lb"`, source `{ kind:"location", locationId: previousSourceId }`; `exemptSupplier:false`, `exemptReason:null`, `exemptReceipt:null`, `supplierLotReference:null`, `notes:null`. No invented exemption or process loss.

- [ ] **Step 1 — write failing tests first.** Pure recipe/schema/fresh-object tests outside DB-skipped suite. Real fixture first initializes accepted references. Fresh Receiving initialize creates exactly one current finalized original v3 Receiving, two real active imported/source-locked lots, two line/document child sets, ordinary operation/audit facts and one receiving stage receipt. No Transformation/cases/Shipping/Plan/request/worker rows. Compare each service-generated ID/TLC/quantity/source/date/document/product snapshot and exact audit actor/tenant/action/outcome/target/requestId/before/after; receiving stage header advances only capture+receipt.

```ts
const first = await seed.initialize(c);
expect(first.record.status).toBe("finalized");
expect(first.record.lifecycle.currentEventId).toBe(first.eventId);
expect(first.lots.map((l) => l.tlc)).toEqual(["OSS-260914-A1", "OSS-260914-A2"]);
const after = await f.snapshot();
expect(await seed.verify(c)).toEqual(first);
expect(await seed.initialize(c)).toEqual(first);
expect(await f.snapshot()).toEqual(after);
```

Test discarded real committed return, concurrent initializers, missing prerequisites/changed references before writes, wrong target/current owner and changed captured recipe. Unknown preexisting event/lot/operation records must block first apply without adoption. Use real void/amend commands after completion, and missing/edited/cross-tenant event/lot/receipt IDs: both verification APIs fail without repair. A pending amendment must also fail, even if original snapshot still exists. Driver failure must propagate. Inject triggers after draft creation/first lot creation/finalization audit and demo receipt update: all Receiving business/counter/audit/operation/receipt writes roll back, separately captured intent remains pending; exact retry succeeds once after fixture-local trigger removal. Full-row before/after hashes supplement precise assertions.

Add a case incrementing only a legitimate technical lot dependency token in the fixture and prove owned lot business evidence stays valid and replay writes nothing. Do not mutate business fields or create fake downstream snapshots for this test. No global exclusivity claim after completion: unrelated references/events remain outside owned receipt; no adoption.

- [ ] **Step 2 — run RED.** New configured seed suite before runtime modules exist. Record expected absent module/behavior, not EPERM. Use exact owned fixture and report skips accurately.
- [ ] **Step 3 — implement strict immutable recipe.** Validate the dependency reference intent/receipt/result with accepted codecs. Generate complete fixed draft from exact bindings. Pin full dependency evidence and `definitionDigest` in receiving intent input; canonical digest covers complete input. Keep recipe fresh ordinary JSON. Stage operationKey is generated once before atomic work and persisted with the intent; both internal commands use that key, with command-qualified identity. EventID/readiness/lots are created/derived inside the single atomic unit, never outside it. There is no separately committed command to replay after ambiguous outcome: receipt replay skips all command execution. Failed transactions may allocate different service IDs on retry because none survived.
- [ ] **Step 4 — implement prerequisite and canonical verifier.** Inside guarded tx, read current `traceabilityDemoSeedStages` references row by tenant+seedId+stage, parse its intent/receipt with existing codecs and compare full canonical values to receiving input dependencies. The enclosing runAtomicStage already validates complete stored journal; do not create an alternative header/provenance parser. Missing/different dependency is `us_demo_receiving_mismatch`. Invoke existing reference verifier with actual services. Root-lock original Receiving before live-read, then lock the two lots in sorted UUID order to serialize status/source writes while verifying; read through Task1 tenant-authorized getters. Require exact current finalized original, lifecycleVersion2/currentEventID/self-root/no pending/predecessor/supersession/void metadata; exact saved live record/finalization snapshot; both schema-valid command receipts matching persisted operation rows, same operationKey and correct command/event/digests. Validate expected fixed draft and v3 source/product/document/quantity snapshots rather than only echoing saved receipts.

Check active lots, full stable service response, imported basis, source lock tied to finalization and exact product/TLC/source. Technical dependency tokens are not immutable business evidence. Query complete current basis through supplied tx: supportCount1, exactly this root/event/revision1 and corresponding lineNo for each lot; do not freeze unrelated technical token values or reconstruct historical balance from today's balance. New current basis elsewhere is a mismatch for this fixture. Missing/invalid canonical business response maps to `us_demo_receiving_mismatch` with preserved cause; SQL/driver errors propagate. No mutation is allowed in verifier except transaction row locks.

- [ ] **Step 5 — implement atomic initialization/verification.** `initialize` requires existing verified references; it never provisions owner/profile/references. Read guarded journal, persist receiving intent if absent, and adopt a concurrent capture winner only after guarded reread and exact input digest/body equality. Catch only specific journal revision/intent conflicts, never arbitrary driver failure. Fresh apply refuses tenant event/lot/Receiving root/counter/child/operation rows before any command; original references remain allowed. Reverify dependency before commands. Call Task1 create, v4 readiness (require complete/no exempt review), explicit revision finalize, canonical live/lot reads; build real result and receipt. Ordinary service finalization writes all snapshots/lots/audits. Apply/verify/receipt use one `runAtomicStage`; no public pool-backed command is called inside it. Pending errors roll back the entire unit. `verify` requires existing header/intents/receipt, uses runAtomicStage receipt branch with an apply callback that throws `us_demo_receiving_incomplete`, and never initializes/captures/repairs.
- [ ] **Step 6 — covering checks and factual docs.** Configured serial run: new seam/seed suites plus demo reference/atomic/journal and Receiving draft/finalization command bridge, revision finalization/concurrency, shared-event/date compatibility and lot suites. All configured DB tests execute, no new skips. Preserve current US CI owners and add an unconditional serial check-only step after shared builds with explicit isolated US URL. Run affected Receiving HTTP/live readiness regressions, API typecheck/lint/build after fixtures close, root format, isolation checker/contracts and gitdiffcheck. One full API package gate with both ambient DB variables unset; report actual setup/import failures and skips without supplying primary secrets. No remote CI or browser/provider/worker/deploy claim.

Exact configured ownership command:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-transaction-seams.e2e.test.ts test/us-demo-receiving-seed.e2e.test.ts test/us-demo-reference-seed.e2e.test.ts test/us-demo-atomic-stage.e2e.test.ts test/us-demo-journal.e2e.test.ts test/us-receiving-draft-command-bridge.e2e.test.ts test/us-receiving-finalization-command-bridge.e2e.test.ts test/us-receiving-revision-finalization.e2e.test.ts test/us-receiving-revision-finalization-concurrency.e2e.test.ts test/us-receiving-shared-event-compatibility.e2e.test.ts test/us-receiving-date-compatibility.e2e.test.ts test/us-lot.e2e.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-http.e2e.test.ts test/us-receiving-revision-readiness.e2e.test.ts test/us-receiving-revision-readiness-concurrency.e2e.test.ts --maxWorkers=1
```

- [ ] **Step 7 — independent and whole-increment review.** Record exact hashes/TDD/audits/rollback/no-op/concurrency/owned-target disposal. No commit/push; retain evidence. Accepted output binds actual two input-lot IDs for the subsequent Transformation plan, not a fabricated output lot.

## Self-review and execution handoff

Spec scope/isolation/source/service ownership bind both tasks. This subproject implements section3 Receiving and section4 transactional Receiving ownership/repetition, with section6 Receiving-specific evidence; all five Review Focus risks have concrete tests. Transformation/cases/Shipping/trace, CLI/preflight, Plan/package, viewer/browser and hosted acceptance remain named subsequent subprojects. No whole-chain or hosted completion is hidden in a Receiving receipt.

Native command/read interfaces are consistent across tasks. Transaction retries remain public-wrapper-owned; supplied tx methods never pretend to create a new isolation configuration. Generated IDs/readiness and command receipts are one atomic unit, while stage intent is durable beforehand. Existing reference verifier explicitly consumes actual service instances. No changed migration, accepted descriptor, dependency or public contract is required.

Preserve chosen execution method: separate implementer and independent reviewer per task, then whole-increment review; no intermediate “continue?” prompts between accepted tasks. This newly written plan requires owner review before implementation under writing-plans; no Receiving implementation has started.
