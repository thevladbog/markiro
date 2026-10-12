# US-11 native SQL-read optimization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Reduce repeated native reference reads and pass all 260-chain acceptance assertions without weakening them.

**Architecture:** Add bounded native batch getters to existing stores, reuse their projections, and replace only collection reads in the existing reference verifier. No authority/proof cache or change to stage ownership.

**Tech Stack:** Node 24, Corepack pnpm, TypeScript, Drizzle/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-us-11-native-sql-optimization-design.md`

## Global Constraints

- Only US worktree `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve inherited source/doc prefixes, HEAD/index.
- No commit/push/PR/deployment, shared DB mutation, env-file reads, dependencies/recipe/receipt/CI/runtime/UI edits; schema changes only Task10's exact audit indexes.
- No authority/proof cache, removed verifier traversal, changed lock order, parallel chain execution, implicit retry or repair.
- Native batches cap at 256 IDs, validate UUIDs, preserve requested order/duplicates, authorize even empty input, reload on every invocation.
- Full native phase remains 900,000 ms and every existing assertion stays; no global timeout changes.
- Native fixture base only verified `127.0.0.1:55432/markiro_us_dev`, role `markiro_us`; mutate/drop only randomized owned children after work drains.
- Native commands unset DATABASE_URL; pure/static commands unset both DB variables. Fixture URL stays in memory, never printed.
- Only this plan's `.superpowers/sdd` workspace is accessible; no sibling artifact reads/writes.

## Review Focus

- A batch that omits a missing/foreign ID must fail, not return a shortened successful proof.
- Unordered/duplicate IDs must not be paired with another record's evidence by positional SQL order.
- Changed membership/profile or same-transaction business edits must be seen on a later call; no cache may hide them.
- Profile batches must retain sorted product share locks and defaults/invalid-profile behavior without modifying writer locks.
- Query-budget success must reflect actual forwarded SQL calls, not omitted reads, mocks or shifted counter boundaries.

### Task 1: Native collection reads and complete coordinator acceptance

**Files:**

- Modify: `apps/api/src/modules/traceability/master-data/us-master-data-store.ts`.
- Modify: `apps/api/src/modules/traceability/catalog/us-catalog-store.ts`.
- Modify: `apps/api/src/modules/traceability/products/us-product-profile-store.ts`.
- If needed create: `apps/api/src/modules/traceability/master-data/us-master-data-batch.ts` for shared bounded ID parsing/order helpers, not business projections.
- Modify: `apps/api/src/modules/traceability/demo/us-dataset-reference-verify.ts`.
- Create: `apps/api/test/us-dataset-reference-batch.e2e.test.ts`.
- If needed create: `apps/api/test/support/us-dataset-query-counter.ts` for transparent actual-driver counting only.
- Modify: `apps/api/test/us-dataset-reference-seed.e2e.test.ts` only real batch pause-witness adaptation; preserve assertions/deadlines.
- Append: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
- DO NOT MODIFY: `apps/api/test/us-dataset-native-seed.e2e.test.ts`, existing native fixture or other seed/verifier modules in this initial task.

**Interfaces:**

```ts
getPartiesInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, ids: unknown): Promise<UsParty[]>;
getLocationsInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, ids: unknown): Promise<UsLocation[]>;
getProductsInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, ids: unknown): Promise<UsProduct[]>;
getProfilesInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, ids: unknown): Promise<ProductTraceabilityProfile[]>;
```

- [ ] **Step 1: Write actual failing query-budget witness before production edits.**

Reuse `specialFixture` and real reference seed/journal. Initialize references, read
the actual installed stage, then invoke `verifyUsDatasetReferences` through an
owned transaction with existing `specialStores(f.db)`. Counter measures actual
client queries from transaction entry to exit, forwards unchanged results/errors,
and restores wrappers in finally. No SQL text/values printed.

```ts
const before = await f.snapshot();
const receipt = stage.receipt;
if (!receipt) throw new Error("Missing installed reference receipt");
const measured = await countActualQueries(f.pool, () =>
  f.db.transaction((tx) => verifyUsDatasetReferences(tx, context, stage.intent, receipt, stores)),
);
expect(measured.count).toBeLessThanOrEqual(32);
expect(await f.snapshot()).toEqual(before);
```

Run actual assertion RED, not module-import/setup failure. Record exact
count and duration. Add native parity/edge cases from the spec with comments naming
the mutation each catches. Reuse current native fixture guards and 60,000 ms bounds
for new bounded cases; do not change existing deadlines.

- [ ] **Step 2: Implement native bounded batch getters.**

