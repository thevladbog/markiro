# US-11 regular dataset Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the selected separate implementer and independent reviewer for each task, then final controller verification and whole-increment review.

**Goal:** Atomically generate and canonically verify one regular chain's synthetic boxes and service-owned demo links without changing the manual API.

**Architecture:** Strict bounded stage evidence binds installed reference/Receiving/Transformation receipts to captured support identities. A guarded internal demo command reuses shared case rules with operation-first prerequisite locking; support, links, native audit/operation, verification and dataset receipt share the journal transaction. No runtime initializer or population command is registered.

**Tech Stack:** Node 24+, repository Corepack pnpm, strict TypeScript, Zod, Drizzle/PostgreSQL, Vitest and Node workflow contracts.

**Spec:** `docs/superpowers/specs/2026-10-08-us-11-dataset-cases-design.md`, owner-approved 2026-10-08.

Status: owner-approved 2026-10-08; execution in progress with separate implementers and independent stage reviews. Only the scoped local implementation/testing is authorized; no shared-base invocation or publication. Commits mentioned by generic skills are expressly excluded here.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve accepted dirty work and the empty index.
- Apply and verify the Cases stage of one regular chain from `us-processor-six-month-v1` at a time.
- Preserve the pinned April–September 2026 recipe, Los Angeles business timezone, 260 regular chains, 15,640 regular boxes and unchanged Scenario A at index259.
- The later corrected chain contributes the additional 60 boxes toward 15,700; this increment does not implement that special chain.
- No staging, commit, push, merge, release, environment/dependency changes, shared-base population, unrelated cleanup, archive/design-file changes or external resources.
- Hosted storage/infrastructure remain outside RF; this increment creates none.
- Do not add an optional client-selectable source flag to the public command. Keep the existing public and native manual signatures and schemas unchanged.
- Links carry `linkSource: demo_seed`. Provenance markers describe boxes, not how manual links were created.
- Native persistence is allowed only for minimal seed-owned support rows/markers; links, dependency writes, case audit and command receipt remain service-owned.
- Both input/result retain 256 KiB bounds; no whole-dataset arrays, receipt-table changes, migration, larger HTTP body or schema limit.
- Retain the journal's guarded read-committed transaction; native commands start no transaction, do no independent pool read, no commit and no inner retry.
- Public manual commandVersion1 digests, replay bytes, audit fields, capabilities, denial precedence, repeatable-read retries and HTTP contracts remain unchanged.
- Use the existing synthetic-marker table with `seedId` equal to the installed dataset UUID and `seedVersion: 1` for this Cases marker contract.
- No box items, scan events, pallet contents, print jobs or physical counters are generated. Actual technical instants are not recipe business dates.
- Read current root/API guides and `docs/us/development-isolation.md`. No Graphify graph exists here; do not install or generate one.
- Test only invocation-owned disposable US PostgreSQL children through `US_TEST_DATABASE_URL`; leave `DATABASE_URL` unset, serialize DB suites with `--maxWorkers=1`, drain all fixture workers before builds.
- Shipping, corrections/orphans, Plan/Requests artifacts, full-volume population, CLI/runtime/HTTP initializer, viewer/browser, remote CI, hosting/backup/deployment/physical/regulatory acceptance remain subsequent gates.

## Review Focus

1. A valid-looking foreign dataset/unit marker or same-lot manual receipt must not be adopted, including replay (Tasks1/2/3).
2. A public holder of the identical operation key must not wait on a seed-held lot while the seed waits on its key; root locks must precede all affected lots (Tasks2/3).
3. Support UUIDs and month numbering must survive a retry across UTC month rollover, without fabricating historical production dates (Tasks1/4).
4. Legitimate Shipping/technical dependency changes must allow byte-identical replay, while unlink/relink or extra active links must stop it (Tasks3/4).
5. Runner cancellation or a cleanup failure before readiness/during lock wait must drain actual workers and preserve the original error, not merely set disposal flags (Tasks3/4).

## File map and interfaces

Create focused production modules:

