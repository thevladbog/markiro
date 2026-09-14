# Offline Grants P1D.1 Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated native client readiness reports, a server-derived rollout readiness inventory, and a non-mutating pilot-cohort preview for offline grants.

**Architecture:** Each native client reports only after configuration, keyset, and a verified device grant survive a durable-store round trip. The API retains immutable self-reports, derives eligibility from current server facts, and exposes a bounded platform list and snapshot preview. SaaS Admin presents the report and preview without any strict-mode activation path.

**Tech Stack:** TypeScript 6, NestJS, Zod, Drizzle/PostgreSQL, React 19, TanStack Query, Station SQLite, kiosk IndexedDB, Kotlin/Room/Retrofit, Vitest, Gradle.

**Spec:** `docs/superpowers/specs/2026-09-14-offline-grants-p1d1-readiness-design.md`

## Global Constraints

- P1D.1 must not create or approve lifecycle policies, change subscriptions, or activate `strict`.
- Client build strings are diagnostic; eligibility requires a current authenticated readiness report tied to an actual server-issued device grant.
- Native reports use native device credentials and remain available through the existing read-only recovery subscription policy.
- Platform reads require the isolated platform principal and every capability named by the spec.
- Existing configuration, grant issuance, evidence, Station, kiosk, and Handheld payloads remain byte/schema compatible.
- Readiness older than 24 hours is blocked; server time is authoritative.
- Persisted history is append-only and tenant/owner scoped. No credential, private key, compact JWS, or evidence payload is copied into readiness rows or platform responses.
- Automated results must be reported separately from Windows, Android hardware, kiosk service-worker, factory network, clock-drift, deployment, and pilot evidence.

---

### Task 1: Shared readiness contracts

**Files:**

- Create: `packages/platform-contracts/src/offline-grant-readiness.ts`
- Modify: `packages/platform-contracts/src/offline-grants.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Create: `packages/platform-contracts/test/offline-grant-readiness.test.ts`

**Interfaces:**

- Produces `grantClientReadinessRequestSchema`, `grantClientReadinessResponseSchema`, `grantReadinessReasonSchema`, `platformGrantReadinessListQuerySchema`, `platformGrantReadinessListResponseSchema`, `platformGrantReadinessPreviewRequestSchema`, and `platformGrantReadinessPreviewResponseSchema`.
- Native request identity is `{protocol, capability, requestId}` plus client/storage/install facts.
- Platform rows expose display data, server facts, eligibility, and reasons without authority-bearing payloads.

- [ ] **Step 1: Write failing strict-schema tests**

Add tests that parse a valid native report and reject unknown fields, duplicate preview device IDs, more than 200 IDs, invalid cursors, and empty reason lists for blocked rows. Pin the discriminants:

```ts
expect(
  grantClientReadinessRequestSchema.parse({
    protocol: "offline-grants-v1",
    capability: "offline-grants-readiness-v1",
    requestId,
    clientBuild: "station:1.4.2",
    storageRevision: 14,
    installed: {
      mode: "observe",
      policyRevision,
      keysetRevision: "keyset-7",
      verifiedGrantId,
    },
  }),
).toMatchObject({ capability: "offline-grants-readiness-v1" });
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/offline-grant-readiness.test.ts`

Expected: FAIL because the readiness schemas are not exported.

- [ ] **Step 3: Implement the native schemas**

In `offline-grants.ts`, extend `grantNegotiationSchema` into the exact request from the spec and export inferred types. Keep `installed` strict and `verifiedGrantId` nullable. Define the response with server-generated `receivedAt` and the two match booleans.

- [ ] **Step 4: Implement platform report and preview schemas**

In `offline-grant-readiness.ts`, define stable reason codes and these outer shapes:

```ts
export const platformGrantReadinessContracts = {
  list: {
    query: platformGrantReadinessListQuerySchema,
    response: platformGrantReadinessListResponseSchema,
  },
  preview: {
    body: platformGrantReadinessPreviewRequestSchema,
    response: platformGrantReadinessPreviewResponseSchema,
  },
} as const;
```

Use `platformTimestampSchema`, `platformUuidSchema`, `deviceKindSchema`, a maximum page size of 100, a maximum cohort size of 200, and `.strict()` at every object boundary. A blocked row must have at least one `grantReadinessReasonSchema` value; an eligible row must have `reasons: []`.

- [ ] **Step 5: Export and run package gates**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
```

