# US-04 Shared Event Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit a typed Transformation draft in the shared event table without changing any existing Receiving history, commands, frozen snapshots or RU behavior.

**Architecture:** Replace the Receiving-only root FK with a same-tenant/same-type self-root FK while retaining enforced type-specific root-pointer tables. Scope Receiving DB guards and API integrity checks to Receiving, then rename the one physical business-date column to `event_date` and preserve the Receiving API mapping. This foundation introduces no Transformation HTTP write route, finalizer, genealogy, case link or UI.

**Tech Stack:** Node >=24, repository-pinned pnpm through Corepack, TypeScript, Drizzle ORM 0.45.2, PostgreSQL, NestJS and Vitest. No new dependencies.

**Spec:** [Approved US-04 design](../specs/2026-09-26-us-04-transformation-current-design.md). Read it and [MVP contract](../../us/mvp-contract.md) before implementation.

## Global Constraints

- Work only in the isolated `codex/us-mvp` worktree. Do not merge, deploy, release, or change the primary RU checkout.
- `0127`/`0128` Receiving CSV migration/schema work is already uncommitted in this worktree. Capture `git status --short` and inspect the migration journal before touching DB files; preserve all existing edits. Choose the next free migration index without rewriting an applied migration or another worker's files.
- A valid Transformation row must not make Receiving unavailable; a corrupt Receiving chain must still fail closed. All tenant/business queries remain tenant-scoped.
- Keep Receiving `dateReceived` in public contracts and frozen JSON. Only the physical `date_received` column becomes `event_date`; no second writable business date.
- Never disable production DB constraints/triggers, migrate a shared DB, or load the primary `.env` for tests. Use only the owned synthetic `US_TEST_DATABASE_URL` test harness. A skipped DB suite is not a pass.
- No Station, RU boxes, physical cases, public deployment, dependency updates, or release workflow changes.
- No commit or push without separate user authorization. Each task ends with a scoped diff/review checkpoint instead of an automatic commit.

## Review Focus

- A Transformation draft in the same tenant must not turn Receiving readiness, basis, amend, void or save into a 503.
- A Receiving revision must not reference a Transformation root, and a Transformation revision must not reference a Receiving root, even when the root UUID is otherwise valid.
- A Receiving item, document or operation must not attach to a Transformation header through its existing event FK.
- Old Receiving v1/v2/v3 finalized snapshots must remain byte-identical after the date rename, and new legacy-version guard checks must still reject corrupt finalization.
- Wrong-type or foreign-tenant event IDs at Receiving routes must not leak the other event and must not be reported as database corruption.

---

## File responsibilities

- `packages/db/src/schema/traceability-receiving.ts`: shared header mapping, conditional typed-root keys/FKs, preserved Receiving tables and checks.
- `packages/db/src/schema/traceability-transformation-roots.ts`: minimal Transformation root identity and pending/current pointers. Export from `packages/db/src/schema.ts` and include in `packages/db/drizzle.config.ts`. No Transformation details/lines yet.
- `packages/db/migrations/<next>_us_shared_event_foundation.sql` plus matching journal/snapshot: typed roots and draft-only slot, preserving old rows and snapshot bytes.
- `packages/db/migrations/<following>_us_shared_event_date.sql` plus matching journal/snapshot: physical date rename and active guard rebinding. These are two sequential migrations, not edits to one already-applied migration.
- `packages/db/test/us-shared-event-foundation-migration.e2e.test.ts`: pre/post upgrade, raw constraint and guard checks, synthetic Transformation draft.
- `packages/db/test/us-shared-event-foundation-schema.test.ts`: Drizzle names, type-conditional generated columns and FKs.
- `apps/api/src/modules/traceability/receiving/us-receiving-{basis,revision-readiness,amendment-save,lifecycle,persistence}.ts`: remove tenant-global non-Receiving scans, keep root-scoped corruption detection, return a safe not-found for wrong-type IDs.
- `apps/api/test/us-receiving-shared-event-compatibility.e2e.test.ts`: store-level and HTTP boundary regression with a synthetic same-tenant Transformation draft.

Do not add a generic event service to solve this foundation; the Transformation command layer is a later plan. Do not refactor Receiving snapshots or digest algorithms.

## Test environment

Use `corepack pnpm` and the existing synthetic database harness `createUsProfileTestDatabase`. The harness owns a random database and removes it after the test. Set `US_TEST_DATABASE_URL` only to the approved local synthetic PostgreSQL server. Build `@markiro/db` before API tests because consumers import its compiled `dist` output. Check `packages/db/drizzle.config.ts` before generation; partitioned tables are intentionally excluded. If a graph exists at execution time, query it first and run `graphify update .` after code edits.

### Task 1: Type-safe shared root and draft-only Transformation slot

