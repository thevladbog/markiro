# US-05 Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-safe, versioned P0 Shipping CTE to the isolated U.S. office and API without enabling a release.

**Architecture:** Extend the existing `traceability_events` shell with a typed Shipping root, lines and snapshots. Compute exact current lot balance from finalized Receiving/Transformation/Shipping revisions under per-lot serialization, then expose versioned Shipping commands and a third type in the unified Events office workflow. No specific SSCC is assigned to a shipment in P0.

**Tech Stack:** Node 24+, Corepack/pnpm, TypeScript, Drizzle/PostgreSQL, NestJS, Zod, React/Vite, `@markiro/ui`, Vitest, isolated Playwright smoke.

**Spec:** [US-05 Shipping current design](../specs/2026-09-27-us-05-shipping-current-design.md). Read it and the current [MVP contract](../../us/mvp-contract.md) before Task 1.

## Global Constraints

- Work only in the isolated US edition/branch; no RU route, Station, scanner, printer, import adapter, case selection, merge, deployment or public release.
- Preserve the existing dirty US-04 checkout. At the start of each task run `git status --short`; never reset, overwrite, stage or include unrelated changes. No commit or push is authorized by this plan.
- Use an isolated disposable PostgreSQL database for migration/e2e/browser work; do not migrate, wipe, seed or copy the shared development or production database. Do not modify `.env`.
- Exact decimal strings have at most three fractional digits; keep UOM explicit. Mixed units yield `unknown` on reads and block P0 finalization. A known over-shipment blocks finalization.
- Shipping references an existing lot only. No TLC/product/source/create-lot input, no implicit UOM conversion, no claim that linked SSCCs were shipped.
- Preserve tenant-composite keys, current US session/profile/capability checks, current role reload, exact audit, operation-key replay, and immutable historical snapshots.
- U.S. office copy is `en-US` and `es-US`; never add Russian to US-only screens. Reuse `@markiro/ui` and the existing U.S. client/proxy patterns.
- Build `@markiro/db`, `@markiro/domain` and `@markiro/platform-contracts` before their consumers. Report DB, browser, hosted CI, physical and external checks separately.
- One fresh implementer owns each task and hands a bounded diff/check report to a fresh reviewer before the next task. The primary agent resolves review findings and confirms each gate.

## Review Focus

1. Two simultaneous shipments for the last available cases must not both finalize (Task 5 concurrent DB test).
2. An archived or cross-tenant recipient/document after draft save must fail current readiness/finalization without leaking its identity (Task 4/5 tests).
3. Multiple current Receiving lines for one lot must add exactly once each, while a superseded revision adds zero (Task 2/3 tests).
4. A manual quarantine/recall after a Shipping-owned `shipped` transition must survive void/amend (Task 3/6 tests).
5. A payload containing `tlc`, `productId`, `createLot`, duplicate lot lines, or a tenant ID must be rejected before a business write (Task 4/5 tests).

---

## File map and task boundaries

| Task | Owned units                                                                                                        | Consumed by  |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1    | `packages/db/src/schema/traceability-shipping-{roots,events}.ts`, additive migration, schema exports/checks        | 3–7          |
| 2    | `packages/domain/src/traceability/shipping-{balance,readiness}.ts`, domain exports and tests                       | 3–6          |
| 3    | `apps/api/src/modules/traceability/shipping/us-shipping-{balance,status-effects}.ts`, lot-status coordination      | 4–6          |
| 4    | `packages/platform-contracts/src/traceability/shipping-{draft,records,http}.ts`, `us-shipping-draft.ts`, readiness | 5–8          |
| 5    | `us-shipping-finalization.ts`, store/controller/runtime registration, audit and HTTP tests                         | 6–8          |
| 6    | `us-shipping-lifecycle.ts`, revision/void compensation, history and blocker tests                                  | 7–8          |
| 7    | shared Events registry/list contract, U.S. client/proxy allowlists and tests                                       | 8            |
| 8    | Shipping office components/copy, browser flow, docs/evidence status                                                | final review |

Existing US-04 modules are touched only where Shipping must participate in current-origin/consumer locking, status ownership, the Events union or the U.S. allowlist. Do not refactor unrelated RU code. The applicable API route inventories and OpenAPI tests must be checked when Task 5 registers the new controller.

