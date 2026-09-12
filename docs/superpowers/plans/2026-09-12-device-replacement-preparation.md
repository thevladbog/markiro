# Device replacement preparation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Keep the delivery local and uncommitted until the user requests push/PR.

**Goal:** Let cabinet and SaaS operators preview, save and cancel a replacement preparation while preserving the source device, slot, credentials and all production evidence.

**Architecture:** Implement delivery 2 of the accepted P1B.2 design. Separate replacement routes and persistence reuse the existing tenant quota/timeline locking, licensing authority and immutable event journal. Pairing and operational admission remain owners of their existing behavior.

**Tech Stack:** Node 24, pnpm 11.22.0, NestJS, Drizzle/PostgreSQL, strict Zod contracts, React/TanStack Query, @markiro/ui, Vitest and browser verification.

**Spec:** [Accepted P1B.2 design](../specs/2026-09-12-entitlements-p1b2-device-licensing-design.md), sections 1, 3, 6, 8–10; FR-DEV-04. Base: origin/main `3e4b74cda`, containing merged PR532. User requested the next delivery after merge.

## Global constraints

- This delivery prepares replacement only. It has no execution/transfer endpoint, no new device/reservation, no credential issuance or revocation, no local ownership change and no new admission restrictions.
- Retention selection remains delivery 3 of the accepted sequence. Never claim complete FR-DEV-04/05 or FR-LIF-07 from this delivery.
- Preserve tariffs, subscriptions, add-ons, services, offers and invoices without requiring a lifecycle policy.
- Source data and journals remain immutable historical facts; telemetry is an observation, not proof that local work is empty.
- Cabinet requires fresh `credentials.manage`; platform reads require `tenants.read`, writes require `tenants.write` and `billing.write`, including fresh factor/user checks.
- Use a new forward migration after 0134; preserve applied SQL and metadata. Rebuild DB/contracts before consumer checks.
- Server derives actor, tenant authority, revisions and time. No client force/ignorePending/generation/execute fields.
- One current prepared replacement per tenant/source device. Cancel explicitly before preparing another target. Cancel never cancels/revokes the source device.
- Preview lasts at most the existing technical 5 minutes and no later than the next entitlement boundary. This is not a business offline/grace policy.
- Freshness includes durable source identity/credential binding, pool assignments, target intent, commercial revision/current conditions/sources/policy/registry, known task/evidence facts. Ordinary heartbeat timestamp changes alone do not invalidate intent.
- No secrets, raw pairing codes, private platform reasons or credential IDs in public DTOs. Platform-only reasons may be retained in protected storage/audit.
- Same unchanged request retries after ambiguous responses with the same identity, including remount. Deterministic stale/conflict requires a fresh preview and explicit confirmation.
- Keep edits in this worktree. Publication follows a separate user request;
  merge, deployment and cleanup retain their own authorization boundaries.

## Interfaces and file ownership

Task 1 owns `packages/db` and `packages/platform-contracts`. Task 2 owns `apps/api`. Task 3 owns both web apps. Controller owns this plan, operational documentation and final validation; no simultaneous writes to a package.

### Task 1: Durable preparations and strict contracts

**Files:** new `packages/db/src/schema/device-replacements.ts`, DB schema exports/config, next generated migration/snapshot/journal; extend the working-device journal action constraint; new DB schema/migration tests. New `packages/platform-contracts/src/device-replacements.ts`, exports and schema tests.

**Produces these shared types and schemas:**

