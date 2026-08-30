# Inventory Bulk Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make inventory discrepancies directly actionable, support atomic bulk void/date corrections across the full filtered result set, expose copyable canonical codes, fix safe close after voiding, and show the correct box projection for each inventory mode.

**Architecture:** PostgreSQL remains the authoritative projection and audit store. A shared event-level evidence query provides one row per scan event to both the paginated list and the batch resolver; the batch service locks the inventory, resolves and validates the selection, writes a batch header plus per-code evidence, publishes per-code progress changes, and increments the revision once. The tenant Admin remains online-only and adds filter-wide selection, confirmation, copy affordances, and mode-specific live box cards.

**Tech Stack:** TypeScript 6, NestJS, Drizzle ORM/PostgreSQL, Zod/OpenAPI, React 19, React Router, TanStack Query, Vitest, Testing Library, @markiro/ui.

**Spec:** docs/superpowers/specs/2026-08-30-inventory-bulk-corrections-design.md

## Global Constraints

- Keep all reads and writes tenant-scoped and preserve composite tenant foreign keys.
- Treat scan events as immutable; corrections change projections and append audit evidence only.
- “Выбрать все” means every event matching the current filter across all pages, with explicit exclusions.
- A batch is atomic, idempotent, and increments resultRevision exactly once.
- A known-box scan is one selected event but may create many per-code corrections and progress changes.
- voided remains in history and counts but is not a safe-close blocker.
- copyIdentity comes only from validated retained raw evidence; never present a digest as a product code.
- Batch corrections are online tenant-admin operations; Station sync and offline queues do not change.
- Keep the existing single-correction endpoint compatible.
- Use strict Zod objects and matching additionalProperties: false OpenAPI schemas.
- Do not introduce an arbitrary event-count cap; process large writes in bounded chunks inside one transaction.

## File Structure

- Create apps/api/src/modules/inventories/inventory-evidence-query.ts for the event-level query shared by pagination and batch selection.
- Create apps/api/src/modules/inventories/inventory-correction-batches.service.ts for atomic orchestration, idempotency, audit, projection updates, and progress changes.
- Modify inventory-event-display.ts and inventory-reconciliation.service.ts for copy identity, grouped events, and verified existing boxes.
- Modify dto.ts, inventories.controller.ts, and inventories.module.ts for strict list, batch, and progress contracts.
- Modify packages/db/src/schema/inventory.ts and generated migration metadata for the batch header and child relation.
- Create DB and API batch tests; extend reconciliation and close e2e coverage.
- Modify Admin schemas/api; create inventory-correction-selection.ts and InventoryCorrectionBatchPanel.tsx.
- Modify InventoryCorrections.tsx, InventoryLivePage.tsx, inventory.css, ru.json, and en.json for the final UX.

---

### Task 1: Make voided scans non-blocking at safe close

**Files:**
- Modify: apps/api/test/inventory-close.e2e.test.ts
- Modify: apps/api/src/modules/inventories/inventory-close.service.ts

**Interfaces:**
- Consumes: existing InventoryCloseService.preview() and close().
- Produces: discrepancy blockers for unknown, ineligible, and date_mismatch only; voidedCount remains available.

- [ ] **Step 1: Write the failing regression test**

~~~ts
it("does not treat an audited voided scan as a safe-close blocker", async () => {
  const fixture = await seedRunningInventory();
  await db
    .update(schema.inventoryCodeResults)
    .set({ classification: "voided" })
    .where(eq(schema.inventoryCodeResults.id, fixture.resultId));

  const preview = await fixture.agent
    .get("/inventories/" + fixture.inventoryId + "/close-preview")
    .expect(200);
  expect(preview.body.blockers).not.toContainEqual(
    expect.objectContaining({
      code: "UNRESOLVED_DISCREPANCY",
      discrepancyCategory: "voided",
    }),
  );
  await fixture.agent.post("/inventories/" + fixture.inventoryId + "/close").send({}).expect(201);
});
~~~

- [ ] **Step 2: Run the test and confirm the current failure**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-close.e2e.test.ts
~~~

Expected: FAIL because preview emits a voided blocker or safe close returns 409.

- [ ] **Step 3: Remove only the voided blocker emission**

~~~ts
for (const [category, count] of [
  ["unknown", closeState.unknownCount],
  ["ineligible", closeState.ineligibleCount],
  ["date_mismatch", closeState.dateMismatchCount],
] as const) {
  if (count > 0) {
    blockers.push(blocker("UNRESOLVED_DISCREPANCY", { count, discrepancyCategory: category }));
  }
}
~~~

