# US-04 Transformation Rules, Storage, and Original Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a server-verified original Transformation CTE that turns two received FTL lots into one newly assigned output lot, freezes its evidence, and records directed genealogy without any cases or Station dependency.

**Architecture:** Extend the existing shared `traceability_events` shell with typed Transformation detail, input, output, document, operation and genealogy tables. Keep deterministic draft/readiness rules in `@markiro/domain`, strict wire/snapshot contracts in `@markiro/platform-contracts`, and transactional authorization, reference resolution, idempotency and finalization in a new U.S.-only API module. This plan enables original draft → finalized only; revision amendments, void, active traversal, case links, HTTP/UI and release are separate approved stages.

**Tech Stack:** Node 24+, repository-declared pnpm/Corepack, TypeScript, Zod, Drizzle ORM, PostgreSQL, NestJS, Vitest. No new dependencies.

**Spec:** [Approved US-04 design](../specs/2026-09-26-us-04-transformation-current-design.md). Also read [MVP contract](../../us/mvp-contract.md), especially sections 4–5, and [US requirements](../../us/requirements.md#trn--transformation-cte).

## Global Constraints

- Work only in the existing `codex/us-mvp` worktree; preserve its dirty US-03 CSV and completed US-04 foundation changes. Run `git status --short` first and inspect the migration journal. At planning time `0130_us_shared_event_date` is last; choose `0131` only if still free.
- No commit, push, PR, merge, deploy, release, infrastructure provisioning or change to the primary RU checkout without separate user authorization. Each task has a scoped diff/review checkpoint in place of an automatic commit.
- The sole physical business date is `traceability_events.event_date`; Receiving's public/snapshot `dateReceived` remains unchanged. Transformation exposes `eventDate` and retains the captured IANA `timeZone`. Do not infer a civil date from `finalized_at`.
- Exact quantities are validated decimal strings plus explicit `UOM_CODES_V1`; no binary floats, rounding or implicit mixed-unit balance. `500 lb + 500 lb → 100 case` is valid and does not assert mass equivalence.
- Output TLC source is the actual processor location, not a URL or a client-supplied alternative. Original finalization creates output lots with `assignmentBasis='transformation'`; draft output lot IDs are server-assigned and not client-provided.
- FTL inputs must have a current finalized Receiving or Transformation origin, resolved same-tenant product/TLC/source and reviewed coverage. A manually imported lot or merely `active` status is not origin evidence. Non-FTL input is represented without a fabricated TLC; its zero-FTL finalization fixture belongs to the next revision/genealogy plan.
- A finalized event and its snapshot/children are immutable. Failed audit, operation receipt, lot creation or edge insertion rolls back the whole transaction. Never change RU `boxes`, `box_items`, Station, scanning or printing.
- Use only the documented isolated `US_TEST_DATABASE_URL` fixture, from the package working directory so its relative migrations path resolves into this worktree. Never migrate the shared `markiro_us_dev` base, load the primary `.env` or count a skipped DB test as passing. Build changed `@markiro/db`, `@markiro/domain` and contracts before API tests.

## Review Focus

- A wrong-tenant or Receiving event ID at a Transformation command must be a safe not-found/denial, never cross-type data or a 503 caused by a valid Receiving row.
- An incomplete or unknown/exemption-pending coverage profile, missing input origin or source, archived processor location, or duplicate input lot must block finalization with a stable issue code.
- Concurrent same-key/same-payload commands must return one durable result; same key/different payload, stale draft version and changed readiness digest must conflict without partial rows.
- A mixed-unit 2→1 event must retain three exact quantity/UOM pairs and two edges, without inventing a converted balance or a case count.
- Direct SQL must reject a Transformation child attached to Receiving, a cross-tenant lot/document, and any post-finalization rewrite of event, detail, lines, documents, snapshot or edges.

---

## File responsibilities and dependency order

1. `packages/domain/src/traceability/transformation-readiness.ts` owns deterministic field/completeness rules; tests in `packages/domain/test/us-transformation-readiness.test.ts`. It consumes resolved facts, never a database or permissions.
2. `packages/platform-contracts/src/traceability/transformation-{draft,readiness,records}.ts` owns strict draft/command/readiness/snapshot schemas; one focused test per file. Its index exports are additive and U.S.-only.
3. `packages/db/src/schema/traceability-transformation.ts` owns typed detail/line/document/counter/operation/edge tables. `traceability-receiving.ts` and `traceability-transformation-roots.ts` change only for original Transformation finalization. Migration `0131_us_transformation_original.sql` plus journal/snapshot and focused fresh/upgrade tests own physical behavior.
4. `apps/api/src/modules/traceability/transformation/` owns internal store, draft commands, reference facts/readiness, snapshot and finalization modules. Existing Receiving modules remain untouched unless a focused regression proves a required compatibility fix. No controller/module registration in this plan.
5. Add the new focused suites to the isolated `.github/workflows/us-development.yml` test lists and `tools/us-development/test/isolation.test.mjs`; preserve pre-existing CSV entries and release locks.

The following task interfaces are binding for adjacent implementers. Do not rename a produced type or function in a later task without updating this plan and the prior task's tests.

### Task 1: Deterministic rules and strict contracts

**Files:** Create `packages/domain/src/traceability/transformation-readiness.ts`, `packages/domain/test/us-transformation-readiness.test.ts`, `packages/platform-contracts/src/traceability/transformation-draft.ts`, `transformation-readiness.ts`, `transformation-records.ts` and matching contract tests; add explicit exports to the two package indexes.

**Interfaces:** The domain exports `TransformationDraftValue`, `TransformationReadinessInput`, `TransformationIssue`, `TRANSFORMATION_READINESS_RULE_VERSION = 'transformation-readiness-v1'` and `assessTransformationReadiness(input: TransformationReadinessInput): TransformationIssue[]`. Contracts export `TransformationDraft` inferred from `transformationDraftSchema`, plus `createTransformationDraftSchema`, `saveTransformationDraftSchema`, `finalizeTransformationSchema`, `transformationReadinessSchema`, `transformationDraftRecordSchema` and `transformationFinalizedRecordSchema`. The Zod draft must structurally satisfy the domain value type without a domain-to-contracts import. Draft lines are discriminated by `kind`; input FTL lots carry `lotId`, non-FTL inputs carry `productId`, `sourceLocationId` and `reference`, and neither client input nor output carries an output `lotId`. Draft replacement uses explicit nulls for incomplete fields.

```ts
type TransformationDraftValue = {
  eventDate: string | null;
  processorLocationId: string | null;
  reason: "commingling_and_repacking" | "repacking" | "relabeling" | "processing" | "other" | null;
  reasonNote: string | null;
  notes: string | null;
  inputs: Array<
    | {
        kind: "ftl_lot";
        lotId: string | null;
        quantity: string | null;
        unitOfMeasure: TraceabilityUom | null;
      }
    | {
        kind: "non_ftl";
        productId: string | null;
        sourceLocationId: string | null;
        reference: string | null;
        quantity: string | null;
        unitOfMeasure: TraceabilityUom | null;
      }
  >;
  outputs: Array<{
    productId: string | null;
    tlc: string | null;
    quantity: string | null;
    unitOfMeasure: TraceabilityUom | null;
  }>;
  documentIds: string[];
};
type TransformationIssue = {
  severity: "error";
  group: "event" | "inputs" | "outputs" | "documents";
  line: number | null;
  field: string;
  code: string;
  detail: string | null;
};
type TransformationReadinessInput = {
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  draft: TransformationDraftValue;
  products: readonly {
    id: string;
    archived: boolean;
    coverage: CoverageReviewRecord;
    descriptionReady: boolean;
  }[];
  locations: readonly {
    id: string;
    roles: readonly string[];
    archived: boolean;
    descriptionReady: boolean;
  }[];
  lots: readonly {
    id: string;
    productId: string;
    tlc: string | null;
    sourceResolved: boolean;
    currentOrigin: boolean;
  }[];
  documents: readonly { id: string; archived: boolean; type: string; number: string }[];
};
```

- [ ] **Step 1: Write failing tests.** Assert strict schemas reject JSON number quantities, hidden extra keys, duplicate document IDs, duplicate FTL lot IDs and supplied output `lotId`; retain opaque TLC characters while using existing `tlcSchema` limits. Domain tests assert stable ordered issues for missing date/location/reason/docs, unknown coverage, unresolved source/origin, non-positive/overprecise quantity, duplicate FTL inputs and empty output. Assert complete `500 lb`, `500 lb` → `100 case` has no balance error, and a documented non-FTL input does not require a TLC.
- [ ] **Step 2: Run focused tests red:** `corepack pnpm --filter @markiro/domain exec vitest run test/us-transformation-readiness.test.ts` and `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-transformation-draft.test.ts test/us-transformation-readiness.test.ts test/us-transformation-records.test.ts`. Expected: missing exports/rules, not dependency or environment errors.
- [ ] **Step 3: Implement schemas and pure rule.** Reuse `traceabilityCivilDateSchema`, `traceabilityQuantitySchema`, `UOM_CODES_V1`, `tlcSchema`, `platformUuidSchema` and `assessCoverageReview`. Keep draft parsing structural/incomplete; readiness requires current `US_FSMA204_PROCESSOR` profile, reviewed FTL input and output coverage, reviewed `not_covered` coverage for non-FTL inputs, active products, real processor role and complete description, nonempty reference documents, valid source/origin for every FTL lot, at least one output, and line quantities/UOM. Task 3 must resolve each product's actual persisted `CoverageReviewRecord` plus archived state under the same consistent read as other facts; no synthetic reviewer, URL or timestamp is allowed. Sort issues by group, line, field and code. Contract readiness includes `state: 'complete' | 'incomplete'`, `ruleVersion`, `expectedDraftVersion`, `inputDigest` and issues. Snapshot v1 carries immutable event identity/date/timezone, processor and document descriptions, reason, input lot/product/TLC/source descriptions with exact quantities, output lot/product/TLC/source descriptions with exact quantities, actor and finalization instant. Use `.strict()` at command/record boundaries.
      The abbreviated snapshot interface includes each input/output product's actual complete `CoverageReviewRecord` and a discriminated source identity: `location` retains location ID/description; `reference` additionally retains the FTL input lot's exact reference kind/value and resolved location ID/description. Finalization and operation replay must preserve these reviewed values even after a later coverage review. See Task 4 for the exact field list and deferred DB projection guard.
- [ ] **Step 4: Run focused suites green, then domain/contracts test, typecheck, lint and build.** Confirm no RU or Receiving export changed. Record exact checks and `git diff --check`.
- [ ] **Step 5: Scoped review checkpoint.** Review issue order, quantities, non-FTL absence of TLC, public-versus-server-only IDs, and frozen snapshot schema; no DB/API work in this task.

### Task 2: Typed storage and original-finalization transition

**Files:** Create `packages/db/src/schema/traceability-transformation.ts`, migration `packages/db/migrations/0131_us_transformation_original.sql` and matching snapshot; modify `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/traceability-receiving.ts`, `packages/db/src/schema/traceability-transformation-roots.ts` and migration journal. Create `packages/db/test/us-transformation-schema.test.ts` and `packages/db/test/us-transformation-original-migration.e2e.test.ts`.

**Interfaces:** Export `transformationEventDetails`, `transformationEventInputs`, `transformationEventOutputs`, `transformationEventDocuments`, `transformationCounters`, `transformationOperations` and `lotGenealogyEdges`. All child rows have `tenantId` plus `eventId`; a generated constant `eventType='transformation'` (or an equivalently enforced type column) participates in the FK to `traceabilityEvents(tenantId,id,type)`. Inputs use `lineNo` and `kind`; `lotId` is only for FTL rows, while non-FTL rows have `productId`, `sourceLocationId` and `reference`. Outputs have nullable `lotId` while draft and require the bound same-tenant lot when finalized. Documents have ordered positions. Genealogy edges pin the exact event revision and both same-tenant lot IDs. Operations store one immutable result per `(tenantId,command,operationKey)`.

```sql
-- The migration replaces, rather than edits, the 0129 draft-only guards.
-- Finalized original: revision=1, no predecessor, event_date and location_id
-- present, finalized_at/by and object snapshot present, pending_draft_id=NULL,
-- current_event_id=id. Draft original retains pending_draft_id=id.
CHECK (type <> 'transformation' OR
  (revision=1 AND root_event_id=id AND previous_revision_id IS NULL
   AND status IN ('draft','finalized')));
-- A typed child cannot attach to a Receiving header even if its UUID exists.
FOREIGN KEY (tenant_id,event_id,event_type)
  REFERENCES traceability_events (tenant_id,id,type);
```

- [ ] **Step 1: Write failing schema and fresh/upgrade migration tests.** Assert all seven tables, tenant-composite FKs and indexes exist. Seed a finalized Receiving v1/v2/v3 history before upgrade; compare its event/child/root rows and frozen snapshot bytes afterward. Assert direct SQL rejects cross-tenant inputs/outputs/documents/edges, wrong-type parent IDs, duplicate input lot or output lot in one event, a root pointer to another event, and a finalized Transformation with missing date/location/snapshot. Assert a raw finalized original can commit only when root current/pending pointers agree and typed detail/children exist.
- [ ] **Step 2: Run tests red from `packages/db` using isolated `US_TEST_DATABASE_URL`.** Expected failure: absent Transformation relations/finalized transition, not a missing fixture DB or a skip.
- [ ] **Step 3: Implement 0131 and schema.** Do not alter 0129/0130. Add tenant-scoped detail/line/document/counter/operation/edge tables and generated/checked Transformation parent type. Relax only the Transformation arm of `traceability_events_lifecycle_valid` to allow original finalization; keep Receiving arm byte-equivalent. Make `transformation_event_roots.pending_draft_id` nullable and replace `transformation_roots_draft_only`, `transformation_root_identity_guard` and `transformation_root_consistency_guard` with draft-or-finalized original predicates. Add header and child write guards: after finalization, only a future explicit lifecycle migration may change the row; UPDATE/DELETE of detail, lines, documents and edges fails. Header finalization guard validates snapshot v1 header identity/date/timezone/reason and ordered line IDs/quantities against relational rows. The original event creates no amendment/void path yet.
- [ ] **Step 4: Run focused tests green, DB package test/typecheck/lint/build, then focused Receiving migration/schema regressions.** Inspect SQL lock scope, index uniqueness, deferred FK behavior and `pg_get_functiondef` of active guards. A deliberate bad snapshot must fail at commit. An unrun DB case is not green.
- [ ] **Step 5: Scoped review checkpoint.** Inspect `git diff --check`, migration/journal/snapshot, Receiving byte comparison and table type/tenant boundaries; do not change shared production migration history.

### Task 3: Authorized draft, save, read and readiness commands

**Files:** Create focused modules `apps/api/src/modules/traceability/transformation/us-transformation-{store,draft,operations,persistence,reference-context,readiness}.ts` and `apps/api/test/us-transformation-draft.e2e.test.ts`, `apps/api/test/us-transformation-readiness.e2e.test.ts`. Use existing test support from `apps/api/test/support/us-profile-database.ts`; add a Transformation fixture beside it if needed.

**Interfaces:** `UsTransformationStore` has `createDraft(tenantId,actorUserId,input,requestId)`, `saveDraft(tenantId,actorUserId,eventId,input,requestId)`, `getRecord(tenantId,actorUserId,eventId)`, and `checkReadiness(tenantId,actorUserId,eventId,{expectedDraftVersion})`. These are internal methods, not registered HTTP routes. `createTransformationDraftSchema` is `{operationKey: UUID,draft: TransformationDraft}`; `saveTransformationDraftSchema` adds `expectedDraftVersion: positive integer`; `finalizeTransformationSchema` (Task 4) has `operationKey`, `expectedDraftVersion` and `expectedInputDigest`. Store returns contract-validated records/receipts.

```ts
const digest = sha256(
  JSON.stringify({
    commandVersion: 1,
    command: "transformation.save",
    eventId,
    input,
  }),
);
// Authorize current membership/profile before command parsing and before replay.
// Lock (tenantId,command,operationKey), compare stored digest, then lock root.
// Save is a full draft replacement and increments draftVersion exactly once.
```

- [ ] **Step 1: Write failing DB-backed API tests.** Exercise `traceability_production` create/save/read, unauthorized role, absent or RU profile, wrong-tenant/wrong-type safe ID, incomplete draft creation, ordered input/output/document round-trip, `TRN-YY-NNNN` counter allocation, exact create/save audit fields, replay same key/payload, same key/different payload conflict, stale version conflict and two concurrent saves with one winner. Test a draft read with another valid Receiving in the tenant.
- [ ] **Step 2: Run red tests with isolated URL from `apps/api` after building changed packages.** Expected failure: missing Transformation store; do not accept a skipped test or stale package `dist`.
- [ ] **Step 3: Implement minimal internal commands.** Reuse `authorizeUsMasterData` with `US_CAPABILITY.TRANSFORMATION_WRITE` for create/save and `READ` for get/readiness. Parse only after authorization. Capture organization profile timezone at create; number from a tenant/year counter, never from client. The create digest includes command version/name and draft but no yet-unallocated event ID; save/finalize digests include their target event ID. Use a repeatable-read transaction, stable operation digest and advisory-key lock, then root lock and draft-version compare. Create header/root/typed children and exact audit atomically; save replaces children only while draft and increments version. Fail closed on missing/corrupt typed roots; wrong-type/foreign-tenant ID uses one safe not-found. Use the established retry policy for `40001`/`40P01` and invisible receipt races, reauthorizing on every retry. Readiness reloads product/coverage/lot/source/location/document rows and current origin evidence in one consistent view, calculates a SHA-256 over rule version, draft version and a canonical ID-sorted projection of the resolved facts, and returns deterministic issues. Do not let a user-supplied lot status or coverage verdict substitute for server facts.
- [ ] **Step 4: Run focused tests green and API test/typecheck/lint/build.** Assert full transaction rollback on an injected audit failure, exact audit actor/tenant/action/target/result, and no rows leaked after denied operations. Build DB/domain/contracts before consumer tests.
- [ ] **Step 5: Scoped review checkpoint.** Inspect authorization order, replay/stale semantics, safe error shapes, draft incompleteness, deterministic digest and no HTTP registration.

### Task 4: Atomic 2→1 original finalization and pinned evidence

**Files:** Create `apps/api/src/modules/traceability/transformation/us-transformation-{finalization,snapshot}.ts`, extend `us-transformation-store.ts`, and add `apps/api/test/us-transformation-finalization.e2e.test.ts`, `apps/api/test/us-transformation-finalization-concurrency.e2e.test.ts`. Extend Task 2's migration test for post-finalization immutability. Update only isolated U.S. CI test lists and their test-list contract to own the new suites.

**Interfaces:** `UsTransformationStore.finalize(tenantId,actorUserId,eventId,input,requestId): Promise<TransformationFinalizedRecord>`. Finalization consumes Task 3's `TransformationReadiness` and produces a v1 immutable snapshot. Every input and output `product` includes the actual locked `coverage` review: `coverageStatus`, `coverageRationale`, `ftlCategory`, `ftlSourceUrl`, `ftlSourceVersion`, `reviewedBy` and `reviewedAt`. Each `source` is discriminated by `kind`: `location` retains its `id` and description; an FTL input's `reference` retains the resolved location `id` and description plus exact `referenceKind` and `referenceValue`. Outputs and non-FTL inputs have location sources only. No coverage or source evidence is fabricated or supplied by the finalization client. The deferred SQL finalization guard compares these immutable fields with authoritative product reviews and line/lot source facts at commit; later master-data edits never rehydrate historical evidence. For each FTL input lot, insert one `lot_genealogy_edges` row to each output lot; for the 2→1 fixture this is exactly two edges. A non-FTL input has no lot edge and no invented TLC. This task tests a 2→1 finalization; 2→2, zero-FTL-input finalization, amendment/void and current-versus-pinned traversal are explicit next-plan gates.

```ts
// Within one repeatable-read transaction:
// 1. authorize QA_MANAGE; parse; lock key; replay only matching digest;
// 2. lock root, then unique input lot IDs in ascending UUID order;
// 3. re-read authoritative facts and current origin; compare draftVersion/digest;
// 4. freeze snapshot, create output lot(s) with source=processor location;
// 5. bind output lot IDs, insert input→output edges, finalize header/root;
// 6. insert exact event/lot audit and durable operation result; commit.
```

- [ ] **Step 1: Write failing finalization tests.** The synthetic `500 lb` + `500 lb` received-lot fixture produces one `100 case` output lot with a new TLC assigned at the processor location, exactly two directed edges and no case/SSCC/shift rows. Assert snapshot v1 freezes product, processor, input TLC/source, output TLC/source, reference document type/number, reason, quantities, event date, IANA zone and actor. Changing master data or tenant zone afterward leaves the pinned snapshot unchanged. Assert source conflict, unknown coverage, absent current origin, changed readiness digest, stale draft, wrong tenant, duplicate operation key with different body, concurrent same-key finalization, and audit failure all leave no partial output/edge/finalized header. Assert direct SQL cannot rewrite finalized evidence and Receiving still finalizes in a tenant containing this Transformation.
- [ ] **Step 2: Run red tests with isolated URL from `apps/api`.** Expected failure: no finalize command and draft-only DB guard.
- [ ] **Step 3: Implement finalizer and snapshot.** Use `QA_MANAGE` for finalize and reauthorize on replay. Lock root and sorted affected lots; resolve current finalized Receiving or Transformation origin, reviewed FTL coverage, active complete processor location and document descriptions. Compare both expected draft version and exact readiness digest under lock. Create output lots with `assignmentBasis='transformation'`, `sourceLocationId=processorLocationId` and permanent source lock; reject existing TLC/source identity rather than reusing a lot. Persist output IDs in event output rows and exact revision-attributed edges. Freeze the contract-validated snapshot, set status/finalization fields and root current/pending pointers, then exact event/lot audit and operation result in the same transaction. A failed insert or audit must reject and roll back. No status-clearing or mixed-unit arithmetic.
- [ ] **Step 4: Run targeted tests green and package gates.** Run DB build, API focused finalization/readiness/Receiving coexistence tests, then DB/domain/contracts/API test/typecheck/lint/build and `corepack pnpm format:check`. Run `node --test tools/us-development/test/isolation.test.mjs` and verify the new suites are in `.github/workflows/us-development.yml` without enabling release jobs. Record infrastructure skips and full API initialization failures separately.
- [ ] **Step 5: Whole-stage review.** Have an independent reviewer inspect the scoped complete diff against this plan/spec, replay and tenant denial, exact audit/rollback, immutable snapshot/edges, Receiving regression and release isolation. Run `git diff --check`. Do not claim HTTP/UI, current graph traversal, cases, hosted CI, physical operations, deployment or regulatory acceptance.

## Handoff to later approved plans

The next plan covers Transformation amendment/void, stable output IDs, zero-FTL-input→1 and 2→2 finalization, downstream blockers, active-versus-pinned genealogy traversal and mixed-unit balance effects. A subsequent plan covers the synthetic server case/SSCC bridge and EN/ES office workflow. This plan creates no public Transformation route: internal server proof is not a usable office workflow.