Expected: all pass.

- [ ] **Step 6: Commit contracts**

```bash
git add packages/platform-contracts/src/offline-grants.ts packages/platform-contracts/src/offline-grant-readiness.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/offline-grant-readiness.test.ts
git commit -m "feat: define offline grant readiness contracts"
```

---

### Task 2: Append-only readiness persistence

**Files:**

- Modify: `packages/db/src/schema/device-grants.ts`
- Create: `packages/db/migrations/0149_offline_grant_readiness.sql`
- Create: `packages/db/migrations/meta/0149_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/device-grants-schema.test.ts`
- Create: `packages/db/test/device-grant-readiness-migration.test.ts`

**Interfaces:**

- Produces `schema.deviceGrantClientReadinessReports`.
- Reuses the established station/handheld/kiosk owner columns and composite foreign keys.
- References `deviceGrantConfigurations.id` and `deviceGrantIssuances.grantId` only for server-matched facts.

- [ ] **Step 1: Add failing schema assertions**

Assert the table export, owner check, positive epoch/storage revision, finite `received_at`, 64-character payload digest, and uniqueness of the complete request identity. Assert that a station ID cannot be paired with owner kind `kiosk`, and a foreign-tenant configuration or grant cannot be referenced.

- [ ] **Step 2: Add a failing migration test**

Create an isolated database, apply migrations through 0149, insert station and kiosk owners, and verify:

```ts
await expect(insertChangedPayloadWithSameRequestIdentity()).rejects.toMatchObject({
  code: "23505",
});
await expect(updatePersistedReport()).rejects.toThrow(/immutable/i);
```

Also run the migration twice through the repository migration runner and verify the table/index set is unchanged.

- [ ] **Step 3: Run focused DB tests and verify failure**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/device-grants-schema.test.ts test/device-grant-readiness-migration.test.ts
```

Expected: FAIL because the table and migration do not exist.

- [ ] **Step 4: Add the Drizzle table**

Define columns from the spec plus:

```ts
reportedMode: text("reported_mode").$type<"observe" | "strict">().notNull(),
reportedPolicyRevision: text("reported_policy_revision"),
reportedKeysetRevision: text("reported_keyset_revision"),
reportedGrantId: uuid("reported_grant_id"),
configurationId: uuid("configuration_id"),
verifiedGrantId: uuid("verified_grant_id"),
matchesCurrentConfiguration: boolean("matches_current_configuration").notNull(),
verifiedGrantMatched: boolean("verified_grant_matched").notNull(),
```

Add tenant-composite references for the matched configuration and verified grant, separate latest indexes for station/handheld and kiosk, and an immutable-update trigger consistent with other append-only grant tables.

- [ ] **Step 5: Generate and review migration metadata**

Run `corepack pnpm --filter @markiro/db db:generate`, rename the generated SQL/tag to `0149_offline_grant_readiness`, and inspect SQL for exact FKs, checks, indexes, trigger, and absence of destructive changes. Do not hand-edit the snapshot JSON.

- [ ] **Step 6: Run DB gates**

Run:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db exec vitest run test/device-grants-schema.test.ts test/device-grant-readiness-migration.test.ts
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
```

Expected: all pass; database-backed tests must report a real test database rather than a skip.

- [ ] **Step 7: Commit persistence**

```bash
git add packages/db/src/schema/device-grants.ts packages/db/migrations/0149_offline_grant_readiness.sql packages/db/migrations/meta/0149_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/device-grants-schema.test.ts packages/db/test/device-grant-readiness-migration.test.ts
git commit -m "feat: retain offline grant client readiness"
```

---

### Task 3: Native readiness report API

