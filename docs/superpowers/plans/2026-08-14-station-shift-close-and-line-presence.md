# Station Shift Close and Line Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make station shifts distinguishable, let a single-device shift close fully offline with a durable summary and conditional fixed reason, reconcile stale multi-device closes in the cabinet, and show trustworthy line presence.

**Architecture:** Stable close-reason rules live in `@markiro/domain`. Postgres records device participation and idempotent station-close events; SQLite records the operator's local close before any network call. The existing serialized station sync drains earlier shift facts before a dedicated close endpoint, while an independent one-minute heartbeat updates the already-authoritative station `lastSeenAt`. The cabinet derives line presence and exposes multi-device close reconciliation.

**Tech Stack:** TypeScript 6, React 19, NestJS 11, Drizzle/Postgres, station SQLite via Tauri SQL, TanStack Query, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-14-station-shift-close-and-line-presence-design.md`

## Global Constraints

- Station close is offline-first; no network check may gate the local commit.
- Only single-device shifts may be closed by Station; a second distinct device makes closing permanently administrator-only.
- Missing plan or equal plan/actual needs no reason; unequal plan/actual requires one of the six fixed domain codes and never free text.
- An open aggregation box blocks shift close.
- Local actual and box counts come from durable SQLite after the ordered scan queue settles.
- Normal scan, box, and exception facts for a shift reach the server before its close event.
- Line presence is informational, tenant-scoped, and based on authenticated heartbeat: 60-second heartbeat, 2-minute online threshold.
- Shift selection and close UI remain fixed at 1280×800 with no scrolling or clipped floor actions.
- Postgres and SQLite migrations are additive; do not rewrite migration `0041` or earlier.
- Preserve old Station/API rolling compatibility and the existing late-data behavior.

---

### Task 1: Shared shift-close reason contract

**Files:**
- Create: `packages/domain/src/shift-close.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/shift-close.test.ts`

**Interfaces:**
- Produces: `SHIFT_CLOSE_REASON_CODES`, `ShiftCloseReasonCode`, `isShiftCloseReasonCode(value)`, and `shiftCloseReasonRequired(plannedQty, actualQty)`.
- Consumed by: API DTO/service validation, Station summary UI, and Admin conflict labels.

- [ ] **Step 1: Write the failing domain tests**

Cover literal expected behavior rather than testing the constants themselves:

```ts
expect(shiftCloseReasonRequired(null, 12)).toBe(false);
expect(shiftCloseReasonRequired(12, 12)).toBe(false);
expect(shiftCloseReasonRequired(12, 11)).toBe(true);
expect(isShiftCloseReasonCode("equipment_stop")).toBe(true);
expect(isShiftCloseReasonCode("operator typed arbitrary text")).toBe(false);
```

- [ ] **Step 2: Run RED**

Run: `corepack pnpm --filter @markiro/domain exec vitest run test/shift-close.test.ts`

Expected: FAIL because `src/shift-close.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal shared contract**

Use one readonly tuple with exactly these codes:

```ts
export const SHIFT_CLOSE_REASON_CODES = [
  "production_defect",
  "material_shortage",
  "equipment_stop",
  "production_order_changed",
  "planned_quantity_error",
  "other_production_deviation",
] as const;

export type ShiftCloseReasonCode = (typeof SHIFT_CLOSE_REASON_CODES)[number];

export function shiftCloseReasonRequired(plannedQty: number | null, actualQty: number): boolean {
  return plannedQty !== null && plannedQty !== actualQty;
}
```

Implement the type guard with membership against the tuple and export the module from `src/index.ts`.

- [ ] **Step 4: Run GREEN and package gates**

