# US-11 Large Demo Progress Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a bounded, tenant-safe journal for resumable six-month dataset units, without generating business records.

**Architecture:** Keep the accepted compact journal unchanged and introduce separate dataset/header/unit-stage persistence. A strict internal contract describes the pinned manifest and bounded receipts. An internal guarded store receives a trusted code-owned definition, verifies real database/original-owner identity and implements exact replay and compare-and-swap; no CLI or business callback runs here.

**Tech Stack:** Node 24+, repository Corepack pnpm, strict TypeScript, Zod, Drizzle/PostgreSQL, Vitest, existing domain canonical hashing. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`, owner approved 2026-10-06.

## Global Constraints

- Work stays in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve accepted and unrelated dirty work.
- No staging, commit, push, PR, release, deployment, shared-base database writes, dependency/environment edits or archive/design-file edits.
- Tests create owned disposable US databases only. Missing optional test URL skips explicitly; a configured but unusable target fails.
- Preserve compact Scenario A descriptor/version/digest, journal behavior and 256 KiB input/result codec; do not rewrite migration 0141.
- Period `2026-04-01` through `2026-09-30`; timezone `America/Los_Angeles`; recipe identity `us-processor-six-month-v1`.
- Expected dataset: 260 regular chains, monthly counts 34/38/42/46/48/52; 964 event roots, 963 current finalized events, 785 lots and 15,700 boxes. Revision counts are separate.
- Request limits remain 500 revisions and 16 MiB; viewer stays read-only with existing EN/ES and authorized downloads.
- No business snapshots, genealogy, balances, boxes, case links, Plan approvals or Request publication in this increment.
- No clock override, deadline renewal, secret logging, record adoption, reset, repair or completion shortcut.
- Separate implementer and independent reviewer for each task, then final review. Capture byte baselines and scoped path manifests; do not infer scope from dirty Git diff alone.

## Review Focus

1. A lost reply must replay exact committed ownership, even with stale CAS, without replacing intent/receipt: Task 3.
2. A forged database/tenant/actor or revoked original owner must write nothing; database failures must not masquerade as authorization denial: Task 3.
3. Two units using the same stage must coexist, but operation keys cannot cross units or tenants: Tasks 2/3.
4. Malicious nested accessors, sparse arrays or secret keys must fail before evaluation/logging; UTF-8 and depth boundaries must remain intact: Task 1.
5. Existing compact headers and arbitrary business records must prevent fresh large initialization, while a legitimate installed large journal must survive later independent records: Task 3.

## Scope and file ownership

This first independently testable increment implements section 4's progress
foundation, not the business recipe generator or full demo acceptance. Subsequent
plans cover concrete expanded reference/chain inputs, service orchestration,
artifacts, CLI/viewer and full-volume/browser measurements. They must supply the
complete code-owned definition before any real dataset initialization; this
increment has no runtime registration or externally reachable write surface.

| Files                                                                                                        | Responsibility                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `apps/api/src/modules/traceability/demo/us-dataset-contract.ts`                                              | Manifest/intent/receipt validation, types and finite errors      |
| `apps/api/src/modules/traceability/demo/us-demo-journal-contract.ts`                                         | Export existing bounded JSON validator only, preserving behavior |
| `packages/db/src/schema/traceability-demo-dataset.ts`                                                        | Separate dataset headers and bounded unit-stage rows             |
| `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, new migration/metadata                         | Additive DB integration                                          |
| `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`                                               | Guarded initialization, paged read, intent and receipt CAS       |
| `apps/api/test/support/us-dataset-journal-fixture.ts`                                                        | Owned DB and small explicitly test-only definition               |
| Focused API/DB tests                                                                                         | Codec, migration, provenance, replay, concurrency                |
| `.github/workflows/us-development.yml`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md` | Exact check-only CI ownership and factual partial-status notes   |

Do not introduce a second command path or refactor the compact store. Read root
and applicable API instructions, the approved spec, current compact codec/store,
`UsDevelopmentOwnerStore`, DB migration helpers and adjacent tests before editing.
The API scoped guide is available in the primary checkout if absent locally.

## Shared interfaces

Task 1 exports the following strict internal types. `JsonObject` means a plain,
bounded evidence object, not arbitrary executable properties. Define it as
`Readonly<Record<string, unknown>>` and validate its contents with the existing
walker. `definition` is a constructor dependency from trusted application code,
not a client request. The store independently validates it before use.

```ts
type UsDatasetContext = UsDemoJournalContext;
type JsonObject = Readonly<Record<string, unknown>>;
type UsDatasetStage =
  | "references"
  | "receiving"
  | "amend_receiving"
  | "void_receiving"
  | "transformation"
  | "cases"
  | "shipping"
  | "trace_readiness"
  | "plan"
  | "request"
  | "package";