**Files:**

- Create: `apps/api/src/modules/device-grants/grant-client-readiness.service.ts`
- Modify: `apps/api/src/modules/device-grants/device-grants.controller.ts`
- Modify: `apps/api/src/modules/device-grants/kiosk-grants.controller.ts`
- Modify: `apps/api/src/modules/device-grants/device-grants.module.ts`
- Create: `apps/api/test/device-grant-client-readiness.test.ts`
- Modify: `apps/api/test/device-grants-routes.test.ts`
- Modify: `apps/api/test/device-grants-openapi.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**

- Produces `GrantClientReadinessService.report(identity, input)` returning `GrantClientReadinessResponse`.
- Consumes current owner locking, signing configuration, configuration history, issuance history, and the Task 1 contracts.
- Both native controllers delegate to the same service after deriving authenticated identity.

- [ ] **Step 1: Write failing service tests**

Cover station, handheld, and kiosk. Seed an approved observe policy, issue and installable device grant, then report the exact policy/keyset/grant tuple. Assert the stored server-derived links and exact tenant audit payload. Add cases for missing grant, foreign owner, retired kid, mismatched configuration, credential rotation, duplicate replay, and changed-payload conflict.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/device-grant-client-readiness.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement report classification and idempotency**

Within one transaction:

```ts
const owner = await lockCurrentGrantOwner(tx, identity, now);
const payloadDigest = entitlementDigest(input);
const replay = await findReadinessRequest(tx, owner, input.requestId);
if (replay && replay.payloadDigest !== payloadDigest) throw readinessConflict();
if (replay) return readinessResponse(replay);
```

Then load the latest owner configuration, current keyset, and the reported device issuance using tenant/owner/epoch predicates. Compute match booleans; never accept booleans from the request. Insert the report and `offline_grant.readiness.reported` tenant audit event atomically. Map unique-race replay to the same response and changed payload to `409 GRANT_READINESS_REQUEST_CONFLICT`.

- [ ] **Step 4: Add both controllers and policies**

Add `POST readiness` with `@HttpCode(200)`, `@AllowSubscriptionReadOnly("read")`, strict Zod body, response/OpenAPI schemas, and existing native guards. Preserve controller-specific identity derivation.

- [ ] **Step 5: Update route inventories and OpenAPI tests**

Pin Station guard order as `TenantGuard -> StationOnlyGuard -> SubscriptionAccessGuard`, kiosk order as `KioskDeviceGuard -> SubscriptionAccessGuard`, and the exact `read_only_allowed` policy. Assert both routes appear in generated OpenAPI without changing existing native contracts.

- [ ] **Step 6: Run API gates**

Run:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/device-grant-client-readiness.test.ts test/device-grants-routes.test.ts test/device-grants-openapi.test.ts test/subscription-route-inventory.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

Expected: all pass.

- [ ] **Step 7: Commit native API**

```bash
git add apps/api/src/modules/device-grants apps/api/test/device-grant-client-readiness.test.ts apps/api/test/device-grants-routes.test.ts apps/api/test/device-grants-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat: accept native offline grant readiness reports"
```

---

### Task 4: Platform readiness inventory and cohort preview

**Files:**

- Create: `apps/api/src/modules/device-grants/grant-readiness-facts.ts`
- Create: `apps/api/src/modules/device-grants/platform-grant-readiness.service.ts`
- Create: `apps/api/src/modules/device-grants/platform-grant-readiness.controller.ts`
- Modify: `apps/api/src/modules/device-grants/device-grants.module.ts`
- Create: `apps/api/test/platform-grant-readiness.integration.test.ts`
- Modify: `apps/api/test/platform-route-contracts.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**

- Produces `readGrantReadinessFacts(tx, asOf, filters)` with one batched query path for stations/handhelds and one for kiosks.
- Produces `PlatformGrantReadinessService.list(principal, query)` and `.preview(principal, input)`.
- Preview digest is `entitlementDigest({protocol:"offline-grants-readiness-preview-v1", ...canonicalFacts})`.