- [ ] **Step 4: Run the focused close suite**

Run the command from Step 2. Expected: PASS, including existing blocker assertions.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api/src/modules/inventories/inventory-close.service.ts apps/api/test/inventory-close.e2e.test.ts
git commit -m "fix(inventory): allow safe close after voiding scans"
~~~

### Task 2: Add batch audit persistence

**Files:**
- Modify: packages/db/src/schema/inventory.ts
- Create: packages/db/migrations/0104_inventory_correction_batches.sql
- Create: packages/db/migrations/meta/0104_snapshot.json
- Modify: packages/db/migrations/meta/_journal.json
- Create: packages/db/test/inventory-correction-batches-migration.test.ts
- Modify: packages/db/test/schema.test.ts

**Interfaces:**
- Produces: schema.inventoryCorrectionBatches, inferred batch types, and nullable inventoryCorrections.batchId.
- Consumed by: InventoryCorrectionBatchesService in Task 5.

- [ ] **Step 1: Write failing schema and forward-migration tests**

Migrate a scratch database through index 103, insert a legacy correction, apply all migrations, and assert:

~~~ts
expect(schema.inventoryCorrectionBatches).toBeDefined();
expect(schema.inventoryCorrections.batchId).toBeDefined();
expect(
  await pool.query("select batch_id from inventory_corrections where id = $1", [
    legacyCorrectionId,
  ]),
).toMatchObject({ rows: [{ batch_id: null }] });
await expect(insertForeignTenantBatchReference(pool)).rejects.toThrow(
  /inventory_corrections_tenant_batch_fk/,
);
~~~

- [ ] **Step 2: Run the tests and confirm failure**

~~~bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/inventory-correction-batches-migration.test.ts
~~~

Expected: FAIL because the table, column, and migration do not exist.

- [ ] **Step 3: Add the Drizzle schema**

Define inventoryCorrectionBatches before inventoryCorrections:

~~~ts
export const inventoryCorrectionBatches = pgTable(
  "inventory_correction_batches",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    action: inventoryCorrectionActionEnum("action").notNull(),
    reason: text("reason").notNull(),
    requestDigest: char("request_digest", { length: 64 }).notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => user.id),
    selectedEventCount: integer("selected_event_count").notNull(),
    affectedCodeCount: integer("affected_code_count").notNull(),
    resultRevision: integer("result_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_correction_batches_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    foreignKey({
      name: "inventory_correction_batches_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    check(
      "inventory_correction_batches_action_check",
      sql`${table.action} in ('void_scan', 'change_date')`,
    ),
    check(
      "inventory_correction_batches_counts_check",
      sql`${table.selectedEventCount} > 0 and ${table.affectedCodeCount} > 0`,
    ),
    check(
      "inventory_correction_batches_reason_check",
      sql`octet_length(btrim(${table.reason})) between 1 and 1024`,
    ),
    check(
      "inventory_correction_batches_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_correction_batches_revision_check",
      sql`${table.resultRevision} > 0`,
    ),
  ],
);
~~~

Add:

~~~ts
batchId: uuid("batch_id"),
foreignKey({
  name: "inventory_corrections_tenant_batch_fk",
  columns: [table.tenantId, table.batchId, table.inventoryId],
  foreignColumns: [
    inventoryCorrectionBatches.tenantId,
    inventoryCorrectionBatches.id,
    inventoryCorrectionBatches.inventoryId,
  ],
}),
index("inventory_corrections_batch_idx").on(
  table.tenantId,
  table.inventoryId,
  table.batchId,
  table.id,
),
~~~

Export InventoryCorrectionBatch and NewInventoryCorrectionBatch.

- [ ] **Step 4: Generate and inspect migration 0104**

~~~bash
pnpm --filter @markiro/db db:generate --name inventory_correction_batches
~~~

It must create only this table/column/constraints/indexes and leave legacy rows nullable. If Drizzle chooses another 0104 filename, use that exact generated filename.

- [ ] **Step 5: Run DB verification**

~~~bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/inventory-correction-batches-migration.test.ts
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
~~~

Expected: PASS. Report an explicit migration-test skip if DATABASE_URL is absent.

- [ ] **Step 6: Commit**