### Task 1: Typed Shipping storage and upgrade-safe shell

**Files:** Create `packages/db/src/schema/traceability-shipping-roots.ts`, `packages/db/src/schema/traceability-shipping-events.ts`, and `packages/db/migrations/0134_us_shipping_foundation.sql` after the current `0133_us_case_bridge.sql` (recheck the journal before writing). Modify `packages/db/src/schema/traceability-receiving.ts`, `packages/db/src/schema.ts`, and `packages/db/migrations/meta/_journal.json`. Test `packages/db/test/us-shipping-schema.test.ts`, `packages/db/test/us-shipping-migration.e2e.test.ts`.

**Interfaces:** Produce `shippingEventRoots`, `shippingEventDetails`, `shippingEventItems`, `shippingEventDocuments`, `shippingLotStatusEffects`; keep `traceabilityEvents` common. Every child has `(tenant_id,event_id)` tenant-composite FK and a typed-event guard; status effects have one active owner per `(tenant_id,lot_id)`.

- [ ] **Step 1: Write failing metadata/upgrade tests.** Exercise original Receiving and Transformation histories plus a Shipping draft/finalized row, wrong-type child and cross-tenant FK rejection, one-current/one-pending root, immutable frozen rows, and migration upgrade without snapshot mutation. A focused assertion begins:

```ts
expect(schema.shippingEventItems).toBeDefined();
expect(await readOldEventSnapshots(pool)).toEqual(snapshotsBeforeMigration);
await expect(insertShippingItemForReceivingEvent(pool)).rejects.toThrow();
```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/db exec vitest run test/us-shipping-schema.test.ts test/us-shipping-migration.e2e.test.ts` against a disposable migrated DB. Expect missing Shipping schema/constraint assertions, not environment errors.
- [ ] **Step 3: Implement the additive schema/migration.** Extend the common shell with a generated `shipping_root_key`, typed FK, lifecycle branch and `SHP-YY-NNNN` check; add Shipping root/detail/items/docs/status-effects tables. Use text decimal quantities and the existing UOM CHECK set. Preserve the current Receiving/Transformation checks and migration journal order.

```ts
shippingRootKey: uuid("shipping_root_key").generatedAlwaysAs(
  sql`CASE WHEN type = 'shipping' THEN root_event_id END`,
),
```

- [ ] **Step 4: Run green and gate.** `corepack pnpm --filter @markiro/db build`, focused tests, DB package test/typecheck/lint/build. Inspect generated SQL, indexes, FK deferral, migration journal and old snapshot equality. The reviewer checks upgrade and cross-type denial, not only fresh-schema success.

### Task 2: Exact lot balance and readiness rules

**Files:** Create `packages/domain/src/traceability/shipping-balance.ts`, `packages/domain/src/traceability/shipping-readiness.ts`, `packages/domain/test/us-shipping-balance.test.ts`, `packages/domain/test/us-shipping-readiness.test.ts`; modify `packages/domain/src/index.ts`.

**Interfaces:** Produce `computeShippingBalance(input: ShippingBalanceInput): ShippingBalance` and `validateShippingReadiness(input: ShippingReadinessInput): ShippingIssue[]`. `ShippingBalanceInput` is `{ contributions: readonly { quantity: string; unitOfMeasure: string }[]; deductions: readonly { quantity: string; unitOfMeasure: string }[] }`. `ShippingBalance` is `{ state: "known"; unitOfMeasure: string; supply: string; used: string; remaining: string } | { state: "unknown"; reason: "no_current_origin" | "mixed_uom" | "invalid_quantity" | "overflow" }`. `ShippingReadinessInput` carries the saved header/lines and current reference, status, coverage and balance facts; each `ShippingIssue` has a stable code, field path and optional line number. No DB access.

- [ ] **Step 1: Write failing rule tests.** Cover two `50 case` Receiving lines, one `25 case` Shipping deduction, current Transformation output/use, void/superseded exclusions supplied by caller, mixed UOM, no origin, >3 decimal places, arithmetic overflow, exact zero, candidate over-shipment and duplicate lot lines.

```ts
expect(
  computeShippingBalance({
    contributions: [
      { quantity: "50", unitOfMeasure: "case" },
      { quantity: "50", unitOfMeasure: "case" },
    ],
    deductions: [{ quantity: "25", unitOfMeasure: "case" }],
  }),
).toEqual({ state: "known", unitOfMeasure: "case", supply: "100", used: "25", remaining: "75" });
```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/domain exec vitest run test/us-shipping-balance.test.ts test/us-shipping-readiness.test.ts`; expect missing exports and failing cases.
- [ ] **Step 3: Implement pure rules.** Parse decimal strings into integer thousandths with `bigint`; reject invalid or unrepresentable sums. `validateShippingReadiness` emits stable field/line paths for missing KDEs, origin, source, blocked status, UOM mismatch/unknown balance and `quantity > remaining`. Do not reuse the per-event Transformation genealogy delta as a lot ledger.