- `demo/us-dataset-cases-contract.ts`: strict intent/result DTOs, dependency identity, digests and owned record IDs.
- `demo/us-dataset-cases-prepare.ts`: actual target/stage reauthorization, operation-first prerequisite locks and current upstream verification.
- `cases/us-case-link-core.ts`: one existing business-rule body with private manual/demo mode metadata; not a public source selector.
- `cases/us-case-demo-command.ts`: separately guarded supplied-transaction demo entry.
- `demo/us-dataset-cases-support.ts`: minimal support persistence and explicit immutable/physical-default projection.
- `demo/us-dataset-cases-locks.ts`: support/box/marker coordination after prerequisite roots/lots.
- `demo/us-dataset-cases-verify.ts`: canonical no-write verification.
- `demo/us-dataset-cases-seed.ts`: per-chain durable capture/atomic apply/recovery.

The paths above are under `apps/api/src/modules/traceability/`. Modify only existing `cases/us-case-commands.ts` and `cases/us-case-store.ts` for shared delegation; `us-case-operations.ts` stays unchanged unless a demonstrated dependency is reported. No journal/native Transformation/reference schema or recipe change is planned.

Create six tests: `us-dataset-cases-contract.test.ts`, `us-case-demo-command.e2e.test.ts`, `us-dataset-cases-prepare.e2e.test.ts`, `us-dataset-cases-verify.e2e.test.ts`, `us-dataset-cases-locks.e2e.test.ts`, `us-dataset-cases-seed.e2e.test.ts`, and test-only `support/us-dataset-cases-fixture.ts`, all under `apps/api/test/`.

Modify workflow/isolation/docs only in Task5. Exact exported contract types:

```ts
type UsDatasetTransformationIdentity = Readonly<{
  datasetId: string;
  unitKey: string;
  stage: "transformation";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
type UsDatasetCasesSupportInput = Readonly<{
  capturedAt: string;
  shiftId: string;
  numberMonthKey: string;
  numberSeq: number;
  boxes: readonly Readonly<{ id: string; deviceBoxId: string; sscc: string }>[];
}>;
type UsDatasetCasesInput = Readonly<{
  codec: "us-dataset-cases-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  index: number;
  references: UsDatasetReferenceIdentity;
  receiving: UsDatasetReceivingIdentity;
  transformation: UsDatasetTransformationIdentity;
  outputLotId: string;
  outputProductId: string;
  support: UsDatasetCasesSupportInput;
}>;
type UsDatasetCasesSupportEvidence = Readonly<{
  shift: Readonly<{
    id: string;
    productId: string;
    status: "planned";
    mode: "aggregation";
    numberMonthKey: string;
    numberSeq: number;
    createdAt: string;
  }>;
  boxes: readonly Readonly<{
    id: string;
    shiftId: string;
    deviceBoxId: string;
    sscc: string;
    openedAt: string;
  }>[];
  markers: readonly Readonly<{
    boxId: string;
    seedId: string;
    seedVersion: 1;
    createdAt: string;
  }>[];
}>;
type UsDatasetCasesResult = Readonly<{
  input: UsDatasetCasesInput;
  support: UsDatasetCasesSupportEvidence;
  operationKey: string;
  requestId: string;
  linked: CaseLinkResult;
}>;
type UsDatasetCasesErrorCode =
  | "us_dataset_cases_input_invalid"
  | "us_dataset_cases_result_invalid"
  | "us_dataset_cases_prerequisite_incomplete"
  | "us_dataset_cases_dependency_conflict"
  | "us_dataset_cases_conflict"
  | "us_dataset_cases_mismatch";
```

These are exported by the new contract module; existing imported types come from `@markiro/platform-contracts`, `us-dataset-contract.ts`, `us-dataset-receiving-contract.ts` and `us-dataset-transformation-contract.ts`. No inferred unknown type names are permitted. Runtime DTO schemas are strict even though TypeScript readonly is structural.

## Task 1: Strict Cases contract and dependency evidence

**Files:** Create contract module and contract test only.

