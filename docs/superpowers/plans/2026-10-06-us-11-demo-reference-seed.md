# US-11 Atomic Demo Reference Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and canonically verify Scenario A's actual reference records through existing US services, with retry-safe journal ownership and no independent partial business commit.

**Architecture:** Add internal transaction-scoped entry points to existing reference services without changing their HTTP contracts, validation, authorization or audits. Extend the guarded journal with one atomic database-stage operation: business records, normal audits and the stage receipt commit together. A fixed reference seed composes these boundaries; an existing receipt requires canonical verification and never invokes creation again.

**Tech Stack:** Existing Node 24+, Corepack pnpm 11.22.0, TypeScript, Drizzle/PostgreSQL, Zod, Vitest and `@markiro/domain` canonical hashing. No new dependency or migration.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-single-tenant-demo-seed-design.md` (owner approved). Accepted prerequisite: `docs/superpowers/plans/2026-10-06-us-11-demo-seed-foundation.md`, all three tasks complete with independent and whole-foundation review.

## Global Constraints

- Work remains in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve unrelated and accepted uncommitted work.
- No staging, commit, push, PR, merge, release, primary-database mutation, old fixture cleanup, dependency installation, personal environment-file write or local archive/design file change is included.
- Tests use owned disposable U.S. databases; they never populate the shared base database implicitly.
- Existing organization name, slug, metadata and owner audit are not repurposed as the dataset journal.
- Runtime code must not import from `apps/api/test` or mutable fixture transports.
- No deletion, reset, password reset, MFA reset or role restoration command is included.
- No machine/authentication/audit clock override or silent deadline extension is allowed.
- No passwords, MFA keys, tokens, cookies, signed URLs, requester payloads or storage credentials in output/logs.
- Do not loosen either runtime edition/loopback enforcement or worker build checks to make this increment appear deployed or publish the current dirty checkout.
- Preserve exact decimal quantities: two inputs `500 lb` each, output/shipment `100 case`, 100 synthetic SSCC links; no implicit packaging conversion. This reference increment creates none of those events, lots or boxes.
- Preserve existing EN/ES cabinet, shared UI tokens and Auditor policy. No UI/auth-policy change or viewer identity is included.
- Use per-task byte baselines and explicit path manifests instead of commit ranges. Every task has RED→GREEN and independent review; broad source review follows acceptance of all tasks.
- Keep `US_DEMO_VERSION`, the accepted descriptor/digest, existing journal methods, migration0141 and compact input/result limits unchanged. Reference recipe content is additionally pinned by its exact immutable stage input digest.

## Review Focus

1. A lost reply after an atomic commit must reuse exact IDs, profiles and audit facts, not create a second reference set: Task 2/3 real committed-return-discard tests.
2. A matching name/number without this journal's receipt is not ownership: Task 3 unknown-reference/collision tests must fail without adoption, update or cleanup.
3. An edited, archived, missing or cross-tenant journaled reference must block verification before any subsequent mutation: Task 3 canonical mismatch tests.
4. Extracting transaction entry points must not change ordinary service validation/error ordering, role reload, conflict mapping or audit actors/targets: Task 1 public-path and transaction-path regressions.
5. A failure after some creates, during audit insertion, receipt parsing or canonical verification must roll back all new reference/audit/receipt writes, while retaining a separately committed intent: Task 2/3 real PostgreSQL rollback tests.

## Scope and inspected sources

This is the first service-backed dataset stage, independently usable by a future internal orchestrator. Its output is three parties, three locations, two catalog products, two reviewed product profiles and six metadata-only documents. It is not the complete chain, an initialization CLI or an Export-ready demo. Receiving/Transformation/Shipping, cases, trace/readiness, Plan/package, viewer, browser and hosting require subsequent plans. No dummy orchestration adapter or success-returning substitute is introduced here.

Current `UsMasterDataStore`, `UsCatalogStore`, `UsProductProfileStore` and `UsReferenceDocumentStore` own real creation rules/audits but start independent transactions. Current journal methods start independent transactions too. Calling them in a loop does not create an atomic unit. Do not cast a transaction to `Db`, replace `db.transaction` with a fake transport, or open an independent pool from inside the new stage. The pinned Drizzle nested-transaction implementation uses savepoints and does not establish a new isolation configuration; this plan instead uses explicit existing transaction objects.

Reference source facts: `docs/us/demo-scenario.md`; FDA-02 URL already recorded in `docs/us/regulatory-basis.md`; current platform-contracts master-data/catalog/products/documents schemas; current `US-REG-2026-09-03` authorization baseline. The source URL below is metadata, not a network fetch or a statement of a new legal assessment.

## File map

| File                                                                         | Responsibility                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/api/src/modules/traceability/master-data/us-master-data-store.ts`      | Shared party/location create/read implementations with transaction entry points |
| `apps/api/src/modules/traceability/catalog/us-catalog-store.ts`              | Shared catalog product create/read implementations                              |
| `apps/api/src/modules/traceability/products/us-product-profile-store.ts`     | Shared profile read/write implementations, current review/audit rules           |
| `apps/api/src/modules/traceability/documents/us-reference-document-store.ts` | Shared document create/read implementations                                     |
| `apps/api/src/modules/traceability/demo/us-demo-journal.ts`                  | Guarded atomic stage, using the same header/intent/receipt validation           |
| `apps/api/src/modules/traceability/demo/us-demo-atomic-stage-contract.ts`    | Internal transaction/work types, no HTTP contract                               |
| `apps/api/src/modules/traceability/demo/us-demo-reference-recipe.ts`         | Deterministic complete reference input recipe and receipt/binding schemas       |
| `apps/api/src/modules/traceability/demo/us-demo-reference-verify.ts`         | Read and compare exact owned records within a guarded transaction               |
| `apps/api/src/modules/traceability/demo/us-demo-reference-seed.ts`           | Explicit internal initialize/verify composition for references only             |
| Three new focused e2e files                                                  | Transaction seam, atomic journal and actual reference dataset acceptance        |
| Existing US workflow and docs                                                | Check-only ownership and factual partial-dataset evidence                       |