- [ ] **Step 1: Write failing eligibility matrix tests**

Seed one eligible device and one row for every reason code. Assert exact reason arrays, not `arrayContaining`. Include boundary checks at exactly 24 hours and one millisecond beyond, current versus old epoch, assigned versus released device, retired key, policy mismatch, and a valid report whose grant has since expired.

- [ ] **Step 2: Write failing platform authorization and snapshot tests**

Assert both capabilities for list and all three for preview, cabinet denial, support-role denial where capabilities are absent, cross-tenant resolution, deterministic order, maximum 100 page size, maximum 200 cohort, cursor/filter binding, no `FOR UPDATE`, and zero writes to policies, subscriptions, assignments, configurations, and client reports.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/platform-grant-readiness.integration.test.ts`

Expected: FAIL because controller/service/fact reader are absent.

- [ ] **Step 4: Implement batched fact loading and pure classification**

Keep eligibility deterministic:

```ts
export function classifyGrantReadiness(
  facts: GrantReadinessFacts,
  targetPolicy: ApprovedGrantPolicy,
  asOf: Date,
): { eligible: boolean; reasons: GrantReadinessReason[] };
```

Load latest configuration and latest current-epoch report with lateral/subquery ranking, not an N+1 loop. Derive assignment using the existing working-device authority. Read evidence only as an aggregate timestamp/count. Sort reasons by the contract enum order.

- [ ] **Step 5: Implement list, cursor, preview, and audit**

List returns an opaque base64url cursor containing schema version, `asOf`, filters, and last `(tenantId, kind, deviceId)`. Preview opens a read-only repeatable-read transaction, resolves every requested ID, computes canonical rows and digest, then records one platform audit event outside the read-only snapshot using the same `asOf`/digest/result counts. The audit write must not alter the preview facts.

- [ ] **Step 6: Register protected platform routes**

Declare `@Controller("platform/offline-grants")`, then use:

```ts
@Get("readiness")
@RequirePlatformCapabilities("tenants.read", "catalog.read")