```ts
type DeviceReplacementTarget = { name: string; kind: "station" | "handheld" };
type DeviceReplacementPreviewRequest = {
  requestId: string;
  target: DeviceReplacementTarget;
  reason: string;
};
type DeviceReplacementConfirm = { requestId: string; previewId: string };
type DeviceReplacementCancel = { requestId: string; expectedRevision: number };
type DeviceReplacementObservation = {
  source: {
    deviceId: string;
    name: string;
    kind: "station" | "handheld";
    lineId: string | null;
    assignmentId: string;
    revision: number;
    state: "assigned" | "released";
    slotOccupied: boolean;
    pairedAt: string | null;
    lastSeenAt: string | null;
    revokedAt: string | null;
  };
  target: DeviceReplacementTarget;
  usage: number;
  limit: number | null;
  preparationSlotDelta: 0;
  expectedTransferSlotDelta: 0 | 1;
  knownServerWork: {
    activeShifts: number;
    activeInventories: number;
    printJobs: number;
    quarantineBatches: number;
  };
  localData: { journals: "unknown"; outbox: "unknown"; printWork: "unknown" };
  execution: {
    available: false;
    reasons: Array<
      | "transfer_not_available"
      | "local_data_unknown"
      | "source_authority_transition_required"
      | "handheld_unavailable"
      | "capacity_unavailable"
      | "lifecycle_policy_not_ready"
    >;
  };
};
type DeviceReplacementPreview = {
  id: string;
  requestId: string;
  sourceDeviceId: string;
  createdAt: string;
  expiresAt: string;
  observation: DeviceReplacementObservation;
};
type DeviceReplacementPreparation = {
  id: string;
  sourceDeviceId: string;
  revision: number;
  state: "prepared" | "cancelled";
  preparedAt: string;
  cancelledAt: string | null;
  observation: DeviceReplacementObservation;
};
type DeviceReplacementReceipt = {
  requestId: string;
  preparation: DeviceReplacementPreparation;
};
type DeviceReplacementList = {
  canPrepare: boolean;
  items: Array<{ preparation: DeviceReplacementPreparation; needsReview: boolean }>;
};
```

Schema export names are the type names with lower first letter plus `Schema` (e.g. `deviceReplacementPreviewRequestSchema`). Use UUID and UTC timestamp primitives; name trimmed 1–200, reason trimmed 1–1000; positive revisions; nonnegative counts; all objects strict; released means occupied false, cancelled requires cancelledAt, prepared requires null. Require fixed unavailable reasons in every observation so no DTO can imply a completed transfer. Unlimited limit is null. Confirm and cancel receipts remain immutable even after later cancellation/state changes.

Contract maps `cabinetDeviceReplacementContracts` and `platformDeviceReplacementContracts`: `list` GET `/device-licensing/replacements`; `preview` POST `/device-licensing/:deviceId/replacements/preview`; `confirm` POST `/device-licensing/:deviceId/replacements/confirm`; `cancel` POST `/device-licensing/replacements/:preparationId/cancel`. Platform prefixes the same paths with `/platform/tenants/:tenantId`. Mutations return 200.

Persistence exports:

```ts
// workingDeviceReplacementPreviews:
// id UUID, tenantId text, deviceId UUID, actorDomain cabinet|platform,
// actorId text NOT NULL, requestId UUID, payload object, payloadHash hex64,
// factsFingerprint hex64, observation object, createdAt, expiresAt,
// confirmedAt nullable, resultPreparationId nullable, response unknown nullable.
// unique tenant/id, tenant/device/id, tenant/request; composite source-device FK.
// confirmedAt/resultPreparationId/response all present or all absent.
// workingDeviceReplacementPreparations:
// id UUID, tenantId text, deviceId UUID, previewId UUID, revision int >=1,
// state prepared|cancelled, actorDomain cabinet|platform, actorId text NOT NULL,
// observation object, factsFingerprint hex64, preparedAt,
// cancelledAt nullable, cancelledActorDomain nullable, cancelledActorId nullable.
// unique tenant/id and tenant/device/id; one prepared row per tenant/device;
// composite tenant/device FK and tenant/device/preview FK; cancellation fields correlate.
// workingDeviceEvents actions additionally replacement_prepared/replacement_cancelled.
// Existing journal immutability stays in force. It holds exact mutation receipts.
```