## Task 1: Transaction-scoped reference service entry points

**Files:** Modify the four existing reference stores in the file map. Create `apps/api/test/us-reference-transaction-seams.e2e.test.ts`. Reuse `apps/api/test/support/us-demo-journal-fixture.ts`; do not change its trusted-owner policy or create global database roles.

**Consumes:** Existing `UsMasterDataTransaction` from `us-master-data-support.ts`, platform-contracts return types and the current public method implementations.

**Produces:** The following additional internal methods, with existing public methods preserved:

```ts
// UsMasterDataStore:
createPartyInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, input: unknown, requestId: string): Promise<UsParty>;
getPartyInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown): Promise<UsParty>;
createLocationInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, input: unknown, requestId: string): Promise<UsLocation>;
getLocationInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown): Promise<UsLocation>;
// UsCatalogStore:
createProductInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, input: unknown, requestId: string): Promise<UsProduct>;
getProductInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown): Promise<UsProduct>;
// UsProductProfileStore:
putProfileInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown, input: unknown, requestId: string): Promise<ProductTraceabilityProfile>;
getProfileInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown): Promise<ProductTraceabilityProfile>;
// UsReferenceDocumentStore:
createDocumentInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, input: unknown, requestId: string): Promise<ReferenceDocument>;
getDocumentInTransaction(tx: UsMasterDataTransaction, tenantId: string, actorUserId: string, id: unknown): Promise<ReferenceDocument>;
```

Use the existing transaction type directly, not a new runtime constructor or a transaction-to-Db cast.