**Files:** `packages/db/src/schema/traceability-receiving.ts`, new `packages/db/src/schema/traceability-transformation-roots.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, new migration/journal/snapshot and two new DB tests above.

**Interfaces:** A synthetic Transformation original has `type='transformation'`, `status='draft'`, `revision=1`, `root_event_id=id`, a `TRN-YY-NNNN` event number and a matching `transformation_event_roots` row with `pending_draft_id=id`. No finalized Transformation is legal in this task. `traceability_events` continues to expose the same Drizzle `traceabilityEvents` export.

The central FK/typed-root DDL shape is:

```sql
ALTER TABLE traceability_events
  ADD CONSTRAINT traceability_events_tenant_id_type_uq UNIQUE (tenant_id, id, type);
ALTER TABLE traceability_events
  ADD CONSTRAINT traceability_events_typed_root_fk
  FOREIGN KEY (tenant_id, root_event_id, type)
  REFERENCES traceability_events (tenant_id, id, type)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE traceability_events
  ADD COLUMN receiving_root_key uuid GENERATED ALWAYS AS
    (CASE WHEN type = 'receiving' THEN root_event_id END) STORED;
ALTER TABLE traceability_events
  ADD COLUMN transformation_root_key uuid GENERATED ALWAYS AS
    (CASE WHEN type = 'transformation' THEN root_event_id END) STORED;
```

The migration must drop the old `traceability_events_root_fk` before adding its replacement, attach the two generated keys to their matching root tables with deferred tenant-composite FKs, and include the type-scoped lifecycle/number constraints and triggers described below. The SQL above is the required relationship, not a license to omit the surrounding checks.

- [ ] **Step 1: Write the failing migration/schema tests.** Start from the current journal's last committed/migrated entry. Seed original and amended/finalized Receiving specimens using the existing `us-receiving-snapshot-fixture`; capture sorted `to_jsonb` event, root, item, document and operation rows and `finalization_snapshot::text`. Assert unchanged bytes after migration except newly generated columns. Add raw SQL assertions that a valid Transformation draft commits, a cross-type or cross-tenant root fails with `23503`, a missing typed root fails at commit, a second pending draft per root fails, and attaching each Receiving child kind to the Transformation header fails with `23514` or `23503`. Add a DB schema test for the self-FK and typed-root FKs.
- [ ] **Step 2: Run the new DB tests and record the expected red failures.** `US_TEST_DATABASE_URL=... corepack pnpm --filter @markiro/db exec vitest run test/us-shared-event-foundation-migration.e2e.test.ts test/us-shared-event-foundation-schema.test.ts`; expected failure is absent Transformation storage/constraints, not a connection or missing `dist` error.
- [ ] **Step 3: Implement the smallest schema/migration.** Keep the existing Receiving lifecycle predicate as the Receiving arm of `traceability_events_lifecycle_valid`; add a Transformation arm permitting only an original draft with no finalization/void/supersession fields. Make event number validation type-specific (`REC-...` versus `TRN-...`). Add `UNIQUE (tenant_id,id,type)` and a `DEFERRABLE INITIALLY DEFERRED` self-FK `(tenant_id,root_event_id,type) -> (tenant_id,id,type)`. Keep `receiving_event_roots` intact; replace the old direct root FK with a generated Receiving-only root key and composite FK to it. Add a generated Transformation-only root key and FK to new `transformation_event_roots`. The new root table has tenant/id/event number, positive lifecycle version, next revision and pending/current pointers, but only original-draft creation is enabled in this task. Type-scope Receiving header triggers; retain their exact checks for Receiving. Add an explicit all-event delete/identity guard and reject Receiving item/document/operation rows whose parent `type` is not `receiving`. Keep a deferred consistency check that verifies each type-specific root points at its own original draft.
- [ ] **Step 4: Run the two new DB tests to green, then the existing Receiving migration/schema suites.** Inspect the generated SQL, Drizzle snapshot and journal diff. Specifically compare v1/v2/v3 snapshot bytes and verify existing Receiving create/finalize/amend/void still work. Do not weaken any old assertion to accommodate Transformation.
- [ ] **Step 5: Review checkpoint.** Record migration lock scope, rollback/recovery implications, generated-column behavior on the actual PostgreSQL test version, and `git diff --check`. Review only Task 1's paths; do not stage unrelated US-03 CSV changes.

### Task 2: Single authoritative `event_date` with Receiving compatibility

**Files:** extend `packages/db/src/schema/traceability-receiving.ts`; create a second, sequential date migration/journal/snapshot; extend `packages/db/test/us-shared-event-foundation-migration.e2e.test.ts`; modify `apps/api/src/modules/traceability/receiving/us-receiving-{draft-create,persistence,revision-finalization,snapshots,registry,history,store}.ts` only where the physical field mapping is used; add a focused Receiving date-compatibility API test.

**Interfaces:** Database header has one physical `event_date date`; the Receiving API and saved `finalization_snapshot` still use `dateReceived`. Drizzle may retain a `dateReceived` property mapped to `event_date` for Receiving call-site compatibility, but Transformation will use the same physical column. No independently writable `date_received` remains.

```sql
ALTER TABLE traceability_events RENAME COLUMN date_received TO event_date;
```

```ts
dateReceived: date("event_date", { mode: "string" }),
```

- [ ] **Step 1: Extend the upgrade test to fail on the old column.** Assert `event_date` exists and `date_received` does not; compare pre/post civil dates and frozen JSON exactly. Exercise the active v1, v2 and v3 Receiving finalization guards with valid and deliberately corrupted snapshots after migration. Add leap-day and zone-change fixtures proving the civil date stays unchanged.
- [ ] **Step 2: Run the targeted test red.** The expected failure is the missing `event_date` column or stale SQL guard reference.
- [ ] **Step 3: Rename, rebind and map.** In the second reviewed migration use `ALTER TABLE traceability_events RENAME COLUMN date_received TO event_date`; update the Drizzle physical mapping and every active SQL CHECK/function reference to `NEW.event_date`. Do not alter frozen `dateReceived` JSON or legacy snapshot validation rules. Adapt any raw SQL tests/queries that address the physical column. Preserve the public Receiving field and its exact value through the existing projection layer.
- [ ] **Step 4: Run targeted DB/API compatibility tests green.** Run DB build first, then focused Receiving readiness/finalization/history tests. Inspect `pg_get_functiondef` for all active Receiving finalization guards and verify no `NEW.date_received` remains. Compare frozen snapshot bytes pre/post.
- [ ] **Step 5: Review checkpoint.** Confirm no second business date was added, no timestamp-to-date conversion was introduced, and `git diff --check` is clean.

### Task 3: Receiving API type isolation

**Files:** the five Receiving API files listed above, new `apps/api/test/us-receiving-shared-event-compatibility.e2e.test.ts`, and focused existing `us-receiving-{basis,revision-readiness,amendment-save,lifecycle,http}.e2e.test.ts` suites.

**Interfaces:** All Receiving reads operate on valid Receiving roots/children only. `readReceivingRecord` returns `NotFoundException` for a valid but wrong-type event ID; it still returns unavailable for malformed Receiving data. `readReceivingBasis` counts Receiving support and does not claim to validate a Transformation origin. Downstream dependency refusal remains conservative until US-04 finalization introduces persisted effects; no code interprets a Transformation row as proof of absent dependencies.

The read boundary should retain the existing not-found error shape:

```ts
if (!header || header.type !== "receiving")
  throw new NotFoundException({ code: "receiving_draft_not_found" });