Run:

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/shift-close.test.ts
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/shift-close.ts packages/domain/src/index.ts packages/domain/test/shift-close.test.ts
git commit -m "feat(domain): define station shift close reasons"
```

---

### Task 2: Additive Postgres and SQLite persistence

**Files:**
- Modify: `packages/db/src/schema/platform.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/sqlite/migrations.ts`
- Modify: `packages/db/src/sqlite/schema.ts`
- Create: `packages/db/migrations/0043_station_shift_close_presence.sql`
- Create: `packages/db/migrations/meta/0043_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/station-shift-close-schema.test.ts`
- Modify: `packages/db/test/station-sync-recovery-schema.test.ts`

**Interfaces:**
- Produces Postgres: `shiftDeviceParticipants`, `stationShiftCloseEvents`, and new close-authority fields on `shifts`; the event ledger is the authoritative store for accepted close snapshots.
- Produces SQLite: `shift_close_outbox`, close-authority fields on `shift_mirror`.
- Consumed by: Tasks 3–6.

- [ ] **Step 1: Write failing schema and migration tests**

Assert observable schema behavior:

- participant uniqueness is `(tenant_id, shift_id, device_id)`;
- participant shift/device foreign keys are composite tenant keys;
- `shifts.station_close_policy` defaults to `single_device` and owner is nullable;
- station close event identity is tenant + device + event id, with payload digest and outcome/conflict fields;
- SQLite migration creates `shift_close_outbox` with `pending | conflict`, fixed snapshot fields, and one row per `event_id`;
- running all SQLite migrations twice remains idempotent;
- the next Postgres migration is journal index 42 and earlier entries remain byte-for-byte present.

- [ ] **Step 2: Run RED**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/station-shift-close-schema.test.ts test/station-sync-recovery-schema.test.ts
```

Expected: FAIL on missing schema objects and SQLite columns/table.

- [ ] **Step 3: Implement Drizzle schema**

Add:

```ts
export const stationClosePolicy = pgEnum("station_close_policy", [
  "single_device",
  "admin_only",
]);
export const stationShiftCloseOutcome = pgEnum("station_shift_close_outcome", [
  "accepted",
  "conflict",
  "dismissed",
  "resolved",
]);
```

Extend `shifts` with `stationClosePolicy` and `stationCloseOwnerDeviceId`. Keep close source, device, operator, plan, actual, closed-box count, fixed reason code, and accepted event id in `station_shift_close_events` so the snapshot has one authoritative row and cannot drift from its idempotency ledger. Add tenant-scoped indexes needed by list/reconciliation queries.

Create `shift_device_participants` with first/last entry timestamps. Create `station_shift_close_events` with the normalized payload snapshot, SHA-256 digest, outcome, nullable bounded conflict code (`multiple_devices`), recorded/resolved timestamps, and resolving cabinet user id. Keep the event row as the idempotency ledger and reconciliation source; do not add a second competing conflict table.

- [ ] **Step 4: Generate and inspect migration 0042**

Run: `corepack pnpm --filter @markiro/db db:generate -- --name station_shift_close_presence`

Rename only if Drizzle does not emit the declared `0043_station_shift_close_presence.sql` tag, then reconcile the snapshot and `_journal.json` together. Inspect SQL for additive enums/tables/columns, tenant composite foreign keys, unique keys, defaults, and indexes. Do not edit migrations `0000`–`0042`.

- [ ] **Step 5: Add the SQLite runtime migration**

Add idempotent `ALTER TABLE shift_mirror ADD COLUMN ...` statements for:

```text
station_close_policy
station_close_owner_device_id
```

Add `shift_close_outbox` with:

```text
event_id, shift_id, device_id, operator_id,
product_id, product_name, planned_qty_snapshot, actual_qty,
closed_box_count, reason_code, closed_at,
state, conflict_code, last_checked_at
```

Use `event_id` as the primary key and add an index on `(state, closed_at)` for the drain. Older rows with no close descriptor must read as administrator-only in application code.

- [ ] **Step 6: Run GREEN and DB gates**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/station-shift-close-schema.test.ts test/station-sync-recovery-schema.test.ts
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
git diff --check
```

Expected: all pass; database-backed skips, if any, are reported explicitly.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/src/schema.ts packages/db/src/sqlite/migrations.ts packages/db/src/sqlite/schema.ts packages/db/migrations/0043_station_shift_close_presence.sql packages/db/migrations/meta/0043_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/station-shift-close-schema.test.ts packages/db/test/station-sync-recovery-schema.test.ts
git commit -m "feat(db): persist station shift close events"
```

