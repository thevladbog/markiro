# US-04 Transformation Revision Lifecycle and Downstream Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal Transformation amendment/void with stable output lots and make Receiving/Transformation origin changes safe against current finalized downstream consumers.

**Architecture:** Preserve the shared event shell, typed Transformation roots/children and immutable per-revision snapshots/edges. Add one cross-CTE lot dependency epoch so repeatable-read commands that race on origin or consumption restart instead of trusting a stale snapshot. First close the existing Receiving void/finalization gap, then enable Transformation revision commands; current/pinned genealogy read services and 2→2/zero-FTL fixtures belong to the next plan.

**Tech Stack:** PostgreSQL 17, Drizzle, NestJS, Zod, Vitest, Node 24, pnpm via Corepack.

**Spec:** [Approved revisions and genealogy design](../specs/2026-09-26-us-04-revisions-genealogy-design.md), [approved parent US-04 design](../specs/2026-09-26-us-04-transformation-current-design.md), [MVP contract](../../us/mvp-contract.md#5-identity-finalization-and-corrections).

## Global Constraints

- Work only in the isolated `codex/us-mvp` worktree; no RU release paths, HTTP/UI enablement, Station, cases/SSCC, deployment or production database.
- Use the next free additive migration after `0131_us_transformation_original.sql`; never rewrite `0129`–`0131` or frozen Receiving/Transformation snapshots.
- Amendment output count/order, lot ID, product, TLC, processor source and assignment basis are immutable. Client draft commands never carry output lot IDs.
- A finalized void preserves output lot identity, operational status, source lock, historical snapshot and edges, but removes current origin. No automatic status transition.
- Commands require current membership/capability/profile authorization before replay, stable operation key/digest, expected versions, exact audit fields and all-or-nothing transactions.
- Every database-backed test uses isolated `US_TEST_DATABASE_URL`; missing infrastructure is a skip/blocker, never a green run. Build changed shared packages before consumer tests.
- A previous step's uncommitted work belongs to this US branch; stage only explicit task files if commit/push is separately authorized. This plan itself does not authorize commit, push or release.

## Review Focus

1. An amendment draft that swaps two otherwise valid output lines must be rejected rather than silently changing lot identities (Task 3 save test).
2. A void racing a new finalized consumer after its snapshot begins must retry or conflict; it must not leave a finalized descendant without current origin (Task 2 concurrency test).
3. A documentary-only amendment with a downstream consumer must preserve the exact current edges/quantities while still freezing a new snapshot (Task 4 test).
4. A cross-tenant or wrong-type event/lot ID must not reveal blocker details or mutate another tenant (Tasks 2 and 4 tests).
5. A failed audit insert, stale version or same-key/different-body replay must roll back pointer, status, epoch and edge changes (Task 4 rollback tests).

## File map and interfaces

- `packages/db/src/schema/traceability-lots.ts`, `traceability-receiving.ts`, `traceability-transformation-roots.ts`, `traceability-transformation.ts`, migration `0132_us_transformation_revisions.sql` and journal/snapshot: dependency epoch, revised Transformation constraints/guards and command values only. Do not alter Receiving's constraint arm.
- `packages/platform-contracts/src/traceability/transformation-records.ts` and new `transformation-lifecycle.ts`: revision-aware records/snapshots and strict amend/void inputs; `packages/domain/src/traceability/transformation-lifecycle.ts`: pure material-change classification and output-identity comparison.
- `apps/api/src/modules/traceability/lots/us-current-consumers.ts`: tenant-scoped blocker query, deterministic lot coordination and dependency-epoch bump shared by both CTEs.
- `apps/api/src/modules/traceability/receiving/us-receiving-lifecycle.ts`, `us-receiving-revision-finalization.ts`, `apps/api/src/modules/traceability/transformation/us-transformation-finalization.ts`: current origin/consumer protection at existing write boundaries.
- `apps/api/src/modules/traceability/transformation/us-transformation-{persistence,draft,snapshot,operations,store}.ts` and new `us-transformation-lifecycle.ts`/`us-transformation-origin.ts`: revision-aware reads, stable output binding, amend/void commands, finalization and explicit current-origin status.
- Focused tests sit beside existing US Transformation and Receiving tests. Add new suites to `.github/workflows/us-development.yml` under the disposable US database job, not any release workflow.

---

### Task 1: Add revision-capable Transformation storage and lot dependency epoch

**Files:** Modify `packages/db/src/schema/traceability-lots.ts`, `traceability-receiving.ts`, `traceability-transformation-roots.ts`, `traceability-transformation.ts`; create `packages/db/migrations/0132_us_transformation_revisions.sql`, metadata snapshot and `packages/db/test/us-transformation-revisions-migration.e2e.test.ts`; extend `packages/db/test/us-transformation-schema.test.ts`.

**Interfaces:** Produce `traceabilityLots.currentDependencyVersion: integer NOT NULL DEFAULT 1` and revised Transformation root/event lifecycle constraints. Existing Receiving original/revision rows and snapshot bytes are unchanged. The epoch is a concurrency marker, not a business status, quantity or audit revision.

- [ ] **Step 1: Write failing schema/upgrade tests.** Extend the migration fixture through `0131` with a finalized 2→1 Transformation and Receiving v1/v2 history. Assert migration preserves serialized pre-existing event/child/root/snapshot rows except the new default epoch. Test direct SQL accepts a matching pending revision 2 and finalized revision 2, rejects mismatched root pointers, wrong tenant/type predecessor, changed output lot identity, duplicate current revisions, finalized child/snapshot rewrite and a revision without immutable evidence. Test epoch positive and max-bound semantics.

```ts
expect(afterReceivingRows).toEqual(beforeReceivingRows);
expect(afterOriginalTransformation.snapshot).toEqual(beforeOriginalTransformation.snapshot);
await expect(
  f.pool.query("UPDATE transformation_event_outputs SET lot_id=$1 WHERE event_id=$2", [
    otherLot,
    finalizedId,
  ]),
).rejects.toThrow();
```

- [ ] **Step 2: Run red with an isolated database.** `US_TEST_DATABASE_URL=<isolated-local-url> corepack pnpm --filter @markiro/db exec vitest run test/us-transformation-revisions-migration.e2e.test.ts test/us-transformation-schema.test.ts`. Expected failure is absent `0132` behavior, not a skipped suite or missing relation.
- [ ] **Step 3: Generate then inspect additive SQL.** Confirm `0132` is still the next free number. Extend only the Transformation branch of `traceability_events_lifecycle_valid`, root CHECK/trigger definitions and operation command CHECK from `0131`; preserve Receiving branch text and all existing Receiving guards. Add `current_dependency_version` and its positive CHECK. Enforce stable output lot/product/TLC/source across revision finalization at the database boundary, including a direct-SQL forged snapshot. Keep historical children/edges immutable.

```sql
ALTER TABLE traceability_lots
  ADD COLUMN current_dependency_version integer NOT NULL DEFAULT 1;
ALTER TABLE traceability_lots
  ADD CONSTRAINT traceability_lots_current_dependency_version_positive
  CHECK (current_dependency_version > 0);
ALTER TABLE transformation_operations
  DROP CONSTRAINT transformation_operations_command_valid;
ALTER TABLE transformation_operations
  ADD CONSTRAINT transformation_operations_command_valid CHECK
  (command IN ('transformation.create','transformation.save','transformation.finalize',
               'transformation.amend','transformation.void'));
```

- [ ] **Step 4: Run green and inspect physical guards.** Run the focused tests, `corepack pnpm --filter @markiro/db test`, `typecheck`, `lint`, `build`. Query active `pg_get_functiondef` for the revised guards; compare Receiving guard definitions and pre/post rows. Run `git diff --check` and check migration journal/snapshot. Review checkpoint: reject any relaxation of Receiving behavior or immutable historical evidence.

### Task 2: Protect current origins against downstream races

**Files:** Create `apps/api/src/modules/traceability/lots/us-current-consumers.ts` and `apps/api/test/us-current-consumers.e2e.test.ts`; modify `apps/api/src/modules/traceability/receiving/us-receiving-lifecycle.ts`, `us-receiving-revision-finalization.ts`, `apps/api/src/modules/traceability/transformation/us-transformation-finalization.ts`; extend their focused e2e/concurrency suites.

**Interfaces:** Export `listCurrentTransformationConsumers(tx, tenantId, lotIds): Promise<CurrentConsumer[]>` where `CurrentConsumer = { lotId: string; eventId: string; rootId: string; revision: number }`, and `bumpLotDependencyVersions(tx, tenantId, lotIds): Promise<void>`. Caller first locks sorted affected lots. The query joins typed roots and requires `status='finalized'` and `superseded_by_event_id IS NULL`.

- [ ] **Step 1: Write failing Receiving and original-Transformation tests.** Seed a finalized Receiving lot consumed by current finalized Transformation. Receiving void conflicts with `traceability_downstream_blocked` and the consumer ID; a changed Receiving amendment finalization conflicts, while a truly documentary correction succeeds. A Transformation draft or amended/void historical consumer does not block. Wrong tenant returns no blocker details. Force consumer-finalize and Receiving-void in both lock orders with barriers; exactly one safe outcome survives. Assert output lot, event pointers, audit and epoch after every failure.

```ts
await expect(receiving.void(tenant, qa, receiptId, command, requestId)).rejects.toMatchObject({
  response: {
    code: "traceability_downstream_blocked",
    blockers: [{ eventId: finalizedTransformationId }],
  },
});
```

- [ ] **Step 2: Run red after DB build.** `corepack pnpm --filter @markiro/db build`; then `corepack pnpm --filter @markiro/api exec vitest run test/us-current-consumers.e2e.test.ts test/us-receiving-lifecycle.e2e.test.ts test/us-transformation-finalization-concurrency.e2e.test.ts`. A skip is not a pass.
- [ ] **Step 3: Implement the shared query/epoch and wire existing writers.** In a repeatable-read transaction, every consumer finalization performs an actual epoch UPDATE on sorted input lots before committing; Receiving void/material amendment performs the same UPDATE after lot locks and blocker check. This update forces a stale waiting transaction to receive `40001` and retry with a new snapshot. Avoid touching operational lot revision/status/source/timestamps. Keep existing Receiving basis-version bumps. Recheck the origin and consumer predicate after locks; do not trust lot `active` status or a draft.

```ts
for (const id of [...new Set(lotIds)].sort()) {
  const [row] = await tx
    .update(schema.traceabilityLots)
    .set({ currentDependencyVersion: sql`${schema.traceabilityLots.currentDependencyVersion} + 1` })
    .where(
      and(
        eq(schema.traceabilityLots.tenantId, tenantId),
        eq(schema.traceabilityLots.id, id),
        lt(schema.traceabilityLots.currentDependencyVersion, 2147483647),
      ),
    )
    .returning({ id: schema.traceabilityLots.id });
  if (!row) throw unavailable();
}
```

- [ ] **Step 4: Run green and review the race.** Run focused Receiving/Transformation compatibility and concurrency suites, then API `test`, `typecheck`, `lint`, `build`; add the new focused suite to US CI. Independently inspect lock order and exact audit/rollback. Record full-package failures caused by unavailable RU env separately from these focused US tests.

### Task 3: Define revision contracts and stable amendment draft handling

**Files:** Modify `packages/platform-contracts/src/traceability/transformation-records.ts`, `packages/platform-contracts/src/index.ts`, `packages/domain/src/index.ts`, `apps/api/src/modules/traceability/transformation/us-transformation-{persistence,draft,operations,snapshot,store}.ts`; create `packages/platform-contracts/src/traceability/transformation-lifecycle.ts`, `packages/domain/src/traceability/transformation-lifecycle.ts`, `apps/api/src/modules/traceability/transformation/us-transformation-lifecycle.ts` and focused tests in all three packages.

**Interfaces:** `amendTransformationSchema = {operationKey, expectedLifecycleVersion, reason}`; `voidTransformationSchema = {operationKey, expectedLifecycleVersion, expectedDraftVersion?: number, reason}`. Revision-aware `TransformationDraftRecord` and `TransformationFinalizedRecord` use positive `revision` and carry root/current/pending/lifecycle metadata; frozen snapshot v1 also accepts positive revision. Revision >1 snapshots require `previousRevisionId: UUID`; original revision 1 snapshots retain their exact prior shape without this key. Add `transformationHistoricalRecordSchema` for amended/finalized-void/draft-void reads and `transformationLifecycleReceiptSchema` for idempotent amend/void results. Export `classifyTransformationChange(prior, next): "material" | "documentary"`, comparing event date, input identity/quantity/UOM and output quantity/UOM as material, but reason/note/document changes as documentary. `UsTransformationStore.amend(...)` and `.void(...)` remain internal.

- [ ] **Step 1: Write failing pure/contract/API tests.** Contract tests reject client `lotId`, missing reason and zero/overflow versions; parse revision 2 snapshots and both void shapes while preserving v1 bytes. Pure tests classify event-date/input-lot/quantity/UOM edits as material and reason/document-only edits as documentary. API tests start one amendment under `QA_MANAGE`, reject a second pending draft and stale lifecycle version, preserve predecessor as current, replay idempotently, and deny swapped/reordered output lines. Audit must name the actor/tenant/action/target and reason.

```ts
expect(classifyTransformationChange(prior, { ...prior, reason: "repacking" })).toBe("documentary");
expect(classifyTransformationChange(prior, { ...prior, inputs: changedInputs })).toBe("material");
expect(
  amendTransformationSchema.safeParse({
    operationKey,
    expectedLifecycleVersion: 2,
    reason: "Correction",
  }).success,
).toBe(true);
```

- [ ] **Step 2: Run red focused tests.** Build DB/domain/contracts dependency `dist` in dependency order; run `corepack pnpm --filter @markiro/domain exec vitest run test/us-transformation-lifecycle.test.ts`, `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-transformation-lifecycle.test.ts` and `corepack pnpm --filter @markiro/api exec vitest run test/us-transformation-lifecycle.e2e.test.ts`. Expected failures identify absent schemas/commands, not stale builds.
- [ ] **Step 3: Implement minimal contracts and amendment draft.** Broaden `revision: z.literal(1)` to bounded positive integer only where revision records/snapshots require it; keep snapshotVersion `1`. Extend `readTransformationRecord` to resolve the typed root by `row.rootEventId`, not `eventId`, and to distinguish current, pending and historical rows. In amendment creation copy prior typed children and bound output IDs into revision `root.nextRevision`; increment root lifecycle/next revision. On save, compare each output at its original `lineNo`, retain server-owned `lotId` during replacement, and refuse product/TLC/processor changes or count/order changes. Do not copy edges into drafts or mutate predecessor on save.

```ts
const bound = previousOutputs.map(({ lineNo, lotId, productId, tlc }) => ({
  lineNo,
  lotId,
  productId,
  tlc,
}));
if (
  draft.outputs.length !== bound.length ||
  draft.outputs.some(
    (line, i) => line.productId !== bound[i]?.productId || line.tlc !== bound[i]?.tlc,
  )
)
  throw new ConflictException({ code: "transformation_output_identity_locked" });
```

- [ ] **Step 4: Run green and inspect compatibility.** Run focused suites, all domain/contracts package gates and API focused draft/readiness/original-finalization tests. Check old v1 finalized records and operation receipts still parse unchanged. Review only the task diff; no route registration.

### Task 4: Finalize amendments and void safely

**Files:** Modify `apps/api/src/modules/traceability/transformation/us-transformation-{finalization,lifecycle,persistence,snapshot,operations,store}.ts`; create `apps/api/src/modules/traceability/transformation/us-transformation-origin.ts`, `apps/api/test/us-transformation-amendment-finalization.e2e.test.ts`, `apps/api/test/us-transformation-void.e2e.test.ts`, and concurrency/rollback tests; update `.github/workflows/us-development.yml`.

**Interfaces:** `UsTransformationStore.finalize` supports both original and pending amendment revisions, reusing server-bound output lot IDs in revision >1. `.void` returns a versioned lifecycle receipt. `readCurrentTransformationOrigin(tx, tenantId, lotId): Promise<{lotId: string; currentOrigin: boolean; eventId: string | null}>` exposes current-origin absence without deleting lot history. Blockers use Task 2's shared query and `traceability_downstream_blocked` error.

- [ ] **Step 1: Write failing amendment/void tests.** An input change without downstream finalizes revision 2 with the same output lot ID/source/TLC, new immutable snapshot/edges and root pointer, predecessor marked amended. Prior snapshot/edges remain exact. Reject a candidate current-graph cycle. With current downstream, material amendment and void conflict with blocker IDs/order; documentary-only amendment succeeds. Void with no downstream retains lot status/source lock and historical edges, clears current root pointer and current-origin evidence. Include pending-draft void, wrong-tenant/type, same-key replay, stale versions, audit failure rollback and two concurrent finalize/void orders.

```ts
expect(revision2.snapshot.outputs.map((x) => x.lotId)).toEqual(
  revision1.snapshot.outputs.map((x) => x.lotId),
);
expect(await readCurrentTransformationOrigin(tx, tenantId, outputLotId)).toEqual({
  lotId: outputLotId,
  currentOrigin: false,
  eventId: null,
});
expect(
  await tx
    .select()
    .from(schema.lotGenealogyEdges)
    .where(eq(schema.lotGenealogyEdges.eventId, revision1.id)),
).toEqual(originalEdges);
```

- [ ] **Step 2: Run red focused suites.** Rebuild changed shared packages; run the two new API suites plus `test/us-transformation-finalization.e2e.test.ts` and concurrency suite against isolated `US_TEST_DATABASE_URL`.
- [ ] **Step 3: Implement amended finalization and void.** Reuse the original readiness/snapshot path, but for revision >1 take output IDs from locked draft child rows instead of `randomUUID()` or new lot INSERTs. Compare stable output identities and processor source against predecessor under lock. Classify material effects and block current downstream before switching root pointers; calculate current graph after excluding predecessor edges and reject cycles. Insert new revision edges, mark predecessor amended, finalize new row and update root atomically. Void changes only event lifecycle/root current pointer and dependency epoch; preserve lots/snapshots/edges. Persist exact audit and operation receipt in the same transaction.

```ts
const outputLotId = revision === 1 ? randomUUID() : lockedOutputRows[i]?.lotId;
if (!outputLotId) throw unavailable();
// Revision >1: no INSERT into traceability_lots; only typed output and edge rows
// for the new event revision are written before the atomic root switch.
```

- [ ] **Step 4: Run green, isolation and independent review.** Run focused suites and affected package `test`, `typecheck`, `lint`, `build`; `corepack pnpm format:check`; `node --test tools/us-development/test/isolation.test.mjs`; `git diff --check`. Check the new suites are in US CI. Review the complete stage against the approved spec, migration, cross-tenant denial, blocker races, exact audit, immutable snapshots/edges and Receiving regressions. Report unrun browser/hardware/production gates explicitly; do not enable HTTP or release.

## Handoff

After all four tasks and independent reviews, write the separate current/pinned genealogy and 2→2/zero-FTL implementation plan from the same approved spec. This plan is ready for owner review; execution starts only after that review confirms its scope and task order.