Each getter validates the ID array using existing input-error conventions and
reloads `authorizeUsMasterData(..., US_CAPABILITY.READ)` once per invocation.
Use one tenant-scoped `inArray` selection per collection and existing response
mapper, then map validated requested IDs to corresponding rows, throwing the
existing not-found error if any is absent. Duplicate/empty input semantics remain
explicit. Reuse query/projection helpers with ordinary paths where appropriate;
preserve ordinary response/error and writer lock behavior.

```ts
// Established authorization and native projection precede this ordering step.
const byId = new Map(rows.map((row) => [row.id, row]));
return ids.map((id) => {
  const row = byId.get(id);
  if (!row) throw new NotFoundException({ code: "party_not_found" });
  return partyResponse(row);
});
```

Profile batches select/share-lock sorted product IDs first, prove every requested
product exists, read stored profiles tenant-scoped, and invoke storedProfileResponse
or profileDefaults exactly as the current ordinary getter. Do not copy demo-specific
business projections or expose routes.

- [ ] **Step 3: Replace only reference verifier collection reads.**

After existing fixed table/ID share locks and inside existing error handling, load
four batch responses in sequence using receipt bindings. Retain all current loops,
schema parses and expected/saved/current digest comparisons, indexing requested
order. Do not remove target checks or nested verifier calls.

```ts
const parties = await stores.master.getPartiesInTransaction(
  tx,
  tenantId,
  actorUserId,
  result.bindings.parties.map((v) => v.id),
);
const locations = await stores.master.getLocationsInTransaction(
  tx,
  tenantId,
  actorUserId,
  result.bindings.locations.map((v) => v.id),
);
const products = await stores.catalog.getProductsInTransaction(
  tx,
  tenantId,
  actorUserId,
  result.bindings.products.map((v) => v.id),
);
const profiles = await stores.profiles.getProfilesInTransaction(
  tx,
  tenantId,
  actorUserId,
  result.bindings.products.map((v) => v.id),
);
// Every existing per-row proof now obtains its current value from these arrays.
```

Adapt existing pause witness from getPartyInTransaction to the real batch getter:
forward original implementation, pause only after its requested IDs include the
owned first party, retain all actual 55P03 lock-timeout/concurrent-edit assertions
and finally draining/restoration. No new production test seam.

- [ ] **Step 4: Bounded GREEN and native semantic regressions.**

Run the new actual batch suite and existing reference suite serially. Show budget
GREEN with same counter boundary, output parity, requested-order/missing-ID denial,
empty authorization, duplicate/invalid/oversize IDs, role/profile reload and
same-transaction edits. Verify default/invalid profiles and concurrent share locks.
Record comparable reference query counts and timings without sensitive data.

Then run relevant existing regular/special native suites serially: real denial,
drift, SQL-failure, resume and proof behavior must remain intact. Build dependencies
before native commands when required, never during live native work.

- [ ] **Step 5: Freeze and review the bounded reference increment.**

Measured chain0 costs after batching remain too high for complete-phase acceptance.
Do not launch a predictably over-budget full run. Report existing adjacent-suite
deadline failures explicitly; preserve their exact assertions and deadlines. Freeze
source and append the truthful bounded checkpoint for independent task review.
Final full-native/package gates below belong to Task 2, after the measured amendment.

### Task 2: Locked owner proof and guarded journal dependency batches

**Files:**

- Modify: `apps/api/src/deployment/us-development-owner.ts` (native locked proof sharing existing validation).
- Modify: `apps/api/src/modules/traceability/demo/us-demo-target.ts` (consume locked native proof, preserve profile/timezone guards).
- Modify: `apps/api/src/modules/traceability/demo/us-dataset-journal.ts` (guarded live stage collection read).
- Modify: `apps/api/src/modules/traceability/demo/us-dataset-transformation-verify.ts`, `us-dataset-cases-prepare.ts`, `us-dataset-shipping-prepare.ts`, `us-dataset-shipping-origin-status.ts` (only contiguous dependency groups).
- Modify: `apps/api/src/modules/traceability/demo/us-dataset-corrected-transformation-prepare.ts`, `us-dataset-corrected-cases-prepare.ts`, `us-dataset-corrected-shipping-prepare.ts` (only equivalent contiguous groups).
- Create: `apps/api/test/us-dataset-journal-batch.e2e.test.ts` (actual query/authority/provenance/live-row/lock parity).
- Append: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
- Other sources/tests and all existing deadlines/assertions remain unchanged. No edits to complete coordinator test or fixture.

**Interfaces:**