---

### Task 3: Record station entry and publish close authority

**Files:**
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/shifts/shifts.module.ts`
- Modify: `apps/api/test/shifts.controller.test.ts`
- Modify: `apps/api/test/shifts.service.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**
- Produces: `StationCloseAccess`, additive `ShiftDto.stationCloseAccess`, and `POST /shifts/:id/enter`.
- `enterShift(tenantId, shiftId, deviceId)` opens planned shifts, upserts participation, irreversibly promotes a second-device shift to `admin_only`, and returns the shift DTO.
- Consumed by: Station selection/bundle in Tasks 5–6.

- [ ] **Step 1: Write failing service/controller tests**

Add literal scenarios:

- first authenticated device entering a planned shift opens it and receives `{kind: "single_device", ownerDeviceId: deviceA}`;
- same device re-entering is idempotent and updates only `lastEnteredAt`;
- device B entering changes policy to `{kind: "admin_only"}`;
- device A entering again never downgrades it;
- station entry is line-scoped and foreign/cross-tenant ids are indistinguishable 404s;
- a cabinet session cannot use the station-only entry route;
- old station-authenticated `POST /shifts/:id/open` still records device A;
- list/get bundle expose the descriptor without N+1 queries.

- [ ] **Step 2: Run RED**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/shifts.controller.test.ts test/shifts.service.test.ts test/shifts.e2e.test.ts
```

Expected: focused assertions fail on absent route/descriptor/participant writes; e2e skips only when its declared DB environment is absent.

- [ ] **Step 3: Implement entry transaction and DTO mapping**

Add:

```ts
export type StationCloseAccess =
  | { kind: "single_device"; ownerDeviceId: string }
  | { kind: "admin_only" };
```

Use one Postgres transaction with a shift row lock. Upsert the authenticated device participant, claim an empty owner, and set `admin_only` when the owner differs. Planned becomes active in the same transaction. The service reloads the tenant-scoped joined DTO after commit.

Keep the old open route contract. Pass `req.deviceId` only for station auth and record participation there; cabinet open retains its existing behavior.

- [ ] **Step 4: Run GREEN and focused authorization tests**

Run the RED command again, then:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shifts apps/api/test/shifts.controller.test.ts apps/api/test/shifts.service.test.ts apps/api/test/shifts.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): track station shift participation"
```

---

### Task 4: Idempotent station close endpoint and cabinet reconciliation API

**Files:**
- Create: `apps/api/src/modules/station-shift-close/dto.ts`
- Create: `apps/api/src/modules/station-shift-close/station-shift-close.service.ts`
- Create: `apps/api/src/modules/station-shift-close/station-shift-close.controller.ts`
- Create: `apps/api/src/modules/station-shift-close/station-shift-close.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/authorization/security-audit.service.ts`
- Create: `apps/api/test/station-shift-close.service.test.ts`
- Create: `apps/api/test/station-shift-close.e2e.test.ts`
- Modify: `apps/api/test/openapi-docs.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**
- Produces station endpoint: `POST /station/shift-closures`.
- Request: `{ eventId, shiftId, operatorId, plannedQtySnapshot, actualQty, closedBoxCount, reasonCode, closedAt }`. Product and tenant metadata are resolved from the locked tenant-scoped shift, never trusted from the device body.
- Response: `{ outcome: "accepted" | "already_resolved" | "conflict"; conflictCode?: "multiple_devices" }`.
- Produces cabinet endpoints: `GET /shift-close-conflicts`, `POST /shift-close-conflicts/:eventId/dismiss`.

- [ ] **Step 1: Write failing DTO/service tests**

Cover:

- malformed UUID/date/counts and arbitrary reason text are rejected;
- a missing/equal plan accepts null reason, mismatch requires a valid reason;
- body tenant/device ids are not accepted at all;
- single-device event closes the active tenant shift and stores exact snapshots/audit metadata;
- exact event redelivery returns an idempotent acknowledgement;
- same event id with a different normalized digest is rejected without mutating the shift;
- second participant or foreign terminal evidence creates one conflict and keeps the shift active;
- an already cabinet-closed shift acknowledges without reopening;
- session auth cannot call the station endpoint and station auth cannot call cabinet reconciliation;
- dismissal is tenant-scoped and audited.

- [ ] **Step 2: Run RED**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/station-shift-close.service.test.ts test/station-shift-close.e2e.test.ts
```

