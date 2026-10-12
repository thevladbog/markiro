# US-11 Dataset Reference Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically install and canonically verify the shared six-month catalogue, with durable identity and no duplicate records on replay.

**Architecture:** An internal reference-only store uses the actual six-month definition and the existing dataset atomic-stage seam. Native master-data, catalog and profile services write all business records and audit in the supplied transaction; its bounded receipt records stable key bindings and service evidence. An exact guarded journal reader avoids scanning hundreds of unrelated stages.

**Tech Stack:** Node 24+, repository-declared Corepack pnpm, TypeScript, Drizzle/PostgreSQL, Zod, Vitest and existing US-only services.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`, sections 1–4 and 6; the accepted compact reference implementation remains unchanged.

Status: proposed written plan; execution requires owner confirmation. Preserve the selected separate implementer and independent reviewer per task, followed by whole-increment review.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve all existing dirty work.
- Recipe remains `us-processor-six-month-v1`, business period `2026-04-01` through `2026-09-30`, timezone `America/Los_Angeles`. Do not change its definition, digest, catalogue or compact Scenario A descriptor.
- Install exactly 23 parties, 23 locations, 16 products and 16 profiles. No reference documents in this shared stage: each chain's documents belong to its bounded event stages.
- Retain 256 KiB per intent/result; no whole-dataset array, limit increase, new migration or global document receipt.
- Unknown business records or a populated compact seed cause conflict, not adoption, repair or deletion. Additional independent references after completion do not invalidate unchanged owned references.
- Actual creation, audit and review timestamps come from existing services; never backdate them to the business period.
- No startup/CLI/HTTP integration, tenant provisioning, actual shared-base population, viewer/UI, artifacts, hosting, dependency/environment edits, staging, commit, push, PR or release.
- Configured database tests create and dispose their own random child database using only `US_TEST_DATABASE_URL`; leave `DATABASE_URL` unset. An unconfigured skip is not database evidence.

## Review Focus

1. Lost reply, new process and simultaneous callers must retain the winning operation identity and return the same IDs without extra audit.
2. A business/audit/verifier/receipt failure halfway through installation must roll back all catalogue writes while retaining the previously committed pending intent.
3. Changed, archived, missing or cross-tenant owned references and forged bindings must stop with a scoped mismatch, not repair or adopt by name.
4. Revoked owner, incompatible database/provenance and unknown pre-existing records must deny before business writes; verify must never initialize an absent dataset.
5. Forged keys, reordered evidence, duplicate UUIDs, profile/product disagreement, extra fields and oversized JSON must fail closed; independent later references must remain allowed on replay.

---

## Source map and interfaces

Read root `AGENTS.md`, applicable API guide, the spec and actual implementations before editing. The worktree currently lacks an API guide; use `/Users/thevladbog/PRSOME/q/apps/api/AGENTS.md` as fallback.

Existing sources:

- `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`: guarded header, bounded pages, intent capture and supplied-transaction apply/verify/receipt.
- `apps/api/src/modules/traceability/demo/us-dataset-contract.ts`: context, stage, intent and receipt codecs.
- `apps/api/src/modules/traceability/demo/us-six-month-references.ts`: immutable validated ordered catalogue inputs.
- `apps/api/src/modules/traceability/demo/us-six-month-definition.ts`: immutable definition; do not modify.
- `apps/api/src/modules/traceability/demo/us-demo-reference-seed.ts` and `us-demo-reference-verify.ts`: compact behavioral reference; do not modify or broaden the compact codec.
- `apps/api/src/modules/traceability/master-data/us-master-data-store.ts`, `catalog/us-catalog-store.ts`, `products/us-product-profile-store.ts`: real supplied-transaction writers/getters. Use `editableProfile` and `canonicalPackageSize` from `products/us-product-profile-support.ts` for expected canonical profile facts.
- `apps/api/test/support/us-dataset-journal-fixture.ts`: complete persisted-row digest snapshot and verified child database disposal.

New result interface, exported from `us-dataset-reference-contract.ts`:

```ts
type UsDatasetReferenceResult = Readonly<{
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  bindings: Readonly<{
    parties: readonly Readonly<{ key: string; id: string }>[];
    locations: readonly Readonly<{ key: string; id: string }>[];
    products: readonly Readonly<{ key: string; id: string }>[];
  }>;
  evidence: Readonly<{
    parties: readonly UsParty[];
    locations: readonly UsLocation[];
    products: readonly UsProduct[];
    profiles: readonly ProductTraceabilityProfile[];
  }>;
}>;
function parseUsDatasetReferenceResult(raw: unknown): UsDatasetReferenceResult;
```

Use existing platform response types/schemas. Binding arrays are in catalogue order; profiles are in product order. Exactly 62 unique business IDs (profiles use the product ID). No arbitrary dictionary keys, document entries or caller-supplied catalogue. Canonical input is `{ version: usSixMonthDefinition.version, definitionDigest: usSixMonthDefinition.digest, catalogue: makeUsSixMonthCatalogue() }`. The parser checks JSON bounds before schema parsing, strict shapes, fixed lengths, exact catalogue keys/order, UUID uniqueness, evidence/binding alignment, profile/product alignment and raw/parsed canonical digest equality. It does not claim deeply immutable service response objects.

New store, exported from `us-dataset-reference-seed.ts`:

```ts
class UsDatasetReferenceSeedStore {
  constructor(db: Db);
  initialize(context: UsDatasetContext): Promise<UsDatasetReferenceResult>;
  verify(context: UsDatasetContext): Promise<UsDatasetReferenceResult>;
}
```

Canonical verifier, exported from `us-dataset-reference-verify.ts`:

```ts
type UsDatasetReferenceStores = Readonly<{
  master: UsMasterDataStore;
  catalog: UsCatalogStore;
  profiles: UsProductProfileStore;
}>;
function verifyUsDatasetReferences(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetReferenceStores,
): Promise<void>;
```

New errors: `us_dataset_reference_mismatch`, `us_dataset_references_incomplete`, `us_dataset_reference_conflict`. Preserve all journal authorization/provenance/identity errors and driver failures without relabeling. Include fixed `unitKey: references` and `stage: references` in diagnostic error properties without sensitive context.

## Task 1: Guarded exact stage reads

**Files:** Modify `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`; test `apps/api/test/us-dataset-journal.e2e.test.ts`.

**Produces:**

```ts
readStage(
  context: UsDatasetContext,
  datasetId: string,
  unitKey: string,
  stage: UsDatasetStage,
): Promise<UsDatasetStageRow | null>;
```

- [ ] Write failing configured tests for existing pending/done rows, absent row, unknown unit/stage, wrong dataset/tenant, revoked owner and malformed persisted evidence. Assert complete snapshots unchanged after every read/denial.

```ts
const before = await fixture.snapshot();
expect(await journal.readStage(context, header.id, "references", "references")).toBeNull();
expect(await fixture.snapshot()).toEqual(before);
```

- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-journal.e2e.test.ts --maxWorkers=1` in the disposable fixture environment. RED must be the missing method, not infrastructure failure or skipped tests.
- [ ] Add only the exact reader. Reuse existing transaction, header guard, unit validation and private row parser/query; no pagination loop or alternate journal codec.

