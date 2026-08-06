# Station Device Pairing & Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task by task. Do not batch tasks across review gates.

**Goal:** Replace normal station API-key enrollment with secure 8-digit pairing, keep station records durable across revoke/re-pair, expose a unified cabinet Devices surface, and preserve every unsynchronized floor fact during credential recovery.

**Architecture:** Extract the hardened code/limiter mechanics from kiosk pairing into a device-pairing core while keeping kiosk and station code rows behind type-specific adapters and real foreign keys. A station is pre-created with a nullable key and optional line. Redeeming a code conditionally claims it, attaches a newly minted Better Auth station key, returns device/place/roster provisioning, and compensates by deleting the key if the DB claim fails. Revoke deletes the key but retains the station row and SSCC history. The station seals, rather than deletes, unsynchronized local facts when its credential is rejected.

**Tech stack:** Drizzle/Postgres and Better Auth; NestJS/Zod; React/Vite/TanStack Query; Tauri config + SQLite mirrors; Vitest/Testing Library.

## Global constraints

- Preserve all unrelated dirty files. Start each task with `git status --short`; stage only explicit task paths if the user later requests commits.
- TDD order is mandatory: failing focused test, implementation, focused pass, refactor.
- Never print pairing plaintext, API keys, badge values, PINs, or raw scan data in logs/tests.
- Keep `kiosk_pair_attempts` as the physical table name in this plan. It becomes the shared attempt ledger; do not add a cosmetic migration under live pairing traffic.
- Rebuild `@markiro/db` after DB source changes before running API tests.
- Every business query is tenant-scoped. Every line relation uses a composite tenant foreign key.
- The unauthenticated pairing endpoints must stay outside `TenantGuard`; document both as deliberate exceptions in `docs/device-key-surface.md`.
- Cabinet management remains `TenantGuard` + `AuthorizationGuard`; a station key cannot list, create, pair, reassign, or revoke devices.
- Existing kiosk token, bootstrap, device sequence, rate limits, and redemption atomicity are regression contracts, not refactor opportunities.
- Do not delete `station_devices` on revoke. `sscc_blocks` and audit history depend on stable device IDs.
- Do not clear local outbox, box-closure, exception, conflict, or journal rows on `401`.
- Subscription quota enforcement is out of scope until an authoritative plan/limit service exists. Render no invented quota.

---

## Task 1: Make station device records durable and add station pairing codes

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Create: next generated migration under `packages/db/migrations/`
- Modify: `packages/db/test/schema.test.ts`
- Modify: `packages/db/test/tenant-isolation.test.ts`
- Modify: `packages/db/test/runtime-migrate.test.ts`

**Contract produced:** nullable `stationDevices.apiKeyId`; nullable `lineId`, `pairedAt`, and `revokedAt`; new `stationPairingCodes` table with real tenant/device FK and enforced live-code invariants.

- [ ] **Step 1: Write failing schema assertions**

Add tests that require:

```typescript
expect(schema.stationDevices.apiKeyId.notNull).toBe(false);
expect(schema.stationDevices.lineId).toBeDefined();
expect(schema.stationDevices.pairedAt).toBeDefined();
expect(schema.stationDevices.revokedAt).toBeDefined();
expect(schema.stationPairingCodes).toBeDefined();
```

Use the existing DB integration fixture to prove a station can be inserted without a key, a same-tenant line succeeds, a foreign-tenant line fails, and a station pairing code cannot point at a foreign-tenant device.

- [ ] **Step 2: Run the focused DB tests and observe failure**

```bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/tenant-isolation.test.ts
```

Expected: missing columns/table and current `api_key_id NOT NULL` prevent the fixtures.

- [ ] **Step 3: Change the Drizzle schema**

In `stationDevices`:

```typescript
apiKeyId: text("api_key_id"),
lineId: uuid("line_id"),
pairedAt: timestamp("paired_at", { withTimezone: true }),
revokedAt: timestamp("revoked_at", { withTimezone: true }),
```