```

- [ ] **Step 1: Write the failing API tests.** In a synthetic tenant with one valid Transformation draft and one complete Receiving, assert Receiving basis/readiness/save/amend/void remain available and produce the same values/audit as a Receiving-only tenant. Assert wrong-type event ID returns 404 with no Transformation content; foreign-tenant ID returns the same safe boundary. Corrupt one event inside a Receiving chain and assert the existing unavailable result remains. Assert a Transformation draft alone does not create a receiving basis for a lot.
- [ ] **Step 2: Run the focused API test red** after rebuilding `@markiro/db`; the expected failures are the four tenant-global `type <> 'receiving'` checks and the wrong-type 503.
- [ ] **Step 3: Make minimal API changes.** Remove the tenant-global type scans in `us-receiving-basis.ts`, `us-receiving-revision-readiness.ts`, `us-receiving-amendment-save.ts` and `us-receiving-lifecycle.ts`. Keep `assertReceivingRootsReadable` and orphaned Receiving child/root checks at the correct scoped read. Change the wrong-type branch in `us-receiving-persistence.ts` to the same not-found response as an absent Receiving ID. Add explicit type filters only where a query could otherwise return a Transformation header. Do not introduce a Transformation write controller.
- [ ] **Step 4: Run focused and package gates.** `corepack pnpm --filter @markiro/db build`; run the new API test plus affected existing Receiving suites, then DB and API package test/typecheck/lint/build. Run `corepack pnpm format:check` on the final broad diff; inspect CI affected-file mapping. Record any DB suite that skipped for missing `US_TEST_DATABASE_URL`.
- [ ] **Step 5: Final scoped review.** Check `git diff --check`, review the complete three-dot branch diff separately from this task's diff, and confirm no deployment/Station/RU paths changed. Record behavior, test evidence and remaining US-04 plans. Do not commit, push or deploy without a distinct user instruction.

## Handoff to later plans

After this foundation is verified, write separate approved plans for (1) Transformation domain/contracts and atomic finalization, (2) amendment/genealogy/balance effects, and (3) P0 synthetic case bridge plus U.S. office UI/browser acceptance. The foundation's draft-only Transformation slot must not be exposed as a product workflow until its server validator, snapshots and lifecycle commands exist.