**Consumes:** Existing `makeUsDatasetReferenceIdentity`, `makeUsDatasetReceivingIdentity`, parsed Transformation result/stage codecs, immutable recipe, bounded synthetic JSON and native case response schemas.

**Produces:** Types above, plus exact exports:

```ts
makeUsDatasetTransformationIdentity(datasetId: string, stage: UsDatasetStageRow): UsDatasetTransformationIdentity;
makeUsDatasetCasesInput(index: number, datasetId: string,
  references: UsDatasetStageRow, receiving: UsDatasetStageRow,
  transformation: UsDatasetStageRow, support: UsDatasetCasesSupportInput): UsDatasetCasesInput;
parseUsDatasetCasesInput(raw: unknown): UsDatasetCasesInput;
parseUsDatasetCasesResult(raw: unknown): UsDatasetCasesResult;
caseDemoCommandDigest(input: UsDatasetCasesInput): string;
caseDemoAuditIdentity(input: UsDatasetCasesInput): Readonly<{
  datasetId: string; recipeVersion: "us-processor-six-month-v1";
  recipeDigest: string; unitKey: string; intentDigest: string;
}>;
usDatasetCasesRecordIds(result: UsDatasetCasesResult): readonly string[];
datasetCasesError(code: UsDatasetCasesErrorCode, unitKey: string, cause?: unknown):
  Error & { unitKey: string; stage: "cases" };
```

- [ ] RED focused tests must fail missing exports/assertions, not DB/environment setup. Build independent valid upstream stage evidence using the existing public response schemas; regular keys derive only from `makeUsSixMonthRegularChain(index)`.

```ts
it("does not invoke an accessor while rejecting unsafe raw evidence", () => {
  let calls = 0;
  const raw = Object.defineProperty({}, "codec", {
    enumerable: true,
    get() {
      calls++;
      return "us-dataset-cases-v1";
    },
  });
  expect(() => parseUsDatasetCasesInput(raw)).toThrow("us_dataset_cases_input_invalid");
  expect(calls).toBe(0);
});
```

- [ ] Reject index -1/260/fraction/nonfinite, incorrect dataset/unit/stage/revision, absent receipt, altered upstream operation/digest/recordIDs, mismatched reference/Receiving identities, inbound-as-output and differing output product/lot. Check raw data descriptors before any getters/property traversal, then bounded JSON and strict Zod; reject symbols, accessors, cycles, custom prototypes, extra fields and normalized-text drift.
- [ ] Pin exact ordered recipe SSCC set, 1–100 distinct check-digit-valid SSCCs, distinct support UUID/device bindings, shift versus box ID uniqueness, `numberSeq === index + 1`. `capturedAt` is canonical UTC ISO; derive `numberMonthKey` from its UTC month using fixed English month abbreviations and two-digit year, never locale/timezone or business event date. Reject a stored different month key without normalizing it.
- [ ] Result parser independently binds shift, every box/marker, dataset marker identity, output and exact `linked.created` set; `linked.unchanged` must be empty. Require canonical operation UUID shape; authoritative equality with captured Cases operation key belongs to the executor/verifier because the key is on the outer intent, not Cases input. Require demo source, current origin, consistent SSCC, active links, actor/time fields, distinct link IDs and canonical order. Link order is SSCC/ID sorted even if recipe support order differs. No normalization into receipt acceptance.
- [ ] Digest envelope code and tests:

```ts
const seed = caseDemoAuditIdentity(input);
const digest = canonicalExportDigest({
  commandVersion: 2,
  command: "case.link",
  source: "demo_seed",
  lotId: input.outputLotId,
  input: { ssccs: input.support.boxes.map((b) => b.sscc).sort() },
  seed,
});
```

`intentDigest` is `canonicalExportDigest(input)`; operation key remains checked separately against the captured stage. Compare with manual `caseCommandDigest` for the same lot/SSCCs and require different bytes; changing dataset/unit/input changes the demo digest. Record IDs are shift, boxes in support order, then created links in service order, unique in insertion order; upstream/product/marker duplicate keys are excluded.