type UsDatasetUnit = Readonly<{
  key: string;
  kind: "references" | "chain" | "correction" | "orphan" | "plan" | "request";
  stages: readonly UsDatasetStage[];
}>;
type UsDatasetDefinition = Readonly<{
  version: "us-processor-six-month-v1";
  digest: string;
  manifest: JsonObject;
  units: readonly UsDatasetUnit[];
}>;
type UsDatasetIntent = Readonly<{
  unitKey: string;
  stage: UsDatasetStage;
  operationKey: string;
  inputDigest: string;
  input: JsonObject;
}>;
type UsDatasetReceipt = UsDemoReceipt;
type UsDatasetHeader = Readonly<{
  id: string;
  tenantId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  manifest: JsonObject;
  createdBy: string;
}>;
type UsDatasetStageRow = Readonly<{
  unitKey: string;
  stage: UsDatasetStage;
  revision: number;
  intent: UsDatasetIntent;
  receipt: UsDatasetReceipt | null;
}>;
type UsDatasetPage = Readonly<{
  rows: readonly UsDatasetStageRow[];
  next: Readonly<{ unitKey: string; stage: UsDatasetStage }> | null;
}>;
```

`parseUsDatasetDefinition(raw: unknown): UsDatasetDefinition` and
`parseUsDatasetIntent(raw: unknown): UsDatasetIntent` reject invalid input with
finite `us_dataset_*` errors. `parseUsDemoReceipt` remains the receipt validator.
The root digest equals `canonicalExportDigest({version, manifest, units})`, never
the digest of itself. Manifest embeds structural unit catalogue/counts and the
complete compact synthetic recipe definition supplied by subsequent recipe work
(static references, exact generation parameters and algorithm identity, not all
expanded event/box rows); it
must not contain runtime IDs, clocks, credentials or artifact URLs. The combined
root evidence must fit 256 KiB; if concrete recipe content exceeds this boundary,
stop for design review rather than increasing it or quietly omitting content.

Unit keys use `/^[a-z][a-z0-9_-]{0,63}$/`, are unique and have ordered unique
stages. Allowed sequences are references=`references`; chain=
`receiving,transformation,cases,shipping,trace_readiness`; correction=
`receiving,amend_receiving,transformation,cases,shipping,trace_readiness`;
orphan=`receiving,void_receiving,trace_readiness`; plan=`plan`;
request=`request,package`. Multiple shipments are business work inside a chain's
Shipping stage, not duplicate stage identities.

## Task 1: Strict definition and unit progress contracts

**Files:** Create `us-dataset-contract.ts` and
`apps/api/test/us-dataset-contract.test.ts`; modify only the export of the existing
`assertBoundedSyntheticJson` in `us-demo-journal-contract.ts`.

**Consumes:** Existing compact JSON walker, `parseUsDemoReceipt`, canonical hashing.
**Produces:** All shared types and parsers above; no production dataset instance.

- [ ] **Step 1 — write failing pure tests.** Use a small valid test definition
      containing two independent chains and an orphan. Compute its digest with the
      exact pattern below. Pin unique keys, valid per-kind stage sequences, immutable
      parsed owned data, unknown-root-field rejection and digest mismatch. Test
      duplicate/reordered stages, invalid key/UUID/digest, cyclic input, sparse arrays,
      NaN, NUL/lone-surrogate text, symbol keys, nested secrets and depth 17.

```ts
const body = { version: "us-processor-six-month-v1", manifest, units };
const definition = parseUsDatasetDefinition({
  ...body,
  digest: canonicalExportDigest(body),
});
expect(definition.units.map((unit) => unit.key)).toEqual(["chain_001", "chain_002", "orphan_001"]);
expect(() => parseUsDatasetDefinition({ ...body, digest: "0".repeat(64) })).toThrow(
  "us_dataset_definition_digest_mismatch",
);
let evaluated = false;
const malicious = Object.defineProperty({}, "hidden", {
  enumerable: true,
  get() {
    evaluated = true;
    return "secret";
  },
});
expect(() => parseUsDatasetIntent(malicious)).toThrow();
expect(evaluated).toBe(false);
```

Build exact-size UTF-8 evidence with the existing codec test pattern: 256 KiB
passes, one byte over fails. Preserve all compact codec assertions unchanged.
Reuse actual walker errors for nested evidence; do not print rejected payloads.

- [ ] **Step 2 — record RED.** Run
      `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-contract.test.ts test/us-demo-journal-contract.test.ts test/us-demo-definition.test.ts`.
      The new missing parser/behavior fails; compact regressions remain green.
- [ ] **Step 3 — implement minimal strict parsers.** Validate property descriptors
      before Zod reads values; export/reuse the existing walker rather than copying
      it. Validate root manifest plus units as one bounded object before hashing.
      Clone validated data, recursively freeze only owned copies, and validate the
      allowed stage sequence by kind. The central identity check is:

```ts
const expected = canonicalExportDigest({
  version: parsed.version,
  manifest: parsed.manifest,
  units: parsed.units,
});
if (expected !== parsed.digest) throw new Error("us_dataset_definition_digest_mismatch");
```

- [ ] **Step 4 — GREEN and review.** Rerun the three tests; run API
      typecheck/lint and affected formatting. Capture paths/hashes and RED/GREEN;
      independent reviewer checks actual codec branches and compact compatibility.
      No commit. Task 2 waits for acceptance.

## Task 2: Separate additive dataset schema

**Files:** Create `packages/db/src/schema/traceability-demo-dataset.ts`,
`packages/db/test/us-demo-dataset-schema.test.ts`,
`packages/db/test/us-demo-dataset-migration.e2e.test.ts`; modify schema exports and
Drizzle file list; generate the next free SQL migration and its metadata.

**Consumes:** Task 1 field meanings; DB must not import API code.
**Produces:** `schema.traceabilityDemoDatasets` and
`schema.traceabilityDemoDatasetStages` with matching snake-case table names.

- [ ] **Step 1 — write schema and real migration RED.** Header columns: UUID id,
      text tenant_id/version/definition_digest/created_by, JSONB manifest, actual
      created_at. Unique tenant_id/id and tenant_id (one installed large dataset);
      non-cascading organization FK. Stage columns: UUID id/dataset_id/operation_key;
      text tenant_id/unit_key/stage/input_digest; int revision default 1; JSONB input,
      nullable receipt; actual created_at. Unique tenant/dataset/unit/stage and
      tenant/dataset/operation_key. Composite tenant/dataset FK to header.
      Enforce valid version, digest, key/stage, revision in 1..2 and
      `revision=1 AND receipt IS NULL OR revision=2 AND receipt IS NOT NULL`.
      JSONB must be objects; storage ceilings are 16 MiB per evidence column solely
      for PostgreSQL representation expansion, not permission to exceed API 256 KiB.

```ts
const config = getTableConfig(schema.traceabilityDemoDatasetStages);
expect(config.uniqueConstraints.map((x) => x.columns.map((c) => c.name))).toContainEqual([
  "tenant_id",
  "dataset_id",
  "unit_key",
  "stage",
]);
expect(
  config.foreignKeys.some(
    (fk) =>
      fk
        .reference()
        .columns.map((c) => c.name)
        .join() === "tenant_id,dataset_id",
  ),
).toBe(true);
```

Add migration-owned INSERT guards on both compact and large headers: acquire
the same existing compact advisory lock for `tenant_id || ':' ||
  'us-processor-demo-v1'`, then reject a header if the other journal already has
one for that tenant. This prevents reverse-order and concurrent initialization
without refactoring the compact store or rewriting its historical migration.
Existing compact installations and ordinary compact replay remain unchanged.
Test two different units with Receiving both succeed, duplicate identity/key
fails, cross-tenant FK fails, unknown stage/bad revision/bad JSON fails,
deletion cannot cascade. Test compact-first and large-first rejection plus
concurrent compact/large inserts with exactly one committed header. Existing
compact initialization/replay still succeeds on an otherwise compatible tenant.
Fresh/upgrade migration tests pin predecessor/new
indices explicitly. Before/after hashes of all predecessor tables match,
including compact journal facts; run packaged `runRuntimeMigrations` against
the owned scratch URL and assert the new tables/tag exist.

- [ ] **Step 2 — record RED.** Run focused DB tests through the existing
      `packages/db/test/support/us-profile-database.ts` helper, using configured
      `US_TEST_DATABASE_URL` only as the scratch-database factory endpoint. Never
      apply migrations to that base database.
- [ ] **Step 3 — add schema and generate new migration.** Read Drizzle exclusions,
      add only the new file and exports, then run `corepack pnpm --filter @markiro/db
