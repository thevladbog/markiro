# Device retention selection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Keep changes local and uncommitted until the user requests push/PR.

**Goal:** Save an explicit complete set of working devices for a server-derived future reduction of licensed capacity, with preview, revision-safe confirmation and truthful shadow-only effects.

**Architecture:** Delivery 3 of the approved P1B.2 design. A dedicated retention owner shares the authoritative entitlement projection, quota/timeline locks and fresh licensing authorization. It persists intent and an immutable journal; pairing, credentials and operational enforcement retain their existing owners.

**Tech Stack:** Node 24, pnpm 11.22.0, NestJS, Drizzle/PostgreSQL, strict Zod, React/TanStack Query, @markiro/ui, Vitest.

**Spec:** [Approved P1B.2 design](../specs/2026-09-12-entitlements-p1b2-device-licensing-design.md), sections 1, 3, 7–10, and FR-DEV-05/FR-LIF-07. User requested continuation after merged PR535. Base origin/main `4fc985a41`.

## Global Constraints

- This delivery saves selection only. No device creation, revocation, assignment release, local owner/generation change, operational restriction or financial mutation.
- Preserve creation/publication of plans, subscriptions, add-ons, services, offers and invoices without lifecycle policy. Missing policy is execution-readiness information, not a sales or selection prohibition.
- Server derives tenant, actor, time, commercial boundary and facts. No client force, effective date, arbitrary future plan, automatic device choices or implicit overwrite.
- Full selected set; reject duplicates, foreign tenant, released/inconsistent device, disabled/unknown future handheld and capacity overflow. Zero permits the empty set. Unlimited does not require a quota selection.
- Cabinet retention writes require fresh credentials.manage AND billing.request; platform reads tenants.read, writes tenants.write AND billing.write, with fresh factor/user state. Read-only subscription may inspect/save intention.
- Read-only repeatable-read inspection. Writers use read committed so an advisory-lock wait cannot pin an older snapshot; after all locks are acquired, reread complete facts. Writers acquire quota locks in numeric order, then timeline, device rows in stable order and commercial facts, revision last; never acquire quota inside an existing timeline transaction.
- Preview is actor/request/payload bound, at most 5 minutes and bounded by the next material entitlement boundary. Confirm rechecks authority, time and facts. Lost responses retry the unchanged ID/body; edits are disabled while outcome is uncertain, including through remount. A deterministic stale conflict requires a fresh explicit preview/confirmation.
- Historical journal and receipts are immutable. Current selected set has optimistic revision, shared by cabinet/platform; no lost updates. Persist the full tenant-scoped selected membership.
- Heartbeat time is not an empty-queue proof. Show known server work and local queues as unknown; no automatic transfer or deletion. Historical observations retain their original facts.
- Strict shared contracts, OpenAPI and route inventories, RU/EN, existing @markiro/ui and keyboard/narrow layouts. Native DTOs remain unchanged. Retention transitions and rendering have one shared UI owner; transport authorization and query/cache registration remain surface-specific.
- New forward migration after 0136 only; no edits to applied SQL/metadata. Rebuild changed shared packages before consumers; keep mutable outputs in this worktree.
- No commit, push, PR, deployment or cleanup in this delivery without subsequent user authorization. Reports and review packets are ignored local artifacts.

## Technical scope and boundary selection

Inspection exposes the nearest future server-known reduction, scanning distinct subscription/add-on/source start/end dates in ascending order and evaluating both sides using the existing resolver/projection at an explicit server-controlled time. Skip dates that only affect other quotas or invitation expiry. Include reductions from unlimited to finite, finite decreases and loss of handheld for occupied handhelds. Do not invent a date for pending activation without startsAt. For handheld eligibility and feature-loss boundaries, also evaluate `handheld.work.start.v1` against the future snapshot, so an operation-scoped grant for another operation cannot grant handheld work merely through an aggregate module boolean.

Add an optional internal `at = new Date()` parameter to `resolveSnapshotInTransaction`; preserve defaults for existing callers. Use `resolve(tenantId, tx, at)`, usage and `readEntitlementFacts` consistently, then project at that same time. No current-time fallback when deriving future conditions. Full source/plan/policy versions and boundary conditions contribute to the fingerprint; future scheduled subscriptions may differ from the current subscription. Expiring individual prepared sources are projection facts, not activated rights.