- [ ] Pin 256 KiB shared guard boundary and oversize input/result denial, including the 100-box representative payload. Error code carries bounded unit/stage only and retains cause; pure parsing never authorizes a DB action.
- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-cases-contract.test.ts`, scoped Prettier and diff check. Independent review gate; no commit.

## Task 2: Guarded demo service and operation-first preparation

**Files:** Create prepare, shared core, demo command, two command/prepare tests and test fixture. Modify existing case commands/store only. No support executor or verifier from Task3 yet.

**Consumes:** Task1 contracts, existing journal `readStageInTransaction`, target/owner guards, native capability, `lockCaseOperation`, `lockUsDatasetTransformation`, `verifyUsDatasetTransformation` and existing case rules.

**Produces:**

```ts
type UsDatasetCasesPrepared = Readonly<{
  input: UsDatasetCasesInput; intent: UsDatasetIntent;
  cases: UsDatasetStageRow; references: UsDatasetStageRow;
  receiving: UsDatasetStageRow; transformation: UsDatasetStageRow;
}>;
type UsDatasetCasesPreparation =
  | Readonly<{ mode: "application" }>
  | Readonly<{ mode: "fresh_verification"; receipt: UsDatasetReceipt }>
  | Readonly<{ mode: "replay"; receipt: UsDatasetReceipt }>;
prepareUsDatasetCases(tx: UsDemoTransaction, context: UsDatasetContext,
  datasetId: string, unitKey: string,
  phase: UsDatasetCasesPreparation,
  stores: UsDatasetTransformationStores): Promise<UsDatasetCasesPrepared>;
linkDemoCasesInTransaction(tx: UsMasterDataTransaction, context: UsDatasetContext,
  datasetId: string, unitKey: string, requestId: string,
  stores: UsDatasetTransformationStores): Promise<CaseLinkResult>;
// Store method delegates directly, retaining the separate manual method:
UsCaseStore.linkDemoInTransaction(tx, context, datasetId, unitKey, requestId): Promise<CaseLinkResult>;
prepareDatasetCasesFixture(f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  context: UsDatasetContext, index: number): Promise<Readonly<{
    datasetId: string; input: UsDatasetCasesInput; intent: UsDatasetIntent;
  }>>;