```ts
verifyLockedTrustedSeed(tenantId: string, actorUserId: string, verifiedAt: Date,
  tx: UsMasterDataTransaction): Promise<{
  seedId: string; verifiedBy: string; verifiedAt: string;
} | null>;
readStagesInTransaction(tx: UsDemoTransaction, context: UsDatasetContext,
  datasetId: string, requests: readonly {
    unitKey: string; stage: UsDatasetStage;
  }[]): Promise<(UsDatasetStageRow | null)[]>;
```

- [ ] **Step 1: Observe actual locked owner-proof budget RED.**

Using existing owned fixture and countActualQueries, call current assertUsDemoTarget
in an actual transaction and assert at most 11 SQL calls including BEGIN/COMMIT;
snapshot unchanged. This catches duplicate native fact reads, not a mock. Obtain
exact direct-query counts for existing contiguous dependency reads as baseline.

```ts
const measured = await countActualQueries(f.pool, () =>
  f.db.transaction((tx) =>
    assertUsDemoTarget(tx, f.db, context, () => {
      throw new Error("denied");
    }),
  ),
);
expect(measured.count).toBeLessThanOrEqual(11);
```

Before production edits, add native cases for current original owner/actor, account,
membership, metadata and provisioning-audit denials; unchanged table hashes; actual
identity/provenance share locks; new stage batch order/duplicates/empty/missing/
foreign dataset/invalid pair/oversize/corrupt row; fresh reads after own writes and
role/provenance changes inside the same transaction. Use actual native fixtures,
not caller-supplied proof objects. Preserve existing denial namespaces/driver causes.

- [ ] **Step 2: Read native owner facts once under original lock order.**

Factor existing verifyTrustedSeed predicates into a shared native implementation,
not a second demo-specific validation copy. Existing verifyTrustedSeed retains
optional transaction/default repeatable-read behavior and exact return shape.
New verifyLockedTrustedSeed uses mandatory caller transaction, complete rows and
FOR SHARE in organization→user→membership→credential→audit order; every existing
predicate remains, plus expected actor ID. Return no credential/user row values.

```ts
// After native locked verification, retain the original profile/timezone checks.
if (
  !(await new UsDevelopmentOwnerStore(db).verifyLockedTrustedSeed(
    context.tenantId,
    context.actorUserId,
    new Date(),
    tx,
  ))
)
  return onDenied();
```

Replace only the guard's duplicate identity pre-lock/read sequence. No catches or
authority caches added. Current actor, account cardinality, original names/metadata,
owner role and exact audit facts must still reject every original mutation.

- [ ] **Step 3: Add live guarded journal collection reads.**

Each invocation calls checkedTransactionContext once, required header proof once,
validates the bounded requested unit/stage collection, selects tenant/dataset-scoped
requested rows once, and invokes existing parseRow for each requested result. Return
null for missing rows in requested order. Do not skip row/receipt validation or
reuse earlier target/header/row results. Empty still proves target/header. Ordinary
readStageInTransaction may delegate a one-element batch only if behavior remains
identical; no change to locks or write/atomic-stage implementation.

```ts
const [references, receiving, transformation] = await journal.readStagesInTransaction(
  tx,
  context,
  datasetId,
  [
    { unitKey: "references", stage: "references" },
    { unitKey, stage: "receiving" },
    { unitKey, stage: "transformation" },
  ],
);
```

Replace only already-contiguous dependency reads in the listed consumers. Leave
separate preliminary reads before raw evidence/locks untouched. Retain every
subsequent null check, identity/digest/schema comparison and verifier invocation.

- [ ] **Step 4: Prove bounded and adjacent native GREEN.**

Owner target budget <=11 and three dependency batch budget <=16 use identical
transaction boundaries. Assert exact response parity with ordinary live reads,
fresh own writes/authority changes, and actual concurrent share-lock denial.
Run existing owner/journal/target native regressions serially. Re-run every Task 1
adjacent-suite timeout failure on the final optimized source under Task4 and report
exact per-case terminal evidence. No timeout/assertion weakening.
Record current one-chain initialize/verify SQL/time measurements before full run.

- [ ] **Step 5: Freeze bounded source checkpoint for task review.**

Actual warm5 measurements after these two changes remain far outside full-phase
budget. Record30new/9reference/122owner-journal native passes and remaining open
failures truthfully. Preserve source, full coordinator and deadline. The unchanged
full/native/project gates below are mandatory Task4, not Task2 acceptance claims.

### Task 3: Identical canonical bytes and fresh-input CPU work

**Files:**