Keep `enrolledAt` as the durable creation timestamp for backwards compatibility. Add a composite `(tenantId, lineId) -> lines(tenantId, id)` FK.

Add `stationPairingCodes` near `stationDevices` with:

```typescript
id: uuid primary key
tenantId: tenantId()
stationDeviceId: uuid not null
codeHash: text not null
expiresAt: timestamptz not null
usedAt: timestamptz nullable
attempts: integer not null default 0
issuedByUserId: text not null
createdAt: timestamptz not null default now()
```

Add a composite tenant/station FK, hash lookup index, partial unique index for one unspent row per station, and partial unique index for one unspent station code hash. The station and kiosk endpoints are type-specific, so a hash may exist once in each type table without ambiguity.

- [ ] **Step 4: Generate and inspect the migration**

```bash
pnpm --filter @markiro/db db:generate
```

The generated structural SQL must only relax `api_key_id`, add the three station columns/FK, create `station_pairing_codes`, and add its indexes/FK. It must not rewrite a previously applied migration or drop existing station rows. The reviewed archived-kiosk credential scrub below is the one deliberate data statement added afterward.

After generation, add one reviewed data-scrub statement to the new migration:

```sql
UPDATE "kiosks"
SET "device_token_hash" = NULL
WHERE "status" = 'archived' AND "device_token_hash" IS NOT NULL;
```

This removes already-persisted credentials from revoked kiosks. It does not reactivate or delete a kiosk and is safe to repeat.

- [ ] **Step 5: Add runtime-migration coverage**

Extend `runtime-migrate.test.ts` so an existing station with an API key and `sscc_blocks` reference survives migration with the same ID, key ID, and `enrolledAt`.

- [ ] **Step 6: Apply to a scratch database and pass focused gates**

Use a disposable database, run `db:migrate`, inspect `\d station_devices` and `\d station_pairing_codes`, then:

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

Review gate: confirm no existing device row can be lost and tenant FKs are composite.

---

## Task 2: Extract shared pairing security without changing kiosk behavior

**Files:**

- Create: `apps/api/src/modules/device-pairing/pairing-policy.ts`
- Create: `apps/api/src/modules/device-pairing/pair-attempts.service.ts`
- Create: `apps/api/src/modules/device-pairing/pair-source.ts`
- Create: `apps/api/src/modules/device-pairing/device-pairing.module.ts`
- Modify: `apps/api/src/modules/kiosk/pairing.service.ts`
- Modify: `apps/api/src/modules/kiosk/kiosk.module.ts`
- Modify or re-export: `apps/api/src/modules/kiosk/pair-source.ts`
- Modify: `packages/db/src/schema/pickup.ts` comments only
- Modify: `apps/api/test/kiosk-pairing.e2e.test.ts`
- Move/modify: `apps/api/test/pair-source.test.ts`
- Create: `apps/api/test/device-pairing-policy.test.ts`

**Contract produced:** one code policy and one persisted source/global limiter used by both pairing routes; kiosk issue/redeem output remains byte-for-byte compatible.

- [ ] **Step 1: Pin current kiosk behavior with regression tests**

Before moving code, add/confirm tests for 8 digits including leading zero, 15-minute TTL, HMAC storage, code regeneration, collision retry, single winner under concurrent redeem, source and global budgets, successful-attempt refund, and unchanged `PairKioskResultDto`.

- [ ] **Step 2: Run the focused suite green before refactor**

```bash
pnpm --filter @markiro/api exec vitest run test/kiosk-pairing.e2e.test.ts test/pair-source.test.ts
```

If the baseline is not green, stop and diagnose; do not hide a pre-existing pairing regression inside extraction.

- [ ] **Step 3: Extract pure policy**

`pairing-policy.ts` owns and exports the real constants and pure helpers:

```typescript
CODE_DIGITS = 8
PAIRING_TTL_MS = 15 * 60_000
PAIR_CODE_MAX_ATTEMPTS = 5
PAIR_ATTEMPT_BUDGET = 10
GLOBAL_PAIR_ATTEMPT_BUDGET = 400
PAIR_ATTEMPT_WINDOW_MS = PAIRING_TTL_MS
GLOBAL_PAIR_SOURCE = "*"
mintPairingCode(): string
pairAttemptWindowStart(now: Date): Date
```

`mintPairingCode` uses `crypto.randomInt`, pads to eight digits, and never logs the result.

- [ ] **Step 4: Extract source normalization and the persisted limiter**

Move `normalizePairSource` into the shared module and leave a compatibility re-export from the old kiosk path until every import is migrated.

Move `assertUnderPairRateLimit` and `refundPairAttempt` into `PairAttemptsService`. Preserve record-before-check ordering, global pre-check, unattributable-source behavior, atomic increments, refund flooring, and current DB table.

- [ ] **Step 5: Rewire kiosk pairing through the shared services**

Keep kiosk-specific candidate lookup, bootstrap, token write, and transaction in `PairingService`; replace only policy/limiter duplication. Do not generalize the device transaction through `any` or broad casts.

- [ ] **Step 6: Run focused and full API tests**

```bash
pnpm --filter @markiro/api exec vitest run test/device-pairing-policy.test.ts test/pair-source.test.ts test/kiosk-pairing.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Review gate: the diff may relocate security code, but must not alter kiosk DB statements or response semantics except dependency injection.

---

## Task 3: Pre-create, list, reassign, and revoke durable stations

**Files:**

- Modify: `apps/api/src/modules/station-devices/dto.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.service.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.controller.ts`
- Modify: `apps/api/test/station-devices.service.test.ts`
- Modify: `apps/api/test/station-devices.e2e.test.ts`
- Modify: `apps/api/test/credential-audit.test.ts`

**Contract produced:** `POST /station-devices` creates an awaiting record instead of returning a key; `PATCH /station-devices/:id` changes name/line; `DELETE` revokes without deleting; list returns lifecycle fields.

- [ ] **Step 1: Replace the old enrollment expectations with failing lifecycle tests**

Assert that creation returns no plaintext key, stores `apiKeyId = null`, validates the line in the same tenant, and reports `awaiting_pairing`. Assert revoke deletes/invalidates the key first, preserves the station row and SSCC references, sets `revokedAt`, clears `apiKeyId`, and retires live station codes.

- [ ] **Step 2: Define DTOs**

```typescript
CreateStationDeviceDto = { name: string; lineId: string | null }
UpdateStationDeviceDto = { name?: string; lineId?: string | null }
StationDeviceDto = {
  id; name; lineId; lineName; lifecycle;
  pairedAt; revokedAt; lastSeenAt; createdAt;
}
```

Lifecycle is derived by a single helper with an exported online threshold so API and tests do not duplicate time math.

- [ ] **Step 3: Implement pre-create and update**

Require a same-tenant line when non-null. Create the station row without a key. Update only provided fields. Preserve `deviceId` and credential when changing line.

- [ ] **Step 4: Replace delete semantics with durable revoke**

Read the tenant-scoped row. If a key exists, delete it as its own auto-committed security-critical operation. Then transactionally clear `apiKeyId`, set `revokedAt`, and retire live codes. Do not delete the station row. Make a repeated revoke idempotent or return the established precise result; pin the choice in tests.

- [ ] **Step 5: Record exact audits**

Use actions `station_device.create`, `station_device.update`, and `station_device.revoke`, with tenant, acting user, device resource, and succeeded/failed outcome following the existing security-audit pattern. Never include key/code plaintext in metadata.

- [ ] **Step 6: Run focused tests after rebuilding DB**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/station-devices.service.test.ts test/station-devices.e2e.test.ts test/credential-audit.test.ts
```

Review gate: the legacy immediate-key response is intentionally removed from the normal route; the later hidden service route must be separately guarded.

---

## Task 4: Issue and redeem station pairing codes

**Files:**