```

- Internal dependency clarification (controller, 2026-10-08): the supplied
  transaction is not assignable to `Db` (it lacks `$client`), while the existing
  journal/owner guards and verifier stores require genuine `Db` construction.
  Pass the existing `UsDatasetTransformationStores` explicitly to the new
  preparation, demo command and Cases verifier. `UsCaseStore` composes those
  genuine stores from its existing `db`; its planned native method signature
  and all public manual/HTTP contracts remain unchanged. Every called boundary
  uses the supplied transaction; no pool read, independent transaction, cast,
  fake database or duplicated guard is permitted. No existing dependency helper
  or file outside this plan's file map changes.

- [ ] RED: actual installed upstream stages through Reference/Receiving/Transformation seed stores, then canonical Cases intent through journal capture. Test-only fixture constructs captured support UUIDs/time and inserts minimal support only inside a caller transaction. It creates no direct SQL links/operations/audits; invoke the real new command. Register owned cleanup synchronously; fixture owns no shared-base mutation.
- [ ] `prepareUsDatasetCases` first reauthorizes capability and actual target/owner/profile through existing same-transaction journal boundary, then validates exact header/Cases intent/prerequisites. Lock the header and Cases stage for command entry outside `runAtomicStage` using current schema, in journal-compatible order. There is no new header initialization. Arbitrate Cases operation before calling any lot-locking verifier. In application phase a stored operation on a pending Cases stage conflicts; on completed stage compare exact demo digest/target/result to its Cases receipt before origin locks. Replay phase additionally requires exact supplied/stored completed receipt equality. Fresh-verification phase is reserved to a trusted verifier callback immediately after successful private writes in the same transaction: require pending intent and exact supplied receipt/actual operation binding, not a persisted receipt. It is never passed to the command or HTTP, nor used by replay or restart to adopt a pending operation. Reject foreign/corrupt evidence before writes.
- [ ] Lock roots/revisions and sorted lot union with existing Transformation helper, then call its replay verifier before any box locks. Validate upstream root/pending/current state and reference/document/product/lot facts; do not pin remaining stock or mutable dependency versions. No Transformation root lock after an output lot. This is the supported explicit read-committed protocol, not general isolation certification.
- [ ] Move the existing link business body into `us-case-link-core.ts`, with closed internal manual/demo metadata. Define `runCaseLinkCore(tx, tenantId, actorUserId, id, input, requestId, mode): Promise<CaseLinkResult>`; `mode` is `"manual" | Readonly<{ source: "demo_seed"; digest: string; seed: ReturnType<typeof caseDemoAuditIdentity> }>`. Existing `linkCases` and `linkCasesInTransaction` delegate with manual mode, same authorization/parser/order/digest/audit/results. Do not expose the core's mode parameter through store/HTTP. Demo command calls preparation with `{ mode: "application" }`, derives all input/actor/tenant/seed metadata, locks sorted eligible boxes, verifies exact bound marker/box identity and pending freshness or completed active-link identity, then delegates shared rules with demo digest/source/audit identity. Core authorization stays before parsing/replay, even when demo preparation already authorized.

```ts
const source = mode === "manual" ? "manual" : "demo_seed";
const digest = mode === "manual" ? caseCommandDigest("case.link", lotId, value) : mode.digest;
// Existing locking/write body remains one implementation. Manual audit keeps
// its exact old shape; demo adds the already-guarded mode.seed identity only.
```

- [ ] Pending mode demands no preexisting box link history/operation and creates every link. Completed command replay demands the same active identities/SSCC/source and current origin; no historical-response-only certification. Repeated preparation acquires only already-held origin locks. Keep native raw errors and one attempt; public retry wrapper unchanged. Guard current membership even when raw index/stage/input is malformed.
- [ ] Native composition test pattern:

```ts
const prepared = await prepareDatasetCasesFixture(f, context, 259);
await f.db.transaction(async (tx) => {
  await prepareUsDatasetCases(
    tx,
    context,
    prepared.datasetId,
    prepared.intent.unitKey,
    { mode: "application" },
    stores,
  );
  // Fixture inserts only captured shift/box/marker values here, with null physical facts.
  const linked = await new UsCaseStore(f.db).linkDemoInTransaction(
    tx,
    context,
    prepared.datasetId,
    prepared.intent.unitKey,
    "owned-demo-command",
  );
  expect(linked.created).toHaveLength(100);
  expect(linked.unchanged).toEqual([]);
  expect(linked.created.every((row) => row.linkSource === "demo_seed")).toBe(true);
  throw primary;
});
// Preserve exact primary object and compare the full pre-support persisted snapshot.
```

- [ ] Cover wrong actual DB/user, reserved owner/provenance/profile/timezone/role, foreign dataset/unit/lot/box/marker, missing/foreign marker, disassembly, duplicate/malformed/101 SSCCs, wrong source selection over strict HTTP and manual↔demo/seed↔seed key clashes. Inspect exact action/actor/tenant/target/outcome/requestID/full metadata and marker source separately through public lookup/list. Preserve manual historical receipt bytes and no-op behavior.
- [ ] Inject dependency/link/audit/operation failures (40001/40P01/nonretryable), prove one native attempt/raw cause and rollback. PID-observe same-key public holder waiting on an independently held lot while seed waits on operation BEFORE any seed lot/root lock; release/drain and explicitly retry entire caller transaction if required.
- [ ] Run the two new files plus all six existing case suites serially with explicit fixture URL; zero configured skips, scoped ESLint/typecheck/Prettier/diff. Freeze source, independently review. No build while fixture alive; no commit.

## Task 3: Support projection, current verifier and contention

**Files:** Create support/locks/verifier and verify/locks e2e tests. Fixture from Task2 may gain test-only helpers. Task2 command/core and upstream modules remain frozen unless a demonstrated gap is reported.

**Consumes:** Task1 types, Task2 preparation/command/fixture, existing transaction and dataset types.

**Produces:**

```ts
insertUsDatasetCasesSupport(tx: UsDemoTransaction, context: UsDatasetContext,
  input: UsDatasetCasesInput): Promise<UsDatasetCasesSupportEvidence>;