Expected: FAIL because the module and routes do not exist.

- [ ] **Step 3: Implement the station service transaction**

Use a normalized payload serializer and SHA-256 digest. Claim the event id inside the same transaction that locks and closes/checks the shift. Resolve participant evidence from `shift_device_participants`, code ownership, and box terminal ids. Attribute the caller from `req.deviceId`; validate the operator tenant membership without replacing historical device evidence when an operator has since been archived.

For `multiple_devices`, persist one conflict event and return `conflict`. For acceptance, update `shifts.status`, `closedAt`, `closeReason`, and the structured close snapshot fields. Preserve current subscription recovery semantics and late-data behavior.

- [ ] **Step 4: Implement reconciliation read/dismiss**

List only conflict outcomes for the current tenant, newest first. Return product/line/device/operator names by tenant-scoped joins. Dismiss changes only conflict outcome and resolution audit fields; closing the shift through the existing cabinet action changes a matching conflict to `resolved` in the same service transaction or a narrowly coordinated helper.

- [ ] **Step 5: Run GREEN and API gates**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/station-shift-close.service.test.ts test/station-shift-close.e2e.test.ts test/openapi-docs.test.ts test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/station-shift-close apps/api/src/app.module.ts apps/api/src/authorization/security-audit.service.ts apps/api/test/station-shift-close.service.test.ts apps/api/test/station-shift-close.e2e.test.ts apps/api/test/openapi-docs.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): reconcile offline station shift closes"
```

---

### Task 5: Durable Station close summary and outbox

**Files:**
- Create: `apps/station/src/lib/shift-close-outbox.ts`
- Modify: `apps/station/src/lib/mirror.ts`
- Modify: `apps/station/src/lib/shift-bundle.ts`
- Create: `apps/station/test/shift-close-outbox.test.ts`
- Modify: `apps/station/test/mirror.test.ts`
- Modify: `apps/station/test/shift-bundle.test.ts`
- Modify: `apps/station/test/credential-recovery.test.ts`

**Interfaces:**
- Produces: `readShiftCloseSummary(exec, shiftId, terminalId)`, `enqueueShiftClose(exec, input)`, `readEligibleShiftCloses(exec, limit)`, `markShiftCloseConflict(...)`, `ackShiftClose(...)`, and `readLocallyClosedShiftIds(exec)`.
- Consumed by: sync engine and UI in Tasks 6–7.

- [ ] **Step 1: Write failing SQLite behavior tests**

Use real in-memory SQLite. Assert:

- actual quantity counts current `codes_mirror` rows for the shift after undo removal;
- box count excludes open and disassembled boxes and is terminal-scoped;
- an open box blocks close summary eligibility;
- enqueue stores exact plan/product/operator/reason snapshots and survives a new executor instance;
- locally closed ids hide a stale active server item after restart;
- missing descriptor reads as `admin_only`, omitted bundle descriptor preserves the previous value, and explicit `admin_only` cannot downgrade;
- a conflict remains locally hidden from the working list and becomes eligible for a bounded resolution recheck after five minutes;
- credential scrub waits in-flight writes and removes close rows without late repopulation.

- [ ] **Step 2: Run RED**

Run:

```bash
corepack pnpm --filter @markiro/station exec vitest run test/shift-close-outbox.test.ts test/mirror.test.ts test/shift-bundle.test.ts test/credential-recovery.test.ts
```

Expected: FAIL on missing close-outbox functions/table/descriptor fields.

- [ ] **Step 3: Implement close-outbox helpers**

Keep SQL in the narrow new module. Validate every SQLite row before returning it. `enqueueShiftClose` performs one durable insert after callers have paused scanner input and settled the scan queue. Use UUID generation already supported by the station runtime; do not derive identity from rowids.

Pending-close eligibility requires no unacknowledged `outbox`, `boxes_mirror`, or `box_exceptions_mirror` row for the same shift. It must not wait for unrelated shifts. Conflict rows use the same idempotent endpoint for resolution checks no more than once every five minutes; `last_checked_at` is updated only after a validated conflict response.

- [ ] **Step 4: Wire mirror compatibility and credential recovery**

Thread the close descriptor through `StationBundle`, `mirrorShiftBundle`, and `readShiftContext`. Preserve `undefined`, publish explicit values, and treat never-published as administrator-only. Add close-table clearing to the same credential-generation barrier as journal/box/image clearing.

- [ ] **Step 5: Run GREEN and Station data-layer gates**

Run the RED command again, then:

```bash
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
```

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/lib/shift-close-outbox.ts apps/station/src/lib/mirror.ts apps/station/src/lib/shift-bundle.ts apps/station/test/shift-close-outbox.test.ts apps/station/test/mirror.test.ts apps/station/test/shift-bundle.test.ts apps/station/test/credential-recovery.test.ts
git commit -m "feat(station): persist offline shift closes"
```