```ts
return this.transaction(context, false, async (tx, checked) => {
  await this.required(tx, checked, datasetId);
  this.unit(unitKey, stage);
  return this.stage(tx, checked, datasetId, unitKey, stage);
});
```

- [ ] Rerun journal and atomic-stage suites; independently review unchanged readPage, authorization and write semantics before Task 2.

## Task 2: Bounded catalogue receipt and atomic orchestration

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-reference-contract.ts`, `us-dataset-reference-seed.ts`, `us-dataset-reference-verify.ts`; create `apps/api/test/us-dataset-reference-contract.test.ts`, `apps/api/test/us-dataset-reference-seed.e2e.test.ts`.

**Consumes:** Task 1 exact reader; existing `runAtomicStage(context, datasetId, expectedRevision, intent, work)`; fixed catalogue/definition and real service transaction methods. **Produces:** the interfaces above, with no public runtime registration.

- [ ] Write pure RED tests using platform-schema-valid evidence built from the fixed catalogue and fixed synthetic UUIDs. Cover all Review Focus 5 codec mutations, valid round-trip, bound failure before parsing and strict canonicalization rejection. Do not require a database for these tests.
- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-reference-contract.test.ts`; confirm missing exported parser is RED. Implement strict parser and rerun GREEN. Test actual service result parsing in configured tests too, not only fixture-shaped output.
- [ ] Write configured RED tests using `createUsDatasetJournalFixture(base)`, actual owner/profile provisioner and actual `usSixMonthDefinition`. Assert exact counts, keys, relationships, profile revision/reviewer, real service timestamps and all audit fields. Do not fabricate business rows through SQL.

```ts
const seed = new UsDatasetReferenceSeedStore(fixture.db);
const first = await seed.initialize(context);
expect(first.bindings.parties).toHaveLength(23);
expect(first.bindings.locations).toHaveLength(23);
expect(first.bindings.products).toHaveLength(16);
expect(first.evidence.profiles).toHaveLength(16);
const before = await fixture.snapshot();
expect(await new UsDatasetReferenceSeedStore(fixture.db).verify(context)).toEqual(first);
expect(await new UsDatasetReferenceSeedStore(fixture.db).initialize(context)).toEqual(first);
expect(await fixture.snapshot()).toEqual(before);
```