- Create: `apps/api/src/modules/station-pairing/dto.ts`
- Create: `apps/api/src/modules/station-pairing/station-pairing.service.ts`
- Create: `apps/api/src/modules/station-pairing/station-pair.controller.ts`
- Create: `apps/api/src/modules/station-pairing/station-pairing.module.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.controller.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/station-pairing.e2e.test.ts`
- Modify: `apps/api/test/authorization-metadata.test.ts`

**Contract produced:** cabinet `POST /station-devices/:id/pairing-code`; unauthenticated `POST /station/pair`; stable error codes; provisioning bundle containing device/place/key/server/roster.

- [ ] **Step 1: Write failing issue-code tests**

Cover tenant-scoped station lookup, 8 digits, HMAC-at-rest, 15-minute TTL, regenerate-retiring-old, one live code per station, and exact audit fields. A station API key must receive 403 from the issue route.

- [ ] **Step 2: Write failing redemption tests**

Cover success, invalid, expired, already used, source/global rate limit, concurrent single winner, revoked station re-pair, roster contents containing hashes but no plaintext PIN/badge, and response containing the same durable `deviceId`.

Use stable public error codes such as:

```typescript
type StationPairErrorCode = "PAIR_INVALID" | "PAIR_EXPIRED" | "PAIR_LOCKED" | "PAIR_RATE_LIMITED";
```

Do not expose tenant/device names on failures.

- [ ] **Step 3: Implement code issuance**

`issueCode(tenantId, stationId, issuedByUserId)` verifies the tenant-scoped station, retires prior unspent codes, mints via shared policy, hashes with the existing server-held pairing pepper, retries hash collisions, and returns plaintext once with expiry.

- [ ] **Step 4: Implement compensating key provisioning**

The station service:

1. consumes the shared limiter before lookup;
2. selects the deterministic station candidate by hash;
3. validates live/attempt state;
4. builds the org-wide roster using `OperatorsService.buildRoster` before claim;
5. creates a candidate Better Auth key with `configId: "station"`, organization ID, stored issuing user ID, and `metadata.kind = "station"`;
6. conditionally marks the code used and updates the station row with key ID, `pairedAt`, and `revokedAt = null` in one DB transaction;
7. deletes the candidate key on any lost race/rollback;
8. refunds the source/global attempt on committed success;
9. returns key plaintext only to the winning request.

- [ ] **Step 5: Return the provisioning bundle**

```typescript
interface PairStationResultDto {
  device: {
    id: string;
    name: string;
    tenantId: string;
    organizationName: string;
    line: { id: string; name: string } | null;
  };
  credential: { apiKey: string; serverUrl: string };
  operators: OperatorMirrorRecord[];
}
```

`serverUrl` comes from the canonical deployment configuration, not the request body. The on-prem client chooses which trusted base URL to call, but the server does not reflect an arbitrary address back.

- [ ] **Step 6: Register route security and docs**

The cabinet issue route uses `CREDENTIALS_MANAGE`. `POST /station/pair` has no auth guard by design and uses only pairing security. Add route metadata tests so a later class-level guard cannot accidentally expose issue/revoke to a device key.