The public boundary has `key` (SHA256 of exact boundary identity/conditions) and `effectiveAt`. Requests send only that server-provided key. A saved selection is keyed by tenant/effectiveAt, not mutable conditions hash: a changed plan at the same time requires replacing the shared revision explicitly. Inspection also returns saved selections including elapsed ones, with needsReview computed from current facts. For current excess/unsupported devices without an applicable valid choice, show a separate shadow awaiting-selection calculation; do not fabricate historical snapshots or claim a runtime block. Future selection is only confirmable before its boundary. After the time passes, retained intent remains diagnostic and actual enforcement stays deferred.

## Task 1: Strict contracts and durable retention persistence

**Files:** create `packages/platform-contracts/src/device-retention.ts` and `packages/db/src/schema/device-retention.ts`; their exports/Drizzle config; focused contract/schema and real PostgreSQL migration tests; generated migration, snapshot/journal; runtime migration expectations if necessary.

**Interfaces:** Export schemas lowerCamelCase plus these corresponding PascalCase types. Reuse existing `entitlementSnapshotV1Schema` for safe commercial snapshots rather than duplicating their structure.

```ts
type DeviceRetentionBoundary = { key: string; effectiveAt: string };
type DeviceRetentionDevice = {
  deviceId: string;
  name: string;
  kind: "station" | "handheld";
  assignmentId: string;
  revision: number;
  state: "reserved" | "assigned";
  eligible: boolean;
  reasons: string[];
  knownServerWork: {
    activeShifts: number;
    activeInventories: number;
    printJobs: number;
    quarantineBatches: number;
  };
  localData: { journals: "unknown"; outbox: "unknown"; printWork: "unknown" };
};
type DeviceRetentionObservation = {
  boundary: DeviceRetentionBoundary;
  current: EntitlementSnapshotV1;
  future: EntitlementSnapshotV1;
  devices: DeviceRetentionDevice[];
  services: {
    id: string;
    nameRu: string;
    nameEn: string;
    quantity: number;
    unit: string;
    status: string;
  }[];
  selectionRequired: boolean;
  execution: { available: false; reasons: string[] };
};
type DeviceRetentionPreviewRequest = {
  requestId: string;
  boundaryKey: string;
  selectedDeviceIds: string[];
  expectedRevision: number;
  reason: string;
};
type DeviceRetentionConfirm = { requestId: string; previewId: string };
type DeviceRetentionPreview = {
  id: string;
  requestId: string;
  createdAt: string;
  expiresAt: string;
  expectedRevision: number;
  selectedDeviceIds: string[];
  observation: DeviceRetentionObservation;
};
type DeviceRetentionSelection = {
  id: string;
  revision: number;
  preparedAt: string;
  selectedDeviceIds: string[];
  observation: DeviceRetentionObservation;
};
type DeviceRetentionReceipt = { requestId: string; selection: DeviceRetentionSelection };
type DeviceRetentionInspection = {
  canSelect: boolean;
  observation: DeviceRetentionObservation | null;
  selections: {
    selection: DeviceRetentionSelection;
    needsReview: boolean;
    boundaryReached: boolean;
  }[];
  currentShadow: { awaitingSelection: boolean; affectedDeviceIds: string[]; enforced: false };
};
```

Use UUID/timestamp primitives; nonnegative expectedRevision (0 for none), positive stored revisions and counts, unique device arrays (empty allowed); strict nested schemas, known reason/status enums inferred from existing service contracts, boundary key hex64. Execution always includes `enforcement_not_enabled`. Validate duplicate device ids and timestamp/observation consistency. Future snapshot asOf equals effectiveAt, preview expires before or at effectiveAt, selected IDs exist in observation and meet eligibility/capacity. Unknown local data cannot become a count or ready state.

Contract maps `cabinetDeviceRetentionContracts` and `platformDeviceRetentionContracts`: inspect GET `/device-licensing/retention`; preview POST `/device-licensing/retention/preview`; confirm POST `/device-licensing/retention/confirm`. Platform prefix `/platform/tenants/:tenantId`; POST return200.