- [ ] **Step 1 — write failing real-DB seam tests.** Use genuine owner/profile in an owned DB. A single outer transaction creates a party/location/product/profile/document through these methods and reads the exact generated IDs on its transaction. Force a deliberate exception after creation and assert all created rows and normal audit rows disappeared. Also cause a real audit-write failure with a test-only trigger in the owned DB; it must propagate and leave no independent commit. Preserve ordinary QA write access and prove Auditor write denial; these service methods must not introduce the seed's original-owner-only restriction. Check cross-tenant parents, archived parents, duplicate active party name/document and malformed profile input. Assert exact ordinary audit actor/tenant/action/target/result/requestId for successful writes.

```ts
await expect(
  f.db.transaction(async (tx) => {
    await master.createPartyInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      { name: "Synthetic atomic seam" },
      "atomic-seam-test",
    );
    throw new Error("synthetic_abort");
  }),
).rejects.toThrow("synthetic_abort");
expect(await f.snapshot(false)).toEqual(before);
```

`f` is the existing fixture, `context = await f.provision()`, `master` the existing real store and `before = await f.snapshot(false)`. `snapshot(false)` hashes all non-journal tables without printing credentials. No fake `Db` implementation or mocked database is permitted.

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-reference-transaction-seams.e2e.test.ts --maxWorkers=1`, with explicit isolated US URL, primary URL unset. Record missing-method failures before store edits. Sandbox EPERM is not successful RED; repeat the safe configured command with loopback approval.
- [ ] **Step 3 — extract one implementation per service operation.** Preserve the exact current schema parsing, authorizer, parent locks, normalization, conflict translation and audit writes. Public methods remain pool-owning wrappers; transaction methods neither start/commit transactions nor call pool-backed getters. Example party wrapper:

```ts
return this.db.transaction((tx) =>
  this.createPartyInTransaction(tx, tenantId, actorUserId, input, requestId),
);
```

Move the current creation callback into the transaction method, with the current party-name conflict mapper rethrowing the same public exception. Do not swallow a constraint error and continue an aborted transaction. Preserve profile pre-transaction input-validation ordering: factor its existing pure parsing/normalization into a private command parser and persistence into one private transaction implementation; the public method parses before acquiring its transaction, and the internal method parses then delegates to that same persistence implementation. Retain zero-revision defaults, immediate exact retry and the two coverage-change audits. Do not duplicate SQL/audit branches between public and transaction methods.

- [ ] **Step 4 — run GREEN and service compatibility.** New seam suite plus `test/us-master-data.e2e.test.ts`, `test/us-catalog.e2e.test.ts`, `test/us-catalog-operational-boundaries.e2e.test.ts`, `test/us-product-profile.e2e.test.ts`, `test/us-reference-document.e2e.test.ts`; configured US tests must execute without skips. Run API typecheck/lint and affected formatting. Add a focused regression if a public method's error precedence changes.
- [ ] **Step 5 — checkpoint and independent review.** Record exact source hashes, RED/GREEN, owned targets/disposal and public-path parity. No commit. Review must approve service behavior before the journal composes these methods.

## Task 2: Atomic journal stage execution

**Files:** Create `apps/api/src/modules/traceability/demo/us-demo-atomic-stage-contract.ts` and `apps/api/test/us-demo-atomic-stage.e2e.test.ts`; modify `apps/api/src/modules/traceability/demo/us-demo-journal.ts` only to share existing guarded internals and add the new method.

**Consumes:** Accepted journal codecs/types, stored header/intent/receipt rules and Task 1 transaction methods.

**Produces:** The contract and method below. Callbacks are trusted internal code, not deserialized handlers, HTTP input or a public authorization mechanism.

```ts
export type UsDemoTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type UsDemoAtomicStageWork = Readonly<{
  apply(tx: UsDemoTransaction, context: UsDemoJournalContext,
    intent: UsDemoIntent): Promise<UsDemoReceipt>;
  verify(tx: UsDemoTransaction, context: UsDemoJournalContext,
    intent: UsDemoIntent, receipt: UsDemoReceipt): Promise<void>;
}>;
// UsDemoJournalStore:
runAtomicStage(context: UsDemoJournalContext, seedId: string,
  expectedRevision: number, intent: UsDemoIntent,
  work: UsDemoAtomicStageWork): Promise<UsDemoJournal>;