```ts
const milli = (whole: string, fraction = "") =>
  BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
```

- [ ] **Step 4: Run green and gate.** Focused tests, `@markiro/domain` test/typecheck/lint/build. Review exact decimal output spelling, negative/zero logic and stable issue paths.

### Task 3: Current-revision ledger reader and status ownership

**Files:** Create `apps/api/src/modules/traceability/shipping/us-shipping-balance.ts`, `apps/api/src/modules/traceability/shipping/us-shipping-status-effects.ts`; modify the current U.S. lot status command only for effect invalidation and, where necessary, Receiving/Transformation lot coordination. Test `apps/api/test/us-shipping-balance.e2e.test.ts`, `apps/api/test/us-shipping-status-effects.e2e.test.ts`.

**Interfaces:** Produce `readCurrentShippingBalance(tx: UsMasterDataTransaction, tenantId: string, lotId: string, excludedShippingEventId?: string): Promise<ShippingBalance>`, `applyShippingStatusEffect(tx, tenantId, lotId, eventId, balance): Promise<void>` and `compensateShippingStatusEffect(tx, tenantId, lotId, eventId, balance): Promise<void>`. Caller holds the lot row lock. The reader selects only current finalized root revisions and exact lot UUIDs, summing all active Receiving lines, Transformation outputs and uses, and Shipping deductions. The effect service owns `active -> shipped` and narrowly authorized compensation; manual status commands invalidate an active effect under the lot lock.

- [ ] **Step 1: Write failing DB tests.** Insert two current Receiving supports, a superseded revision, Transformation input/output, a void Shipping row and a current Shipping row. Assert exact balance; assert mixed UOM is `unknown`; assert a manual recall remains after a void compensation attempt. Race a Receiving/Transformation material correction against a Shipping finalize and assert one serialized, valid outcome.