Persistence: `workingDeviceRetentionPreviews` (id,tenant,actorDomain,actorId,requestId,payload,payloadHash,factsFingerprint,observation,expectedRevision,selectedDeviceIds,createdAt,expiresAt,confirmedAt,resultSelectionId,response). Unique tenant/request and tenant/id; tenant FK; checked actor/object/digest/time/result correlations matching replacement safety. `workingDeviceRetentionSelections` (id,tenant,effectiveAt,previewId,revision,actorDomain,actorId,observation,factsFingerprint,preparedAt), unique tenant/effectiveAt and tenant/id; composite tenant/preview FK. `workingDeviceRetentionMembers` (tenantId,selectionId,deviceId) composite tenant/selection and tenant/device FKs, unique selection/device. Dedicated immutable `workingDeviceRetentionEvents` (id,tenantId,selectionId,requestId,actorDomain,actorId,action='selection_confirmed',before,after,result,createdAt) with unique tenant/request and composite selection FK. Do not weaken existing per-device event constraints for a tenant-wide action. Use existing immutable event trigger pattern on the new event table.

- [x] Write/run RED strict schema tests and real PostgreSQL migration test: foreign tenant membership/preview denial, duplicate boundary/member/request, immutable event update/delete denial, invalid actor/expiry/result rejected, historical operational rows unchanged across migrate/rerun.
- [x] Implement/generate reviewed forward SQL. No manual snapshot/lockfile editing.
- [x] Run DB/contracts focused and full test/lint/typecheck/build, preserve exact RED/GREEN evidence. Review scoped diff.

```ts
expect(
  deviceRetentionPreviewRequestSchema.safeParse({
    requestId,
    boundaryKey,
    selectedDeviceIds: [deviceId, deviceId],
    expectedRevision: 0,
    reason: "Downgrade",
  }).success,
).toBe(false);
expect(
  deviceRetentionPreviewRequestSchema.safeParse({
    requestId,
    boundaryKey,
    selectedDeviceIds: [],
    expectedRevision: 0,
    reason: "Zero capacity",
  }).success,
).toBe(true);
await expect(insertMember({ tenantId: otherTenant, selectionId, deviceId })).rejects.toMatchObject({
  code: "23503",
});
```

## Task 2: Temporal facts and transactional API

**Files:** create `apps/api/src/modules/device-licensing/device-retention-facts.ts`, `device-retention.service.ts`, cabinet/platform retention controllers; affected licensing module/authorization/policy/routes/OpenAPI; internal time parameter in entitlement resolver; focused facts/integration/boundary tests. Helpers may be split by temporal projection vs device work aggregation if needed; do not refactor unrelated replacement UI/services.

**Consumes:** Task1 schemas/tables, `EntitlementsService.resolveSnapshotInTransaction(tenantId,tx,at?)`, assignment consistency/occupancy, licensing authority, quota/timeline locks and transactional platform audit.

**Produces:** `DeviceRetentionService.inspect(tenantId,actor)`, `preview(tenantId,body,actor)`, `confirm(tenantId,body,actor)` with exact shared DTO return types. `readDeviceRetentionFacts(tx,tenantId,entitlements,at)` returns public inspection observation plus internal fingerprint/boundary and pool facts. Optional selected stored boundary inspection must not reuse incomplete target caches.

Inspection reads once per transaction wherever possible; no FOR UPDATE, revision writes or tenant-wide rescans per device. Aggregate shifts/inventories/retained product-label jobs/quarantine by tenant/device using batched queries. Include pool device/assignment stable facts, credentials binding, known work identities/states, prepared replacement identities/revisions, all relevant current/future commercial source/version/policy/revision facts in fingerprint. Exclude ordinary heartbeat timestamps, volatile asOf/connectivity and private reason. Show ordered services from existing tenant orders only, with no recurring projection or private platform metadata.

Preview validates boundaryKey against server's nearest reduction, complete selected set and expectedRevision, then persists actor/request/content-bound snapshot. Normalize set order for canonical intent but reject duplicates first. Unchanged retries return same preview; changed actor/body/revision conflicts. Confirm authenticates first, returns existing immutable receipt on identical replay even if selection was subsequently revised, otherwise locks/rechecks facts/revision/time and replaces current membership atomically with selection row, event before/after/result and platform audit. Same boundary confirms compete by expectedRevision; existing prepared replacement changes invalidate selection preview and vice versa by including the current selection in replacement fingerprint. When adding retention facts to replacement freshness, retain the existing once-per-list read-only tenant fact cache: load the selection identities/revisions once per tenant transaction, not once per replacement row. No writes to operational/commerce rows or revision bumps that falsely activate grants.