```

- [ ] **Step 1 — write real-DB failing tests.** Initialize/capture an intent using the existing methods first. The new method must refuse missing or different intent, invalid revisions/seed/target/current owner and corrupt stored evidence before any callback. A valid pending stage applies actual party creation through Task 1, verifies the real row, persists a codec-validated receipt and advances the header exactly once. A second exact call with a valid stale revision invokes canonical verification but no apply/create/audit. An existing receipt with missing/edited party fails without repair. Discard a real committed first return and repeat; compare exact full-row business/journal/audit digests. Two concurrent identical calls create one row/receipt/audit. Rollback tests cover apply exception, real audit failure, invalid receipt, verifier exception and receipt-write trigger failure.

```ts
const recorded = await store.runAtomicStage(context, captured.id, captured.revision, intent, work);
expect(recorded.revision).toBe(captured.revision + 1);
expect(await store.runAtomicStage(context, captured.id, captured.revision, intent, work)).toEqual(
  recorded,
);
expect(await snapshot()).toEqual(afterFirstCommit);
```

`work` uses real transaction service methods and real row comparisons; any test-local invocation counter supplements, never replaces, persisted-state assertions.

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-demo-atomic-stage.e2e.test.ts --maxWorkers=1`; record genuine configured failures before implementation.
- [ ] **Step 3 — implement through the existing journal transaction.** Keep actual identity check, tenant/version advisory lock, owner/provenance/profile row locks and strict stored parsing in one transaction. Validate numeric revision even on replay. Require an already persisted exact matching intent; this method never captures a replacement or initializes a missing header. If a receipt exists, run `verify` on that receipt and return current journal before valid stale CAS comparison. If pending, require current revision, invoke `apply`, parse/hash the receipt using the accepted codec, invoke `verify`, then persist receipt/header advancement in the same transaction. Factor the current receipt persistence into one private implementation reused by `recordReceipt`; retain all old method signatures/semantics. No callback runs outside the guard, no independent service transaction, no post-commit callback and no generic catch around driver operations.

```ts
if (existing.receipt !== null) {
  await work.verify(tx, checkedContext, existing.intent, existing.receipt);
  return current;
}
const receipt = parseUsDemoReceipt(await work.apply(tx, checkedContext, existing.intent));
await work.verify(tx, checkedContext, existing.intent, receipt);
```

`existing`, `current`, `tx` and `checkedContext` are the existing guarded/stored values. The shared private receipt writer retains the current row predicates and revision arithmetic. If commit outcome is ambiguous, propagate; a subsequent call reads canonical persisted state and either verifies an existing receipt or executes a still-pending atomic unit. There cannot be independently committed reference records without this transaction's receipt.

- [ ] **Step 4 — run GREEN/regression.** New atomic suite plus `test/us-demo-journal.e2e.test.ts`, `test/us-demo-journal-contract.test.ts`, `test/us-reference-transaction-seams.e2e.test.ts`, `test/us-development-owner.e2e.test.ts` and `test/us-profile-store.e2e.test.ts`; configured real DB, no new skips. Run API typecheck/lint/format. Prove the earlier journal methods still permit bookkeeping-only receipts and preserve their existing corrupt-state and malformed-revision denials.
- [ ] **Step 5 — checkpoint and independent review.** Capture exact diffs and real rollback/lost-reply/concurrency evidence. No commit. Do not infer business completion from a receipt until Task 3's verifier is present.

## Task 3: Exact Scenario A references and canonical no-op verification

**Files:** Create `us-demo-reference-recipe.ts`, `us-demo-reference-verify.ts`, `us-demo-reference-seed.ts` in `apps/api/src/modules/traceability/demo/`; create `apps/api/test/us-demo-reference-seed.e2e.test.ts`; modify `.github/workflows/us-development.yml`, `docs/us/implementation-plan.md`, `docs/us/development-isolation.md` only for this check-only partial-dataset evidence.