- [x] Write focused failing contract/schema tests and actual PostgreSQL migration tests. Assert cross-tenant/source FK denial, duplicate active project rejection, history after cancel/recreate, actor identity, timestamp/state correlations and no mutation of pre-existing devices/assignments/events when migrating from 0134.
- [x] Run the RED tests; implement checked schema and strict contracts. Generate migration using Drizzle, inspect SQL/snapshot and update runtime migration expectations if required.
- [x] Run DB/contracts focused and package test/lint/typecheck/build. Preserve the RED/GREEN evidence and leave scoped diff for task review.

Example assertions:

```ts
expect(
  deviceReplacementConfirmSchema.safeParse({ requestId, previewId, force: true }).success,
).toBe(false);
await expect(insertPreparedForOtherTenant()).rejects.toMatchObject({ code: "23503" });
await expect(insertSecondPreparedForSource()).rejects.toMatchObject({ code: "23505" });
expect(await readLegacyDeviceRows()).toEqual(beforeMigration);
```

### Task 2: Transactional API and bounded observation

**Files:** new `apps/api/src/modules/device-licensing/device-replacement.service.ts`, `device-replacement-facts.ts`, cabinet/platform replacement controllers, shared licensing authority helper; update licensing module/old service to reuse the extracted authority without changing its rules, subscription policy/guard and route/OpenAPI inventories. New integration/boundary tests adjacent to existing device-licensing tests.

**Consumes:** Task 1 schemas and tables; `EntitlementsService.resolveSnapshotInTransaction`, `withQuotaLock`, `lockTenantSubscriptionTimeline`, `assignmentConsistent`, `assignmentOccupied`, immutable `workingDeviceEvents` and transactional `PlatformAuditService`.

**Produces:** `DeviceReplacementService.list(tenantId,actor)`, `preview(tenantId,deviceId,body,actor)`, `confirm(tenantId,deviceId,body,actor)`, `cancel(tenantId,preparationId,body,actor)` with the corresponding exact shared response types. Extract existing `requireActor` as `requireDeviceLicensingActor(tx,tenantId,actor,write)` without weakening fresh membership/factor checks.

Source must be a consistent assigned device with pairing evidence, or a security-released previously paired device. A cancelled/never-paired reservation is not a replacement source. Missing/inconsistent assignments block preparation. Current projects can always be cancelled by an authorized writer even if their source facts later became stale. Prepared source replacement costs zero additional slots; expected eventual net change is zero when the source occupies a slot and one for a security-released source. No slot is actually changed.

Known work derives from tenant-scoped source references: open/closing shifts via participant or close owner, nonterminal inventories via participant, retained product-label job count, quarantine batch count. Count distinct tasks, not participant rows. Include task IDs/statuses and relevant inventory pending/open-box observations in the internal freshness fingerprint. Print-job count is explicitly retained server records, never a claim about unresolved local printing. All local channels remain unknown. A terminal/no-task server result must not turn these into zero local queues.

Use coherent repeatable-read transactions and the existing order: quota locks in numeric order, timeline, subscription rows, source row, referenced catalog/policy rows, entitlement revision last. Retry serialization failures and specifically recognized same-request/one-current-project races, revalidating actor and payload. Capture commercial facts from the authoritative resolver, not a client-supplied date or plan. Fingerprint excludes `asOf`, connectivity/heartbeat timestamps and private reason text in public observations, but includes source credential-binding identity internally, durable source fields, full pool assignment identity/revision, usage, current conditions, source versions, registry/policy/revisions and known task state. Bound expiry by `nextChangeAt` and verify server time at confirm.

Preview persistence is actor/request/content bound. A duplicate request with changed actor/target/reason/source conflicts; unchanged retries return the same snapshot or deterministic stale response. Confirm requires the preview's actor and request ID, fresh facts, no other current project, and stores prepared row + journal receipt + platform audit atomically. Confirm retry returns the original saved receipt before freshness checks, even after cancellation; recheck present-day authorization first. Cancel is revision-checked, journaled and idempotent; different actor/body under the same request ID conflicts. There is no automatic replacement or cancellation on source changes; list returns `needsReview` using fresh facts. Reason is stored privately and only sent to platform audit where appropriate, never echoed to cabinet list/preview/receipt.