Past saved selections remain visible; needsReview compares current durable pool/commercial facts and reached boundary explicitly, avoiding pretending a historical snapshot was recomputed exactly. An elapsed saved choice is diagnostic; no late confirm of an expired preview. Current shadow computes affected occupied devices and whether no valid applicable retained intention exists. At a reached boundary, an unchanged saved set remains applicable to the shadow calculation: affectedDeviceIds are the unselected devices and awaitingSelection is false. Without a valid applicable set the affected pool awaits selection as a whole. Reaching the date alone must not invalidate a saved choice; compare stable semantic dated commercial/pool facts and the current expected conditions, not a changing asOf, nextChangeAt or routine scheduled-to-active lifecycle status. Conservatively mark materially changed facts for review without reconstructing historical rights. No automatic device picking.

- [x] RED temporal tests: scheduled smaller plan, add-on expiry, grant expiry, intervening irrelevant boundary, zero/unlimited, pending activation without date, future handheld false/unknown, current versus future snapshot same server time inputs.
- [x] RED actualPG: full/empty set, foreign/released/duplicate device rejection, stale source/pool/plan/add-on/replacement, cancellation and new pairing invalidation, exact expiry and next boundary; actor loss, platform reader denial, billing capability; immutable original retry receipt and payload conflicts; exact journal/audit/operational-row equality.
- [x] Implement then test both concurrency orders: two cabinet/platform confirms on same revision, commercial timeline change versus confirm, pairing/cancel/replacement versus confirm. Use real transaction barriers/polling with bounded timeout, not arbitrary sleeps. Read-only inspection must proceed while writer holds device locks.
- [x] Add strict HTTP parsing/OpenAPI/inventories/guard coverage; run focused then API package gates with local test infrastructure. Report all intentional skips.

```ts
const inspection = await service.inspect(tenantId, actor);
const preview = await service.preview(
  tenantId,
  {
    requestId,
    boundaryKey: inspection.observation!.boundary.key,
    selectedDeviceIds: [deviceId],
    expectedRevision: 0,
    reason: "Keep line station",
  },
  actor,
);
const receipt = await service.confirm(tenantId, { requestId, previewId: preview.id }, actor);
expect(receipt.selection.selectedDeviceIds).toEqual([deviceId]);
expect(await operationalRows()).toEqual(before);
expect(await service.confirm(tenantId, { requestId, previewId: preview.id }, actor)).toEqual(
  receipt,
);
```

## Task 3: Explicit selection in cabinet and SaaS

**Files:** shared retention view/controller in `packages/ui/src/entitlements/`, thin
`DeviceRetentionPanel.tsx` and `device-retention-api.ts` adapters adjacent to existing device licensing panels in admin/pages/devices and saas-admin/pages/tenants; integration alongside replacement panel; RU/EN strings; typed fixtures, component/client tests.

**Consumes:** Task1 DTOs/contracts and Task2 inspect/preview/confirm. Query inspection server-authorized canSelect, never infer capability from tenant principal shape. Reuse API clients and existing uncertainty storage scoped by tenant/action in QueryClient.

Show nearest reduction date, future shared capacity/features, occupied devices and known tasks, source/add-on/ordered-service context and selected count. Explicit unchecked initial checkboxes; for editing a saved choice user explicitly invokes edit of that revision. Ineligible devices explain why; zero supports an intentional empty confirmation; unlimited copy says no mandatory quota selection. An explicit new-draft action can clear obsolete or ineligible saved IDs while retaining the saved revision; refresh must never silently filter the set. Preview/confirm save the entire intended set. Summary says saved for date and execution not enabled; no revoke/pair/create calls. Existing saved historical sets remain readable, stale/reached warning separate from current access. Support may inspect but cannot write.