```ts
expect(await readCurrentShippingBalance(tx, tenantId, lotId)).toMatchObject({
  state: "known",
  unitOfMeasure: "case",
  remaining: "75",
});
```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/us-shipping-balance.e2e.test.ts test/us-shipping-status-effects.e2e.test.ts` with disposable DB; distinguish missing migrations from product failures.
- [ ] **Step 3: Implement bounded queries/effects.** Select current roots by `current_event_id`, `status='finalized'`, no supersession; fail closed on corrupt/orphaned references. Lock affected lots in sorted UUID order before balance reads. The status effect transition and its exact audit occur in the caller transaction; a manual status update invalidates ownership before it commits.

```ts
if (balance.state !== "known") return balance;
// Only current finalized root pointers contribute; never select by lot status alone.
```

- [ ] **Step 4: Run green and gate.** Focused API e2e, API package typecheck/lint/build and the existing Receiving/Transformation correction tests. Reviewer checks lock order, status ownership, orphan failure and cross-tenant selection.

### Task 4: Strict contracts, draft storage and saved readiness

**Files:** Create `packages/platform-contracts/src/traceability/shipping-draft.ts`, `shipping-records.ts`, `shipping-http.ts`; modify `packages/platform-contracts/src/index.ts`. Create `apps/api/src/modules/traceability/shipping/us-shipping-draft.ts`, `us-shipping-readiness.ts`; test `packages/platform-contracts/test/us-shipping-contracts.test.ts`, `apps/api/test/us-shipping-draft.e2e.test.ts`, `apps/api/test/us-shipping-readiness.e2e.test.ts`.

**Interfaces:** Produce `shippingDraftSchema`, `shippingDraftRecordSchema`, `shippingReadinessSchema`, `createShippingDraftSchema`, `saveShippingDraftSchema`; server methods `createDraft`, `saveDraft`, `checkReadiness`. Draft item input is `{ lotId, quantity, unitOfMeasure }`; all schemas `.strict()` and server-owned fields absent. Reuse `operationKey`, `expectedDraftVersion`, saved-version digest and the existing US audit pattern.

- [ ] **Step 1: Write failing contract and draft tests.** `tlc`, `productId`, `createLot`, `tenantId` and duplicate lot lines fail parsing; incomplete draft persists; cross-tenant lot/recipient/document is 404; archived reference after save becomes a readiness blocker; wrong ship-from/recipient role and same-location selection block readiness; stale version conflicts without write. Generic-profile records do not claim FDA readiness.

```ts
expect(
  shippingDraftSchema.safeParse({
    ...validDraft,
    items: [
      {
        lotId,
        quantity: "1",
        unitOfMeasure: "case",
        tlc: "NEW",
      },
    ],
  }).success,
).toBe(false);
```

- [ ] **Step 2: Run red.** Focused `@markiro/platform-contracts` and API Vitest files; expect missing schemas/commands.
- [ ] **Step 3: Implement contracts and draft/readiness.** Use exact decimal/UOM schemas, tenant-scoped reference lookups and current master-data snapshots; allow incomplete but structurally valid drafts. Saved readiness reloads current source, coverage, locations, document type/number, balance and lot status; it never trusts a client-supplied balance.

```ts
import { UOM_CODES_V1 } from "@markiro/domain";
import { traceabilityQuantitySchema } from "./event-values.js";
export const shippingItemInputSchema = z
  .object({
    lotId: platformUuidSchema,
    quantity: traceabilityQuantitySchema,
    unitOfMeasure: z.enum(UOM_CODES_V1),
  })
  .strict();