- [x] Write and run RED PostgreSQL tests for preview/confirm/cancel, exact journal/audit, safe unknown local data and no side effects on credentials/device/pairing codes/assignments/usage/work/commerce rows.
- [x] Implement services/controllers using strict shared request and response schemas. Explicit licensing policies: `replacement_preview`, `replacement_confirm`, `replacement_cancel`, plus existing inspect. They remain allowed in read-only/unmanaged states without authorizing enrollment.
- [x] Test two tenants, cabinet/device/platform separation, invalid payload IDs, lost membership/factor/role between preview and confirm, platform reader versus writer, unchanged/changed retries, duplicate preparations, double cancel, stale source/credential/pool/plan/add-on/policy, exact expiry including next boundary, zero/unlimited and target handheld unavailable.
- [x] Race confirm versus source re-pair/revoke/cancel, two actors preparing the same source, and commercial change; assert one coherent winner or rejection and no operational side effects. Exercise both lock orders using transaction barriers, not arbitrary sleeps.
- [x] Run focused tests then API package gates; preserve existing cancellation/pairing/catalog sales and OpenAPI/route-boundary regressions. Leave exact evidence for review.

```ts
const preview = await service.preview(tenantId, sourceId, intent, actor);
const receipt = await service.confirm(
  tenantId,
  sourceId,
  { requestId: intent.requestId, previewId: preview.id },
  actor,
);
expect(receipt.preparation.state).toBe("prepared");
expect(await operationalRows()).toEqual(before);
expect(
  await service.confirm(
    tenantId,
    sourceId,
    { requestId: intent.requestId, previewId: preview.id },
    actor,
  ),
).toEqual(receipt);
expect((await service.list(tenantId, actor)).items[0]?.needsReview).toBe(false);
```

### Task 3: Cabinet and SaaS preparation flow

**Files:** new `DeviceReplacementPanel.tsx` and replacement API module in `apps/admin/src/pages/devices/` and `apps/saas-admin/src/pages/tenants/`; integrate under existing licensing panels; RU/EN translations; dedicated component/client tests in each app. Split an editor/state helper if needed to keep the flow understandable; reuse UI tokens/components rather than introduce a visual system.

**Integration correction:** The existing SaaS licensing client duplicated `/platform` when composing its request URL. Keep the local prefix correction in `tenants/api.ts` and the exact GET/POST URL regression in `platform-pages-api.test.ts`; new replacement calls must also apply the platform base once. The real browser fixture exposed the failure, and the focused regression passed after the correction.

**Consumes:** Task 1 exact contracts; existing pool projection for source choices; list provides server canPrepare. Use typed clients `listDeviceReplacements`, `previewDeviceReplacement`, `confirmDeviceReplacement`, `cancelDeviceReplacement` with platform tenant-scoped equivalents.

Flow: select eligible source, enter future name/kind and reason; preview shows old/new kind and name, unchanged present slot count, expected eventual delta, observed known server tasks, explicitly unknown local queues and why completion is unavailable. Confirmation is “Сохранить подготовку” / “Save preparation”; result “Подготовлено” / “Prepared”. List shows saved projects with `needsReview`, persisted observation and explicit cancellation confirmation. Re-pair is a separate existing action. A support reader can inspect projects but not modify them. No hidden auto-selection, no “transfer complete” copy, no pairing/create/revoke calls.

Changing source/target/reason invalidates confirmation, requires a new preview and request identity. Store uncertain attempt state in the QueryClient scoped to tenant/source/action with infinite GC, preserving preview and confirm/cancel request across remount. Disable simultaneous requests and mutation during an in-flight confirm. For SaaS require the parsed error kind before treating 401/403/409 as deterministic. Cabinet ApiRequestError has no kind: validate its retained details as a recognized domain code or a complete matching Nest authorization envelope within the replacement client (including the installed Nest default `{message:"Forbidden",statusCode:403}` / `{message:"Unauthorized",statusCode:401}` without an `error` field); do not change the global client. Malformed/network responses remain uncertain. Known authorization loss closes confirmation and refreshes current auth/capabilities. Known conflict retains editable intent, refreshes facts, and requires a new user confirmation; never automatically confirms a refreshed preview. Success clears attempt and invalidates replacement/pool projections; no optimistic operational changes.