db:generate`. Inspect all SQL and metadata; do not modify historical migration
      bytes. Use the actual next free migration, not an assumed 0142 reservation.

```ts
foreignKey({
  name: "traceability_demo_dataset_stages_dataset_fk",
  columns: [t.tenantId, t.datasetId],
  foreignColumns: [traceabilityDemoDatasets.tenantId, traceabilityDemoDatasets.id],
});
```

- [ ] **Step 4 — GREEN and review.** DB focused tests plus package
      test/typecheck/lint/build. Rebuild DB before API consumers. Report skips
      separately; real configured PostgreSQL migration/FK evidence is mandatory.
      Capture SQL, metadata and predecessor-preservation hashes for independent
      review. No commit; Task 3 waits for acceptance.

## Task 3: Guarded exact-replay journal and check-only CI

**Files:** Create `us-dataset-journal.ts`,
`apps/api/test/support/us-dataset-journal-fixture.ts`,
`apps/api/test/us-dataset-journal.e2e.test.ts`; modify only check-only workflow
ownership and the two partial-status docs listed above.

**Consumes:** Task 1 parsers/types, Task 2 tables, native DB transaction,
`UsDevelopmentOwnerStore.verifyTrustedSeed`, current authorization/profile
checks and owned `createUsDemoJournalFixture` test infrastructure.

**Produces:** `UsDatasetJournalStore(db: Db, definition: UsDatasetDefinition)`:

```ts
read(context: UsDatasetContext): Promise<UsDatasetHeader | null>;
initialize(context: UsDatasetContext): Promise<UsDatasetHeader>;
readPage(context: UsDatasetContext, datasetId: string,
  after: { unitKey: string; stage: UsDatasetStage } | null,
  limit: number): Promise<UsDatasetPage>;