@Post("readiness/preview")
@RequirePlatformCapabilities("tenants.read", "catalog.read", "catalog.write")
```

Apply platform response parsing and the shared contracts. Add exact route inventory and OpenAPI coverage.

- [ ] **Step 7: Run API package gates**

Run the focused integration/contract tests, then API test, typecheck, lint, and build with `DATABASE_URL` pointing only to the disposable test database.

- [ ] **Step 8: Commit platform readiness API**

```bash
git add apps/api/src/modules/device-grants apps/api/test/platform-grant-readiness.integration.test.ts apps/api/test/platform-route-contracts.ts apps/api/test/platform-contract-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat: preview offline grant rollout readiness"
```

---

### Task 5: Station durable readiness reporting

**Files:**

- Modify: `apps/station/src/lib/offline-grants/transport.ts`
- Modify: `apps/station/src/lib/offline-grants/store.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/test/offline-grants-store.test.ts`
- Modify: `apps/station/test/offline-grants-recovery.test.ts`

**Interfaces:**

- Produces `reportStationGrantReadiness(input)`.
- Reads configuration, keyset revision, and latest verified device grant back through `SqlExecutor` after the install command commits.
- Uses the existing credential generation lease through report construction; a changed generation cancels reporting.

- [ ] **Step 1: Add failing durable-order tests**

Assert no report occurs after verification failure, SQLite command failure, stale credential lease, or a response that has not been reread. Assert the body contains the reread mode/policy/keyset/grant ID and that a lost response retries the same stored requestId/body.

- [ ] **Step 2: Run Station focused tests and verify failure**

Run: `corepack pnpm --filter @markiro/station exec vitest run test/offline-grants-store.test.ts test/offline-grants-recovery.test.ts`

Expected: FAIL because reporting does not exist.

- [ ] **Step 3: Persist a pending report intent in SQLite**

Add an `offline_grant_readiness_outbox` runtime migration/table through the authoritative Station migration list. Store requestId, canonical body, credential generation, attempts, and acknowledgement. Do not derive a fresh requestId after restart.

- [ ] **Step 4: Implement report creation and delivery**

After configuration install, request and install a device grant in observe mode when no current device slot exists. Then query `offline_grant_install_state`, current keyset, and the `device` token slot. Build `clientBuild` from the packaged Station version and `storageRevision` from the Station offline-grant migration version. POST `/station/grants/v1/readiness`; delete/ack the outbox row only after the shared response schema parses and echoes requestId. Failure to obtain the diagnostic device grant leaves readiness pending and does not block existing productive recovery.

- [ ] **Step 5: Wire refresh points without blocking productive recovery**

Call report flushing after existing configuration refreshes in `App.tsx`. A report transport failure remains retryable and must not undo a valid installed configuration or stop legacy observe work.

- [ ] **Step 6: Run Station gates**

Run Station focused tests, package test/typecheck/lint/build, SQLite parity check, and `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`. Record that host Cargo does not prove Windows persistence.

- [ ] **Step 7: Commit Station reporting**

```bash
git add apps/station/src/lib/offline-grants apps/station/src/App.tsx apps/station/test/offline-grants-store.test.ts apps/station/test/offline-grants-recovery.test.ts
git commit -m "feat(station): report durable offline grant readiness"
```

---

### Task 6: Handheld durable readiness reporting

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/StationApi.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/grants/GrantStorage.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/grants/GrantTransport.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/grants/GrantRefresher.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/grants/GrantTransportTest.kt`
- Modify: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/grants/GrantMigrationTest.kt`

**Interfaces:**

- Adds Retrofit `grantReadiness(JsonObject)`.
- Adds Room `GrantReadinessOutboxEntity` and DAO operations.
- Reports `BuildConfig.VERSION_NAME` and Handheld database version after a Room transaction and reread.

- [ ] **Step 1: Add failing Room migration and transport tests**

Upgrade a real prior-version database and assert the outbox survives reopen. Test no report on failed grant verification/transaction, exact body from reread state, same request after IOException, and deletion only after parsed acknowledgment.

- [ ] **Step 2: Run focused Android tests and verify failure**

Run:

```bash
cd apps/handheld
./gradlew testDebugUnitTest --tests '*GrantMigrationTest' --tests '*GrantTransportTest'
```

Expected: FAIL because entity/API/reporting are absent.

- [ ] **Step 3: Add Room entity and numbered migration**

Increment `HandheldDatabase.version` by one, add `grant_readiness_outbox`, preserve all existing grant tables, and register the exact migration in the production builder and migration tests. Never use destructive fallback.

- [ ] **Step 4: Implement durable report creation and retry**

Within the grant install transaction, write the outbox intent using the installed mode, policy/keyset revision, and device grant ID. After commit, reread the row/state and POST it. `GrantRefresher` retries pending rows on normal authenticated refresh without blocking offline work.

- [ ] **Step 5: Run Android gates**

Run `./gradlew testDebugUnitTest lintDebug assembleDebug`. Record that emulator/vendor scanner/device storage was not exercised.

- [ ] **Step 6: Commit Handheld reporting**

```bash
git add apps/handheld/app/src/main/kotlin apps/handheld/app/src/test/kotlin
git commit -m "feat(handheld): report durable offline grant readiness"
```

---

### Task 7: Kiosk durable readiness reporting

**Files:**

- Modify: `apps/kiosk/src/api/client.ts`
- Modify: `apps/kiosk/src/grants/store.ts`
- Modify: `apps/kiosk/src/grants/transport.ts`
- Modify: `apps/kiosk/src/grants/sync.ts`
- Modify: `apps/kiosk/src/store/db.ts`
- Modify: `apps/kiosk/test/offline-grants-store.test.ts`
- Modify: `apps/kiosk/test/offline-grants-transport.test.ts`
- Modify: `apps/kiosk/test/offline-grants-recovery.test.ts`

**Interfaces:**

- Adds optional `grantReadiness(request)` to the kiosk client.
- Adds an IndexedDB readiness outbox bound to the current installation owner/generation.
- Flushes only after `installGrantConfiguration` and device grant installation complete and reopen through a new transaction.

- [ ] **Step 1: Add failing IndexedDB upgrade and retry tests**

Open a legacy DB, upgrade it, and assert existing queue/grant state survives. Test stale owner, blocked transaction, verification failure, lost response, new service-worker process reopening the outbox, and exact requestId replay.

- [ ] **Step 2: Run focused kiosk tests and verify failure**

Run: `corepack pnpm --filter @markiro/kiosk exec vitest run test/offline-grants-store.test.ts test/offline-grants-transport.test.ts test/offline-grants-recovery.test.ts`

Expected: FAIL because the readiness store and transport are absent.

- [ ] **Step 3: Add IndexedDB store and typed client call**

Bump the existing IndexedDB version once, create the outbox store in the upgrade transaction, and preserve prior stores. Parse request and response with Task 1 schemas. Use the kiosk build identifier as `clientBuild` and the DB version as `storageRevision`.

- [ ] **Step 4: Wire post-install creation and background retry**

Write the intent after durable grant state is visible in a fresh transaction. Flush it from the existing grant sync path. Network failure leaves the row pending and never rolls back installed authority or the productive kiosk queue.

- [ ] **Step 5: Run kiosk gates**

Run kiosk test/typecheck/lint/build and the PWA configuration test. Record that a real browser service-worker replacement was not exercised.

- [ ] **Step 6: Commit kiosk reporting**

```bash
git add apps/kiosk/src/api/client.ts apps/kiosk/src/grants apps/kiosk/src/store/db.ts apps/kiosk/test/offline-grants-store.test.ts apps/kiosk/test/offline-grants-transport.test.ts apps/kiosk/test/offline-grants-recovery.test.ts
git commit -m "feat(kiosk): report durable offline grant readiness"
```

---

### Task 8: SaaS Admin rollout-readiness experience

**Files:**

- Create: `apps/saas-admin/src/pages/catalog/OfflineGrantReadinessPanel.tsx`
- Create: `apps/saas-admin/src/pages/catalog/offline-grant-readiness-api.ts`
- Modify: `apps/saas-admin/src/pages/catalog/OfflineGrantPoliciesPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Create: `apps/saas-admin/test/offline-grant-readiness.test.tsx`
- Create: `apps/saas-admin/test/offline-grant-readiness-api.test.ts`