~~~bash
git add packages/db/src/schema/inventory.ts packages/db/migrations packages/db/test/schema.test.ts packages/db/test/inventory-correction-batches-migration.test.ts
git commit -m "feat(db): add inventory correction batches"
~~~

### Task 3: Build one event-level evidence query and copy identity

**Files:**
- Create: apps/api/src/modules/inventories/inventory-evidence-query.ts
- Modify: apps/api/src/modules/inventories/inventory-event-display.ts
- Modify: apps/api/src/modules/inventories/inventory-reconciliation.service.ts
- Modify: apps/api/src/modules/inventories/dto.ts
- Modify: apps/api/src/modules/inventories/inventories.controller.ts
- Modify: apps/api/test/inventory-reconciliation.e2e.test.ts
- Create: apps/api/test/inventory-event-display.test.ts

**Interfaces:**
- Produces: InventoryEvidenceFilter, buildInventoryEvidenceRowsSql(), resolveInventoryEvidenceEvents(), formatInventoryEventCopyIdentity(), grouped DTO fields, and list metadata.
- Consumed by: batch service in Task 5 and Admin contracts in Task 6.

- [ ] **Step 1: Write failing identity and evidence tests**

~~~ts
expect(formatInventoryEventCopyIdentity("item", "]d2010468008990038321SERIAL")).toBe(
  "010468008990038321SERIAL",
);
expect(formatInventoryEventCopyIdentity("known_box", "(00)046800899000600163")).toBe(
  "00046800899000600163",
);
expect(formatInventoryEventCopyIdentity("item", null)).toBeNull();
expect(formatInventoryEventCopyIdentity("item", "invalid")).toBeNull();
~~~

Seed one known-box event with twenty results and assert:

~~~ts
expect(response.body.items).toHaveLength(1);
expect(response.body.items[0]).toMatchObject({
  eventId: boxEventId,
  copyIdentity: "00046800899000600163",
  affectedCodeCount: 20,
  discrepancyCodeCount: 2,
  classifications: ["expected", "unknown"],
  discrepancyCategories: ["unknown"],
});
expect(response.body).toMatchObject({
  total: 1,
  allMatchingActions: ["void_scan"],
  allMatchingAffectedCodeCount: 20,
});
~~~

Also cover scope=discrepancies, category=date_mismatch, classification=unknown, search, pagination, and rawPayload=null.

- [ ] **Step 2: Run focused tests and confirm failure**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-event-display.test.ts test/inventory-reconciliation.e2e.test.ts
~~~

- [ ] **Step 3: Implement canonical copy identity**

~~~ts
export function formatInventoryEventCopyIdentity(
  kind: InventoryEventKind,
  rawPayload: string | null,
): string | null {
  if (rawPayload === null) return null;
  if (kind === "item") {
    try {
      return canonicalizeKm(rawPayload).raw;
    } catch {
      return null;
    }
  }
  const sscc = parseScannedSscc(rawPayload);
  return sscc === null ? null : "00" + sscc;
}
~~~

- [ ] **Step 4: Add strict query and response contracts**

Extend the query with scope defaulting to all and optional actionable discrepancyCategory. Add copyIdentity, affectedCodeCount, discrepancyCodeCount, classifications, and discrepancyCategories to each event. Add allMatchingActions and allMatchingAffectedCodeCount to the response. Update OpenAPI and controller queries exactly.

- [ ] **Step 5: Implement the shared grouped query**

Export:

~~~ts
export interface InventoryEvidenceFilter {
  scope: "all" | "discrepancies";
  search?: string;
  kind?: "item" | "known_box" | "old_box";
  classification?: "expected" | "protected" | "ineligible" | "unknown" | "voided";
  discrepancyCategory?: InventoryActionableDiscrepancyCategory;
}

export type InventoryActionableDiscrepancyCategory =
  | "ineligible"
  | "unknown"
  | "date_mismatch";

export type InventoryEvidenceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface EvidenceSqlInput {
  tenantId: string;
  inventoryId: string;
  filter: InventoryEvidenceFilter;
  eventIds?: readonly string[];
  excludedEventIds?: readonly string[];
}

export interface ResolveInventoryEvidenceInput extends EvidenceSqlInput {
  order: "newest" | "stable_lock";
}