- Modify: `packages/domain/src/traceability/export/canonical.ts`, `packages/domain/src/index.ts`.
- Append tests: `packages/domain/test/us-export-registry.test.ts` (no existing assertion edits).
- Create: `apps/api/src/modules/traceability/demo/us-demo-canonical.ts`, `apps/api/test/us-demo-canonical.test.ts`.
- Modify hot US imports only under `apps/api/src/modules/traceability/demo/`: `us-demo-journal-contract.ts`, `us-dataset-contract.ts`, `us-dataset-journal.ts`, `us-dataset-reference-contract.ts`, `us-dataset-reference-verify.ts`, `us-dataset-reference-seed.ts`, `us-dataset-receiving-contract.ts`, `us-dataset-receiving-verify.ts`, `us-dataset-transformation-contract.ts`, `us-dataset-transformation-verify.ts`, `us-dataset-cases-contract.ts`, `us-dataset-cases-prepare.ts`, `us-dataset-cases-verify.ts`, `us-dataset-shipping-contract.ts`, `us-dataset-shipping-prepare.ts`, `us-dataset-shipping-verify.ts`, `us-dataset-shipping-origin-status.ts`.
- Append: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
- No other files; catalogue factory, recipes, assertions, native full fixture and deadlines unchanged.

**Interfaces:** `canonicalExportJson(input: unknown): string` shared browser-pure
export; US adapter `canonicalExportDigest(input: unknown): string` same name/bytes
for import-local opt-in. No cache or public route.

- [ ] **Step 1: Differential RED and baseline.**

Before implementation add literal serialization/native-digest tests, characterize
all documented JSON/error behaviors against the existing serializer, and retain
the current bounded walker only in test code for deterministic differential cases.
Observe actual failing expectations for the new export/adapter, not infrastructure
or import setup failure. Existing warm5/CPU logs are performance baseline; preserve
them. Avoid machine-dependent absolute throughput assertions. All existing tests
and deadlines unchanged. New tests cover root/nested ordering, integer keys, NUL/
surrogates/escaping, finite/-0 values, alias/cycle, null/custom prototypes, hidden/
symbols/accessors (counters), array legacy behavior and combined defect precedence.
Walker tests cover exact262144/one-over bytes, depth16/17 and all secret aliases.

- [ ] **Step 2: Extract unchanged serializer and native hashing.**

Move original serialization body into canonicalExportJson; browser digest calls it
and retains Noble. API adapter uses createHash('sha256').update(canonicalExportJson
(input),'utf8').digest('hex'). No Node dependency/import in shared domain. All
original validation/output algorithms and error precedence retained; no serializer
rewrite or fallback. Rebuild domain before API consumers. Replace only the listed
hot imports, retaining every digest comparison and nested proof call.

- [ ] **Step 3: Fresh walker and private immutable expectations.**

Reuse existing descriptor collection/keys only within the current ordinary-object
walk; preserve exact prototype/hidden/accessor errors and precedence. Optional fast
NUL/surrogate regex uses original scan fallback, only if differential parity passes.
No WeakMap or validated-input shortcut. Factory freshness unchanged; private owned
expected catalogue/input constants only in reference parser/verifier/seed. Freeze
wrapper before retaining its expected digest. Journal precomputes only immutable
expected manifest digest, hashes native manifest anew on every stored read.

- [ ] **Step 4: Actual GREEN, source freeze and review.**

Domain tests/typecheck/lint/build, API new differential and existing codec/reference/
factory/definition tests, US browser-consumer import/bundle check, focus formatting
and diff. Run native Task1/Task2 bounded/header own-write drift on final source,
then actual warm5 diagnostic at same boundary (existing60s tracked fixturephase).
Record paired output/error parity and performance without claiming full acceptance.
Append truthful docs and freeze for task review. Full project/full coordinator
remain Task4; no commit/push/release.

### Task 4: Ordered native authorization read consolidation and full acceptance

**Files:**

- Modify: `apps/api/src/modules/traceability/master-data/us-master-data-support.ts`.
- Modify: `apps/api/src/modules/traceability/demo/us-demo-target.ts`.
- Create: `apps/api/test/us-master-data-authorization-read.e2e.test.ts`.
- Append: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.
- No ordinary writer, schema, recipe, full fixture, CI or timeout/assertion changes.

**Interfaces:** `authorizeUsMasterDataDetails(tx,tenantId,actorUserId,required)`
returns native validated `{code,timeZone}`; existing authorizeUsMasterData wraps
the same implementation and returns code unchanged. Required alternatives/empty
array retain JS resolveUsAccess/hasUsCapabilities policy.