- [x] Write RED tests using changing UUIDs and actual cached request assertions: prepare success, private/unknown facts copy, permission denial/read-only reader, target edit, valid conflict/auth error, malformed 401/403/409, lost preview/confirm/cancel response, remount retry, source navigation, stale saved project and explicit cancellation.
- [x] Implement both localized panels and typed clients; preserve old reservation/cabinet device tests. Shared core UI is optional only if the existing package boundary makes it smaller; do not introduce a new package. The existing `@markiro/ui/entitlements` subpath already depends on platform contracts and can host shared presentation/state while auth/transport/QueryClient adapters remain in each app; if used, include its focused tests and package lint/typecheck/test/build before app gates.
- [x] Run focused component/client tests then both app lint/typecheck/test/build. Leave review evidence, then controller exercises real panels in local browser at desktop and narrow widths in RU/EN.

```ts
expect(postBodies[1]).toEqual(postBodies[0]); // same failed confirm after remount
expect(randomUUID).toHaveBeenCalledTimes(1);
expect(fetchCalls.some((call) => /pairing-code|station-devices.*DELETE/.test(call))).toBe(false);
```

### Task 4: Acceptance and operating documentation

**Files:** this plan, `docs/operations/entitlements-p1b2.md`, applicable architecture status notes. No feature changes unless review establishes a concrete defect.

- [x] Explain preparation/cancellation, `needsReview`, unknown local data and unavailable execution. Preserve first-v1 rollout floor and no lifecycle-policy sales blocker; no new binary floor unless actual compatibility evidence requires it.
- [x] Review whole branch against the accepted delivery and run final affected DB/contracts/API/admin/SaaS gates in dependency order with local test env, full format check and diff check. Run deployment/CI contracts if mappings/migrations require them; do not overlap DB boundary tests with mutable DB builds.
- [x] Browser-check real panels using local fixture transport in RU/EN desktop/narrow, keyboard confirmation and lost-response recovery. Do not claim deployed routes, Android/Rust/Windows or hardware acceptance from those checks.
- [x] Independent task and final review, address valid findings, reconcile all test skips and leave a cleanly scoped uncommitted diff. Report that selection is next and replacement execution is still a future accepted phase.

## Verification record

Local PostgreSQL and package checks passed: DB 467 tests, platform contracts 260,
API 3743. The 26 explicitly skipped API tests require a separate inventory test
database (22), opt-in local infrastructure checks (3), or live National Catalog
configuration (1). All 28 new replacement PostgreSQL cases ran; the combined
replacement, HTTP-boundary and subscription-guard checks passed 51 tests.

The full cabinet and SaaS suites passed 1279 and 415 tests. A subsequent
single-expression correction to uncertain-cancellation feedback was verified by
the final focused suites (36 cabinet, 29 SaaS). Final lint, typecheck and builds
passed for both apps. DB, contracts and API package gates, repository formatting,
diff checks, production-bundle contracts (558), Yandex runtime contracts (107)
and CI-policy checks (41) passed. Existing lint and build-size warnings remain.

Real production panels were exercised with an isolated browser fixture transport
in RU/EN at desktop and 390px widths. Checks covered explicit save/cancel,
keyboard confirmation, read-only access, historical observations, source edits,
and unchanged request retries after lost preview/confirm/cancel responses and
panel remount. No horizontal overflow was observed at 390px. Browser fixtures do
not establish deployed API or factory acceptance. Native code and device
protocols did not change; Android, Rust, Windows and physical scanner/printer
checks were not run. Production deployment was not performed.

Independent reviews approved each task and the complete final diff. All reported
findings were resolved; the final review has no open findings. The implementation
is on `codex/entitlements-device-replacement`. The user subsequently requested
commit, push and PR publication. Retention selection
is the next delivery; execution of the actual replacement remains a later phase.