export interface InventoryEvidenceSelectionEvent {
  eventId: string;
  kind: "item" | "known_box" | "old_box";
  normalizedIdentity: string;
  rawPayload: string | null;
  terminalId: string;
  terminalName: string;
  scannedAt: Date;
  resultIds: string[];
  affectedCodeCount: number;
  discrepancyCodeCount: number;
  classifications: Array<"expected" | "protected" | "ineligible" | "unknown" | "voided">;
  discrepancyCategories: InventoryActionableDiscrepancyCategory[];
  actions: Array<"void_scan" | "restore_scan" | "change_date" | "remove_item">;
}

export function buildInventoryEvidenceRowsSql(input: EvidenceSqlInput): SQL;
export async function resolveInventoryEvidenceEvents(
  tx: InventoryEvidenceTransaction,
  input: ResolveInventoryEvidenceInput,
): Promise<InventoryEvidenceSelectionEvent[]>;
~~~

The SQL must be tenant/inventory scoped, group by scan event, compute date mismatch only for non-voided rows, return stable distinct arrays, use EXISTS semantics for classification/category/scope, apply explicit IDs/exclusions in the same query, and order by scannedAt desc/eventId desc. InventoryReconciliationService must use this query for total, page rows, allMatchingActions, and allMatchingAffectedCodeCount.

- [ ] **Step 6: Run tests and commit**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-event-display.test.ts test/inventory-reconciliation.e2e.test.ts
git add apps/api/src/modules/inventories/inventory-evidence-query.ts apps/api/src/modules/inventories/inventory-event-display.ts apps/api/src/modules/inventories/inventory-reconciliation.service.ts apps/api/src/modules/inventories/dto.ts apps/api/src/modules/inventories/inventories.controller.ts apps/api/test/inventory-event-display.test.ts apps/api/test/inventory-reconciliation.e2e.test.ts
git commit -m "feat(inventory): expose actionable event evidence"
~~~

### Task 4: Return the correct live box projection

**Files:**
- Modify: apps/api/src/modules/inventories/dto.ts
- Modify: apps/api/src/modules/inventories/inventory-reconciliation.service.ts
- Modify: apps/api/test/inventory-reconciliation.e2e.test.ts

**Interfaces:**
- Produces: InventoryVerifiedBoxDto and verifiedBoxTotal, verifiedBoxesTruncated, verifiedBoxes.
- Consumed by: InventoryLivePage in Task 7.

- [ ] **Step 1: Write failing progress tests**

~~~ts
expect(progress.body).toMatchObject({
  verifiedBoxTotal: 1,
  verifiedBoxesTruncated: false,
});
expect(progress.body.verifiedBoxes).toEqual([
  expect.objectContaining({
    eventId: appliedBoxEventId,
    sscc,
    terminalName: "Correction terminal",
    affectedCodeCount: 20,
  }),
]);
expect(progress.body.recentEvents).toContainEqual(
  expect.objectContaining({ eventId: duplicateEventId, authoritativeVerdict: "duplicate" }),
);
~~~

Add 101 unique applied boxes and assert the first 100 are returned, total is 101, and truncation is true.

- [ ] **Step 2: Run the suite and confirm failure**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-reconciliation.e2e.test.ts
~~~

- [ ] **Step 3: Add DTO/OpenAPI fields and query**

~~~ts
export interface InventoryVerifiedBoxDto {
  eventId: string;
  sscc: string;
  terminalId: string;
  terminalName: string;
  scannedAt: string;
  affectedCodeCount: number;
}
~~~

Use row_number() partitioned by normalized_identity over applied known_box events, keep row 1, join child results for affectedCodeCount, fetch 101 rows, and exclude duplicate verdicts. Keep existing repack boxes fields.

- [ ] **Step 4: Run tests and commit**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-reconciliation.e2e.test.ts
git add apps/api/src/modules/inventories/dto.ts apps/api/src/modules/inventories/inventory-reconciliation.service.ts apps/api/test/inventory-reconciliation.e2e.test.ts
git commit -m "feat(inventory): report verified existing boxes"
~~~

### Task 5: Implement atomic bulk corrections

**Files:**
- Create: apps/api/src/modules/inventories/inventory-correction-batches.service.ts
- Create: apps/api/src/modules/inventories/inventory-correction-common.ts
- Create: apps/api/test/inventory-correction-batches.e2e.test.ts
- Modify: apps/api/src/modules/inventories/inventory-corrections.service.ts
- Modify: apps/api/src/modules/inventories/dto.ts
- Modify: apps/api/src/modules/inventories/inventories.controller.ts
- Modify: apps/api/src/modules/inventories/inventories.module.ts
- Modify: apps/api/test/inventory-corrections.e2e.test.ts