- [ ] **Step 7: Run concurrency and security tests**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/station-pairing.e2e.test.ts test/kiosk-pairing.e2e.test.ts test/authorization-metadata.test.ts
```

Review gate: inspect the losing redemption path and prove every candidate key is deleted.

---

## Task 5: Resolve station heartbeat and default line safely

**Files:**

- Modify: `apps/api/src/tenancy/tenant.guard.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/test/tenant.guard.test.ts`
- Modify: `apps/api/test/station-auth.e2e.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`

**Contract produced:** verified station calls update `lastSeenAt`; station shift listing defaults to assigned line without turning line into an authorization boundary.

- [ ] **Step 1: Write failing guard tests**

Assert that a valid key resolving to a station sets `req.deviceId`, exposes its assigned `lineId` on `RequestWithTenant`, and updates only that tenant/device `lastSeenAt`. Invalid/revoked keys update nothing.

- [ ] **Step 2: Extend the authenticated request context**

Add `deviceLineId?: string | null` and select both device ID and line ID during key resolution. Update `lastSeenAt` only after the row is found. If a valid Better Auth key has no station row, reject it rather than creating an authenticated station principal with no device identity.

- [ ] **Step 3: Write failing shift-default tests**

For a station request without an explicit line query, return shifts assigned to the station line plus unassigned shifts so legacy/ad-hoc work is not stranded. For a cabinet request, preserve current list behavior.

- [ ] **Step 4: Apply the default filter at the controller boundary**

Pass an effective query into `ShiftsService.listShifts`. When a station explicitly supplies `lineId`, preserve the existing tenant-wide query capability because line is not an authorization boundary; tenant scoping still applies. The production station UI does not expose that override in this slice. Tests must distinguish this deliberate behavior from an authorization check.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @markiro/api exec vitest run test/tenant.guard.test.ts test/station-auth.e2e.test.ts test/shifts.e2e.test.ts
```

Review gate: tenant isolation and existing cabinet shift filters remain unchanged.

---

## Task 6: Add a unified, paginated Devices read model

**Files:**

- Create: `apps/api/src/modules/devices/dto.ts`
- Create: `apps/api/src/modules/devices/devices.service.ts`
- Create: `apps/api/src/modules/devices/devices.controller.ts`
- Create: `apps/api/src/modules/devices/devices.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/devices.e2e.test.ts`
- Modify: `docs/device-key-surface.md`

**Contract produced:** cabinet-only `GET /devices` combining kiosks and stations with server pagination/filtering and no secret material.

- [ ] **Step 1: Define and test the query contract**

```typescript
GET /devices?type=station|kiosk&status=awaiting_pairing|online|offline|revoked&page=1&pageSize=8
```

Response:

```typescript
{
  items: Array<{
    id: string;
    type: "station" | "kiosk";
    name: string;
    place: { id: string | null; name: string | null };
    status: "awaiting_pairing" | "online" | "offline" | "revoked";
    lastSeenAt: string | null;
    paired: boolean;
  }>;
  page: number;
  pageSize: number;
  total: number;
}
```

Assert stable sort (most actionable status, then name/type/id or another documented order), exact total, filter semantics, and no key/token/hash columns.

- [ ] **Step 2: Implement the read model**

Use tenant-scoped selects from each table, normalize in service memory, sort deterministically, then page. This is acceptable for MVP device counts; do not build a polymorphic persistence table. Bound `pageSize` (recommended maximum 50).

- [ ] **Step 3: Protect the route**

Use `OPERATIONS_READ` through `AuthorizationGuard`. Add e2e denial for a station key and update the cabinet-only table in `docs/device-key-surface.md`.

- [ ] **Step 4: Run focused API tests and OpenAPI check**

```bash
pnpm --filter @markiro/api exec vitest run test/devices.e2e.test.ts test/device-key-triage.e2e.test.ts test/openapi-docs.test.ts
```

Review gate: quota fields are absent until a real subscription service exists.

---

## Task 7: Align kiosk revoke/unbind semantics for the unified Devices lifecycle

**Files:**

- Modify: `apps/api/src/modules/kiosks/kiosks.service.ts`
- Modify: `apps/api/src/modules/kiosks/kiosks.controller.ts`
- Modify: `apps/api/src/modules/kiosks/dto.ts`
- Modify: `apps/api/test/kiosks.e2e.test.ts`
- Modify: `apps/api/test/kiosk-device.guard.test.ts`
- Modify: `apps/api/test/kiosk-pairing.e2e.test.ts`
- Modify: `apps/api/test/credential-audit.test.ts`

**Contract produced:** a revoked kiosk retains its record but no token/code; an unbound active kiosk is awaiting pairing; reactivation cannot resurrect an old credential.

- [ ] **Step 1: Write failing lifecycle tests**