**Consumes:** Accepted descriptor, Task 1 service methods, Task 2 atomic work and existing genuine-owner fixture.

**Produces:** `makeUsDemoReferenceRecipe`, `parseUsDemoReferenceResult`, `verifyUsDemoReferences`, and `UsDemoReferenceSeedStore` with the following interface:

```ts
type UsDemoPartyKey = "previous_source" | "processor" | "recipient";
type UsDemoProductKey = "inbound" | "output";
type UsDemoDocumentKey = "receiving_asn" | "receiving_bol" |
  "transformation_work_order" | "transformation_batch" |
  "shipping_bol" | "shipping_invoice";
type UsDemoReferenceBindings = Readonly<{
  parties: Readonly<Record<UsDemoPartyKey, string>>;
  locations: Readonly<Record<UsDemoPartyKey, string>>;
  products: Readonly<Record<UsDemoProductKey, string>>;
  documents: Readonly<Record<UsDemoDocumentKey, string>>;
}>;
type UsDemoReferenceResult = Readonly<{
  recipeVersion: 1;
  bindings: UsDemoReferenceBindings;
  evidence: Readonly<{
    parties: readonly UsParty[]; locations: readonly UsLocation[];
    products: readonly UsProduct[]; profiles: readonly ProductTraceabilityProfile[];
    documents: readonly ReferenceDocument[];
  }>;
}>;
type UsDemoReferenceRecipe = Readonly<{
  recipeVersion: 1; definitionDigest: string;
  parties: readonly Readonly<{ key: UsDemoPartyKey; input: CreateUsParty }>[];
  locations: readonly Readonly<{ key: UsDemoPartyKey; partyKey: UsDemoPartyKey;
    input: Omit<CreateUsLocation, "partyId"> }>[];
  products: readonly Readonly<{ key: UsDemoProductKey; input: CreateUsProductInput;
    profile: PutProductTraceabilityProfile }>[];
  documents: readonly Readonly<{ key: UsDemoDocumentKey; partyKey: UsDemoPartyKey;
    input: Omit<ReferenceDocumentInput, "partyId"> }>[];
}>;
makeUsDemoReferenceRecipe(): UsDemoReferenceRecipe;
parseUsDemoReferenceResult(raw: unknown): UsDemoReferenceResult;
verifyUsDemoReferences(tx: UsDemoTransaction, context: UsDemoJournalContext,
  intent: UsDemoIntent, receipt: UsDemoReceipt): Promise<void>;
// Constructor: new UsDemoReferenceSeedStore(db: Db).
initialize(context: UsDemoJournalContext): Promise<UsDemoReferenceResult>;
verify(context: UsDemoJournalContext): Promise<UsDemoReferenceResult>;
```

Export these types from the recipe module. Strict result/binding schemas reuse existing response schemas; reject extra keys, duplicate IDs or evidence/key-count drift. Profiles use the same two product IDs and are not additional `recordIds`. Receipt `recordIds` contains exactly the 14 distinct party/location/product/document IDs in deterministic recipe order.

### Fixed recipe content

Use accepted descriptor names/phones/products/references/dates, without changing its digest. Resolve symbolic parent/product keys only from records created in this atomic unit or the exact verified receipt. Parties have full fictional `legalName`, descriptor phone, null contactName/contactEmail/notes. Locations have matching `name`/`businessName`, descriptor phone, street address components below, null coordinates and fixed roles:

| Key             | Street/city/state/postal/country                    | Roles                                        |
| --------------- | --------------------------------------------------- | -------------------------------------------- |
| previous_source | 100 Example Orchard Rd / Yakima / WA / 98901 / US   | supplier, tlc_source                         |
| processor       | 500 Example River Pkwy / Portland / OR / 97203 / US | processor, receive_at, ship_from, tlc_source |
| recipient       | 200 Example Harbor Ave / Seattle / WA / 98134 / US  | recipient                                    |