**Interfaces:**
- Consumes: schema.inventoryCorrectionBatches, inventoryCorrections.batchId, and resolveInventoryEvidenceEvents().
- Produces: POST /inventories/:id/corrections/batch and strict batch request/response types.

- [ ] **Step 1: Write failing batch DTO and e2e tests**

Cover explicit selection, all_matching plus exclusions, known-box fan-out, both actions, one revision increment, per-code audit/progress, replay/mismatch, stale/empty/changed selection, active-box date conflict, total rollback, cross-tenant denial, read-only subscription, closed inventory, and unknown fields.

~~~ts
expect(response.body).toMatchObject({
  action: "void_scan",
  selectedEventCount: 2,
  affectedCodeCount: 21,
  resultRevision: 5,
});
const batches = await batchRows(fixture);
const corrections = await correctionRows(fixture);
expect(batches).toHaveLength(1);
expect(corrections).toHaveLength(21);
expect(new Set(corrections.map((row) => row.resultRevision))).toEqual(new Set([5]));
expect(corrections.every((row) => row.batchId === batches[0]?.id)).toBe(true);
expect((await progressChangeRows(fixture)).every((row) => row.resultRevision === 5)).toBe(true);
~~~

- [ ] **Step 2: Run batch tests and confirm failure**

~~~bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/inventory-correction-batches.e2e.test.ts
~~~

Expected: FAIL because the route and DTO do not exist.

- [ ] **Step 3: Add strict DTO and OpenAPI schemas**

~~~ts
const uniqueUuidArray = z
  .array(z.string().uuid())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length);

const batchFilterSchema = z.strictObject({
  scope: z.enum(["all", "discrepancies"]),
  search: z.string().trim().min(1).max(128).optional(),
  kind: z.enum(INVENTORY_EVIDENCE_KINDS).optional(),
  classification: z.enum(INVENTORY_EVIDENCE_CLASSIFICATIONS).optional(),
  discrepancyCategory: z
    .enum(["ineligible", "unknown", "date_mismatch"])
    .optional(),
});
~~~

Build strict explicit/all_matching selection branches and the strict void_scan/change_date union exactly as the spec. The response requires id, action, selectedEventCount, affectedCodeCount, resultRevision, and createdAt.

- [ ] **Step 4: Extract compatible correction primitives**

Move the existing SHA-256 digest, deterministic UUID builder, codeResultProjection, database timestamp reader, and progress-change row construction into inventory-correction-common.ts. Preserve the single endpoint’s v1 UUID namespace and request digest. Run inventory-corrections.e2e.test.ts before adding batch behavior.

~~~ts
export function inventoryCorrectionUuid(
  namespace: "single" | "batch" | "batch-child",
  ...parts: readonly string[]
): string;
export function inventoryProjectionDigest(value: Record<string, unknown>): string;
export function codeResultProjection(result: CodeResultProjectionInput): Record<string, unknown>;
export async function readCorrectionTimestamp(tx: CorrectionTransaction): Promise<Date>;

type CorrectionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
interface CodeResultProjectionInput {
  id: string;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided";
  observedProductionDate: string | null;
  updatedAt: Date;
}
~~~

- [ ] **Step 5: Implement the batch transaction**

~~~ts
correct(
  tenantId: string,
  actorUserId: string,
  inventoryId: string,
  input: CreateInventoryCorrectionBatchDto,
): Promise<InventoryCorrectionBatchDto>
~~~

Inside one transaction:

1. Lock the tenant-scoped inventory.
2. Derive the batch ID from tenant, inventory, and idempotencyKey; compare requestDigest on replay.
3. Verify running status, active snapshot, and expectedResultRevision.
4. Resolve explicit/all_matching events with the shared evidence query.
5. For explicit mode require every requested event to resolve.
6. Lock every related code result in stable ID order.
7. For void_scan target every non-voided child. For change_date reject voided children and any active repack membership.
8. Require every selected event to have at least one target before any write.
9. Capture one database timestamp and next revision.
10. Insert one batch header.
11. Insert one deterministic correction per target with event ID, result ID, batch ID, and exact before/after digests.
12. Update results and insert progress changes in chunks of 500 inside the transaction.
13. Update inventory.resultRevision once and return the stored batch DTO.

Use only these stable errors:

~~~text
INVENTORY_CORRECTION_NOT_RUNNING
INVENTORY_CORRECTION_STALE_REVISION
INVENTORY_CORRECTION_SNAPSHOT_MISSING
INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH
INVENTORY_CORRECTION_BATCH_EMPTY
INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED
INVENTORY_CORRECTION_ACTIVE_BOX_CONFLICT
~~~

No error or log may contain raw codes.

- [ ] **Step 6: Wire controller and module**

Add POST :id/corrections/batch with OPERATIONS_WRITE, RequireSubscriptionWrite, ZodValidationPipe, @ApiBody, and @ApiCreatedResponse. Register InventoryCorrectionBatchesService as a provider.

- [ ] **Step 7: Run batch and single suites**

~~~bash
pnpm --filter @markiro/api exec vitest run test/inventory-correction-batches.e2e.test.ts test/inventory-corrections.e2e.test.ts
~~~

Expected: PASS.

- [ ] **Step 8: Commit**

~~~bash
git add apps/api/src/modules/inventories/inventory-correction-batches.service.ts apps/api/src/modules/inventories/inventory-correction-common.ts apps/api/src/modules/inventories/inventory-corrections.service.ts apps/api/src/modules/inventories/dto.ts apps/api/src/modules/inventories/inventories.controller.ts apps/api/src/modules/inventories/inventories.module.ts apps/api/test/inventory-correction-batches.e2e.test.ts apps/api/test/inventory-corrections.e2e.test.ts
git commit -m "feat(inventory): add atomic bulk corrections"
~~~

### Task 6: Add strict Admin contracts and selection state

**Files:**
- Modify: apps/admin/src/pages/inventory/schemas.ts
- Modify: apps/admin/src/pages/inventory/api.ts
- Create: apps/admin/src/pages/inventory/inventory-correction-selection.ts
- Create: apps/admin/test/inventory-correction-selection.test.ts
- Modify: apps/admin/test/inventory-corrections.test.tsx

**Interfaces:**
- Produces: CreateInventoryCorrectionBatchInput, InventoryCorrectionSelectionState, serializeSelection(), and useCreateInventoryCorrectionBatch().
- Consumed by: InventoryCorrections and InventoryCorrectionBatchPanel in Task 8.

- [ ] **Step 1: Write failing schema, request, and selection tests**

~~~ts
const selected = selectAllMatching({
  filter,
  total: 2582,
  affectedCodeCount: 2600,
});
const excluded = toggleEvent(selected, {
  eventId: EVENT_ID,
  affectedCodeCount: 20,
});
expect(excluded).toMatchObject({
  mode: "all_matching",
  selectedEventCount: 2581,
  selectedCodeCount: 2580,
});
expect(serializeSelection(selected)).toEqual({
  mode: "all_matching",
  filter,
  excludedEventIds: [],
});
~~~

Assert one POST to /corrections/batch contains the exact filter snapshot, exclusions, reason, optional date, revision, and idempotency key.

- [ ] **Step 2: Run focused tests and confirm failure**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-correction-selection.test.ts test/inventory-corrections.test.tsx
~~~

- [ ] **Step 3: Add strict schemas and mutation hook**

Mirror every API field, including nullable copyIdentity, grouped arrays/counts, allMatchingActions, allMatchingAffectedCodeCount, verified box fields, selection union, action union, and batch response.

~~~ts
export function useCreateInventoryCorrectionBatch(): UseMutationResult<
  InventoryCorrectionBatch,
  Error,
  { inventoryId: string; correction: CreateInventoryCorrectionBatchInput }
>
~~~

On success invalidate inventory detail, progress, and all evidence queries under the inventory key.

- [ ] **Step 4: Implement pure selection helpers**

~~~ts
export function createExplicitSelection(): ExplicitSelectionState;
export function toggleVisiblePage(
  state: InventoryCorrectionSelectionState,
  events: readonly SelectableEvidenceEvent[],
): InventoryCorrectionSelectionState;
export function selectAllMatching(input: AllMatchingSelectionInput): AllMatchingSelectionState;
export function toggleEvent(
  state: InventoryCorrectionSelectionState,
  event: SelectableEvidenceEvent,
): InventoryCorrectionSelectionState;
export function clearSelection(): ExplicitSelectionState;
export function serializeSelection(
  state: InventoryCorrectionSelectionState,
): InventoryCorrectionBatchSelection;
~~~