Assert that archive/revoke clears `deviceTokenHash`, retires live codes, makes the old token fail, retains the kiosk row/history, and writes exact audit fields. Assert an explicit unbind keeps `status = active` but clears token/codes, so the combined read model reports `awaiting_pairing`.

- [ ] **Step 2: Make revoke and unbind transactional**

Within one tenant-scoped DB transaction, clear token, retire live codes, and set the requested active/archived state. A repeated call is idempotent. Never return the old hash/token.

- [ ] **Step 3: Preserve re-pair rotation**

Issuing a code for an active unbound/bound kiosk stays allowed; successful redemption writes a new token hash through the existing atomic path. An archived kiosk must be explicitly reactivated/unbound before code issue, and because revoke scrubbed its token, reactivation cannot restore access accidentally.

- [ ] **Step 4: Run kiosk security regressions**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/kiosks.e2e.test.ts test/kiosk-device.guard.test.ts test/kiosk-pairing.e2e.test.ts test/credential-audit.test.ts
```

Review gate: existing pickup data, device sequence, and bootstrap content remain unchanged.

---

## Task 8: Build the cabinet Devices page and reusable drawer

**Files:**

- Create: `packages/ui/src/components/Drawer.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/test/components.test.tsx`
- Create: `apps/admin/src/pages/devices/api.ts`
- Create: `apps/admin/src/pages/devices/index.tsx`
- Create: `apps/admin/src/pages/devices/DeviceDrawer.tsx`
- Create: `apps/admin/src/pages/devices/DevicePager.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/devices.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`
- Modify: `apps/admin/test/shell-layout.test.tsx`

**Contract produced:** `/devices` list/filter/pager and Add-device drawer; `/kiosks` compatibility redirect.

- [ ] **Step 1: TDD the Drawer accessibility contract**

Test `role="dialog"`, `aria-modal`, labelled title, initial focus, focus trap, Escape, overlay/close behavior, and focus restoration. The panel enters from the right through CSS only; reduced motion receives no slide transition.

- [ ] **Step 2: TDD typed API hooks**

Add query keys including type/status/page/pageSize and mutations for type-specific create/update/revoke/issue endpoints. Invalidate combined Devices plus legacy Kiosks queries after kiosk mutations.

- [ ] **Step 3: Build bounded list states**

Render header, filters, table/cards, empty/loading/error, and large pager. The admin application may scroll normally; the no-scroll contract applies to station surfaces, not the office list.

- [ ] **Step 4: Build the first drawer stage**

Type selection changes Place input: existing line selector for station, location for kiosk. Keep kiosk day-limit/show-price defaults compatible. Submit creates a device, then advances the same drawer to its code state rather than closing.

- [ ] **Step 5: Update routing/navigation**

Replace Kiosks nav with Devices. Add a redirect route from `/kiosks` to `/devices?type=kiosk`; preserve direct kiosk settings access through the Devices row action.

- [ ] **Step 6: Run UI package/admin tests**

```bash
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm --filter @markiro/admin exec vitest run test/devices.test.tsx test/access-routing.test.tsx test/shell-layout.test.tsx
```

Review gate: cabinet behavior is capability-gated and no one-time secret enters query cache longer than the active drawer state.

---

## Task 9: Finish code reveal, print sheet, and lifecycle actions in the cabinet

**Files:**

- Create: `apps/admin/src/pages/devices/PairingCodePanel.tsx`
- Move/reuse: `apps/admin/src/pages/kiosks/PairingBarcode.tsx`
- Create: `apps/admin/src/pages/devices/PairingInstructions.tsx`
- Create: `apps/admin/src/pages/devices/DeviceActions.tsx`
- Modify: `apps/admin/src/pages/devices/api.ts`
- Modify: `apps/admin/src/pages/devices/DeviceDrawer.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/device-pairing.test.tsx`

**Contract produced:** one-time code/barcode/countdown, regeneration, browser print, reassign, re-pair, and revoke interactions for both types.

- [ ] **Step 1: Write failing one-time-secret tests**

Assert the code is rendered only from the mutation response, cleared when the drawer closes or the route unmounts, never persisted to local/session storage, and replaced when regenerated. Use `gcTime: 0` plus explicit mutation reset for this one-time-secret mutation, or bypass the mutation cache with an equivalent ephemeral request. Countdown uses `expiresAt`, not a fresh client-side 15 minutes.

- [ ] **Step 2: Reuse the barcode renderer**

Move the existing kiosk barcode component to a neutral devices path or wrap it without duplicating encoding. Its payload remains the exact 8 digits.

- [ ] **Step 3: Implement the print document**

Use a semantic print-only section and `window.print()`. Add `@media print` rules so only the instruction sheet prints, in black/white with a quiet zone around the barcode. Include device type/name/place, organization, grouped digits, raw accessible digits, issued/expiry time, and numbered instructions. Do not write the code to the URL.

- [ ] **Step 4: Implement lifecycle confirmations**

Reassign keeps credentials. Re-pair issues a fresh code for the same record. Revoke uses a destructive confirmation describing delayed offline observation and retained unsynchronized data. Update UI only after server success; failures preserve the current visible state.

- [ ] **Step 5: Test RU/EN, countdown expiry, and print semantics**

```bash
pnpm --filter @markiro/admin exec vitest run test/device-pairing.test.tsx test/devices.test.tsx test/kiosks.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Review gate: no plaintext code or credential survives drawer teardown.