Block all intent edits while busy or uncertainty pending, retain preview/requestId/expectedRevision across remount. Retry unchanged transport/invalid-envelope failures with same identity. Correct domain409 or authorization401/403 can clear pending identity; stale conditions require new preview and explicit confirmation. Avoid hidden automatic reselection after refresh or changed limit.

- [x] RED typed client/component tests: full/empty explicit set, disabled invalid device, support read-only, stale selection, current shadow message, deterministic error recovery, lost preview/confirm before/after remount preserving exact identity/body and blocking edits.
- [x] Implement production UI using @markiro/ui with labels/keyboard, RU/EN translations and exact platform URL prefix once; parse recorded JSON bodies for value equality.
- [x] Run focused and full admin/SaaS test/lint/typecheck/build. Preserve RED/GREEN and scoped review evidence.

```ts
expect(screen.getByRole("checkbox", { name: /Line station/ })).not.toBeChecked();
await user.click(screen.getByRole("checkbox", { name: /Line station/ }));
await user.click(screen.getByRole("button", { name: /Preview/ }));
expect(previewMock).toHaveBeenCalledWith(
  expect.objectContaining({ selectedDeviceIds: [deviceId], expectedRevision: 0 }),
);
```

## Controller: integration, documentation and final verification

- [x] Update operations guide and design delivery status; state preparation versus enforcement, precise boundary, missing choice shadow behavior, retry semantics and migration rollout.
- [x] Review complete diff; DB/contracts builds precede consumers, DB boundary suites do not overlap other DB consumers/builds. Run affected final gates, production contracts for migration/runtime, full format and diff checks once on final code; repeat only after material changes/failures.
- [x] Browser-check real panels with isolated fixture transport RU/EN desktop/narrow, keyboard, full/zero set, expired/stale selection and lost-response retry/remount. Report local fixture versus live API/hardware separately.
- [x] Independent task reviews and whole-branch review. Keep cleanly scoped changes local/uncommitted; report remaining P1B.3/P1C/P1D/P2 accurately.

## Verification record

- Shared upstream builds completed before consumer checks. DB: 476 tests passed;
  platform contracts: 268 tests passed. Both packages passed lint, typecheck and
  build. The new migration was exercised on local PostgreSQL, including immutable
  receipts and retention of operational records.
- API: 3800 tests passed, 26 intentionally skipped (separate inventory test
  database, opt-in local infrastructure and live National Catalog). The affected
  249-test set, including 41 retention PostgreSQL cases, passed without skips.
  API lint, typecheck and build passed.
- Production bundle contracts: 558 passed. This does not establish deployment.
- Browser: real cabinet RU and SaaS EN panels with isolated, contract-validated
  fixture transport. Verified explicit finite/zero selections, read-only and
  unlimited states, stale/reached history, keyboard focus/Enter, same-identity
  lost-response retry across remount and removal of the future observation.
  Both forms fit a 390px container, including a 100-character service unit and
  expanded original observations. This was narrow-container verification, not
  mobile-device emulation or live authenticated API acceptance.
- Native protocols were unchanged. Windows, scanners, printers, installed
  handheld applications and production rollout were not exercised.

- Cabinet: 1325 tests passed; SaaS: 462 passed, no skips. Both applications passed
  lint, typecheck and build. The shared UI package passed 190 tests and its lint, typecheck and build gates.
  Existing cabinet hook warnings, JSDOM canvas/navigation
  limitations and Vite chunk-size notices remain reported, not suppressed.
- Whole-repository formatting and `git diff --check` passed. API and shared
  package paths select the existing API/app/static/production CI jobs; no new
  test owner or native contract requires changing the job classifier.

- Final review fixes: the UI describes handheld module inclusion without inferring
  work permission and explicitly shows a pool awaiting selection, including when
  the live future observation is absent. RU/EN browser fixtures verified both
  awaiting states and authoritative handheld denial. The 41-case PostgreSQL suite
  also passed with an exact retry of a two-device set in reversed order; API
  typecheck/lint and the shared UI and both app gates passed after these fixes.

- Independent task reviews and the whole-branch review completed. The single
  final fix wave addressed both UI findings and the retry-normalization test gap;
  the scoped re-review found all three addressed with no new breakage. Changes
  remain local and uncommitted on `codex/entitlements-device-retention`.