- [ ] **Step 1: Observe real authorization RED before product edits.**

Actual direct authorize call in transaction must cost <=4 includingBEGIN/COMMIT
(current5 fails); target <=9 (current11 fails). Transparent count, hashes unchanged.
Add actual membership/capability alternatives, empty, cross-tenant, profile missing/
invalid/baseline/retention, timezone, own-write role/profile/zone reload, driver
identity and lock-order witnesses. Missing profile must reject without waiting
on lockedorg; blocked profile must not acquire org early. Both shares persist.

- [ ] **Step 2: Consolidate only ordered profile facts.**

Original member query/JS permission branch stays first. Parameterized materialized
profile CTE FOR SHARE then explicitly dependent org-profile CTE FOR SHARE; absent
profile skips org and retains old denial. Read scalar fields using unknown-safe
typed result then existing Zod validation; no broad cast/Date assumptions/policy
copy. Return detailed native result, code-only wrapper unchanged. Target consumes
same invocation timezone and retains exact processor/LA predicates and private
denial handling. Driver errors propagate unchanged; no transaction cache.

- [ ] **Step 3: Native GREEN and all deferred regressions.**

Pass new real budgets/parity/locks and native owner/journal/master/catalog/profile.
Re-run final Task1/Task2 suites and all six Task1 adjacent files, including every
previous26failure, plus affected corrected/special/shipping tests serially. Keep
full logs, deadline failures and drain evidence. If failure remains, investigate
actualcause; never weakenassertion/increasedeadline. After drain record warm5
measurements with same diagnostic boundary. If still overbudget, controller must
amend scoped optimization before any further product edit; fullgate never waived.