---

## Task 10: Add station pairing client, provisioning persistence, and service recovery

**Files:**

- Create: `apps/station/src/lib/pairing.ts`
- Modify: `apps/station/src/lib/api-client.ts`
- Modify: `apps/station/src/lib/config.ts`
- Modify: `apps/station/src-tauri/src/config.rs`
- Replace: `apps/station/src/pages/Enrollment.tsx`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/enrollment.test.tsx`
- Modify: `apps/station/test/App.test.tsx`
- Modify: `apps/station/test/api-client.test.tsx`
- Modify: `apps/station/src-tauri/src/config.rs` tests

**Contract produced:** functional pairing state machine and persisted provisioning bundle. Visual polish is completed by the fullscreen UI plan.

- [ ] **Step 1: TDD an unauthenticated pairing client**

Add a client that posts `{ code }` to `/station/pair` without `x-api-key`, uses the same request deadline discipline, and maps status/body error codes into a typed result. It must not log response bodies containing the key.

- [ ] **Step 2: TDD provisioning persistence order**

Test the following sequence:

1. validate the response shape;
2. publish the complete operator roster into the inactive mirror slot;
3. write config containing stable machine ID plus tenant/device/key/server;
4. signal `onEnrolled` only after both succeed.

If roster publish fails, config remains unpaired. If config write fails, the previous config remains readable and local operational tables are untouched.

- [ ] **Step 3: Extend Tauri config only where necessary**

Persist optional display metadata (`organization_name`, `line_id`, `line_name`) if the shell requires it offline. Keep API key owner-only on Unix and per-user on Windows. Add explicit `clear_credential` behavior that removes key/tenant/place fields but preserves `machine_id` and `device_id` for same-record re-pair.

- [ ] **Step 4: Replace normal Enrollment UI behavior**

Implement code entry, scanner capture, typed states, setup entry, and success callback. Keep the existing manual URL/API-key form behind an explicit service-mode action; it must not be the default and must still perform a reachability/auth probe before writing config.

- [ ] **Step 5: Route app startup through pairing state**

`nextStationView` distinguishes loading, pairing, login, and floor. A config with device ID but no key is recovery pairing, not a fresh unknown device. Existing fully enrolled configs continue directly to login for upgrade compatibility.

- [ ] **Step 6: Run station/Rust focused tests**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/station exec vitest run test/enrollment.test.tsx test/App.test.tsx test/api-client.test.tsx test/roster-sync.test.ts
cargo test --manifest-path apps/station/src-tauri/Cargo.toml config
```