Both catalog products use descriptor description and `gtin: null`; no invented real GTIN. Profile productName/brandName use descriptor values, commodity `Apples`, inbound variety `Red Delicious`, output variety null. Inbound packaging is value `10`, UOM `lb`, style `bag`, default UOM `lb`; output packaging is value `6`, UOM `oz`, style `cup, 24 cups/case`, default UOM `case`. This describes packaging, not conversion. Both profile commands use expectedRevision0 and:

```ts
coverageStatus: "covered",
coverageRationale: "Synthetic demo manual review of a fresh-cut fruit fixture; not an operational assessment.",
ftlCategory: "Fruits (fresh-cut)",
ftlSourceUrl: "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
ftlSourceVersion: "markiro-us-synthetic-ftl-review-v1",
```

These are explicitly synthetic review inputs; existing profile service stamps the real actor/time. No network lookup, copied review stamps or claim of official approval. Six document types are respectively `asn`, `bol`, `work_order`, `batch_log`, `bol`, `invoice`; exact descriptor reference numbers and corresponding civil event dates. Receiving documents bind previous_source, transformation documents processor, shipping documents recipient. All have typeOtherLabel null and notes `Synthetic demo metadata only; no source attachment.` No attachments or request record is created.

- [ ] **Step 1 — write failing real-data tests.** Initialize and assert exact 3/3/2/2/6 rows, all complete location descriptions, covered synthetic profiles with service-owned review stamps, six exact metadata references and 14 receipt IDs. Expected reference audit facts: 3 party creates, 3 location creates, 2 product creates, 2 profile-update plus 2 coverage-change facts, 6 document creates = 18; assert exact actor/tenant/action/target/requestId/before/after semantics. No CTE, lot, genealogy, case, Plan/request/run is created. Verify then initialize again and compare all IDs, rows, timestamps, journal revisions and audit digests unchanged. Test concurrent initializers and discarded committed return. Test every reference-kind missing/archive/edit/cross-tenant binding and changed recipe under an existing stage: fail without repair. Preexisting unowned reference data, including names/numbers identical to the recipe, must not be adopted. Inject failure after several creates and at receipt write: intent remains, business/audits/receipt roll back, subsequent initialization succeeds once.

```ts
const first = await seed.initialize(context);
expect(Object.keys(first.bindings.parties)).toEqual(["previous_source", "processor", "recipient"]);
expect(first.evidence.profiles.map((p) => p.defaultQuantityUom)).toEqual(["lb", "case"]);
const after = await f.snapshot();
expect(await seed.verify(context)).toEqual(first);
expect(await seed.initialize(context)).toEqual(first);
expect(await f.snapshot()).toEqual(after);
```