---

### Task 6: Close synchronization and reliable station heartbeat

**Files:**
- Modify: `apps/station/src/lib/sync.ts`
- Modify: `apps/station/src/lib/use-sync-engine.ts`
- Create: `apps/station/src/lib/use-station-heartbeat.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/test/sync.test.ts`
- Modify: `apps/station/test/use-sync-engine.test.tsx`
- Create: `apps/station/test/use-station-heartbeat.test.tsx`
- Create: `apps/api/src/modules/station-devices/station-heartbeat.controller.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.module.ts`
- Modify: `apps/api/test/station-auth.e2e.test.ts`

**Interfaces:**
- Sync consumes Task 5 close helpers and Task 4 response.
- Heartbeat hook calls `POST /station/heartbeat` every 60,000 ms while a paired credential generation is current.

- [ ] **Step 1: Write failing sync ordering tests**

Prove with interleaving, not mock call counts alone:

- a close is not posted while its shift has an unacknowledged scan/box/exception;
- after those acknowledgements, the close posts without waiting for another shift's queue;
- network failure leaves it pending and backoff retries;
- restart resends the same event id;
- `accepted`/`already_resolved` removes the row only after response validation;
- `conflict` changes it to durable conflict state and a five-minute recheck later removes it only after `already_resolved`;
- credential rejection seals the generation and prevents post-scrub writes.

- [ ] **Step 2: Run close-sync RED**

Run: `corepack pnpm --filter @markiro/station exec vitest run test/sync.test.ts test/use-sync-engine.test.tsx`

Expected: new close assertions fail while existing scan sync remains green.

- [ ] **Step 3: Extend the serialized drain minimally**

After ordinary batch work, read one eligible close event and call `/station/shift-closures`. Validate the response shape before ack/conflict writes. Fold close pending state into the existing `SyncState.pending` count so the status bar remains truthful, but do not expose a second competing sync engine.

- [ ] **Step 4: Write heartbeat RED tests**

With fake timers assert immediate startup heartbeat, 60-second cadence, no overlapping requests, cleanup on unmount, quiet network failure, retry on the next cadence, and credential rejection entering the existing recovery path.

- [ ] **Step 5: Implement station/API heartbeat**

Add a station-only 204 endpoint with no body. Let `TenantGuard` perform the authoritative `lastSeenAt` update. Mount one heartbeat hook at the paired App boundary, independent of screen and queue state. Do not durably enqueue heartbeat or use `navigator.onLine` as authority.