captureIntent(context: UsDatasetContext, datasetId: string,
  intent: UsDatasetIntent): Promise<UsDatasetStageRow>;
recordReceipt(context: UsDatasetContext, datasetId: string,
  expectedRevision: number, unitKey: string, stage: UsDatasetStage,
  operationKey: string, receipt: UsDatasetReceipt): Promise<UsDatasetStageRow>;
```

Pagination is lexicographic `(unit_key,stage)`, limit 1..100, fetch limit+1,
no offset/all-row read. Capture starts at revision 1; receipt advances to 2
exactly once. No global header CAS causes unrelated units to contend.

- [ ] **Step 1 — write genuine DB RED.** Fixture provisions the real reserved
      owner/profile in its random DB and supplies a small test-only definition.
      Initialize twice yields the same header. Same intent replay preserves row;
      changed body/key conflicts. Same receipt replay succeeds even with stale CAS
      after exact equality, different receipt conflicts; absent stage/stale revision
      cannot invent completion. Two units sharing Receiving remain independent.

```ts
const first = await store.initialize(context);
expect(await store.initialize(context)).toEqual(first);
const pending = await store.captureIntent(context, first.id, intent);
expect(pending.revision).toBe(1);
const completed = await store.recordReceipt(
  context,
  first.id,
  1,
  intent.unitKey,
  intent.stage,
  intent.operationKey,
  receipt,
);
expect(completed.revision).toBe(2);
expect(
  await store.recordReceipt(
    context,
    first.id,
    1,
    intent.unitKey,
    intent.stage,
    intent.operationKey,
    receipt,
  ),
).toEqual(completed);
```

Test all pages at limit 1/100, invalid limits/cursors, no omissions/duplicates,
tenant-scoped foreign IDs, unit/stage not in definition and operation-key reuse
across units. Use real concurrent initialize/capture/receipt calls: one durable
winner, exact loser replay or finite conflict; no lost rows.
Prove wrong actual database/user, forged context, revoked owner, altered
provenance/profile and driver failure leave all dataset and business tables
unchanged. Initialization with compact journal or unknown business rows fails;
subsequent legitimate independent references do not make installed replay
fail. Changed manifest/digest/version cannot replace the header. Missing or
corrupted stored receipt fails verification, not a fabricated empty result.

- [ ] **Step 2 — record RED.** Run the new configured PostgreSQL test with
      compact journal/atomic-stage/reference-seed regressions. Keep owned fixtures
      isolated, dispose them in finally, and never rebuild packages while a live
      fixture process is using them.
- [ ] **Step 3 — implement guarded store.** Check actual `current_database()`/
      `current_user` against validated context; lock original reserved organization,
      owner/membership/credential/provenance rows as the compact store does; invoke
      trusted seed verification and current QA/profile/timezone checks. Preserve
      driver exceptions. Serialize dataset bookkeeping with a tenant advisory lock
      using the exact existing compact key `tenantId + ":us-processor-demo-v1"`,
      backed by Task 2's bidirectional insert guards, so incompatible initializers
      cannot both pass freshness checks. Do not call the compact store to create a
      header. Re-read header identity/definition and tenant scope on every operation.
      Guard initial freshness across the same actual business/reference tables used
      by accepted seed initialization, including compact headers; tolerate the
      already provisioned owner/profile facts only. Header stores bounded root
      evidence; stage intents must belong to the supplied catalogue.

```ts
// Under the guarded transaction and lock, after stored evidence validation:
if (stored.receipt !== null) {
  if (canonicalExportDigest(stored.receipt) !== canonicalExportDigest(receipt))
    throw new Error("us_dataset_receipt_conflict");
  return stored;
}
if (stored.revision !== expectedRevision) throw new Error("us_dataset_revision_conflict");
```

Compare full intent identity before replay; allow exact prior intent regardless
of receipt state. CAS writes include tenant/dataset/unit/stage/revision/key and
verify one updated row. Missing prior required stage receipt refuses capture
of its successor; separate units remain independent. A bookkeeping receipt
never establishes canonical business validity or complete-demo status.

- [ ] **Step 4 — GREEN and check-only integration.** Add exact new focused test
      paths to the US workflow's serial check-only steps, not publication/seed runs.
      Run new codec/journal tests plus all accepted compact demo tests; run DB
      focused/package gates, API test/typecheck/lint/build and isolation contracts.
      Relevant commands include:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-contract.test.ts test/us-dataset-journal.e2e.test.ts test/us-demo-definition.test.ts test/us-demo-journal-contract.test.ts test/us-demo-journal.e2e.test.ts test/us-demo-atomic-stage.e2e.test.ts test/us-demo-reference-seed.e2e.test.ts test/us-reference-transaction-seams.e2e.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm format:check
git diff --check
```

Set only the owned-test environment in the process, not `.env`; keep ambient
`DATABASE_URL` unset for broad suites. Record real PostgreSQL pass/skip counts,
baseline setup failures and external checks not run. Update docs to say
progress foundation only, not six-month dataset generated or demo deployed.

- [ ] **Step 5 — independent and final review.** Capture exact changed paths and
      before/after byte evidence, ensure index untouched, compare spec requirements
      for this increment and compact regressions. Final reviewer checks all three
      tasks and no unauthorized mutations. No staging/commit. Next step is a separate
      recipe/reference/service-orchestration plan, not seed execution.

## Coverage and acceptance boundary

This plan covers strict bounded definition/progress contracts, additive storage,
tenant/original-owner guard, exact replay/CAS, paged progress and CI ownership.
It deliberately does not implement the 260-chain business generator, special
events, Plan/Requests, CLI, viewer provisioning, full-volume benchmark, browser
journey or hosting; these are the subsequent increments named in the approved
spec, not silently omitted acceptance criteria. A passing foundation is not a
ready demo. Review method already selected by the owner is preserved; written
plan approval is required before dispatching its implementers.