Use Set only in UI state, return new objects, and store the exact filter snapshot in all_matching mode.

Define the state types in the same module:

~~~ts
export interface SelectableEvidenceEvent {
  eventId: string;
  affectedCodeCount: number;
}

export interface ExplicitSelectionState {
  mode: "explicit";
  selected: ReadonlyMap<string, number>;
  selectedEventCount: number;
  selectedCodeCount: number;
}

export interface AllMatchingSelectionInput {
  filter: InventoryEvidenceFilter;
  total: number;
  affectedCodeCount: number;
}

export interface AllMatchingSelectionState {
  mode: "all_matching";
  filter: InventoryEvidenceFilter;
  totalEventCount: number;
  totalCodeCount: number;
  excluded: ReadonlyMap<string, number>;
  selectedEventCount: number;
  selectedCodeCount: number;
}

export type InventoryCorrectionSelectionState =
  | ExplicitSelectionState
  | AllMatchingSelectionState;
~~~

- [ ] **Step 5: Run tests and commit**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-correction-selection.test.ts test/inventory-corrections.test.tsx
git add apps/admin/src/pages/inventory/schemas.ts apps/admin/src/pages/inventory/api.ts apps/admin/src/pages/inventory/inventory-correction-selection.ts apps/admin/test/inventory-correction-selection.test.ts apps/admin/test/inventory-corrections.test.tsx
git commit -m "feat(admin): add inventory batch correction contracts"
~~~

### Task 7: Make discrepancies and boxes clear on the live page

**Files:**
- Modify: apps/admin/src/pages/inventory/InventoryLivePage.tsx
- Modify: apps/admin/src/pages/inventory/inventory.css
- Modify: apps/admin/src/i18n/ru.json
- Modify: apps/admin/src/i18n/en.json
- Modify: apps/admin/test/inventory-live.test.tsx
- Modify: apps/admin/test/inventory-css.test.ts

**Interfaces:**
- Consumes: verifiedBoxes progress fields from Task 4.
- Produces: direct discrepancy link and mode-specific box card.

- [ ] **Step 1: Write failing live-page tests**

~~~ts
expect(screen.getByRole("link", { name: /Расхождения 6/ })).toHaveAttribute(
  "href",
  "/inventory/" + INVENTORY_ID + "/corrections?view=discrepancies",
);
expect(screen.getByRole("heading", { name: "Проверенные короба" })).toBeInTheDocument();
expect(screen.queryByRole("heading", { name: "Новые короба" })).not.toBeInTheDocument();
expect(screen.getByText("Повторный скан")).toBeInTheDocument();
~~~

Render repack mode and assert only “Новые короба”. Render read-only/non-running variants and assert the metric is not a link.

- [ ] **Step 2: Run tests and confirm failure**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx test/inventory-css.test.ts
~~~

- [ ] **Step 3: Implement navigation and mode-specific cards**

Allow LiveMetric an optional to prop. For check mode render verifiedBoxes with SSCC, terminal, scan time, and affectedCodeCount plus truncation. For repack render existing boxes as “Новые короба” with state, item count, and print state. Do not render an irrelevant empty card.

Map technical verdicts through translations, including duplicate -> “Повторный скан”; do not show raw verdict text as the primary label.

- [ ] **Step 4: Add accessible styles/translations, run tests, and commit**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx test/inventory-css.test.ts
git add apps/admin/src/pages/inventory/InventoryLivePage.tsx apps/admin/src/pages/inventory/inventory.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/inventory-live.test.tsx apps/admin/test/inventory-css.test.ts
git commit -m "feat(admin): clarify inventory discrepancies and boxes"
~~~

### Task 8: Build the bulk corrections interface

**Files:**
- Create: apps/admin/src/pages/inventory/InventoryCorrectionBatchPanel.tsx
- Modify: apps/admin/src/pages/inventory/InventoryCorrections.tsx
- Modify: apps/admin/src/pages/inventory/inventory.css
- Modify: apps/admin/src/i18n/ru.json
- Modify: apps/admin/src/i18n/en.json
- Modify: apps/admin/test/inventory-corrections.test.tsx
- Modify: apps/admin/test/inventory-routing.test.tsx
- Modify: apps/admin/test/inventory-css.test.ts

**Interfaces:**
- Consumes: evidence metadata, selection helpers, and batch mutation.
- Produces: complete deep-link, selection, confirmation, and recovery workflow.