readUsDatasetCasesSupport(tx: UsDemoTransaction, context: UsDatasetContext,
  input: UsDatasetCasesInput): Promise<UsDatasetCasesSupportEvidence>;
lockUsDatasetCasesSupport(tx: UsDemoTransaction, context: UsDatasetContext,
  input: UsDatasetCasesInput): Promise<void>;
verifyUsDatasetCases(tx: UsDemoTransaction, context: UsDatasetContext,
  intent: UsDatasetIntent, receipt: UsDatasetReceipt,
  mode: "fresh" | "replay", stores: UsDatasetTransformationStores): Promise<void>;
```

- [ ] RED verifier tests build genuine support and links with Task2 command and locally composed actual result/receipt, not the future executor. Start from completed upstream stages and a captured Cases intent. Within journal `runAtomicStage`, fixture apply inserts support, calls demo command and returns canonical receipt; verifier under test must detect deliberate allowed-field drift. Do not corrupt production tables with bypassed constraints.
- [ ] Minimal runtime support code uses captured values, actual output product, `status: planned`, `mode: aggregation`, null devices/operators/physical relations, defaults for actual required instants, no counters/items/scans. On conflict never upsert/adopt. Map only established owned uniqueness constraints to bounded Cases conflict; propagate unrelated/driver failures through causes. Parent shift and box/marker tenant keys are exact. Read support rechecks every physical nullable/default field, all owned rows, marker identity and exact box set before returning strict evidence projection; don't pin mutable registry cursors/update timestamps.
- [ ] Support locking occurs ONLY after `prepareUsDatasetCases` has arbitrated operation and locked prerequisite roots/lots/reference facts. Lock owned shift, sorted SSCC/ID boxes and their markers consistently; no new prerequisite root discovery from box/link/genealogy. Reject missing/extra support/active lot links. Subsequent post-write locks are reentrant held-row locks, not new out-of-order roots.
- [ ] Verifier reauthorizes/prepares current state with `{ mode: "fresh_verification", receipt }` ONLY for successfully applied private rows in the current callback, otherwise `{ mode: "replay", receipt }`. Bind exact intent/receipt/result/recordIDs/digests, current dependency stages and output. Compare support, exact full persisted active link fields, no unexpected link history or physical contents, actual case operation and complete native audit (including seed identity). Receipt requestID is frozen for audit comparison; replay does not overwrite it. Native operation replay alone is insufficient. Return no value/write, and never initialize missing state.
- [ ] No-write/rejection patterns:

```ts
const before = await f.snapshot();
await journal.runAtomicStage(context, datasetId, stage.revision, stage.intent, {
  apply: async () => {
    throw new Error("completed replay must not apply");
  },
  verify: (tx, checked, intent, receipt) =>
    verifyUsDatasetCases(tx, checked, intent, receipt, "replay", stores),
});
expect(await f.snapshot()).toEqual(before);
```

Include public audited unlink then relink with a different ID, extra active lot link, forged receipt rehash, marker/version/shift/device/product drift, archived/void/amended/pending origin and missing support. Each rejection preserves the complete persisted snapshot. Real Shipping later consumes the lot: verification must still return original bytes, without mutable balance/dependency pins.

- [ ] Real PID/barrier schedules both orders: completed verifier versus public link/unlink (same/different keys), Transformation void/amend finalization, output-lot status/source attempts and catalogue/document edits. Include explicit root-before-lot inversion-sensitive schedule and operation-first holder. Outcomes must match actual public semantics/raw native retry; no guessed timing, synthetic PIDs or successful retry presented as causal fix. Amendment-start is sequential unless actual command takes a contested lock; label honestly.
- [ ] Reuse existing signal-aware worker/cleanup helpers. Actual `TestContext.signal` cancellation before readiness/while native waiter is observed must have positive phase/PID/signal.reason assertions in an ordinary following proof test. Release gates, await actual worker outcomes, independently drop owned triggers/functions/clients/pools/child DB, preserve primary error despite cleanup error. No unidentified-resource deletion.
- [ ] Run verify/locks and Task2 new suites serially, exact owned-disposal evidence, scope/static gates and independent review. No commit.

## Task 4: Per-chain durable executor and recovery

**Files:** Create seed module and seed e2e test only; fixture helper may expand within test scope.

**Consumes:** Previous contracts/preparation/support/command/verifier and existing journal `read`, `readStage`, `captureIntent`, `runAtomicStage`.

**Produces:**

```ts
export class UsDatasetCasesSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetCasesResult>;
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetCasesResult>;
}
```

- [ ] RED actual April/index0, middle/index130 and unchanged Scenario A/index259 through installed seed prerequisites. `verify` absent/pending must make zero writes; invalid index/context authority fails in established order. Do not install missing references/Receiving/Transformation implicitly.
- [ ] Read authorized header/dependency stages, reconstruct expected canonical descriptor. If Cases intent exists, validate dependency/recipe first and USE ITS CAPTURED SUPPORT VALUES; do not regenerate UUID/time or compare them to a new candidate. When absent on initialize only, generate actual UTC capture instant and UUIDs once, construct canonical input and capture intent. A capture conflict reads/validates winner's input/operation; loses no accepted state and does not compare loser-generated support to winner as drift.
- [ ] Apply algorithm inside the supplied journal transaction:

```ts
const prepared = await prepareUsDatasetCases(
  tx,
  checked,
  datasetId,
  intent.unitKey,
  { mode: "application" },
  stores,
);
const support = await insertUsDatasetCasesSupport(tx, checked, prepared.input);
const requestId = `dataset-cases:${intent.operationKey}`;
const linked = await cases.linkDemoInTransaction(tx, checked, datasetId, intent.unitKey, requestId);
const result = parseUsDatasetCasesResult({
  input: prepared.input,
  support,
  operationKey: intent.operationKey,
  requestId,
  linked,
});
return {
  recordIds: usDatasetCasesRecordIds(result),
  result,
  resultDigest: canonicalExportDigest(result),
};
```

Mandatory verify calls `verifyUsDatasetCases` before journal receipt persistence. After apply the pending journal row STILL has no receipt. Task2 preparation and Task3 verifier explicitly distinguish fresh verification evidence from completed-row evidence. Fresh evidence is verified against this transaction's canonical intent and actual operation/support; it is never used to adopt preexisting pending operations. Task3 fixture uses fresh only immediately after its real native write. Task4 sets a local `applied = false`, flips it only after successful apply, and selects fresh only in that callback invocation. Standalone/public command entry remains application-only; completed replay always takes replay, never apply.

- [ ] Pin full rollback for support/marker/link/dependency/audit/operation/verification/receipt failpoints; intent survives with original support values. Remove trigger then explicit re-initialize succeeds using same key/IDs. Lost commit acknowledgement: completed stage exists, next initialize verifies and returns identical result, no duplicates.
- [ ] Concurrent capture and application have one winner/canonical key/support/receipt. Midmonth rollover uses an already captured prior-month intent unchanged; no clock mocking of auth/audit or production instants. Freeze only descriptor capture inputs in test construction, not global Date. Exact audit before/after/native tables inspected independently; no invented aggregate of different runs.
- [ ] No-write initialize/verify after real later Shipping, public lookup/list synthetic demo source, current trace and unchanged snapshots/quantities. Explicit drift and wrong-source denial. Real cancellation/cleanup with the same evidence rules as Task3; no extra retries/deadlines. Driver errors annotated unit/stage without replacing original extensible object/cause.
- [ ] Run six new Cases suites plus current dataset journal/atomic/Transformation seed and six old case suites serially; static checks and independent review. No CLI/runtime/HTTP registration, shared-base generation or commit.

## Task 5: Exact CI ownership, docs and final verification

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md` only.

