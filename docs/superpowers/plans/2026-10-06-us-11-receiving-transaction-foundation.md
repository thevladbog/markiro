# US-11 Receiving Transaction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose real document creation, Receiving draft/readiness/finalization and lot reads inside one caller-owned transaction, retaining existing public behavior.

**Architecture:** Extract native transaction command implementations from the current Receiving services, not the legacy finalization writer. Public wrappers keep their isolation, bounded retry, authorization, parsing and historical response behavior. New internal entry points let the subsequent bounded per-chain dataset orchestrator commit documents, Receiving, lots, audit and its journal receipt atomically.

**Tech Stack:** Node 24+, repository-declared Corepack pnpm, TypeScript, Drizzle/PostgreSQL, existing platform contracts/domain rules and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`, sections 1, 3, 4 and 6. Reference prerequisite is the accepted implementation described by `2026-10-06-us-11-dataset-reference-seed.md`.

Status: proposed written plan; execution requires owner confirmation. Keep the selected separate implementer and independent reviewer per task, followed by whole-increment review. The old compact `2026-10-06-us-11-demo-receiving-seed.md` remains unapproved and is not executed by this plan.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve unrelated and accepted dirty work.
- Preserve `us-processor-six-month-v1`, `2026-04-01` through `2026-09-30`, `America/Los_Angeles`, catalogue/manifest/digest, compact Scenario A, migrations 0141/0142 and 256 KiB journal limits.
- No staging, commit, push, PR, release, shared-base population, destructive cleanup, environment/dependency changes or archive/design-file changes.
- No runtime/CLI/HTTP/UI registration, new customer provisioning, Station, scanning, printing or hosting. No dataset Receiving orchestrator, new receipt codec or full-volume generation in this increment.
- Event snapshots, lots, references, operation receipts and audit remain owned by current services. Never insert fabricated final event/lot/balance/genealogy rows through seed SQL.
- Historic dates are business civil dates only. Actual creation, audit, review and finalization clocks and generated event-number year remain service-owned; no fake system clock.
- Existing public capabilities, tenant isolation, legacy/versioned replay, save/amend/void behavior, isolation and bounded retries remain unchanged. Runtime never imports test helpers or casts a transaction into Db.
- Use only fixture `US_TEST_DATABASE_URL`, leave `DATABASE_URL` unset, create/dispose owned random child databases. Never write the shared base or count an unconfigured skip as DB evidence.

## Review Focus

1. Extraction must not weaken public repeatable-read isolation or three-attempt reauthorization/retry behavior, including invisible operation-receipt races.
2. Caller abort or an actual document/draft/lot/audit/receipt failure must roll back every composed write, counter, root and operation; supplied-transaction commands must not retry a partially failed transaction.
3. Historical command replay must remain compatible but must not masquerade as current finalized origin after void or amendment; current readers expose lifecycle and basis independently.
4. Tenant/role denial, malformed input precedence, stale readiness and lot uniqueness conflicts must preserve public error behavior and leave no writes.
5. Read methods cannot silently promise repeatable-read consistency on a caller's read-committed transaction; their isolation/locking obligation must be explicit, with meaningful fresh-record composition and public concurrent-reader regressions.

---

## Sources and file boundaries

Before editing read root `AGENTS.md`, API guide (fallback `/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md` where worktree copy is absent), the named spec and current code/tests/history. No Graphify graph exists in the US worktree; use current source, do not install/build a graph for this increment.

Modify only:

- `apps/api/src/modules/traceability/receiving/us-receiving-draft-commands.ts`: one shared create SQL/audit/operation body; preserve existing save implementation.
- `apps/api/src/modules/traceability/receiving/us-receiving-revision-finalization.ts`: one current v3 finalization body for compatible/revision public paths and native compatible path.
- `apps/api/src/modules/traceability/receiving/us-receiving-store.ts`: internal command/read entry points, public wrappers delegate without changing isolation or output schema.
- `apps/api/src/modules/traceability/lots/us-lot-store.ts`: share existing authorized exact lot getter.
- `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`: check-only test ownership and factual status.

Create `apps/api/test/us-receiving-transaction-seams.e2e.test.ts`. Reuse `createUsDatasetJournalFixture` for full persisted-row digests and disposal; no fixture-policy or migration edit. Document service already exports native create/get methods; do not change it. Do not modify `us-receiving-finalization.ts` (legacy writer), operation/retry policy, schemas, dataset journal/recipe/reference sources or accepted pure tests in this increment.

## Task 1: Native commands and authorized reads

**Files:** Four existing source paths above and the new configured seam test.

**Consumes:** Current `UsMasterDataTransaction`, Receiving parsers/operation helpers, `receivingTransaction`, v3 finalizer, `readReceivingRevisionContext`, live/basis readers and existing lot response builder.

**Produces:** These additional store interfaces using existing platform response types:

```ts
// UsReceivingStore; all methods start no transaction/retry of their own:
createDraftCommandInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, input: unknown, requestId: string): Promise<ReceivingCreateResult>;
finalizeCommandInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown, input: unknown, requestId: string): Promise<ReceivingFinalizeResult>;
checkRevisionReadinessInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown, query: unknown): Promise<ReceivingRevisionReadiness>;
getLiveRecordInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown): Promise<ReceivingLiveRecord>;
getLotReceivingBasisInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, lotId: unknown, query: unknown): Promise<ReceivingBasis>;
// UsLotStore:
getLotInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown): Promise<TraceabilityLot>;
```

Native creation uses exported `createReceivingDraftCommandInTransaction(tx, tenantId, actorUserId, input, requestId, format)` overloads: `legacy` returns `ReceivingDraftRecord`; `versioned` returns `ReceivingDraftRecord | ReceivingOperationReceiptV2`, preserving old stored acknowledgements. Public creation retains its current format-based transaction selection and store output parser.

Export compatible `finalizeReceivingCommandInTransaction(tx, tenantId, actorUserId, id, input, requestId): Promise<ReceivingFinalizeResult>`. Refactor the private execution body into `executeFinalizationInTransaction(tx, tenantId, actorUserId, id, input, requestId, mode)` with `mode: "revision" | "compatible"`. Current public revision and compatible functions retain their outer parsers and `receivingTransaction`; both call the same SQL body. Extract one private lot-conflict error mapper if necessary so neither helper nor public commit error handling duplicates the list of uniqueness constraints. Translate only the three existing lot uniqueness constraints to `receiving_lot_conflict`; all other failures propagate. A supplied transaction must throw, not catch an aborted SQL transaction and continue or open a nested pool transaction.

Public readiness/live/basis wrappers keep repeatable read and call native methods. Public exact lot getter keeps its existing default transaction isolation. Authorization precedes identifier/body parsing exactly as now. Native readers use the supplied transaction and existing helpers; they do not choose isolation or acquire a novel generic global lock. Document that a caller needs repeatable read or a sufficient explicit lock protocol for multi-statement current-state verification. Newly created/finalized records can be read within their creating transaction; this is not a public read-committed snapshot guarantee.

- [ ] **Step 1 — configure real prerequisites and write failing tests.** Create owned dataset fixture, provision actual owner/profile, initialize `UsDatasetReferenceSeedStore`, then use `makeUsSixMonthRegularChain(259)` as the unchanged Scenario A descriptor. Resolve bindings by catalogue keys. Within one outer transaction create only the descriptor's two Receiving documents through `UsReferenceDocumentStore.createDocumentInTransaction`, using their real party binding. Build `ReceivingDraft` from descriptor Receiving fields, receipt-bound product/location IDs and returned document IDs; no caller recipe change or direct final-state SQL. Literal acceptance expectations remain `2026-09-14`, TLCs `OSS-260914-A1/A2`, two `500.000 lb` lines.

```ts
const bound = (entries: readonly { key: string; id: string }[], key: string) => {
  const entry = entries.find((item) => item.key === key);
  if (!entry) throw new Error("Expected fixture reference binding");
  return entry.id;
};
const documentIds: string[] = [];
for (const key of chain.receiving.references) {
  const definition = chain.documents.find((item) => item.key === key);
  if (!definition) throw new Error("Expected Receiving document descriptor");
  const document = await documents.createDocumentInTransaction(
    tx,
    context.tenantId,
    context.actorUserId,
    { ...definition.input, partyId: bound(references.bindings.parties, definition.partyKey) },
    operationKey,
  );
  documentIds.push(document.id);
}
const sourceId = bound(references.bindings.locations, chain.receiving.previousSourceLocationKey);
const draft: ReceivingDraft = {
  dateReceived: chain.receiving.eventDate,
  locationId: bound(references.bindings.locations, chain.receiving.receivingLocationKey),
  previousSourceLocationId: sourceId,
  receivedAtNote: null,
  notes: null,
  documentIds,
  items: chain.receiving.lines.map((line) => ({
    productId: bound(references.bindings.products, line.productKey),
    lotLinkMode: "create_on_finalize",
    lotId: null,
    tlc: line.tlc,
    source: { kind: "location", locationId: sourceId },
    quantity: line.quantity,
    unitOfMeasure: line.unitOfMeasure,
    exemptSupplier: false,
    exemptReason: null,
    exemptReceipt: null,
    supplierLotReference: null,
    notes: null,
  })),
};
```

- [ ] **Step 2 — assert composition and complete rollback.** Use the following command sequence as a configured test helper local to the test file; `draft` and `operationKey` are produced in Step 1. Capture both operation responses, live record, lots and basis inside the same outer transaction.

```ts
const created = await receiving.createDraftCommandInTransaction(
  tx,
  context.tenantId,
  context.actorUserId,
  { operationKey, draft },
  operationKey,
);
if (!("receiptVersion" in created)) throw new Error("Expected new versioned creation");
const ready = await receiving.checkRevisionReadinessInTransaction(
  tx,
  context.tenantId,
  context.actorUserId,
  created.eventId,
  { expectedDraftVersion: 1 },
);
expect(ready.ruleVersion).toBe("receiving-readiness-v4");
expect(ready.state).toBe("complete");
const finalized = await receiving.finalizeCommandInTransaction(
  tx,
  context.tenantId,
  context.actorUserId,
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
if (!("receiptVersion" in finalized)) throw new Error("Expected new versioned finalization");
const live = await receiving.getLiveRecordInTransaction(
  tx,
  context.tenantId,
  context.actorUserId,
  created.eventId,
);
expect(live.status).toBe("finalized");
expect(live.lifecycle.currentEventId).toBe(created.eventId);
```

For each actual snapshot line, call native lot getter and native basis getter with `{ limit: 10, offset: 0 }`. Assert two distinct real imported/source-locked lots, literal identity/quantity/UOM/date/parents/documents, revision1, draftVersion1, lifecycleVersion2 and snapshotVersion3. Basis must have state present, supportCount1, hasMorefalse and exactly the created root/event/line. Root ID equals original event ID. Assert exact document creation, draft creation, two lot creates and finalization audits: tenant/actor/action/target/outcome/requestId/before/after, not counts alone. Two operation rows are command-scoped; using the same UUID for create and finalize is already supported, not a new identity rule.

Repeat with `throw new Error("receiving_outer_abort")` after all work; wrap outer transaction in rejection assertion and compare `fixture.snapshot()` before/after, including documents, counters, roots, children, lots, basis epochs, audits, operations and dataset tables. No dataset Receiving receipt is created by these tests.

- [ ] **Step 3 — observe RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=1` with documented owned-loopback fixture URL and `DATABASE_URL` unset. Missing new methods is feature RED; EPERM/setup failure or skipped tests are not. Record actual output before implementation.
- [ ] **Step 4 — extract minimal shared command/read bodies.** Move existing callback bodies, retaining authorization, operation advisory lock, replay, root-before-event-before-sorted-lot/reference lock order, snapshot builder, finalization audits/operation receipts and errors. No duplicate finalization writer or copied create implementation.

```ts
// Existing public readiness wrapper keeps its declared isolation:
return this.db.transaction(
  (tx) => this.checkRevisionReadinessInTransaction(tx, tenantId, actorUserId, id, query),
  { isolationLevel: "repeatable read" },
);
// The extracted native readiness method begins with the same authorization:
const profileCode = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
const eventId = parseMasterDataInput(platformUuidSchema, id);
const value = parseMasterDataInput(receivingReadinessQuerySchema, query);
return (
  await readReceivingRevisionContext(tx, tenantId, eventId, value.expectedDraftVersion, profileCode)
).readiness;
```

- [ ] **Step 5 — pin all Review Focus risks.** Test outer abort plus real test-only triggers failing second document insertion, first/second lot audit, finalization audit and Receiving operation receipt insertion; compare complete snapshots and remove only the fixture-owned trigger before retry. Retry the full fresh unit externally, never inside a failed supplied transaction. Assert commit once and exact same-key command replay adds no audits/operations; changed command input gets conflict. Add tenant/QA/Auditor denial, malformed-input precedence, foreign document/lot/event references, stale readiness after a real reference/profile edit, and actual duplicate TLC/source conflict. Preserve errors and no-write snapshots. Use fresh fixtures or provision resets confined to the owned child.
- [ ] **Step 6 — test historical/current distinction and public compatibility.** Finalize through native compatible mode, then use existing public void and amendment commands in separate transactions. Repeating the historical command must retain existing acknowledgement bytes without pretending to change current state; native live/basis reads expose actual void/amendment/pending/current revision state. Verify public legacy create and old finalization acknowledgements still replay unchanged, revision-only finalization stays strict and public APIs still reauthorize on replay. Exercise the existing public concurrency and readiness suites below to retain retry/isolation evidence; do not replace failures with a larger timeout. Native fresh-record composition runs both in repeatable read and read committed, without asserting general read-committed reader consistency.
- [ ] **Step 7 — run GREEN and independent review.** New suite plus `us-receiving-draft-command-bridge.e2e.test.ts`, `us-receiving-finalization-command-bridge.e2e.test.ts`, `us-receiving-original-command.e2e.test.ts`, `us-receiving-revision-finalization.e2e.test.ts`, `us-receiving-revision-finalization-concurrency.e2e.test.ts`, `us-receiving-revision-readiness.e2e.test.ts`, `us-receiving-revision-readiness-concurrency.e2e.test.ts`, `us-receiving-shared-event-compatibility.e2e.test.ts`, `us-receiving-date-compatibility.e2e.test.ts`, `us-lot.e2e.test.ts`, `us-dataset-reference-seed.e2e.test.ts`, `us-reference-transaction-seams.e2e.test.ts` using `--maxWorkers=1`. Require zero configured skips, exact audits/rollback evidence and verified fixture disposal. Capture byte checkpoint; independent review must accept public wrapper parity and lock/error behavior before Task 2. No commit.

## Task 2: Check-only execution ownership and factual handoff

**Files:** Existing workflow, isolation test and two docs listed above. No Task1 source/test modifications unless a reviewed defect requires an explicit ruling.

**Consumes:** Accepted Task1 seam suite and existing workflow ownership; **produces:** one unconditional serial configured owner after dependency/API builds, with fixture-only US database environment. No operational entrypoint.

- [ ] **Step 1 — write failing parsed workflow tests.** Require the new configured seam file exactly once among existing Receiving regression owners and after the current shared/API build. Mutation table covers omission, duplication, conditional owner/build, continue-on-error, shell failure suppression, DATABASE_URL fallback, wrong/missing fixture URL, execution before builds and nonserial workers. Preserve all existing reference/dataset owners and inherited release locks. Check executable parsed commands, not source-text grep.

```js
assert.equal(
  executions.filter((token) => token === "test/us-receiving-transaction-seams.e2e.test.ts").length,
  1,
);
assert.equal(owner.if, undefined);
assert.equal(owner["continue-on-error"], undefined);
assert.equal(owner.env.DATABASE_URL, undefined);
assert.ok(owner.run.trim().split(/\s+/).includes("--maxWorkers=1"));
```

Define `executions`, `owner` and build-index assertions from fresh parsed workflow using the established helper style; exact existing suite order and all pre-existing guards remain pinned. Run `node --test tools/us-development/test/isolation.test.mjs` before workflow edit and retain the expected absent-suite RED.

- [ ] **Step 2 — extend the existing Receiving check owner once.** Keep current suite paths/order, direct command, owned fixture URL and serial flags. Run Node ownership tests and `node tools/us-development/check-isolation.mjs` GREEN. No new release job, initialization script or credentials.
- [ ] **Step 3 — append factual docs.** State native transaction composition and tests, preserving public API semantics. Shared catalogue remains accepted; per-chain dataset intent/receipt orchestration, canonical current-origin verification, special correction/void seed stages and full generation are still separate work. Do not describe native acknowledgement replay alone as canonical origin or actual demo initialization.
- [ ] **Step 4 — final automated gates.** Run API build/typecheck/lint before final configured fixtures, then the Task1 configured suite group and existing dataset/reference/recipe regressions; build no dependencies concurrently with fixtures. Run `corepack pnpm --filter @markiro/api test` with both DB variables unset and retain failed suite names/skips. Previous full API exit1 had failed billing-accounts, exchange-credentials/import/orders/protocol, integrations-delete/integrations and subscription-route-inventory files; six missing auth/origin variables were established only for billing. Matching paths do not establish other causes. Report this gate honestly rather than broadening fixes or weakening assertions/timeouts.
- [ ] **Step 5 — whole-increment review and handoff.** Run all `tools/us-development/test/*.test.mjs`, local isolation checker, scoped Prettier and `git diff --check`. Use original byte baseline to prove only scoped files changed. Independent Task2 and final whole-increment reviewers check actual transaction/audit/receipt boundaries and public compatibility. Full-volume/browser/artifact/remote CI/cloud/physical gates remain unrun. No staging/commit/push/cleanup or merge-readiness claim while full API is nongreen.

## Self-review and next boundary

This is the Receiving transaction-seam portion explicitly allowed by spec section 6. It enables atomic per-chain documents plus Receiving, but does not implement that dataset orchestrator or claim persisted business-stage progress. All five Review Focus conditions map to Task1 configured tests; Task2 pins their check-only execution. Native command/read signatures use existing response schemas and provided transaction types. Public isolation/retry/parser order remains authoritative. No recipe, journal, migration or public route change is needed.

After acceptance, the next plan will bind thin shared-reference dependency identity and each unchanged chain descriptor to a dataset intent, verify prerequisites/current origin inside the stage transaction, and persist the bounded Receiving receipt. It must address cross-unit reference reading and owned-root/lot lock ordering; this plan does not guess or silently implement those interfaces.