- [ ] Implement orchestration: initialize guarded header; exact-read `references/references`; capture one random UUID intent before work if absent. On only `us_dataset_intent_conflict`, guarded reread may use the winner iff full canonical reference input matches. Never adopt another unit/recipe or swallow driver/authorization errors. Use persisted intent/revision in `runAtomicStage`.
- [ ] Apply freshness check immediately inside the supplied stage transaction over tenant-scoped parties, locations, products, profiles and documents; archived and identically named unknown records conflict too. Then call native party creates, location creates with receipt-owned parent IDs, product creates and profile puts, in catalogue order. Every requestId is the persisted operationKey; no nested pool-backed commands. Build result from returned service evidence, flatten recordIds parties→locations→products, calculate resultDigest and return receipt.

```ts
return {
  recordIds: [
    ...result.bindings.parties.map(({ id }) => id),
    ...result.bindings.locations.map(({ id }) => id),
    ...result.bindings.products.map(({ id }) => id),
  ],
  resultDigest: canonicalExportDigest(result),
  result,
};
```

- [ ] Implement mandatory verifier: exact stage/input identity, bounded result codec, recordIds order and resultDigest; compare intended normalized facts to saved evidence and each current service getter response. Require unarchived records, owned parent relationships, profile revision 1, actual actor/review timestamp and unchanged saved creation/update times. Translate missing-record NotFound and malformed service evidence to scoped mismatch; other failures propagate. Lock owned parties, locations and products by sorted ID with tenant-scoped `FOR SHARE` before their comparisons, in that fixed table order; profile getter already share-locks the product. Do not lock or count independent later references during replay. Tests must exercise concurrent edit vs verification and ensure the operation either verifies the locked state or reports drift; this is not a promise of permanence after transaction completion.
- [ ] Implement verify as read-only orchestration: absent header/receipt yields incomplete without capture/initialize. For a committed stage call runAtomicStage with an apply callback that throws incomplete and the same mandatory verifier; return parsed receipt result. No repair path.
- [ ] Add Review Focus 1–4 configured tests: overlapping calls, fresh-store/lost-reply replay, owner revocation, wrong database/tenant/provenance, unknown first-apply records, changed/archived/missing own records, forged/cross-tenant bindings, and independent added references. Assert snapshots and precise errors. Tamper SQL is test-only and cannot become orchestration SQL.
- [ ] Inject native write/audit failure midway, canonical verification failure and final receipt-update failure using test-only database triggers/actual transaction seams. Capture intent first; snapshot then failing attempt must be byte-identical, with pending intent retained. Remove only fixture trigger and rerun; same operationKey must succeed. Assert exact tenant, actor, action, target, outcome, requestId and before/after for each native audit record, including profile coverage-change rows rather than audit count alone.
- [ ] Run pure/configured new suites plus dataset journal/atomic and compact reference/native transaction regressions. Verify successful receipt fits 256 KiB. Independently review Task 2 before workflow changes.

## Task 3: Check-only ownership and factual evidence

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.

- [ ] Add failing parsed workflow mutation tests for absent/duplicated new configured suite, a guarded/continue-on-error owner step, wrong database variable and execution before dependency builds. Preserve existing exact two-file dataset-progress owner step; add the reference seed suite to the existing reference-service disposable-database owner, extending its ownership assertions without relaxing prior checks.
- [ ] Add pure contract suite to the existing pure API test owner once. Add configured seed suite once to the reference-service owner; retain fixture-only US_TEST_DATABASE_URL, no DATABASE_URL fallback and `--maxWorkers=1`. No release/publish/automatic tenant initialization workflow changes.
- [ ] Run `node --test tools/us-development/test/isolation.test.mjs` and `node tools/us-development/check-isolation.mjs`. Update factual docs: shared catalogue orchestration implemented and fixture-verified; no chain documents/events/cases/corrections/Plan/Request orchestration, full-volume or browser/hosting acceptance.
- [ ] Before configured fixtures, run API build, typecheck and lint with declared toolchain. Then run focused pure/configured reference, dataset and compact regression suites, zero database skips required for acceptance. Never build while fixtures are live. Verify each child database is disposed.
- [ ] Run API package test with both database variables unset and retain exact failures/skips separately. The prior full API gate was not green: eight files had failed nested suites, with missing auth/origin variables established only for billing. Matching paths or a focused green run do not establish other causes. Do not weaken tests/timeouts or silently label the full gate harmless.
- [ ] Run scoped Prettier check, `git diff --check`, check-only isolation and independent Task 3 review, then whole-increment review against original byte checkpoint. Report behavior/areas, configured and unconfigured checks, and unrun external gates. No commit/push/cleanup.

## Self-review and handoff

The plan implements only the shared-reference portion of spec sections 1–4. Dates, manifest/recipe identity, target provenance, bounds, canonical replay, real clocks and no-adoption constraints remain pinned. Chain stages and document creation, corrections, boxes, artifacts, overall dataset acceptance and viewer/hosting remain separate increments, not implied deliverables here.

All five Review Focus conditions have Task 1/2 tests; Task 3 pins execution ownership. Interfaces use actual journal contracts and native transaction services; the exact reader is a scoped internal extension, not new HTTP access. No schema or compact behavior changes are needed. Preserve the separate implementer/reviewer method after written-plan approval.