```

- [ ] **Step 4: Run green and gate.** Build contracts before API tests. Run focused suites, contract package test/typecheck/lint/build, API typecheck. Review strict unknown-key denial and no writes on conflicts.

### Task 5: Finalization, audit and U.S. HTTP boundary

**Files:** Create `apps/api/src/modules/traceability/shipping/us-shipping-finalization.ts`, `us-shipping-store.ts`, `apps/api/src/deployment/us-shipping.controller.ts`; modify `apps/api/src/deployment/us-runtime.ts`, `us-development.module.ts`, `packages/platform-contracts/src/traceability/shipping-http.ts`. Test `apps/api/test/us-shipping-finalization.e2e.test.ts`, `us-shipping-finalization-concurrency.e2e.test.ts`, `us-shipping-http.e2e.test.ts`, and applicable OpenAPI/route inventory tests.

**Interfaces:** Produce `UsShippingStore.finalize(tenantId, userId, id, command, requestId)` and controller `POST /traceability/shipments/:id/finalize`; register only in `UsDevelopmentModule`. Return a frozen finalized record or stable typed conflict. QA capability is checked server-side.

- [ ] **Step 1: Write failing HTTP/DB tests.** Finalize `100 case` with BOL/invoice; reject missing recipient/document, over-shipment, UOM mismatch, stale draft/digest, foreign tenant and wrong role. Run two concurrent `60 case` finalizations against `100 case`: exactly one succeeds. Assert exact actor/tenant/action/target/result and frozen source, recipient, document type/number/issuer snapshot fields. A post-draft archive or coverage change must be rechecked at finalization.

```ts
const results = await Promise.allSettled([
  finalizeShipment(tenantA, firstId, "60"),
  finalizeShipment(tenantA, secondId, "60"),
]);
expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
```

- [ ] **Step 2: Run red.** Focused API Vitest files with disposable DB; expect absent routes/behavior, not a service-env skip.
- [ ] **Step 3: Implement atomic finalization.** Check US session/profile/membership/capability; lock root and sorted lots, compare versions/digest, revalidate current references/balance, freeze snapshots, change root pointer and Shipping-owned status, insert audit in one transaction. Register exact `/traceability/shipments` route and body/query limits in the US-only allowlist. Update OpenAPI and the applicable route inventories; no RU module registration.

```ts
const principal = this.principal(request);
return this.runtime.databaseOperation(() =>
  this.runtime.shipping.finalize(
    principal.tenantId,
    principal.userId,
    id,
    body,
    this.requestId(request),
  ),
);
```

- [ ] **Step 4: Run green and gate.** Focused API suites, API package test/typecheck/lint/build, route/OpenAPI contracts, `tools/us-development` isolation and runtime-entry checks. Reviewer checks one-winner concurrency, error safety and audit rollback.

### Task 6: Amendment, void, compensation and bounded history

**Files:** Create `apps/api/src/modules/traceability/shipping/us-shipping-lifecycle.ts`, `apps/api/src/modules/traceability/shipping/us-shipping-history.ts`; modify `apps/api/src/modules/traceability/shipping/us-shipping-store.ts`, `apps/api/src/deployment/us-shipping.controller.ts`, status-effects integration and Shipping contracts. Test `apps/api/test/us-shipping-revisions.e2e.test.ts`, `apps/api/test/us-shipping-void.e2e.test.ts`.

**Interfaces:** Produce `amend`, `void`, `listRevisions` methods following current Transformation lifecycle command shapes. Amendment keeps the predecessor current until successor finalize; balance evaluation excludes the predecessor, then replaces it atomically. Void removes current deduction, retains frozen history and conditionally compensates only a Shipping-owned status effect.

- [ ] **Step 1: Write failing lifecycle tests.** Partial `20+30 case`, amendment `30 -> 25`, void second shipment, duplicate operation retry, stale lifecycle version, void draft and manual recall before void. Compare historical snapshots before/after byte-for-byte. Shipping is terminal in this P0 event set: test that no fictitious downstream blocker is returned; retain the existing bounded blocker contract for any actual future consumer rather than claiming one exists today.

```ts
expect(await readCurrentShippingBalance(tx, tenantId, lotId)).toMatchObject({
  state: "known",
  remaining: "55",
});
expect(await readHistoricalSnapshot(firstRevisionId)).toEqual(frozenBeforeAmend);
```

- [ ] **Step 2: Run red.** Focused API lifecycle suites; expect unsupported commands or failing effects.
- [ ] **Step 3: Implement lifecycle.** Use root/lot locks and stable operation receipts; a pending amendment never withdraws the predecessor. Replace only current effects on successor finalization; preserve historical rows. Void with a reason, check downstream consumers, mark status effect compensated only when still owned, and return bounded blockers.

```ts
if (currentRoot.pendingDraftId !== null) {
  throw new ConflictException({
    code: "shipping_pending_amendment",
    pendingDraftId: currentRoot.pendingDraftId,
  });
}
```

- [ ] **Step 4: Run green and gate.** Focused and full API package checks plus Receiving/Transformation amendment/void regressions. Reviewer checks pinned history, manual controls, race order and audit metadata.

### Task 7: Unified Events contract and safe browser proxy

**Files:** Modify `packages/platform-contracts/src/traceability/events.ts`, `apps/api/src/modules/traceability/events/us-events-registry.ts`, `us-events-store.ts`, `apps/admin/src/us/client.ts`, `apps/admin/vite.us.config.ts`, `tools/us-development/test/browser-entry.test.mjs`. Test `packages/platform-contracts/test/us-events.test.ts`, `apps/api/test/us-events-registry.e2e.test.ts`, `us-events-http.e2e.test.ts`, `apps/admin/test/us-events-client.test.ts`, `us-shipping-client.test.ts`.

**Interfaces:** Extend `UsEventSummary` and `usEventListQuerySchema` with `shipping`; preserve Receiving/Transformation shapes and paging. Add strict client methods `list/get/create/save/readiness/finalize/amend/void/revisions` for Shipping. Proxy accepts only bounded US Shipping paths and rejects arbitrary query keys, duplicate keys and extra path segments.

- [ ] **Step 1: Write failing contract/proxy tests.** Mixed list is stable and tenant-scoped; Shipping filter includes Shipping only; old types parse unchanged. Proxy accepts exact method/path pairs and rejects `tenantId`, path traversal, unknown action and malformed UUID.

```ts
expect(usEventListQuerySchema.parse({ type: "shipping" }).type).toBe("shipping");
let status = 0;
middleware(
  { url: "/api/us/traceability/shipments?tenantId=other" },
  {
    writeHead(code) {
      status = code;
    },
    end() {},
  },
  () => assert.fail("Unknown route reached fallback"),
);
assert.equal(status, 404);
```

- [ ] **Step 2: Run red.** Focused contract/API/admin Vitest and `node --test tools/us-development/test/browser-entry.test.mjs`.
- [ ] **Step 3: Implement union, registry, client and allowlist.** Add Shipping summary selection from typed roots/current pointer, document and line counts; preserve consistent root snapshots and history paging. Match the client response/error schemas to the server, with no generic forwarding escape hatch.

```ts
type ShippingSummary = Extract<UsEventSummary, { type: "shipping" }>;
```

- [ ] **Step 4: Run green and gate.** Build contracts before API/admin, run focused suites and US isolation/proxy tests. Reviewer checks no unrelated Receiving/Transformation list regression or RU route exposure.

### Task 8: Shipping office workflow, smoke and evidence

**Files:** Create `apps/admin/src/us/shipping/editor.tsx`, `readiness-panel.tsx`, `detail.tsx`, `revision-history.tsx`, `copy.ts`, `shipping.css`. Modify `apps/admin/src/us/events/events-view.tsx`, `apps/admin/src/us/events/copy.ts`, `apps/admin/src/us/app.tsx`. Test `apps/admin/test/us-shipping-editor.test.tsx`, `us-shipping-readiness.test.tsx`, `us-shipping-detail.test.tsx`, `us-shipping-history.test.tsx`, `us-events-ui.test.tsx`; create `tools/us-development/test/shipping-flow.smoke.mjs`; modify `tools/us-development/test/isolation.test.mjs` and `.github/workflows/us-development.yml` to own the new checks. Update `docs/us/implementation-plan.md` and `docs/us/requirements-traceability.md` only with evidence actually achieved.

**Interfaces:** `ShippingRecordView` consumes the strict U.S. client, `UsEventSummary` and current user capabilities; it never creates a TLC or selects a case ID. Existing Events remains the entry point for all three CTE types.

- [ ] **Step 1: Write failing UI tests.** Existing-lot picker, exact `100 case` quantity, recipient and BOL/invoice, saved readiness blockers, finalize/amend/void reason dialogs, frozen detail/history, keyboard focus and EN/ES text. Assert no TLC-create or SSCC-selection control and no assertion that linked cases were shipped.

```tsx
expect(screen.getByRole("button", { name: /new shipment/i })).toBeEnabled();
expect(screen.queryByRole("button", { name: /create TLC/i })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run red.** Focused admin Vitest files after dependency builds; expect missing Shipping workflow.
- [ ] **Step 3: Implement scoped UI.** Reuse `@markiro/ui`, Events selection and client/error patterns. Keep components focused on editor, readiness, frozen detail and history; use `events/copy.ts` plus Shipping EN/ES copy. Keep exact identifiers and quantities unlocalized.

```tsx
<ShippingRecordView client={client} eventId={selected.id} onClose={backToEvents} />
```

- [ ] **Step 4: Run green and browser gate.** Focused and full admin test/typecheck/lint/build, isolated US build, `node --test tools/us-development/test/browser-entry.test.mjs`, and a disposable-DB browser walk through draft, readiness, QA finalize, mixed Events, history, EN/ES and 1024px layout. Record screenshots only as browser evidence, not physical/deployed evidence.
- [ ] **Step 5: Final diff/evidence review.** Run `corepack pnpm format:check`, `git diff --check`, applicable isolation checks and changed-package gates; inspect the complete diff against the spec and existing user changes. Update requirement status only to the level actually verified. Do not commit, push, create a PR, merge or deploy without separate authorization.

## Handoff after implementation

The primary agent reviews each task's tests and diff before the next implementer begins, then performs a final cross-task review of tenant boundaries, current-revision arithmetic, exact audit, EN/ES UI, and isolation. Final report separates automated tests, disposable-DB/browser checks, skipped infrastructure checks and external/physical checks. Passing local gates does not mark US-05 or the MVP released.