- [ ] **Step 6: Run GREEN**

Run:

```bash
corepack pnpm --filter @markiro/station exec vitest run test/sync.test.ts test/use-sync-engine.test.tsx test/use-station-heartbeat.test.tsx
corepack pnpm --filter @markiro/api exec vitest run test/station-auth.e2e.test.ts
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/api typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/lib/sync.ts apps/station/src/lib/use-sync-engine.ts apps/station/src/lib/use-station-heartbeat.ts apps/station/src/App.tsx apps/station/test/sync.test.ts apps/station/test/use-sync-engine.test.tsx apps/station/test/use-station-heartbeat.test.tsx apps/api/src/modules/station-devices/station-heartbeat.controller.ts apps/api/src/modules/station-devices/station-devices.module.ts apps/api/test/station-auth.e2e.test.ts
git commit -m "feat(station): sync shift closes and heartbeat"
```

---

### Task 7: Shift cards, separate pause/close, and close summary UI

**Files:**
- Modify: `apps/station/src/pages/ShiftSelection.tsx`
- Modify: `apps/station/src/ui/ShiftCard.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/ui/work/WorkFooter.tsx`
- Modify: `apps/station/src/ui/work/work-labels.ts`
- Create: `apps/station/src/ui/work/ShiftCloseDialog.tsx`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/dev/StationScreenGallery.tsx`
- Modify: `apps/station/src/dev/gallery-fixtures.ts`
- Modify: `apps/station/test/shift-selection.test.tsx`
- Modify: `apps/station/test/work-instruments.test.tsx`
- Modify: `apps/station/test/work-screen.test.tsx`
- Modify: `apps/station/test/App.test.tsx`
- Modify: `apps/station/test/screen-gallery.test.tsx`

**Interfaces:**
- `ShiftCard` gains status, mode, planned date, planned quantity, and translated labels.
- `WorkFooter` receives separate `onPause` and `onClose` callbacks.
- `ShiftCloseDialog` receives the durable summary and emits cancel or a valid nullable reason code.

- [ ] **Step 1: Write card metadata RED tests**

Render complete API-shaped fixtures and assert:

- planned/active cards say `Not started`/`In progress` in English and their Russian equivalents;
- date is locale-formatted from `YYYY-MM-DD` without UTC day drift;
- missing date says `No date`/`Без даты`;
- quantity and missing-plan copy are distinct;
- validation/aggregation labels differ;
- locally close-pending ids are absent;
- three-card pagination remains unchanged.

- [ ] **Step 2: Run card RED and implement minimal card UI**

Run: `corepack pnpm --filter @markiro/station exec vitest run test/shift-selection.test.tsx`

Expected: FAIL on missing metadata. Add typed fields/labels and a compact metadata grid; then rerun to GREEN.

- [ ] **Step 3: Write pause/close summary RED tests**

Cover real rendered behavior:

- Pause exits without enqueueing or posting close;
- Close pauses scanner intake, waits an in-flight journal write, then reads the durable summary;
- no-plan and equal-plan summaries need no reason;
- mismatch shows six translated touch choices, requires exactly one, and has no textbox;
- validation omits box statistics; aggregation shows closed boxes and `—` average for zero;
- open box blocks the local insert and points to close/clear controls;
- known admin-only policy creates no close event;
- storage failure stays in work and resumes scanning after dismissal;
- successful insert exits and shows network-neutral automatic-sync confirmation;
- focused buttons blur after activation so scanner Enter cannot retrigger them.

- [ ] **Step 4: Run close UI RED**

Run:

```bash
corepack pnpm --filter @markiro/station exec vitest run test/work-instruments.test.tsx test/work-screen.test.tsx test/App.test.tsx
```

Expected: FAIL because the footer and dialog do not yet separate actions.

- [ ] **Step 5: Implement the dialog and flow**

Reuse `@markiro/ui` Card/Button/Alert primitives and the existing cached `ProductImage`. Do not put SQL into the dialog. `WorkScreen` owns scan-input pausing/queue settling, asks Task 5 for the summary, and calls Task 5 enqueue only after valid confirmation. `App` clears active shift state only after enqueue success.

Replace the old `pauseFinish` copy with explicit labels while preserving the pending-sync warning on Pause. Close never warns about network backlog because its durability contract is the local insert.

- [ ] **Step 6: Add fixed-viewport gallery coverage**

Add gallery states for metadata cards, equal-plan close, mismatch reason selection, open-box blocker, and admin-only close. Assert the 1280×800 root has no vertical overflow and footer/dialog actions stay within bounds.

- [ ] **Step 7: Run GREEN and Station UI gates**

Run:

```bash
corepack pnpm --filter @markiro/station exec vitest run test/shift-selection.test.tsx test/work-instruments.test.tsx test/work-screen.test.tsx test/App.test.tsx test/screen-gallery.test.tsx
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
```

- [ ] **Step 8: Commit**

```bash
git add apps/station/src/pages/ShiftSelection.tsx apps/station/src/ui/ShiftCard.tsx apps/station/src/pages/WorkScreen.tsx apps/station/src/ui/work/WorkFooter.tsx apps/station/src/ui/work/work-labels.ts apps/station/src/ui/work/ShiftCloseDialog.tsx apps/station/src/station.css apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/dev/StationScreenGallery.tsx apps/station/src/dev/gallery-fixtures.ts apps/station/test/shift-selection.test.tsx apps/station/test/work-instruments.test.tsx apps/station/test/work-screen.test.tsx apps/station/test/App.test.tsx apps/station/test/screen-gallery.test.tsx
git commit -m "feat(station): close shifts with offline summary"
```

---

### Task 8: Cabinet line presence and close-conflict resolution

**Files:**
- Modify: `apps/api/src/modules/lines/dto.ts`
- Modify: `apps/api/src/modules/lines/lines.service.ts`
- Create: `apps/api/test/lines.service.test.ts`
- Create: `apps/api/test/lines.e2e.test.ts`
- Modify: `apps/admin/src/pages/shifts/api.ts`
- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/pages/shifts/shifts.css`
- Modify: `apps/admin/src/pages/lines/index.tsx`
- Modify: `apps/admin/src/pages/lines/lines.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/lines-api.test.tsx`
- Modify: `apps/admin/test/lines.test.tsx`
- Modify: `apps/admin/test/shifts.test.tsx`