**Interfaces:**

- `listOfflineGrantReadiness(filters, cursor)` and `previewOfflineGrantReadiness(input)` parse shared contracts.
- `OfflineGrantReadinessPanel` owns filters, eligible selection, preview query, and dirty state.
- Existing policy creation/approval remains unchanged.

- [ ] **Step 1: Write failing client tests**

Assert URL encoding, cursor preservation, exact JSON body after `JSON.parse(recorded.body)`, response parsing, authorization envelope handling, and rejection of malformed reason/eligibility combinations.

- [ ] **Step 2: Write failing UI tests**

Cover loading/error/empty states, tenant/kind/status filters, reason translations, evidence as a separate diagnostic, disabled selection for blocked rows, 200-selection bound, capability-gated preview, dirty close guard, and explicit replacement of an older preview by a newer `asOf`/digest.

- [ ] **Step 3: Run focused SaaS tests and verify failure**

Run: `corepack pnpm --filter @markiro/saas-admin exec vitest run test/offline-grant-readiness-api.test.ts test/offline-grant-readiness.test.tsx`

Expected: FAIL because API and panel are absent.

- [ ] **Step 4: Implement API client and query keys**

Use stable query keys containing every filter. Keep selection outside cached server data. Preview mutation sends a new requestId only for a deliberate new preview; retry of an uncertain request preserves requestId and body.

- [ ] **Step 5: Implement the panel**

Use `@markiro/ui` table, filters, status chips, alerts, pager, and `CatalogDrawer`. Show `clientBuild`, storage revision, report age, policy/keyset match, grant verification, and observe evidence. Label the only action “Проверить пилотную группу” / “Preview pilot cohort”. Do not render strict activation controls.