- [ ] **Step 4: Run untouched complete full coordinator file.**

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-seed.e2e.test.ts --maxWorkers=1
```

Pass only verified fixture URL to child US_TEST_DATABASE_URL in memory; unset
DATABASE_URL. Do not print workflow fixture declarations. All eleven cases and the
900,000 ms full phase must pass, including late special failure, failed-full verify,
explicit resume, counts 964 roots / 963 current finalized / 785 lots / 15700 distinct
synthetic boxes, Scenario A100, 440 regular shipments, no-write full verify/replay
and no-repair drift rejection. Record per-mode timings, process peak RSS KiB and
child database bytes including schema. Confirm owned work drain and exact disposal.

If full phase fails, report actual position/cause and reprofile before another
change. Do not repeat blindly or expand scope silently. Further optimization needs
a controller-recorded spec/plan amendment, never weakened checks or deadline bump.

- [ ] **Step 6: Final package gates, truthful docs, scoped review.**

With both DB variables unset run API test once, typecheck, lint, build; pure
assembly/regular/special contracts; Node US-development tests; isolation checker;
whole format and git diff --check. Native and bare API workload must not overlap.
If sandbox loopback listeners fail EPERM, rerun only those exact affected files
with appropriate escalation, not the full suite. Missing-env failures/skips stay
explicit; no env-file/shared DB workaround.

Append docs with measured before/after and actual complete native outcome. Do not
claim full native acceptance until observed. Controller task review and independent
final review follow. No commits, push, PR, publication or inherited-work cleanup.

### Rejected Task 5 proposal: Ordered native owner statement

DO NOT EXECUTE. Source-backed READ COMMITTED credential-insert counterexample
invalidates single-command equivalence. No production implementation occurred.
Retain the five native owner commands and every current cardinality predicate.
The steps below are historical rejected proposal, not active work.

Files: only `apps/api/src/deployment/us-development-owner.ts`, new
`apps/api/test/us-demo-owner-batch.e2e.test.ts`, and append-only US progress docs.
Unlocked owner verification/provisioning remains unchanged. No target, journal,
consumer, fixture, existing-test, schema or deadline edits in this increment.

- [ ] Record actual target <=5-query RED using forwarded real queries and hashes.
- [ ] Implement the spec's ordered materialized owner SQL with complete gated
      predicates and cardinality. Reuse final JS validation where feasible.
- [ ] Pass real native denials, early-lock ordering, retained shares, own-write
      freshness, exact driver-cause and <=5-query witnesses. Run existing owner,
      final authorization and journal-batch whole files, then identical warm5.
- [ ] Freeze exact source, append truthful checkpoint and provide dirty-baseline
      scoped review package for independent task review. Further changes require
      measured root amendments. All Task 4 heavy/full/package gates remain pending
      and mandatory; full coordinator file remains byte-identical.

### Task 5: Remaining private Receiving expectations

Files: `apps/api/src/modules/traceability/demo/us-dataset-receiving-contract.ts`,
new `apps/api/test/us-dataset-receiving-expectations.test.ts`, append-only US docs.
No other production edits, factory edits or existing assertion/deadline changes.

- [ ] Actual RED witnesses runtime catalogue reconstruction in valid Receiving
      identity/result codec calls; use existing valid fixture builders, no mocks
      of codecs or proof result. Restore transparent factory instrumentation.
- [ ] Use one private owned frozen catalogue and expected-input digest; preserve
      every fresh input traversal/validation and output ownership.
- [ ] Run focused new and existing codec/factory tests, API typecheck/scoped lint,
      formatting/scope check. Native runs stay serial and use unchanged warm5.
- [ ] Append measured checkpoint, freeze for independent task review. Keep all
      full/heavy/package gates pending until they actually execute and pass.

### Task 6: Complete live terminal proof for completed regular chains

Active correction: the full-row eligibility prototype failed actual combined-partial
priority RED. Replace its new public wrapper with metadata-only readStageCompletions
as specified by the final spec subsection. Preserve existing in-transaction batch,
the exact Receiving-first regression and every original test/deadline. The wrapper
never parses downstream payloads before deciding partial; it only selects native
revision and receipt-presence metadata under current target/header guards.

Files: `apps/api/src/modules/traceability/demo/us-dataset-journal.ts` (only public
readStages wrapper, existing native batch unchanged),
`apps/api/src/modules/traceability/demo/us-dataset-regular-seed.ts`, new
`apps/api/test/us-dataset-completed-chain-proof.e2e.test.ts`, append-only US docs.
Do not modify nested verifiers, current stores, recipes, existing tests or fixtures.

- [ ] Actual completed-chain driver-budget RED <=650 queries including controls,
      using initialized chain0 then one regular verify; hashes and returned summary
      unchanged. Add complete proof matrix from spec using real native fixture.
- [ ] Public readStages owns repeatable-read TX and delegates guarded bounded batch;
      root/tenant/current guards preserved. Regular executor selects terminal.verify
      only after fresh structural completeness, otherwise original four-stage path.
      Terminal denial never falls back to apply/initialize. Every nested proof stays.
- [ ] Pass new native budgets/drift/no-write/authority and unchanged whole regular
      and reference/journal tests serially; measure unchanged warm5 with verbose
      output and disposal. Keep source frozen for independent task review.
- [ ] Root evaluates actual measured full readiness, executes unchanged full11 when
      suitable, and completes remaining heavy/package gates and final independent
      review. If this exposes a missing predicate, fix code, not checks/timeouts.

### Task 7: Bounded-memory complete test snapshot

Spec: final Task7 amendment above; actual full11 failure is OOM in snapshot,
not product generation or timeout. All260 shipping receipts already committed.
Files: modify apps/api/test/support/us-dataset-journal-fixture.ts; create focused
apps/api/test/support/us-dataset-snapshot.ts and
apps/api/test/us-dataset-snapshot.e2e.test.ts; append-only US progress docs.
No production, existing tests/fixtures elsewhere, full11 body, timers, schema,
dependencies, resource limits or workflows may change.

- [ ] Native RED: original snapshot uses giant aggregate, violating bounded-memory
      driver witness. Actual full11 OOM log is additional genuine resource RED.
- [ ] Implement complete per-table64-row cursor streaming in one read-only RR
      transaction, exact old hash representation, no truncation or weakened check.
- [ ] Native GREEN: old-oracle differential on small fixture, actual bounded
      batches, all row/table drift, concurrent commit remains outside snapshot,
      empty tables, duplicates/Unicode/numbers, failure rollback/release/error
      identity. Keep work owned, drained, safely disposed. Static gates and scope.
- [ ] Root validates bounded snapshot on exact retained failed-full owned child,
      confirms inactive connections before normal recoverable ownership cleanup;
      never FORCE drop or touch other databases. No old giant query rerun.
- [ ] Freeze for fresh independent task review, then unchanged full11 rerun and
      all remaining heavy/package gates. Actual fullGREEN remains mandatory.

### Task 8: Native coordinator semantic drift boundary

Files: modify apps/api/src/modules/traceability/demo/us-dataset-native-seed.ts;
new apps/api/test/us-dataset-native-drift.e2e.test.ts; appendonly US progress docs.
No existing test/assertion/deadline, nestedproof/error, driver identity or row/query
change. Only exact known domain mismatches translate at full coordinator boundary.

- [ ] Native RED reproduces corrected onechain notes drift with affectedrow>0,
      exact existing full11 /drift|invalid/, all198tablehash unchanged bothmodes.
- [ ] Add narrowly classified native drift wrapper preserving original Error as
      cause and unitKey/stage, original driver/network/other errors passthrough,
      no fallback/retry/repair or mutation. Handle causecycle/depth conservatively.
- [ ] Native GREEN bothmodes reference/document drift, originaldirectnestedcodes,
      actualforwarded originalerroridentity, actual SQL40001 and unchangedtarget/
      incomplete semantics, no-writetablehash and ownedchilddrain/disposal. Pure
      classification edge cases may supplement realnative tests, never replace.
- [ ] Typecheck/scopedlint/format/diff/preservation guard, append exact results,
      freeze for fresh independent task review. No fullsuccess/commit/push claim.

### Task 9: Cache-free ASCII JSON scalar fast paths

Files: modify packages/domain/src/traceability/export/canonical.ts and
apps/api/src/modules/traceability/demo/us-demo-journal-contract.ts; create
packages/domain/test/us-canonical-ascii.test.ts and
apps/api/test/us-demo-canonical-ascii.test.ts; appendonly US progress docs.
No cache/map, traversal/array/reflection/validation/native proof/SQL/recipe/schema
change. Only scalar fastpath and exact unchangedfallback; modelhighestcapability
because canonicalbytes and security-boundary/error parity are mandatory.

- [ ] Write independent frozen original canonical/walker oracles and literal
      byte/SHA tests before edits. Realforwarding JSON.stringify count RED for
      valid ASCII serialization/walking, output assertions before budget.
- [ ] Implement only safeprintableASCII string/key quote and stringBytes len+2;
      preserve fallback/error/traversal/legacyarray behavior byte-for-byte.
- [ ] Exact exhaustiveUTF16/key/escape/unordered/order/proxy/iterator/getter/error
      precedence/size/depth/secret/mutation corpus GREEN, original domain whole
      test/type/lint/build. Rebuild domain before all API consumers.
- [ ] API original codec suite/type/lint/build proportionate; browser-entry tests;
      realnative completedproof plus journal/reference/regular/drift regressions,
      unchangedwarm5 counts/results/hashes. Rootretained260 read-only measurement
      afterfreeze/review; never substitute it for unchangedfull11 acceptance.
- [ ] Freeze scoped baseline/newtests/docappend package, actual results/limits,
      independent task review. All finalwide/full/package gates still mandatory.

### Task 10: Two additive tenant-audit indexes

Files: packages/db/src/schema/team.ts (two declarations only); generated
packages/db/migrations/0143_us_demo_audit_indexes.sql and meta/0143_snapshot.json,
append migrations/meta/_journal.json; new packages/db/test/us-demo-audit-indexes.test.ts
and us-demo-audit-indexes-migration.e2e.test.ts; append US docs. No other edits.
Interfaces: existing schema and transactional/runtime migrators unchanged;
two nonunique physical indexes only. No API contract or proof query changes.

- [ ] Write focused schema/SQL failing tests: expect exactly named
      tenant_audit_events_tenant_action_idx and tenant_audit_events_tenant_request_idx,
      tenant column first, nonunique, existing tenant_created retained. Run RED.
- [ ] Add existing index(...).on(...) declarations. With both DB vars unset run
      corepack pnpm --filter @markiro/db exec drizzle-kit generate --name us_demo_audit_indexes.
      Inspect output: exactly two CREATE INDEX statements; stop on unrelated drift.
- [ ] New guarded native test uses createUsProfileTestDatabase and
      copyMigrationsThroughIndex(...142); two tenants, duplicate owner/action and
      request audits. Upgrade143, all saved row facts/duplicates unchanged;
      exact index definitions and actual EXPLAIN selective corpus without planner
      overrides. Fresh full migration, runtime upgrade and idempotent rerun pass.
      Existing fixture deadlines/drain remain; no shared DB or FORCE drop.
- [ ] Build DB before consumers; focused and whole DB test/typecheck/lint/build.
      Unchanged native owner/master authorization/reference/journal lock tests.
      Append measured facts, index size/DDL caveats to US docs.
- [ ] Freeze, prepare task10 report/diff from provided dirty baselines, independent
      review. No commit/push/PR. Root then unchanged full11/260 acceptance.

Task10 explicit test-only exception after actual195/196 native regression:
capture dirty baseline of apps/api/test/us-master-data.e2e.test.ts; import desc,
add .orderBy(desc(schema.tenantAuditEvents.action)) only to first-case audit SELECT.
Keep every existing assertion, predicate and deadline literally unchanged.
The audited actions are exactly party.created then location.created in explicit
descending action order; SQL's former unspecified order was not a valid contract.
Run unchanged whole master-data file; no blind rerun of the196 passing cases.

### Task 11: Correct exact allocator preservation oracle

Files: apps/api/test/us-dataset-native-seed.e2e.test.ts (only counter-preservation
logic/import); create test/support/us-dataset-counter-preservation.ts,
test/us-dataset-counter-preservation.test.ts and
test/us-dataset-counter-preservation.e2e.test.ts; append US docs. No production,
schema, recipe, fixture, source, deadline or other existing assertion edits.

Interfaces: test-only pure expectedCounterTransition(beforeRows,newRootEvidence)
and native collector/check returning exact expected digest for preexisting counter
PK rows plus separately checking WHOLE after counter tables. No public API.
Capture original full baseline; freeze all Task1–10 source and prior tests.

- [ ] Write focused pure RED for exact2R/1T/1S, rollover and malformed evidence;
      expected helper missing is not the causal RED, native592545ms and bounded
      reproduction already prove original false immutability. Test under/over/
      missing/extra/foreign/year/other-field/duplicate-number non-contiguous states.
- [ ] Implement test-only deterministic expected state from before counter rows
      and actual new root/original revision1 created_at/time_zone/event_number.
      Require exact newroot kind/tenant counts2/1/1. Match year independently via
      original allocation instant/saved timezone. Preserve old years, support new
      year starting1. Never use after.sequence to construct expected values.
- [ ] Integrate full test's counter comparisons without skipping any table:
      retain original business PK digest assertion for all other tables; counter
      expected digest uses exact transition and full after-state validation.
      New roots are collected against all saved preexisting root IDs, not only
      current tenant; reject unexpected foreign/new IDs. Original260 and timing
      literals and all other assertions remain intact. No timer increase.
- [ ] Native one regular chain + exact40001 special stage + explicit resume:
      same before/failed counters, exact transitions, all old business PK facts
      unchanged, alltable verify/replay no-write. Counter drift/tampering rejects.
      Only invocation-owned native children, normal awaited drain and disposal.
- [ ] Focused pure/native GREEN, API typecheck/lint, changed formatting, original
      versus amended full diff reviewed explicitly, frozen-source/census guards.
      Freeze report/diff, fresh independent review before full11/260 retry; no
      commit/push/deployment. Root runs actual whole unchanged-scope900000ms suite.

### Task 12: Separate permanent-root classification from current origin census

Files: only apps/api/test/us-dataset-native-seed.e2e.test.ts census/orphan assertions;
new apps/api/test/us-dataset-root-census.e2e.test.ts; append canonical spec/plan and
US progress docs. No production/helper/schema/recipe/env/fixture/timer edits.

- [ ] Capture current full SHA2a5d4f8c4ff2b2a8ac085b215829d537f4e917bc8490ca07b6a8f67e3a325743,
      all57 prior allowed non-doc sources excluding full, four current document
      prefixes and4354 unrelated files. Extend the existing census allowlist only
      for the new regression and refresh only the two amended controller docs.
- [ ] Retain actual bounded causal RED: original regular0+259 and Special40001/
      resume, all later checks pass, old current join fails physicalReceiving4
      versus observed3. The saved audit run suffices; do not repeat that diagnostic.
- [ ] Change only the full physical type classifier to original root.id/event.id
      with same tenant, preserving exact262/441/261. Add independent current
      classifier261/441/261 with finalized status and the exact orphan root null
      pointers/latest actual revision1 void receipt witness. Preserve every other
      full source byte; prove inverse removal restores the saved full file.
- [ ] Add focused native regression from the audited actual0+259/Special probe:
      literal physical4/4/3 versus current3/4/3, root11/current10/lots11/boxes215,
      same one40001/resume and four new roots, exact counter/business preservation,
      actual shipping/lifecycle facts, no Plan/Request/readiness, frozen bounded
      summaries, all198 hashes for verify/replay and notes-drift denials. Use the
      existing bounded60000ms phase and fixture acquisition/drain/disposal.
- [ ] Run corrected focused native GREEN, then API typecheck/scoped lint/build,
      changed-file/addition formatting and diff checks. Freeze report, source
      review diff, doc additions, exact hashes and inverse full-change proof.
      Explicitly release native/heavy ownership before fresh independent review.
- [ ] Controller reviews this narrow exception and proof before any full retry.
      Actual full11/260 under900000ms, full envelope/size and native-boundary drift
      remain mandatory and unrun in this task. No commit/push/PR/deployment.