**Consumes:** Frozen six suite names and independently approved task reports. **Produces:** One serial check-only owner and actual partial acceptance evidence.

- [ ] RED parsed ownership validator for exact owner `Verify regular US dataset Cases on disposable databases`; six suites in one unconditional exact command, globally once, after existing successful shared/domain/API builds:

```yaml
- name: Verify regular US dataset Cases on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-cases-contract.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts --maxWorkers=1
```

- [ ] Preserve all old selections/order/permissions/services/locks/30-minute budget; add only new-owner exclusions to historical hash filters, never repin historical baselines. Removing new owner must restore actual preincrement steps hash `f3b34bfe35b442908b8696fce4b424f96d5ce02859124094ce3ac7f8cd579f1b` and whole-workflow hash `c221c71b470554b13d1d5010affb6ed33a74664c843ab3bba969dbb44b40787c`; recheck at execution preflight.
- [ ] Fresh YAML mutations with intended AssertionError/message: omit/duplicate/split suites and named owners across workflows, workflow/job/step conditions, ignored/shell-suppressed failure, wrong/missing serial, wrong/missing fixture and primary fallback at every scope, build omission/reorder/condition/failure suppression, prior command/settings/permissions/budget drift. New owner uniqueness must also detect quoted filenames and `./test/...` aliases in duplicate commands; keep actual exact command strict. Do not rewrite old validators merely to polish their retained alias limitation.
- [ ] GREEN `node --test tools/us-development/test/isolation.test.mjs`, all safe `node --test tools/us-development/test/*.test.mjs`, checker/scoped lint/format/diff. Docs append actual per-task results, separate marker/manual/demo modes, exact no-repair replay, current population limits and external unrun gates. Never call recipe counts stored demo records.
- [ ] Controller after all workers drain: fresh API typecheck/lint/build. Then explicit fixture-only configured 24-file regression, verify all filenames before launch:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-cases-contract.test.ts test/us-case-demo-command.e2e.test.ts test/us-dataset-cases-prepare.e2e.test.ts test/us-dataset-cases-verify.e2e.test.ts test/us-dataset-cases-locks.e2e.test.ts test/us-dataset-cases-seed.e2e.test.ts test/us-case-commands.e2e.test.ts test/us-case-concurrency.e2e.test.ts test/us-case-reads.e2e.test.ts test/us-case-http.e2e.test.ts test/us-case-transaction-seams.e2e.test.ts test/us-case-transaction-locks.e2e.test.ts test/us-dataset-journal.e2e.test.ts test/us-dataset-atomic-stage.e2e.test.ts test/us-dataset-transformation-contract.test.ts test/us-dataset-transformation-verify.e2e.test.ts test/us-dataset-transformation-locks.e2e.test.ts test/us-dataset-transformation-seed.e2e.test.ts test/us-transformation-void.e2e.test.ts test/us-transformation-amendment-finalization.e2e.test.ts test/us-transformation-revision-concurrency.e2e.test.ts test/us-current-consumers.e2e.test.ts test/us-transformation-http.e2e.test.ts test/us-dataset-receiving-seed.e2e.test.ts --maxWorkers=1
```

- [ ] After configured workers drain, one separate full `corepack pnpm --filter @markiro/api test` with both DB variables unset and necessary local listeners permitted. Report exact pass/fail/skip/suite/file counts and causes actually established; prior eight nongreen files are not automatic harmlessness. No unrelated RU fixes/primary credentials.
- [ ] Controller repository `corepack pnpm format:check`, diff check including untracked paths, source-byte inventory and HEAD/index preservation. Independent whole-increment review of all five task packages/current interfaces/retained findings. Save final evidence without staging, commit, push or cleanup. Full API nongreen remains separate from bounded increment quality.

## Execution handoff

Owner reviews this written plan before implementation. Preserve the previously
selected separate implementer and independent reviewer for each task. Fresh review
gates precede the next task; final controller verification and whole-increment
review remain distinct. Generic commit instructions are overridden by explicit
no-commit scope. Shipping orchestration is subsequent design, not a hidden sixth
task. No shared-base population or deployment follows from accepting this plan.