**Interfaces:**
- `LineDto.presence`: `{status, onlineStations, totalStations, lastSeenAt}`.
- Admin close-conflict hooks consume Task 4 cabinet endpoints and invalidate both conflict and shift queries after close/dismiss.

- [ ] **Step 1: Write API presence RED tests**

With a fixed clock assert tenant-safe aggregation:

- no assigned stations => `unassigned`;
- one last seen exactly 120 seconds ago => online;
- 120 seconds plus 1 ms => offline;
- one recent of two assigned => online with `1/2`;
- revoked/unpaired/foreign-tenant devices do not count;
- `lastSeenAt` is the newest eligible station timestamp.

- [ ] **Step 2: Run RED and implement one joined aggregate query**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/lines.service.test.ts test/lines.e2e.test.ts`

Expected: FAIL on missing presence. Implement a tenant-scoped grouped join/aggregate without per-line queries, then rerun GREEN.

- [ ] **Step 3: Write Admin RED tests**

Assert the real tables show:

- `Online · 1 of 2 stations`, `Offline · last seen …`, and `No stations assigned`;
- text remains present independently of badge color;
- one-minute polling refreshes stale presence;
- an active shift with a close conflict shows device, operator, plan, actual, boxes, reason, and close time;
- Dismiss and existing cabinet Close are separately authorized actions;
- success invalidates the relevant lists; server error keeps details visible.

- [ ] **Step 4: Implement Admin presence and reconciliation UI**

Extend the existing shared shifts API module rather than creating an uncoordinated fetch layer. Use `refetchInterval: 60_000` for lines. Reuse translated close-reason labels from a small Admin mapping keyed by the domain type; do not accept/render arbitrary device text as a reason.

- [ ] **Step 5: Run GREEN and Admin gates**

Run:

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/lines-api.test.tsx test/lines.test.tsx test/shifts.test.tsx
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/lines apps/api/test/lines.service.test.ts apps/api/test/lines.e2e.test.ts apps/admin/src/pages/shifts apps/admin/src/pages/lines apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/lines-api.test.tsx apps/admin/test/lines.test.tsx apps/admin/test/shifts.test.tsx
git commit -m "feat(admin): show line presence and close conflicts"
```