`f.snapshot()` is the existing fixture's full-row digest helper; `seed` is the new real store. Add pure assertions in this same test file outside DB-skipped suites for complete recipe-schema validity, fresh returned objects/no aliasing and deterministic recipe digest. All created IDs/evidence must be generated by services, not test final-state dumps.

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-demo-reference-seed.e2e.test.ts --maxWorkers=1` with the configured owned US DB; record absent module/behavior failures before runtime edits.
- [ ] **Step 3 — implement the recipe and canonical verifier.** Build complete schema-validated inputs as fresh ordinary JSON values, including all fields above. Capture their exact recipe digest in the references intent; new seed facts are not hidden behind the descriptor digest. Changing a captured recipe under this version conflicts, never updates/reclassifies existing records. Parse result/evidence with existing response schemas. In the current guarded transaction, read each exact bound ID through Task 1 getters, require live/unarchived same-tenant records and compare complete normalized response evidence to the frozen receipt. Validate all counts, parent bindings, profile product IDs/revision/reviewer, document bindings and canonical `recordIds`; no name lookup can establish ownership. Any mismatch throws `us_demo_reference_mismatch`; missing receipt throws `us_demo_references_incomplete`. Driver exceptions propagate; do not sanitize SQL failures into a successful no-op.
- [ ] **Step 4 — implement internal initialization/verification.** Initialization uses the existing guard to initialize/read the header. If no references intent exists, persist `{ stage: "references", operationKey: randomUUID(), input: recipe, inputDigest: canonicalExportDigest(recipe) }` before invoking the atomic unit. If concurrent capture loses with the specific revision/intent conflict, reread and adopt only the canonical winner with the exact same recipe digest and intact original-owner header; propagate driver errors and reject any different recipe. Do not generate a replacement key for an already captured intent.

Fresh apply refuses nonempty tenant reference tables (parties, locations, catalog products, product profiles, reference documents) with `us_demo_reference_collision`; it never adopts or clears unowned data. Create in party → location → catalog/profile → document order using transaction entry points, one stable requestId derived from the persisted operationKey, and build the actual result/receipt. Run canonical verifier and save the receipt atomically. On repetition, verifier runs but apply does not. `verify` never initializes a header/captures intent: require an existing exact intent/receipt, then use the guarded atomic entry with an apply callback that throws `us_demo_references_incomplete`; its successful existing-receipt branch writes nothing. This reloads authorization inside verification without a new public read callback or independent unguarded transaction. No CLI/HTTP/module registration or shared-base invocation.

- [ ] **Step 5 — run covering gates and update check-only ownership.** Configured command:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-reference-transaction-seams.e2e.test.ts test/us-demo-atomic-stage.e2e.test.ts test/us-demo-reference-seed.e2e.test.ts test/us-demo-journal.e2e.test.ts test/us-master-data.e2e.test.ts test/us-catalog.e2e.test.ts test/us-catalog-operational-boundaries.e2e.test.ts test/us-product-profile.e2e.test.ts test/us-reference-document.e2e.test.ts --maxWorkers=1
```

Add this exact selection as an unconditional serial check-only step to existing US workflow after shared builds, with explicit isolated US URL. Preserve foundation/Requests/browser gates, budget, read-only permissions and release locks. Run affected HTTP regressions `test/us-master-data-http.e2e.test.ts`, `test/us-catalog-http.e2e.test.ts`, API typecheck/lint/build after fixtures close, root format/isolation/whitespace and one full API package gate with appropriate safe environment; report primary setup failures/skips and do not supply primary secrets. Document references-only scope and unchanged dates/descriptor, no whole-demo completion claim. Remote CI/browser/provider/storage/release are not run.

- [ ] **Step 6 — checkpoint, independent and whole-increment reviews.** Record exact byte hashes, RED/GREEN and real persistence/rollback/concurrency/verification evidence. No commit/push or actual shared-base seed. Retain reviewed artifacts while uncommitted.

## Self-review and approval handoff

Spec sections1/2 isolation and existing service boundaries bind all tasks; section3 party/product/document inputs are Task3; section4 journal-owned transactional setup and safe repetition are Tasks1–3; section6 wrong-target/collision/replay/concurrency/partial-failure/privacy checks have named tests above. The remaining section3 CTE/case/Plan/request data, section4 CLI/storage/build/worker orchestration, section5 viewer and section6 whole-chain/browser/hosting acceptance are explicit subsequent independent subprojects, not missing implementations hidden in this reference stage. All five Review Focus items have concrete Task1/2/3 tests.

Type names and transaction method names are consistent across tasks; existing platform-contracts types are imported, not redefined in production. The atomic callback contract is a trusted internal database composition seam, not externally supplied code. Recipe result evidence and bindings are codec-validated; a saved receipt alone is never accepted without current canonical reads. No schema, dependency, runtime publication or descriptor-version change is planned.

Preserved execution method: a separate implementer and independent reviewer per task, then whole-increment review. Owner review of this plan is required before execution; no implementation has started for these tasks.