- [ ] **Step 6: Integrate with policy panel and dirty guard**

Add a policies/readiness tab inside the existing offline-policy drawer. Reset dirty state only after confirmed close or successful preview state reset. Preserve the dedicated accessible close label.

- [ ] **Step 7: Run SaaS Admin gates**

Run focused tests, full package test, typecheck, lint, and build.

- [ ] **Step 8: Commit SaaS Admin**

```bash
git add apps/saas-admin/src/pages/catalog apps/saas-admin/src/i18n/en.json apps/saas-admin/src/i18n/ru.json apps/saas-admin/test/offline-grant-readiness.test.tsx apps/saas-admin/test/offline-grant-readiness-api.test.ts
git commit -m "feat(saas-admin): preview offline grant pilot readiness"
```

---

### Task 9: Operations documentation and final gates

**Files:**

- Modify: `docs/operations/offline-device-grants.md`
- Modify: `docs/architecture.md`
- Modify: `tools/ci/affected.mjs` only if the new tests are not already owned by API/native/SaaS jobs
- Modify: `.github/workflows/ci.yml` only if ownership inspection proves a missing required job
- Create: `deploy/production/test/offline-grant-readiness-contract.test.mjs`

**Interfaces:**

- Documents migration-before-reader order, observe rollout, report freshness, preview semantics, rollback, and evidence boundaries.
- Production contract pins both native routes, both platform routes, and the absence of activation endpoints in P1D.1.

- [ ] **Step 1: Add a failing production contract**

Assert the production bundle includes migration 0149, the four route registrations, signing configuration validation, and no `confirm`, `activate`, or cohort-policy mutation route under platform offline-grants readiness.

- [ ] **Step 2: Run the focused production test and verify failure**

Run: `node --test deploy/production/test/offline-grant-readiness-contract.test.mjs`

Expected: FAIL until the completed implementation is represented in the production bundle.

- [ ] **Step 3: Update operational documentation**

Document this order:

1. back up production database;
2. apply 0149 before readiness readers/routes;
3. deploy API in observe;
4. deploy Station, Handheld, and kiosk clients;
5. wait for current reports and review blocked reasons;
6. preview a pilot cohort;
7. stop before activation and hand the digest to P1D.2.

Document rollback as deployment of compatible observe code without deleting grant stores or readiness history.

- [ ] **Step 4: Update Graphify and inspect CI ownership**

Run `graphify update .`, inspect `tools/ci/affected.mjs` and `.github/workflows/ci.yml`, and modify them only if one changed surface would otherwise skip its required tests.

- [ ] **Step 5: Run final scoped gates**

Run package test/typecheck/lint/build for platform-contracts, DB, API, Station, kiosk, and SaaS Admin; run Android `testDebugUnitTest lintDebug assembleDebug`; run Station Cargo tests; run `git diff --check` and `corepack pnpm format:check`.

- [ ] **Step 6: Run cross-workspace and production gates**

With a disposable migrated PostgreSQL database and required safe test environment:

```bash
corepack pnpm turbo lint typecheck test build --concurrency=1 --force
corepack pnpm test:production-bundle:contract
```

Expected: all required jobs pass with no database skips. Do not run against the shared development database.

- [ ] **Step 7: Record external checks accurately**

In the PR description list Windows Station persistence, physical TSD/vendor scanner, kiosk service-worker replacement, clock rollback, factory network loss, deployment, and pilot acceptance as `NOT RUN` unless separate evidence exists.

- [ ] **Step 8: Commit docs and release contract**

```bash
git add docs/operations/offline-device-grants.md docs/architecture.md deploy/production/test/offline-grant-readiness-contract.test.mjs tools/ci/affected.mjs .github/workflows/ci.yml
git commit -m "docs: define offline grant readiness rollout"
```

Stage `tools/ci/affected.mjs` and `.github/workflows/ci.yml` only if they changed after the ownership audit.