- [ ] **Step 1: Write failing interaction tests**

Cover the discrepancy query-param view, all-scans switch, exact clipboard value, null-copy state, page selection, all_matching, exclusions, selection reset on every filter, one batch request, stale recovery, network retry with the same key, and success refresh.

~~~ts
expect(JSON.parse(String(requestInit?.body))).toEqual({
  action: "void_scan",
  selection: {
    mode: "all_matching",
    filter: { scope: "discrepancies", discrepancyCategory: "unknown" },
    excludedEventIds: [EXCLUDED_EVENT_ID],
  },
  reason: "Проверено по журналу",
  expectedResultRevision: 8,
  idempotencyKey: expect.any(String),
});
~~~

- [ ] **Step 2: Run focused tests and confirm failure**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-corrections.test.tsx test/inventory-routing.test.tsx test/inventory-css.test.ts
~~~

- [ ] **Step 3: Implement URL-backed views and filters**

Use useSearchParams. Normalize absent/invalid view to all. Add “Расхождения / Все сканирования” and actionable category. Reset selection whenever view, search, kind, classification, or category changes.

- [ ] **Step 4: Render one event row**

Render checkbox, HRI, separate copyIdentity and copy button, classification/category summary, affected/discrepancy counts, original date or “Разные даты”, terminal/time, and existing single actions. Call navigator.clipboard.writeText only with non-null copyIdentity; never reconstruct codes in the browser.

- [ ] **Step 5: Implement filter-wide selection**

The header checkbox selects the page. When the full page is selected and total is larger, show “Выбрано 50. Выбрать все 2 582 по текущему фильтру”. In all_matching mode show selected event/code counts and exclusions. Keep the action bar sticky and keyboard reachable.

- [ ] **Step 6: Implement the confirmation panel**

~~~ts
interface InventoryCorrectionBatchPanelProps {
  action: "void_scan" | "change_date";
  selectedEventCount: number;
  affectedCodeCount: number;
  pending: boolean;
  errorCode: string | null;
  onCancel(): void;
  onConfirm(input: { reason: string; observedProductionDate?: string }): void;
}
~~~

Require a trimmed reason of 1–1024 UTF-8 bytes and a civil date for change_date. Mention both counts and per-code audit in the confirmation.

- [ ] **Step 7: Submit and recover**

Create one idempotency key when confirmation opens; reuse it through network retries and replace it only after success/cancel/selection change. Submit the stored filter snapshot. On stale/selection-changed/empty clear selection, refresh progress/evidence, and show localized retry guidance.

- [ ] **Step 8: Run tests and commit**

~~~bash
pnpm --filter @markiro/admin exec vitest run test/inventory-corrections.test.tsx test/inventory-routing.test.tsx test/inventory-css.test.ts
git add apps/admin/src/pages/inventory/InventoryCorrectionBatchPanel.tsx apps/admin/src/pages/inventory/InventoryCorrections.tsx apps/admin/src/pages/inventory/inventory.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/inventory-corrections.test.tsx apps/admin/test/inventory-routing.test.tsx apps/admin/test/inventory-css.test.ts
git commit -m "feat(admin): add bulk inventory correction workflow"
~~~

### Task 9: Run cross-package verification

**Files:**
- Modify only when a gate reveals a defect within this scope.
- Regenerate graphify-out only if the ignored local graph exists.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: release-quality automated evidence without claiming browser/hardware validation.

- [ ] **Step 1: Run package gates in dependency order**

~~~bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
~~~

Record database-backed skips separately.

- [ ] **Step 2: Run hygiene and update the local graph**

~~~bash
pnpm format:check
git diff --check
git status --short
test ! -f graphify-out/graph.json || graphify update .
~~~

Do not add graphify-out to Git.

- [ ] **Step 3: Review every spec requirement**

Map passing tests to navigation, copy identity, one-row box events, filter-wide selection, exclusions, atomic audit, revision/idempotency, safe close, verified/new boxes, localization, errors, and compatibility.

- [ ] **Step 4: Commit only scoped gate fixes**

If no files changed, do not create an empty commit. Otherwise stage exact files and use:

~~~bash
git commit -m "fix(inventory): satisfy bulk correction verification"
~~~

- [ ] **Step 5: Prepare delivery evidence**

Report behavior, files, commits, exact checks and skips, browser coverage, unchanged/unrun Station hardware coverage, and migration execution status.
