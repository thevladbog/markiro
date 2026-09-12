# Working device reservations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Count Station/handheld license assignments consistently and let authorized cabinet/platform users cancel a never-paired reservation without revoking credentials or deleting history.

**Architecture:** One current tenant/device assignment plus an append-only transition journal. Existing device writers maintain this projection inside their quota-locked transactions. A shared conservative usage reader feeds quota enforcement and platform usage. Separate cabinet/platform HTTP controllers expose inspection and idempotent cancellation; pairing keeps its existing response contracts.

**Tech Stack:** TypeScript, PostgreSQL, Drizzle, NestJS, Zod, React, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-entitlements-p1b2-device-licensing-design.md`, first delivery only.

## Global constraints

- Base: merged PR #530, `4279b58072be88d0ea6cf7d97642f14f608d1fe1`.
- Plans/subscriptions, add-ons, services, offers and invoices stay usable without additional lifecycle policy.
- Station and handheld share `stations`; kiosks keep their separate quota.
- No credential deletion for commercial cancellation; `revokedAt`, device identity and production history stay intact.
- Cancellation is terminal for that reservation. Re-pairing a security-revoked device remains supported with a fresh quota check.
- Lock order: quota lock, device row, assignment/event writes, revision last. No new timeline lock inside pairing.
- Keep one current assignment per tenant/device; journal transitions preserve the complete assignment history.
- Missing/inconsistent assignment must never create capacity. Existing unmanaged handling remains unchanged.
- No client-supplied actor, tenant authority, force flag or credential generation.
- No replacement/retention implementation in this delivery, no automatic strict enforcement or offline grants.
- Use Node 24 and installed workspace dependencies; shared DB/contracts must be rebuilt before consumers.
- Tests use isolated scratch PostgreSQL databases and the existing local test environment, never production.
- No commit, push, deployment or cleanup in this implementation turn; leave a reviewable local diff.

## Task 1: Assignment schema, migration and journal

**Files:** create `packages/db/src/schema/device-licensing.ts`, `packages/db/test/device-licensing-schema.test.ts`, `packages/db/test/device-licensing-migration.test.ts`; modify `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`; generate the next migration and metadata.

**Produces:** `schema.workingDeviceAssignments` and `schema.workingDeviceEvents`.

```ts
type AssignmentState = "reserved" | "assigned" | "released";
type ReleaseReason = "reservation_cancelled" | "security_revoked";
// workingDeviceAssignments: id UUID, tenantId text, deviceId UUID,
// state AssignmentState, revision integer >= 1, observedAt/updatedAt timestamps,
// releasedAt timestamp|null, releaseReason ReleaseReason|null,
// provenance "migration"|"runtime", lastEventId UUID|null.
// Unique (tenantId,deviceId) and (tenantId,id); composite tenant/device FK.
// workingDeviceEvents: id UUID, tenantId text, deviceId UUID,
// actorDomain "migration"|"system"|"cabinet"|"platform"|"device", actorId text|null,
// action "observed"|"reserved"|"assigned"|"released"|"reservation_cancelled",
// before/after JSON, outcome "success", requestId UUID|null,
// requestHash text|null, response JSON|null, createdAt timestamp.
// Unique (tenantId,id) and (tenantId,requestId); composite tenant/device FK.
```

- [x] Write schema and migration tests first. Seed pre-migration active unpaired, paired, key-only, revoked and contradictory records in two tenants. Assert exact device rows stay identical and occupied totals match the old `revoked_at IS NULL` calculation.
- [x] Run focused tests and capture the expected missing-schema failure.
- [x] Add checked schema and a forward migration. Observe each existing device: revoked → released/security_revoked; otherwise pairedAt/key present → assigned; otherwise reserved. Record migration provenance and one observation event, not a historical actor or purchase timestamp. Constrain release fields to released state and protect a cancelled assignment from resurrection. Re-applying runtime migrations adds no observations.
- [x] Run schema/migration tests and DB lint/typecheck/test/build. Verify composite FKs deny another tenant and the current assignment cannot duplicate.

Migration test assertion shape:

```ts
expect(afterDevices).toEqual(beforeDevices);
expect(occupiedByTenant).toEqual(legacyOccupiedByTenant);
expect(migrationEvents.every((e) => e.actorDomain === "migration" && e.actorId === null)).toBe(
  true,
);
```

## Task 2: Strict inspection/cancellation contracts

**Files:** create `packages/platform-contracts/src/device-licensing.ts` and `packages/platform-contracts/test/device-licensing.test.ts`; export from `src/index.ts`.

**Produces:** `workingDevicePoolSchema`, `cancelDeviceReservationSchema`, `deviceReservationReceiptSchema`, corresponding inferred types, `cabinetDeviceLicensingContracts` and `platformDeviceLicensingContracts`.

```ts
type CancelDeviceReservation = {
  requestId: string; // UUID
  expectedRevision: number; // positive integer
};
type DeviceReservationReceipt = {
  requestId: string;
  deviceId: string;
  assignmentId: string;
  revision: number;
  state: "released";
  releaseReason: "reservation_cancelled";
  releasedAt: string; // UTC ISO timestamp
};
type WorkingDevicePool = {
  tenantId: string;
  usage: number;
  limit: number | null;
  canCancelReservations: boolean;
  integrity: "ready" | "inconsistent";
  devices: Array<{
    deviceId: string;
    name: string;
    kind: "station" | "handheld";
    assignmentId: string | null;
    revision: number | null;
    state: "reserved" | "assigned" | "released" | "inconsistent";
    releaseReason: "reservation_cancelled" | "security_revoked" | null;
    slotOccupied: boolean;
    canCancel: boolean;
    blockedReason: "already_paired" | "released" | "inconsistent" | "production_evidence" | null;
    connectionStatus: "awaiting_pairing" | "online" | "offline" | "revoked";
    pairedAt: string | null;
    lastSeenAt: string | null;
  }>;
};
```

Routes: GET `/device-licensing`; POST `/device-licensing/:deviceId/cancel-reservation`; GET `/platform/tenants/:tenantId/device-licensing`; POST `/platform/tenants/:tenantId/device-licensing/:deviceId/cancel-reservation`. Contract methods `inspect` and `cancelReservation` have `method`, `path`, `response`, and mutation `body` following existing packages.

- [x] RED: reject unknown fields/actor/force, invalid UUID/revision, kiosk kind; accept cancelled and inconsistent projections plus null unlimited quota.
- [x] Implement `.strict()` schemas and inferred exports. Add correlations where a released receipt/assignment must be complete; public DTOs never include credentials, pairing codes or internal platform reasons.
- [x] Run contracts package lint/typecheck/test/build.

## Task 3: Maintain assignments and expose safe cancellation

**Files:** create `apps/api/src/subscriptions/working-device-assignments.ts`, module/controller/service under `apps/api/src/modules/device-licensing/`; modify station-devices/station-pairing services/controllers, `entitlements.service.ts`, `platform-tenants.service.ts`, subscription access policy/guard, app module and route/OpenAPI inventories; add PostgreSQL tests in `apps/api/test/device-licensing*.test.ts`.

**Interfaces:** helper accepts the owning DB transaction and server-derived actor. `countWorkingDeviceUsage(executor,tenantId): Promise<number>` is the only working-device usage reader. Service `inspect(tenantId,canCancelReservations)` returns `WorkingDevicePool`; `cancel(tenantId,deviceId,body,actor)` returns `DeviceReservationReceipt`. Cabinet/platform controllers derive actor/tenant after existing guards.

- [x] RED: create reserves one place, pairing assigns the same place, security revoke releases it, authorized re-pair reacquires quota. Raw/missing or contradictory assignments count conservatively.
- [x] Implement transactional assignment transitions and exact journal events. Creation accepts server-derived cabinet actor; successful pairing uses durable device identity; revoke uses requesting cabinet actor. Update kind rechecks immutable-after-pairing under the row lock. Keep existing credential deletion order on revoke.
- [x] RED: cancel succeeds only for reserved, never paired, no key, no production references. Same request/payload/actor returns identical saved receipt; changed payload/actor conflicts. Assert exact audit, unchanged device/credential fields, retired live codes and durable record retention.
- [x] Implement cancellation under existing station quota and device-row locks, compare assignment revision, check production references, append event/receipt and release assignment atomically. Validate complete assignment pool before enabling cancellation. Reject issueCode, legacy pair and recovery after terminal cancellation; compensate a candidate key provisioned before a losing claim.
- [x] RED: race both orders cancel versus claim, concurrent final-slot creation, repeat cancel, revoke versus re-pair and kind change versus claim. Use deferred transactions/locks, not arbitrary sleeps; assert loser rollback and exact final state.
- [x] Implement separate cabinet/platform boundaries. Cabinet inspect/cancel requires `credentials.manage`; platform inspect requires `tenants.read`, cancellation requires both `tenants.write` and `billing.write`. Add explicit subscription `licensing` policy restricted to `cancel_reservation`, permitted during read-only without allowing enrollment/key issuance.
- [x] Run focused API tests including tenant denial, device credential rejection, stale membership and exact platform audit; update OpenAPI/subscription route inventory expectations. Re-run catalog sales tests to prove no policy blocker reappears.

```ts
expect(receipt.state).toBe("released");
expect(await licensing.cancel(tenantId, deviceId, request, actor)).toEqual(receipt);
expect(await devicesAfter()).toEqual(devicesBefore);
expect(await usage()).toBe(previousUsage - 1);
await expect(pairOldCode()).rejects.toMatchObject({ response: { code: "PAIR_INVALID" } });
```

## Task 4: Cabinet and SaaS inspection and cancellation

**Files:** new licensing API/panel in `apps/admin/src/pages/devices/` and `apps/saas-admin/src/pages/tenants/`; integrate into device page/drawer and tenant page; RU/EN translations, focused DOM/API tests in both apps.

**Consumes:** Task 2 exact shared schemas and paths; existing auth capabilities and query clients.

- [x] RED: show shared Station/ТСД count and occupied/reserved/released states; cancellation only for server-authorized eligible reservation. Never call security revoke to cancel.
- [x] Implement using `@markiro/ui`; show explicit confirmation that one place is freed and old pairing code stops working. Keep request ID/revision stable across an uncertain response retry; disable duplicate submission; refresh usage/device/subscription projections on success. A 409 refreshes facts and requires a fresh confirmation, never silently retries new intent.
- [x] For a cancelled station-like record show licensing status and suppress pair/re-pair/edit actions based on new projection; do not label it as revoked for security. Preserve kiosk and existing connection behavior. Do not request restricted cabinet projection without credentials capability.
- [x] RED: keyboard confirmation, permission denial, stale revision, network retry with same request, in-flight navigation, cancelled state after reload, zero/unlimited limits and RU/EN copy.
- [x] Run focused tests plus both app lint/typecheck/test/build and local browser checks at desktop/narrow widths.

## Task 5: Release compatibility, documentation and whole-branch acceptance

**Files:** `docs/operations/entitlements-p1b2.md`, `docs/architecture.md`, applicable deployment compatibility checker/runbook and tests; CI ownership only if current mapping omits changed consumers.

- [x] Make the compatibility check executable: require complete assignments and supported writers before cancellation is enabled. Document exact rollout verification and forbid rollback to the old revoked-at usage reader once cancellation exists; preserve database/history instead of pretending old binaries are compatible. Reuse the existing deployment workflow and do not dispatch it.
- [x] Verify creation/pair/revoke writer coverage and every existing count reader, including fixtures and alternate APIs. Document inconsistent-state repair as diagnosis, never automatic release.
- [x] Run `pnpm turbo run lint typecheck test build --concurrency=1 --force` with the isolated test environment, `pnpm format:check`, `git diff --check`, and affected production bundle contracts. Reconcile skipped tests. Native recovery checks stay separate; run them if actual client contracts/behavior changed.
- [x] Independent spec/quality review, fix concrete findings, and inspect the complete diff against base. Report actual browser evidence and remaining external/hardware checks. Leave scoped changes local for user review.

## Local acceptance — 2026-09-12

All 13 packages completed lint, typecheck, tests and build: 9498 tests passed,
26 explicitly skipped. API 3698, DB 447, contracts 253, cabinet 1242 and SaaS 383 passed.
Production/Yandex Node contracts: 662 passed; the actual compiled API compatibility
probe returned the exact v1 receipt. Full Prettier and `git diff --check` passed.

The initial forced run overlapped review edits and failed. Fresh API verification
passed, then the broad cabinet run exposed three outdated route/auth fixtures.
After their focused fixes, final verification completed in two Turbo runs:
48 successful tasks excluding cabinet, and 8 successful tasks for cabinet plus
dependency builds. Successful unchanged results were cached; failed tasks reran.
The initial failures are not counted as successful verification.

The 26 API skips require a dedicated inventory database (22), opt-in local
Mailpit/MinIO/real CLI checks (3), or a live National Catalog setup (1). Ordinary
PostgreSQL and all new licensing scenarios ran. Native response DTOs and client
sources did not change; server pairing/recovery compatibility was exercised.

Root browser checks exercised the real cabinet/SaaS panels with local fixture
transport in RU/EN at 1440×1000 and 390×844. Confirmation, close/focus, translated
copy and the 2-to-1 count transition passed. This does not establish full deployed
route or production acceptance. Docker image build/publication, production fleet,
native Android/Rust/Windows and physical hardware checks were not performed.

Independent API/DB and UI/deployment findings were resolved. The changes remain
local and uncommitted. First-v1 deployment requires a compatible recovery image;
see the [rollout runbook](../../operations/entitlements-p1b2.md).