---

### Task 9: CORS, contracts, documentation, and release gates

**Files:**
- Modify: `apps/api/src/cors.ts`
- Modify: `apps/api/test/cors-station-surface.test.ts`
- Modify: `apps/api/test/cors.e2e.test.ts`
- Modify: `tools/station-release/verify-api-cors.mjs`
- Modify: `tools/station-release/test/verify-api-cors.test.mjs`
- Modify: `tools/station-release/test/workflow.test.mjs`
- Modify: `docs/device-key-surface.md`
- Modify: `docs/architecture.md`
- Modify: `apps/station/README.md`

**Interfaces:**
- Adds Station preflight inventory for `POST /shifts/:id/enter`, `POST /station/shift-closures`, and `POST /station/heartbeat`.
- Preserves the already-implemented product-image GET preflight from commit `33ffb5a1f`.

- [ ] **Step 1: Add failing route/CORS contract cases**

Add exact positive methods/paths/headers and adjacent negative methods/suffixes. The production verifier uses sentinel UUIDs and never sends credentials. Update route inventory and OpenAPI assertions from Task 4 rather than source-text grep checks.

- [ ] **Step 2: Run RED**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/cors-station-surface.test.ts test/cors.e2e.test.ts
corepack pnpm test:station-release:contract
```

Expected: new route probes fail before the CORS matcher/verifier is extended.

- [ ] **Step 3: Implement exact CORS paths and docs**

Allow only the declared methods on exact canonical paths. Update the device-key surface with entry/heartbeat/close-sync trust boundaries, architecture with offline close ordering and stale multi-device reconciliation, and Station README with the operator workflow and heartbeat semantics.

- [ ] **Step 4: Run focused final verification**

Build dependencies first so consumers do not use stale workspace output:

```bash
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/ui build
corepack pnpm --filter @markiro/api exec vitest run test/cors-station-surface.test.ts test/cors.e2e.test.ts test/shifts.e2e.test.ts test/station-shift-close.e2e.test.ts test/lines.e2e.test.ts
corepack pnpm --filter @markiro/station exec vitest run test/shift-close-outbox.test.ts test/sync.test.ts test/shift-selection.test.tsx test/work-screen.test.tsx test/screen-gallery.test.tsx
corepack pnpm --filter @markiro/admin exec vitest run test/lines.test.tsx test/shifts.test.tsx
corepack pnpm test:station-release:contract
```

Record database skips and environment failures separately; do not call skipped e2e or Windows behavior verified.

- [ ] **Step 5: Run package and repository gates**

```bash
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/station test
corepack pnpm --filter @markiro/admin test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/station build
corepack pnpm --filter @markiro/admin build
corepack pnpm format:check
git diff --check
```

- [ ] **Step 6: Commit contracts/docs**

```bash
git add apps/api/src/cors.ts apps/api/test/cors-station-surface.test.ts apps/api/test/cors.e2e.test.ts tools/station-release/verify-api-cors.mjs tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs docs/device-key-surface.md docs/architecture.md apps/station/README.md
git commit -m "docs: record offline shift close contracts"
```

- [ ] **Step 7: Independent review and external acceptance handoff**

Request a scoped code review against the design and plan. Resolve Critical/Important findings with a fresh RED/GREEN cycle. Report Windows 1280×800, two-device, offline restart, live production heartbeat, and production deployment checks as pending until actually exercised.