Review gate: no test snapshot or error string contains a real-looking API key.

---

## Task 11: Seal unsynchronized work on credential rejection and restore after re-pair

**Files:**

- Create: `apps/station/src/lib/credential-recovery.ts`
- Modify: `apps/station/src/lib/sync.ts`
- Modify: `apps/station/src/lib/use-sync-engine.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/pages/Enrollment.tsx`
- Modify: `apps/station/test/sync.test.ts`
- Modify: `apps/station/test/use-sync-engine.test.tsx`
- Create: `apps/station/test/credential-recovery.test.ts`

**Contract produced:** authenticated `401` stops retrying the rejected key, clears only reproducible credential/cache state, reports sealed pending counts, and resumes the same queue after re-pair.

- [ ] **Step 1: Write failing recovery-boundary tests**

Create fixtures containing scans, boxes, exceptions, conflicts, roster, and config. After a simulated authenticated `401`, assert:

- outbox/box/exception/journal/conflict rows are byte-for-byte present;
- key and reproducible roster/reference caches are cleared;
- stable machine/device IDs remain;
- sync stops retrying with the rejected client;
- UI receives a recovery event with exact unsynchronized counts.

Network errors, timeout, 429, and 5xx must not trigger credential recovery.

- [ ] **Step 2: Add a typed terminal sync outcome**

The engine already catches ordinary failures for retry. Introduce an `onCredentialRejected` callback only for `StationApiError.status === 401`. Ensure concurrent drains publish the terminal outcome once and cannot ack rows after rejection.

- [ ] **Step 3: Implement recoverable cache clearing**

Use explicit table/key allowlists; never “clear the database”. Keep the operator roster until the UI has safely exited the authenticated floor, then remove/reseed it as part of pairing. Document each retained/deleted table in code.

- [ ] **Step 4: Resume after same-device re-pair**

After a new key is persisted for the same device ID, rebuild the client, refresh roster/reference data, and nudge the existing sync engine. Its idempotency keys and local ceilings remain unchanged.

- [ ] **Step 5: Run restart and queue-integrity tests**

```bash
pnpm --filter @markiro/station exec vitest run test/credential-recovery.test.ts test/sync.test.ts test/use-sync-engine.test.tsx test/outbox.test.ts test/box-exceptions-mirror.test.ts
```

Review gate: inspect every `DELETE` introduced by this task and identify why it cannot remove a production fact.

---

## Task 12: Final security, compatibility, and documentation gates

**Files:**

- Modify: `docs/device-key-surface.md`
- Modify: `docs/architecture.md` if the durable lifecycle is an accepted architectural invariant
- Modify: relevant OpenAPI snapshots/tests
- Modify: `docs/superpowers/specs/2026-07-24-device-commissioning-design.md` status/link only if the user approves updating the older spec

- [ ] **Step 1: Run the complete changed-package gates**

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm format:check
git diff --check
```

- [ ] **Step 2: Audit exact security properties**

Search the final diff for key/code logging, unscoped device queries, plaintext response caching, broad casts, deletion of station rows, and local destructive SQL. Confirm exact audits for create/issue/reassign/re-pair/revoke outcomes.

- [ ] **Step 3: Perform cabinet browser verification**

Check combined pagination/filtering, station and kiosk creation, one-time reveal, expired/regenerated code, print preview, change place, re-pair, revoke, long RU/EN names, keyboard focus, and capability denial. Record screenshots separately from automated results.

- [ ] **Step 4: Perform station integration verification**

With a non-production test tenant: pair by keypad, pair by scanner, race the same code from two clients, work offline, queue facts, revoke, reconnect, observe recovery without data deletion, re-pair same record, and drain the queue once.

- [ ] **Step 5: Report external gaps honestly**

List whether Windows, physical scanner, printer, on-prem TLS, sudden power loss, and real subscription limits were exercised. Do not infer them from unit/e2e success.

Final review gate: request a whole-plan code review focused on security atomicity, tenant isolation, and offline data retention before merging.
