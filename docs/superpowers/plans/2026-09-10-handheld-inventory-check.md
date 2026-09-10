# Handheld Inventory Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The handheld joins a running `check` inventory as one more terminal, downloads the snapshot, verifies codes and boxes offline with the station's verdicts and active production date, syncs events with the station's inventory protocol, shows other terminals' progress and leaves the task.

**Architecture:** A second offline contour next to the shift slice: Room v3 tables scoped by snapshot, a Kotlin port of the domain's inventory classifier verified by exported fixtures, `InventoryBundleMirror` (digest-checked paging), `InventoryRecorder` (port of the station journal for `check`), `InventorySyncEngine` (batches with `payloadDigest`, outcomes, progress feed) sharing transport, backoff and nudges with the shift engine. Two small API changes for `handheld` devices only.

**Tech Stack:** Kotlin 2.2, Jetpack Compose / Material 3, Hilt, Room 2 (v3 schema), Retrofit + OkHttp, kotlinx.serialization, Robolectric + MockWebServer + Turbine; NestJS + Drizzle + vitest for the API; `packages/domain` TypeScript for fixtures.

Spec: `docs/superpowers/specs/2026-09-10-handheld-inventory-check-design.md`.

## Global Constraints

- Every user-facing string lives in `apps/handheld/app/src/main/res/values/strings.xml` (ru) **and** `values-en/strings.xml`; lint treats `MissingTranslation` / `ExtraTranslation` as errors. No Kotlin string literals shown to the operator.
- `check` mode only; `repack` tasks are listed but never joined.
- Wire formats are the domain's: `inventoryEventSchema`, `inventoryEventBatchSchema` (`payloadDigest` = SHA-256 of the canonical payload JSON, key order `snapshotId, snapshotRevision, sequenceCeiling, pendingEventCount, openBoxCount, events[eventId, deviceSequence, operatorId, scannedAt, kind, normalizedIdentity, codeHash, canonicalRaw, activeProductionDate, localVerdict]`, no whitespace, `JSON.stringify` escaping), page digests `{version:1, snapshotId, snapshotFixedAt, contentDigest, cursor, items, nextCursor}`, content digest `{version:1, items}`; canonical item keys `codeHash, canonicalRaw, gtin14, serial, sourceStatus, sourceState, sourceProductionDate, parentSscc, expected, protected`.
- Batch size 100, code page size 200, progress page size 200, heartbeat 15 s, backoff 2 s → 60 s.
- Capabilities header stays `handheld-v1,subscription-state-v1,station-recovery-v1`.
- Tests: `./gradlew testDebugUnitTest lintDebug assembleDebug` from `apps/handheld`; run outside the sandbox (`dangerouslyDisableSandbox`). Use `/usr/bin/git`, never bare `git` (rtk hook). Complex shell goes into script files under `/tmp/claude/`.
- The Write tool strips control characters: write `\u001d` escapes in source, never a literal GS.
- Room migrations are hand-written SQL that must match the entity schema exactly (Room validates on open).

## File Structure

**API (`apps/api`)**

- Modify `src/tenancy/tenant.guard.ts` — `req.deviceKind`.
- Modify `src/modules/inventories/station-inventory.dto.ts` — `stationInventoryTaskListQuerySchema`.
- Modify `src/modules/inventories/station-inventory-bundle.service.ts` — `listRunningManifests(tenantId, lineId | null)`.
- Modify `src/modules/inventories/station-inventory-access.service.ts` — `list(scope)`, handheld join rule.
- Modify `src/modules/inventories/station-inventories.controller.ts` — `scope` query.
- Create `test/handheld-inventory-access.e2e.test.ts`.

**Domain (`packages/domain`)**

- Create `src/inventory/inventory-fixtures.ts`, `scripts/export-inventory-fixtures.mjs`, `test/inventory-fixtures.test.ts`; modify `package.json`, `src/inventory/index.ts`, `src/index.ts`.
- Output `apps/handheld/app/src/test/resources/inventory-fixtures.json`.

**Handheld (`apps/handheld/app/src/main/kotlin/app/markiro/handheld`)**

- `core/storage/InventoryEntities.kt`, `InventoryDaos.kt`; modify `HandheldDatabase.kt`, `Migrations.kt`, `StorageModule.kt`, `DeviceWipe.kt`, `Entities.kt`, `MetaStore.kt`.
- `core/network/InventoryDtos.kt`; modify `Dtos.kt`, `StationApi.kt`.
- `core/inventory/ScanClassifier.kt`, `InventoryClassifier.kt`, `CanonicalJson.kt`, `InventoryBundleMirror.kt`, `InventoryRecorder.kt`, `InventoryBatchCodec.kt`, `InventorySyncEngine.kt`, `InventoryModule.kt`.
- Modify `core/sync/SyncTransport.kt` (`get`), `ConnectivityNudger.kt`, `SyncModule.kt`, `HandheldApp.kt`.
- `feature/inventory/InventoryRepository.kt`, `InventoryListViewModel.kt`, `InventoryListScreen.kt`, `InventoryWorkViewModel.kt`, `InventoryWorkScreen.kt`, `InventoryLeaveViewModel.kt`, `InventoryLeaveScreen.kt`, `InventoryLabels.kt`.
- Modify `feature/hub/HubViewModel.kt`, `HubScreen.kt`, `feature/settings/SettingsViewModel.kt`, `AppNavigation.kt`, `res/values/strings.xml`, `res/values-en/strings.xml`.
- Tests under `app/src/test/kotlin/app/markiro/handheld/` mirroring the packages.

---

### Task 1: API — `scope=all` task list and the handheld join rule

**Files:**

- Modify: `apps/api/src/tenancy/tenant.guard.ts`
- Modify: `apps/api/src/modules/inventories/station-inventory.dto.ts`
- Modify: `apps/api/src/modules/inventories/station-inventory-bundle.service.ts`
- Modify: `apps/api/src/modules/inventories/station-inventory-access.service.ts`
- Modify: `apps/api/src/modules/inventories/station-inventories.controller.ts`
- Test: `apps/api/test/handheld-inventory-access.e2e.test.ts`

**Interfaces:**

- Produces: `RequestWithTenant.deviceKind?: "station" | "handheld"`; `GET /station/inventory-tasks?scope=all`; `POST /station/inventories/:id/join` accepting `{ operatorId, confirmDifferentLine: true }` from a handheld for another line's task.

- [ ] **Step 1: Write the failing e2e test**

Copy `seedRunningInventory` and `attachExpiredSubscription` from `apps/api/test/station-inventory-access.e2e.test.ts` (lines 63–197) verbatim into the new file, then add:

```ts
// apps/api/test/handheld-inventory-access.e2e.test.ts (after the copied helpers)
async function device(agent: Agent, name: string, lineId: string, kind: "station" | "handheld") {
  const created = await createTestStationDevice(app!, agent, name, { kind });
  await db
    .update(schema.stationDevices)
    .set({ lineId })
    .where(eq(schema.stationDevices.id, created.deviceId));
  return created;
}

async function seedSecondRunningInventory(fixture: RunningInventoryFixture, lineId: string) {
  const [member] = await db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, fixture.tenantId));
  if (!member) throw new Error("Expected tenant member");
  const inventoryId = randomUUID();
  const inventoryNumber = `INV-${inventoryId.slice(0, 8)}`;
  await db.insert(schema.inventories).values({
    id: inventoryId,
    tenantId: fixture.tenantId,
    number: inventoryNumber,
    productId: fixture.productId,
    gtin14Snapshot: GTIN14,
    lineId,
    mode: "check",
    productionDateFrom: "2026-08-01",
    productionDateTo: "2026-08-31",
    createdByUserId: member.userId,
  });
  const [snapshot] = await db
    .insert(schema.inventorySnapshots)
    .values({
      tenantId: fixture.tenantId,
      inventoryId,
      revision: 1,
      combinedDigest: DIGEST,
      productName: "Inventory Water",
      lineName: "Other line",
      boxCapacity: 12,
      emittedCount: 0,
      introducedCount: 0,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 0,
      packageCount: 0,
      looseCount: 0,
      fixedByUserId: member.userId,
    })
    .returning({ id: schema.inventorySnapshots.id, fixedAt: schema.inventorySnapshots.fixedAt });
  if (!snapshot) throw new Error("Expected snapshot");
  await db
    .update(schema.inventories)
    .set({
      status: "running",
      activeSnapshotId: snapshot.id,
      stationManifest: {
        inventoryId,
        inventoryNumber,
        snapshotId: snapshot.id,
        snapshotRevision: 1,
        snapshotFixedAt: snapshot.fixedAt.toISOString(),
        combinedDigest: DIGEST,
        contentDigest: EMPTY_CONTENT_DIGEST,
        codeCount: 0,
        productId: fixture.productId,
        productName: "Inventory Water",
        productPrintName: null,
        egaisCode: null,
        shelfLifeDays: null,
        gtin14: GTIN14,
        boxCapacity: 12,
        mode: "check",
        lineId,
        lineName: "Other line",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
        boxLabelTemplate: null,
        limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
      },
      startedByUserId: member.userId,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(schema.inventories.tenantId, fixture.tenantId),
        eq(schema.inventories.id, inventoryId),
      ),
    );
  return { inventoryId, inventoryNumber };
}

it("lists every running inventory for a handheld with scope=all and only the line for a station", async () => {
  const agent = request.agent(app!.getHttpServer());
  const fixture = await seedRunningInventory(agent);
  const other = await seedSecondRunningInventory(fixture, fixture.otherLineId);
  const handheld = await device(agent, "Handheld A", fixture.lineId, "handheld");
  const station = await device(agent, "Station A", fixture.lineId, "station");

  const own = await request(app!.getHttpServer())
    .get("/station/inventory-tasks")
    .set("x-api-key", handheld.apiKey)
    .expect(200);
  expect(own.body.items.map((item: { inventoryId: string }) => item.inventoryId)).toEqual([
    fixture.inventoryId,
  ]);

  const all = await request(app!.getHttpServer())
    .get("/station/inventory-tasks")
    .query({ scope: "all" })
    .set("x-api-key", handheld.apiKey)
    .expect(200);
  expect(all.body.items.map((item: { inventoryId: string }) => item.inventoryId).sort()).toEqual(
    [fixture.inventoryId, other.inventoryId].sort(),
  );
  expect(
    all.body.items.find((item: { inventoryId: string }) => item.inventoryId === other.inventoryId),
  ).toMatchObject({
    lineId: fixture.otherLineId,
    lineName: "Other line",
    mode: "check",
  });

  const stationAll = await request(app!.getHttpServer())
    .get("/station/inventory-tasks")
    .query({ scope: "all" })
    .set("x-api-key", station.apiKey)
    .expect(200);
  expect(stationAll.body.items.map((item: { inventoryId: string }) => item.inventoryId)).toEqual([
    fixture.inventoryId,
  ]);

  await request(app!.getHttpServer())
    .get("/station/inventory-tasks")
    .query({ scope: "everything" })
    .set("x-api-key", handheld.apiKey)
    .expect(400);
});

it("lets a handheld join another line's task with confirmation only, while a station still needs the barcode", async () => {
  const agent = request.agent(app!.getHttpServer());
  const fixture = await seedRunningInventory(agent);
  const handheld = await device(agent, "Handheld B", fixture.otherLineId, "handheld");
  const station = await device(agent, "Station B", fixture.otherLineId, "station");

  const stationAttempt = await request(app!.getHttpServer())
    .post(`/station/inventories/${fixture.inventoryId}/join`)
    .set("x-api-key", station.apiKey)
    .send({ operatorId: fixture.operatorId, confirmDifferentLine: true })
    .expect(409);
  expect(stationAttempt.body).toMatchObject({ code: "INVENTORY_TASK_BARCODE_REQUIRED" });

  const unconfirmed = await request(app!.getHttpServer())
    .post(`/station/inventories/${fixture.inventoryId}/join`)
    .set("x-api-key", handheld.apiKey)
    .send({ operatorId: fixture.operatorId })
    .expect(409);
  expect(unconfirmed.body).toMatchObject({
    code: "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED",
  });

  const joined = await request(app!.getHttpServer())
    .post(`/station/inventories/${fixture.inventoryId}/join`)
    .set("x-api-key", handheld.apiKey)
    .send({ operatorId: fixture.operatorId, confirmDifferentLine: true })
    .expect(200);
  expect(joined.body).toMatchObject({
    inventoryId: fixture.inventoryId,
    mode: "check",
    sscc: null,
  });

  const [participant] = await db
    .select({ deviceId: schema.inventoryDeviceParticipants.deviceId })
    .from(schema.inventoryDeviceParticipants)
    .where(
      and(
        eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
        eq(schema.inventoryDeviceParticipants.deviceId, handheld.deviceId),
      ),
    );
  expect(participant?.deviceId).toBe(handheld.deviceId);
});
```

Check the participants table name first: `grep -n "inventoryDeviceParticipants\|inventory_device_participants" packages/db/src/schema/inventory.ts`; if the table is named differently (e.g. `inventoryTerminals`), use that name in the last assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash .superpowers/with-dev-env.sh pnpm --filter @markiro/api --config.verify-deps-before-run=false exec vitest run test/handheld-inventory-access.e2e.test.ts`
Expected: FAIL — `scope=all` returns only the line's task and the handheld join gets `INVENTORY_TASK_BARCODE_REQUIRED`.

- [ ] **Step 3: Expose the device kind on the request**

In `apps/api/src/tenancy/tenant.guard.ts`:

```ts
  /** Assigned production line for a station principal; null means no default line. */
  deviceLineId?: string | null;
  /** `station` or `handheld` (brief 10); only on the api-key path. */
  deviceKind?: "station" | "handheld";
```

and in the device lookup add `kind: schema.stationDevices.kind` to the `select`, then after `req.deviceLineId = device.lineId;`:

```ts
req.deviceKind = device.kind === "handheld" ? "handheld" : "station";
```

- [ ] **Step 4: Query schema, service and controller**

`station-inventory.dto.ts`, next to `stationInventoryProgressQuerySchema`:

```ts
export const stationInventoryTaskListQuerySchema = z.strictObject({
  scope: z.enum(["line", "all"]).default("line"),
});
export type StationInventoryTaskListQueryDto = z.infer<typeof stationInventoryTaskListQuerySchema>;
```

`station-inventory-bundle.service.ts` — let `listRunningManifests` take `lineId: string | null`; `null` means every line:

```ts
  async listRunningManifests(
    tenantId: string,
    lineId: string | null,
  ): Promise<StationInventoryManifest[]> {
    const access = await this.entitlements.resolveRecovery(tenantId, this.db, new Date());
    const rows = await this.selectStoredManifestFacts(this.db)
      .where(
        and(
          eq(schema.inventories.tenantId, tenantId),
          eq(schema.inventories.status, "running"),
          ...(lineId === null ? [] : [eq(schema.inventories.lineId, lineId)]),
        ),
      )
      .orderBy(asc(schema.inventories.number), asc(schema.inventories.id));
    return Promise.all(
      rows
        .filter((row) => this.isRecoveryEligible(access, row.startedAt))
        .map((row) => this.resolveStoredManifest(this.db, tenantId, row)),
    );
  }
```

`station-inventory-access.service.ts`:

```ts
  async list(
    tenantId: string,
    deviceLineId: string | null,
    deviceKind: "station" | "handheld",
    scope: "line" | "all",
  ): Promise<StationInventoryTaskListDto> {
    // Only a walking handheld sees other lines; a station keeps its line-only contract.
    const everyLine = scope === "all" && deviceKind === "handheld";
    if (!everyLine && deviceLineId === null) return { items: [] };
    const manifests = await this.bundles.listRunningManifests(tenantId, everyLine ? null : deviceLineId);
    return { items: manifests.map((manifest) => this.taskFromManifest(manifest)) };
  }
```

and give `join` a `deviceKind` parameter after `deviceLineId`; replace the barcode rule:

```ts
const differentLine = deviceLineId !== inventory.lineId;
const barcodeInventoryId =
  input.barcode === undefined ? null : parseInventoryTaskBarcode(input.barcode);
if (input.barcode !== undefined && barcodeInventoryId !== inventoryId) {
  throw new ConflictException({ code: "INVENTORY_TASK_BARCODE_INVALID" });
}
// A stationary terminal must prove it holds the task form; a handheld confirms on screen instead.
if (differentLine && input.barcode === undefined && deviceKind !== "handheld") {
  throw new ConflictException({ code: "INVENTORY_TASK_BARCODE_REQUIRED" });
}
if (differentLine && input.confirmDifferentLine !== true) {
  throw new ConflictException({ code: "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED" });
}
```

Controller:

```ts
  @Get("inventory-tasks")
  @ApiQuery({ name: "scope", required: false, schema: { type: "string", enum: ["line", "all"], default: "line" } })
  ...
  list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(stationInventoryTaskListQuerySchema)) query: StationInventoryTaskListQueryDto,
  ): Promise<StationInventoryTaskListDto> {
    return this.access.list(req.tenantId!, req.deviceLineId ?? null, req.deviceKind ?? "station", query.scope);
  }
```

and pass `req.deviceKind ?? "station"` into `this.access.join(...)` after `req.deviceLineId ?? null`. Update the description string: «Running inventories on the station's assigned production line; `scope=all` lists every line for a handheld.»

- [ ] **Step 5: Run the new test and the existing access test**

Run: `bash .superpowers/with-dev-env.sh pnpm --filter @markiro/api --config.verify-deps-before-run=false exec vitest run test/handheld-inventory-access.e2e.test.ts test/station-inventory-access.e2e.test.ts test/station-inventory-openapi.test.ts`
Expected: PASS. If `station-inventory-openapi.test.ts` snapshots the query parameters, update its expectation to include `scope`.

- [ ] **Step 6: Typecheck, lint, prettier and commit**

Run: `pnpm --filter @markiro/api --config.verify-deps-before-run=false typecheck && pnpm --filter @markiro/api --config.verify-deps-before-run=false lint && pnpm --config.verify-deps-before-run=false exec prettier --check apps/api/src/tenancy/tenant.guard.ts apps/api/src/modules/inventories apps/api/test/handheld-inventory-access.e2e.test.ts`

Commit (script file, `/usr/bin/git`): `feat(api): handheld inventory access — every line on request, join by confirmation`

---

### Task 2: Domain — inventory fixtures for the Kotlin port

**Files:**

- Create: `packages/domain/src/inventory/inventory-fixtures.ts`
- Create: `packages/domain/scripts/export-inventory-fixtures.mjs`
- Create: `packages/domain/test/inventory-fixtures.test.ts`
- Modify: `packages/domain/src/inventory/index.ts`, `packages/domain/src/index.ts`, `packages/domain/package.json`
- Output: `apps/handheld/app/src/test/resources/inventory-fixtures.json`

**Interfaces:**

- Produces: `buildInventoryFixtures(): InventoryFixtures` with `classify: InventoryClassifyFixture[]` and `batchDigest: InventoryBatchDigestFixture[]`; script `fixtures:inventory`.

- [ ] **Step 1: Write the drift test**

```ts
// packages/domain/test/inventory-fixtures.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInventoryFixtures } from "../src/inventory/inventory-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/inventory-fixtures.json", import.meta.url),
);

describe("inventory fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed).toBe(JSON.stringify(buildInventoryFixtures(), null, 2) + "\n");
  });

  it("cover every classification kind, both box outcomes and all three source-date kinds", () => {
    const fixtures = buildInventoryFixtures();
    const kinds = new Set(fixtures.classify.map((c) => c.expected.kind));
    for (const kind of [
      "expected",
      "protected",
      "known-ineligible",
      "unknown",
      "duplicate",
      "invalid",
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(
      fixtures.classify.some(
        (c) => c.expected.kind === "duplicate" && c.expected.scanKind === "known_box",
      ),
    ).toBe(true);
    expect(
      fixtures.classify.some(
        (c) => c.expected.kind === "unknown" && c.expected.scanKind === "old_box",
      ),
    ).toBe(true);
    const dateKinds = new Set(fixtures.classify.map((c) => c.sourceDate.kind));
    expect([...dateKinds].sort()).toEqual(["mixed", "none", "single"]);
    expect(fixtures.batchDigest.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/domain --config.verify-deps-before-run=false exec vitest run test/inventory-fixtures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the fixture module**

```ts
// packages/domain/src/inventory/inventory-fixtures.ts
import { canonicalizeKm, kmHash } from "../gs1/km.js";
import {
  classifyInventoryScan,
  resolveInventoryScanSourceDate,
  type InventoryLocalClaim,
  type InventoryScanClassification,
  type InventoryScanSnapshotRow,
  type InventoryScanSourceDate,
} from "./scan.js";
import { inventoryEventBatchDigest, type InventoryEventBatchPayload } from "./station-sync.js";

/**
 * Cases the handheld's Kotlin `InventoryClassifier` and `InventoryBatchCodec`
 * must reproduce. Exported to
 * `apps/handheld/app/src/test/resources/inventory-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:inventory`;
 * `test/inventory-fixtures.test.ts` fails when the committed JSON drifts.
 */
export interface InventoryClassifyFixture {
  name: string;
  taskGtin14: string;
  rows: InventoryScanSnapshotRow[];
  claims: InventoryLocalClaim[];
  raw: string;
  expected: InventoryScanClassification;
  sourceDate: InventoryScanSourceDate;
}

export interface InventoryBatchDigestFixture {
  name: string;
  payload: InventoryEventBatchPayload;
  digest: string;
}

export interface InventoryFixtures {
  classify: InventoryClassifyFixture[];
  batchDigest: InventoryBatchDigestFixture[];
}

const GTIN = "04600000000015";
const OTHER_GTIN = "04600682000013";
const SSCC = "346006820000000014";
const OTHER_SSCC = "346006820000000021";
const GS = "\u001d";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";

function raw(serial: string, gtin14 = GTIN): string {
  return `01${gtin14}21${serial}${GS}91KEY${GS}92SIGNATURE`;
}

function row(
  serial: string,
  values: Partial<InventoryScanSnapshotRow> = {},
): InventoryScanSnapshotRow {
  const km = canonicalizeKm(raw(serial));
  return {
    codeHash: kmHash(km),
    canonicalRaw: km.raw,
    gtin14: km.gtin14,
    serial: km.serial,
    sourceStatus: "INTRODUCED",
    sourceState: null,
    sourceProductionDate: "2026-08-20",
    expected: true,
    protected: false,
    parentSscc: null,
    ...values,
  };
}

function claim(
  codeHash: string,
  deviceId: string,
  scannedAt: string,
  eventId: string,
): InventoryLocalClaim {
  return { codeHash, eventId, deviceId, scannedAt };
}

interface Scenario {
  name: string;
  rows: InventoryScanSnapshotRow[];
  claims?: InventoryLocalClaim[];
  raw: string;
}

function scenarios(): Scenario[] {
  const expected = row("EXPECTED-1");
  const dated = row("DATED-1", { sourceProductionDate: "2026-08-05" });
  const emitted = row("EMITTED", { sourceStatus: "EMITTED", expected: false });
  const retired = row("RETIRED", { sourceStatus: "RETIRED", expected: false });
  const moving = row("MOVING", { sourceState: "MOVING_BY_UD", expected: true });
  const flagged = row("FLAGGED", { protected: true, expected: false });
  const boxA = row("BOX-A", { parentSscc: SSCC, sourceProductionDate: "2026-08-10" });
  const boxB = row("BOX-B", { parentSscc: SSCC, sourceProductionDate: "2026-08-10" });
  const boxC = row("BOX-C", { parentSscc: SSCC, sourceProductionDate: "2026-08-12" });
  const boxProtected = row("BOX-P", { parentSscc: SSCC, sourceState: "MOVING_BY_UD" });
  const boxIneligible = row("BOX-I", {
    parentSscc: SSCC,
    sourceStatus: "APPLIED",
    expected: false,
  });
  const onlyProtected = row("ONLY-P", { parentSscc: OTHER_SSCC, sourceState: "MOVING_BY_UD" });
  const onlyIneligible = row("ONLY-I", {
    parentSscc: OTHER_SSCC,
    sourceStatus: "RETIRED",
    expected: false,
  });
  const claimedA = claim(
    boxA.codeHash,
    DEVICE,
    "2026-08-25T10:00:00.000Z",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const claimedB = claim(
    boxB.codeHash,
    OTHER_DEVICE,
    "2026-08-25T09:59:00.000Z",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
  const claimedC = claim(
    boxC.codeHash,
    OTHER_DEVICE,
    "2026-08-25T09:59:00.000Z",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  );
  return [
    {
      name: "expected item with aim prefix and edges",
      rows: [expected],
      raw: ` \t]d2${raw("EXPECTED-1")}\t `,
    },
    { name: "expected item plain", rows: [expected], raw: raw("EXPECTED-1") },
    { name: "expected item with its own date", rows: [dated], raw: raw("DATED-1") },
    { name: "wrong gtin", rows: [], raw: raw("OTHER", OTHER_GTIN) },
    { name: "bare gtin is unsupported", rows: [], raw: GTIN },
    { name: "malformed", rows: [], raw: "not a code" },
    { name: "emitted is known ineligible", rows: [emitted], raw: emitted.canonicalRaw },
    { name: "retired is known ineligible", rows: [retired], raw: retired.canonicalRaw },
    { name: "moving by ud is protected", rows: [moving], raw: moving.canonicalRaw },
    { name: "protected flag wins", rows: [flagged], raw: flagged.canonicalRaw },
    { name: "unknown item", rows: [], raw: raw("NOWHERE") },
    {
      name: "duplicate item here",
      rows: [expected],
      claims: [
        claim(
          expected.codeHash,
          DEVICE,
          "2026-08-25T08:00:00.000Z",
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ),
      ],
      raw: raw("EXPECTED-1"),
    },
    { name: "box with aim prefix", rows: [boxA, boxB], raw: `]C100${SSCC}` },
    { name: "box with parentheses", rows: [boxA, boxB], raw: `(00)${SSCC}` },
    { name: "box bare twenty digits", rows: [boxA, boxB], raw: `00${SSCC}` },
    { name: "box bare eighteen digits mixed dates", rows: [boxA, boxC], raw: SSCC },
    {
      name: "box partially claimed keeps single date",
      rows: [boxA, boxB, boxC],
      claims: [claimedC],
      raw: SSCC,
    },
    {
      name: "box fully claimed is duplicate with the earliest winner",
      rows: [boxA, boxB],
      claims: [claimedA, claimedB],
      raw: SSCC,
    },
    {
      name: "box with only protected left",
      rows: [boxA, boxProtected],
      claims: [claimedA],
      raw: SSCC,
    },
    {
      name: "box with only ineligible left",
      rows: [boxA, boxIneligible],
      claims: [claimedA],
      raw: SSCC,
    },
    {
      name: "box of protected and ineligible",
      rows: [onlyProtected, onlyIneligible],
      raw: OTHER_SSCC,
    },
    { name: "box unknown", rows: [], raw: SSCC },
    { name: "box with a bad check digit is malformed", rows: [], raw: "346006820000000015" },
  ];
}

function classify(scenario: Scenario): InventoryScanClassification {
  const rowsByHash = new Map(scenario.rows.map((item) => [item.codeHash, item]));
  const claimsByHash = new Map((scenario.claims ?? []).map((item) => [item.codeHash, item]));
  return classifyInventoryScan(scenario.raw, {
    taskGtin14: GTIN,
    findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
    findSnapshotChildren: (parentSscc) =>
      scenario.rows.filter((item) => item.parentSscc === parentSscc),
    findLocalClaim: (codeHash) => claimsByHash.get(codeHash) ?? null,
  });
}

function batchPayloads(): { name: string; payload: InventoryEventBatchPayload }[] {
  const item = canonicalizeKm(raw("сериЯ-1"));
  const base = {
    snapshotId: "33333333-3333-4333-8333-333333333333",
    snapshotRevision: 1 as const,
    openBoxCount: 0,
  };
  const event = (deviceSequence: number, extra: Record<string, unknown>) => ({
    eventId: `4444444${deviceSequence}-4444-4444-8444-444444444444`,
    deviceSequence,
    operatorId: "55555555-5555-4555-8555-555555555555",
    scannedAt: "2026-08-25T10:00:00.000Z",
    activeProductionDate: "2026-08-20",
    ...extra,
  });
  return [
    {
      name: "single expected item with unicode serial and gs",
      payload: {
        ...base,
        sequenceCeiling: 1,
        pendingEventCount: 0,
        events: [
          event(1, {
            kind: "item",
            normalizedIdentity: `item:${kmHash(item)}`,
            codeHash: kmHash(item),
            canonicalRaw: item.raw,
            localVerdict: "expected",
          }),
        ],
      } as InventoryEventBatchPayload,
    },
    {
      name: "known box and old box",
      payload: {
        ...base,
        sequenceCeiling: 3,
        pendingEventCount: 7,
        events: [
          event(2, {
            kind: "known_box",
            normalizedIdentity: `known_box:${SSCC}`,
            codeHash: null,
            canonicalRaw: SSCC,
            localVerdict: "expected",
          }),
          event(3, {
            kind: "old_box",
            normalizedIdentity: `old_box:${OTHER_SSCC}`,
            codeHash: null,
            canonicalRaw: OTHER_SSCC,
            localVerdict: "unknown",
          }),
        ],
      } as InventoryEventBatchPayload,
    },
    {
      name: "duplicate and quotes in serial",
      payload: {
        ...base,
        sequenceCeiling: 4,
        pendingEventCount: 0,
        events: [
          (() => {
            const quoted = canonicalizeKm(raw('Q"\\/'));
            return event(4, {
              kind: "item",
              normalizedIdentity: `item:${kmHash(quoted)}`,
              codeHash: kmHash(quoted),
              canonicalRaw: quoted.raw,
              localVerdict: "duplicate",
            });
          })(),
        ],
      } as InventoryEventBatchPayload,
    },
  ];
}

export function buildInventoryFixtures(): InventoryFixtures {
  return {
    classify: scenarios().map((scenario) => {
      const expected = classify(scenario);
      const rowsByHash = new Map(scenario.rows.map((item) => [item.codeHash, item]));
      return {
        name: scenario.name,
        taskGtin14: GTIN,
        rows: scenario.rows,
        claims: scenario.claims ?? [],
        raw: scenario.raw,
        expected,
        sourceDate: resolveInventoryScanSourceDate(expected, {
          findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
          findSnapshotChildren: (parentSscc) =>
            scenario.rows.filter((item) => item.parentSscc === parentSscc),
        }),
      };
    }),
    batchDigest: batchPayloads().map(({ name, payload }) => ({
      name,
      payload,
      digest: inventoryEventBatchDigest(payload),
    })),
  };
}
```

Note `raw('Q"\\/')`: `` is a control character that `canonicalizeKm` rejects (`KM_BAD_CONTROL`), so replace it with `Q"\\/tab\t`? Tabs are also forbidden inside. Use `raw('Q"\\/é')` (a quote, a backslash, a slash and a non-ASCII letter) instead; the GS separators in `raw()` already exercise control-character escaping.

Export: in `src/inventory/index.ts` add `export { buildInventoryFixtures } from "./inventory-fixtures.js"; export type { InventoryClassifyFixture, InventoryBatchDigestFixture, InventoryFixtures } from "./inventory-fixtures.js";` and re-export from `src/index.ts` next to the KM fixture exports (`grep -n "buildKmFixtures" src/index.ts`).

- [ ] **Step 4: Script and package.json**

```js
// packages/domain/scripts/export-inventory-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventoryFixtures } from "../dist/inventory/inventory-fixtures.js";

const target = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/inventory-fixtures.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildInventoryFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
```

`package.json` scripts: `"fixtures:inventory": "pnpm run build && node scripts/export-inventory-fixtures.mjs"`.

- [ ] **Step 5: Generate and test**

Run: `pnpm --filter @markiro/domain --config.verify-deps-before-run=false fixtures:inventory && pnpm --filter @markiro/domain --config.verify-deps-before-run=false test`
Expected: JSON written; all domain tests pass (643 + 2).

Inspect the JSON: `expected.kind` values present; a `batchDigest` entry whose `canonicalRaw` shows `\u001d`.

- [ ] **Step 6: Lint, prettier, commit**

Run: `pnpm --filter @markiro/domain --config.verify-deps-before-run=false lint && pnpm --config.verify-deps-before-run=false exec prettier --check packages/domain/src/inventory/inventory-fixtures.ts packages/domain/scripts/export-inventory-fixtures.mjs packages/domain/test/inventory-fixtures.test.ts`

Commit: `feat(domain): export inventory classifier and batch digest fixtures for the handheld`

---

### Task 3: Room v3 — inventory tables

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/InventoryEntities.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/InventoryDaos.kt`
- Modify: `HandheldDatabase.kt`, `Migrations.kt`, `StorageModule.kt`, `DeviceWipe.kt`, `Entities.kt`, `MetaStore.kt` (same package)
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt`, `InventoryStorageTest.kt`

**Interfaces:**

- Produces: entities `InventoryTaskEntity`, `InventorySnapshotCodeEntity`, `InventoryTerminalStateEntity`, `InventoryEventEntity`, `InventoryResultEntity`, `InventoryOutboxEntity`; DAOs below; `DeviceConfigEntity.activeInventoryId`; `MetaStore.inventoryPin(inventoryId)`.

- [ ] **Step 1: Write the failing tests**

Extend `MigrationTest`: chain `MIGRATION_2_3` after `MIGRATION_1_2` and assert the new tables work:

```kotlin
        val db = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .allowMainThreadQueries()
            .build()
        try {
            val config = db.deviceConfigDao().get()
            assertEquals("dev-1", config?.deviceId)
            assertEquals(null, config?.activeShiftId)
            assertEquals(null, config?.activeInventoryId)
            db.outboxDao().insert(
                OutboxEntity(shiftId = "s", raw = "r", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null, gtin14 = null, serial = null),
            )
            assertEquals(1, db.outboxDao().head(1).size)
            db.inventoryOutboxDao().insert(
                InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e1", deviceSequence = 1, payloadJson = "{}", createdAt = "t"),
            )
            assertEquals(1, db.inventoryOutboxDao().head("i1", 10).size)
        } finally {
```

New `InventoryStorageTest`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    @Test
    fun snapshotCodesAreLookedUpByHashAndByParentSscc() = runTest {
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", "h1", parentSscc = "346006820000000014"),
                InventoryFixtures.code("snap", "h2", parentSscc = "346006820000000014", expected = false, protected = true),
                InventoryFixtures.code("snap", "h3"),
            ),
        )
        assertEquals("h3", db.inventorySnapshotCodeDao().get("snap", "h3")?.codeHash)
        assertEquals(listOf("h1", "h2"), db.inventorySnapshotCodeDao().children("snap", "346006820000000014").map { it.codeHash })
        assertEquals(3, db.inventorySnapshotCodeDao().count("snap"))
        assertEquals(2, db.inventorySnapshotCodeDao().countExpected("snap"))
        assertEquals(listOf("h1", "h2"), db.inventorySnapshotCodeDao().pageAfter("snap", "", 2).map { it.codeHash })
        assertEquals(listOf("h3"), db.inventorySnapshotCodeDao().pageAfter("snap", "h2", 2).map { it.codeHash })
    }

    @Test
    fun resultsInsertIgnoreReturnsMinusOneForAnExistingClaim() = runTest {
        val first = InventoryFixtures.result("i1", "snap", "h1", eventId = "e1", deviceId = "dev-1")
        assertEquals(true, db.inventoryResultDao().insertIgnore(first) >= 0)
        assertEquals(-1L, db.inventoryResultDao().insertIgnore(first.copy(firstAcceptedEventId = "e2")))
        assertEquals("e1", db.inventoryResultDao().get("i1", "h1")?.firstAcceptedEventId)
        assertEquals(1, db.inventoryResultDao().observeCount("i1", "expected").first())
        assertEquals(1, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
    }

    @Test
    fun outboxHeadFollowsDeviceSequenceAndCountsTheTail() = runTest {
        for (n in 1L..3L) {
            db.inventoryOutboxDao().insert(InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e$n", deviceSequence = n, payloadJson = "{}", createdAt = "t"))
        }
        val head = db.inventoryOutboxDao().head("i1", 2)
        assertEquals(listOf(1L, 2L), head.map { it.deviceSequence })
        assertEquals(1, db.inventoryOutboxDao().countAfter("i1", head.last().id))
        db.inventoryOutboxDao().deleteIds(head.map { it.id })
        assertEquals(1, db.inventoryOutboxDao().observeCount("i1").first())
        assertEquals(1, db.inventoryOutboxDao().observeTotal().first())
    }

    @Test
    fun terminalStateAndTaskLifecycle() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1", state = "staging"))
        db.inventoryTaskDao().setStaging("i1", cursor = "h9", staged = 200)
        assertEquals("h9", db.inventoryTaskDao().get("i1")?.stagingCursor)
        db.inventoryTaskDao().activate("i1", expectedCount = 150, joinedAt = 5L)
        assertEquals("active", db.inventoryTaskDao().observe("i1").first()?.state)
        assertNull(db.inventoryTerminalStateDao().get("i1"))
        db.inventoryTerminalStateDao().upsert(InventoryTerminalStateEntity("i1", "snap", "op-1", "2026-08-20", 1, null, 0, "t"))
        db.inventoryTerminalStateDao().setProgress("i1", "3:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 3)
        assertEquals(3L, db.inventoryTerminalStateDao().get("i1")?.progressResultRevision)
    }
}
```

and the shared test fixture object:

```kotlin
// apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/InventoryFixtures.kt
package app.markiro.handheld.core.storage

object InventoryFixtures {
    fun task(id: String, state: String = "active", snapshotId: String = "snap", mode: String = "check") = InventoryTaskEntity(
        inventoryId = id, inventoryNumber = "INV-0007", productId = "p1", productName = "Вода 0,5 л", productPrintName = "Вода",
        gtin14 = "04600000000015", mode = mode, lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01",
        productionDateTo = "2026-08-31", boxCapacity = 12, snapshotId = snapshotId, snapshotFixedAt = "2026-08-25T01:02:03.000Z",
        contentDigest = "b".repeat(64), combinedDigest = "a".repeat(64), codeCount = 0, expectedCount = 0, state = state,
        stagingCursor = null, stagedCount = 0, joinedAt = if (state == "active") 1L else null, leftAt = null,
    )

    fun code(
        snapshotId: String, hash: String, serial: String = hash, parentSscc: String? = null, expected: Boolean = true,
        protected: Boolean = false, status: String = "INTRODUCED", state: String? = null, date: String? = "2026-08-20",
    ) = InventorySnapshotCodeEntity(
        snapshotId = snapshotId, codeHash = hash, canonicalRaw = "010460000000001521$serial", gtin14 = "04600000000015",
        serial = serial, sourceStatus = status, sourceState = state, sourceProductionDate = date, parentSscc = parentSscc,
        expected = expected, protected = protected,
    )

    fun result(inventoryId: String, snapshotId: String, hash: String, eventId: String, deviceId: String, classification: String = "expected") =
        InventoryResultEntity(
            inventoryId = inventoryId, snapshotId = snapshotId, codeHash = hash, firstAcceptedEventId = eventId, winningDeviceId = deviceId,
            winningScannedAt = "2026-08-25T10:00:00.000Z", observedProductionDate = "2026-08-20", classification = classification,
            source = "local", updatedAt = "2026-08-25T10:00:00.000Z",
        )
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.storage.*" -q`
Expected: compilation error (entities missing).

- [ ] **Step 3: Entities**

```kotlin
// core/storage/InventoryEntities.kt
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Joined inventory tasks with their manifest; `state` is `staging` (snapshot downloading), `active` or `closed`. */
@Entity(tableName = "inventory_tasks")
data class InventoryTaskEntity(
    @PrimaryKey val inventoryId: String,
    val inventoryNumber: String,
    val productId: String,
    val productName: String,
    val productPrintName: String?,
    val gtin14: String,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
    val boxCapacity: Int,
    val snapshotId: String,
    val snapshotFixedAt: String,
    val contentDigest: String,
    val combinedDigest: String,
    val codeCount: Int,
    /** Rows with `expected && !protected`; the «Проверено» denominator. */
    val expectedCount: Int,
    val state: String,
    val stagingCursor: String?,
    val stagedCount: Int,
    val joinedAt: Long?,
    val leftAt: Long?,
)

/** Immutable snapshot rows; `parentSscc` is indexed so a box scan finds its contents. */
@Entity(
    tableName = "inventory_snapshot_codes",
    primaryKeys = ["snapshotId", "codeHash"],
    indices = [Index(value = ["snapshotId", "parentSscc"])],
)
data class InventorySnapshotCodeEntity(
    val snapshotId: String,
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String?,
    val sourceProductionDate: String?,
    val parentSscc: String?,
    val expected: Boolean,
    val protected: Boolean,
)

/** One row per task: the active production date, the next device sequence and the progress cursor. */
@Entity(tableName = "inventory_terminal_state")
data class InventoryTerminalStateEntity(
    @PrimaryKey val inventoryId: String,
    val snapshotId: String,
    val operatorId: String?,
    val activeProductionDate: String?,
    val nextDeviceSequence: Long,
    val progressCursor: String?,
    val progressResultRevision: Long,
    val updatedAt: String,
)

/** This device's inventory events; `serverStatus` is null until the batch is acknowledged. */
@Entity(
    tableName = "inventory_events",
    indices = [
        Index(value = ["inventoryId", "deviceSequence"], unique = true),
        Index(value = ["inventoryId", "normalizedIdentity"]),
    ],
)
data class InventoryEventEntity(
    @PrimaryKey val eventId: String,
    val inventoryId: String,
    val snapshotId: String,
    val deviceSequence: Long,
    val operatorId: String,
    val scannedAt: String,
    val kind: String,
    val normalizedIdentity: String,
    val codeHash: String?,
    val canonicalRaw: String?,
    val activeProductionDate: String,
    val localVerdict: String,
    val claimedCount: Int,
    val winnerEventId: String?,
    val winnerDeviceId: String?,
    val winnerScannedAt: String?,
    val serverStatus: String?,
)

/** Who counted a code first, locally or per the server (`source`); a row makes later scans duplicates. */
@Entity(
    tableName = "inventory_results",
    primaryKeys = ["inventoryId", "codeHash"],
    indices = [Index(value = ["inventoryId", "firstAcceptedEventId"])],
)
data class InventoryResultEntity(
    val inventoryId: String,
    val snapshotId: String,
    val codeHash: String,
    val firstAcceptedEventId: String,
    val winningDeviceId: String,
    val winningScannedAt: String,
    val observedProductionDate: String?,
    val classification: String,
    val source: String,
    val updatedAt: String,
)

/** Canonical event JSON waiting for `POST /station/inventories/:id/event-batches`. */
@Entity(tableName = "inventory_outbox", indices = [Index(value = ["eventId"], unique = true)])
data class InventoryOutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val inventoryId: String,
    val snapshotId: String,
    val eventId: String,
    val deviceSequence: Long,
    val payloadJson: String,
    val createdAt: String,
)
```

`Entities.kt`: add to `DeviceConfigEntity` after `activeShiftId`:

```kotlin
    /** Inventory task this handheld is working in or paused from. */
    val activeInventoryId: String? = null,
```

- [ ] **Step 4: DAOs**

```kotlin
// core/storage/InventoryDaos.kt
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface InventoryTaskDao {
    @Query("SELECT * FROM inventory_tasks ORDER BY inventoryNumber")
    fun observeAll(): Flow<List<InventoryTaskEntity>>

    @Query("SELECT * FROM inventory_tasks WHERE inventoryId = :id")
    suspend fun get(id: String): InventoryTaskEntity?

    @Query("SELECT * FROM inventory_tasks WHERE inventoryId = :id")
    fun observe(id: String): Flow<InventoryTaskEntity?>

    @Upsert
    suspend fun upsert(task: InventoryTaskEntity)

    @Query("UPDATE inventory_tasks SET stagingCursor = :cursor, stagedCount = :staged WHERE inventoryId = :id")
    suspend fun setStaging(id: String, cursor: String?, staged: Int)

    @Query("UPDATE inventory_tasks SET state = 'active', expectedCount = :expectedCount, stagingCursor = NULL, joinedAt = :joinedAt, leftAt = NULL WHERE inventoryId = :id")
    suspend fun activate(id: String, expectedCount: Int, joinedAt: Long)

    @Query("UPDATE inventory_tasks SET state = :state WHERE inventoryId = :id")
    suspend fun setState(id: String, state: String)

    @Query("UPDATE inventory_tasks SET joinedAt = :at, leftAt = NULL WHERE inventoryId = :id")
    suspend fun setJoinedAt(id: String, at: Long)

    @Query("UPDATE inventory_tasks SET leftAt = :at WHERE inventoryId = :id")
    suspend fun setLeftAt(id: String, at: Long?)

    @Query("DELETE FROM inventory_tasks WHERE inventoryId = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM inventory_tasks")
    suspend fun clear()
}

@Dao
interface InventorySnapshotCodeDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(rows: List<InventorySnapshotCodeEntity>)

    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND codeHash = :hash")
    suspend fun get(snapshotId: String, hash: String): InventorySnapshotCodeEntity?

    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND parentSscc = :sscc ORDER BY codeHash")
    suspend fun children(snapshotId: String, sscc: String): List<InventorySnapshotCodeEntity>

    @Query("SELECT COUNT(*) FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId")
    suspend fun count(snapshotId: String): Int

    @Query("SELECT COUNT(*) FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND expected = 1 AND protected = 0")
    suspend fun countExpected(snapshotId: String): Int

    /** Strict `codeHash` order after `after` (pass "" for the first page): the content digest is recomputed in this order. */
    @Query("SELECT * FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId AND codeHash > :after ORDER BY codeHash LIMIT :limit")
    suspend fun pageAfter(snapshotId: String, after: String, limit: Int): List<InventorySnapshotCodeEntity>

    @Query("DELETE FROM inventory_snapshot_codes WHERE snapshotId = :snapshotId")
    suspend fun deleteSnapshot(snapshotId: String)

    @Query("DELETE FROM inventory_snapshot_codes")
    suspend fun clear()
}

@Dao
interface InventoryTerminalStateDao {
    @Query("SELECT * FROM inventory_terminal_state WHERE inventoryId = :id")
    suspend fun get(id: String): InventoryTerminalStateEntity?

    @Query("SELECT * FROM inventory_terminal_state WHERE inventoryId = :id")
    fun observe(id: String): Flow<InventoryTerminalStateEntity?>

    @Upsert
    suspend fun upsert(state: InventoryTerminalStateEntity)

    @Query("UPDATE inventory_terminal_state SET activeProductionDate = :date, operatorId = :operatorId, updatedAt = :at WHERE inventoryId = :id")
    suspend fun setActiveDate(id: String, date: String, operatorId: String, at: String)

    @Query("UPDATE inventory_terminal_state SET progressCursor = :cursor, progressResultRevision = :revision WHERE inventoryId = :id")
    suspend fun setProgress(id: String, cursor: String?, revision: Long)

    @Query("DELETE FROM inventory_terminal_state WHERE inventoryId = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM inventory_terminal_state")
    suspend fun clear()
}

@Dao
interface InventoryEventDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(event: InventoryEventEntity)

    @Query("SELECT * FROM inventory_events WHERE eventId = :eventId")
    suspend fun get(eventId: String): InventoryEventEntity?

    @Query("SELECT EXISTS(SELECT 1 FROM inventory_events WHERE inventoryId = :id)")
    suspend fun hasAny(id: String): Boolean

    /** Earliest unknown observation of an identity (the winner a later scan duplicates). */
    @Query("SELECT * FROM inventory_events WHERE inventoryId = :id AND normalizedIdentity = :identity AND localVerdict = 'unknown' ORDER BY deviceSequence LIMIT 1")
    suspend fun firstUnknown(id: String, identity: String): InventoryEventEntity?

    @Query("SELECT * FROM inventory_events WHERE inventoryId = :id ORDER BY deviceSequence DESC LIMIT :limit")
    fun observeRecent(id: String, limit: Int): Flow<List<InventoryEventEntity>>

    @Query("UPDATE inventory_events SET serverStatus = :status WHERE eventId = :eventId")
    suspend fun setServerStatus(eventId: String, status: String)

    @Query("SELECT COUNT(*) FROM inventory_events WHERE inventoryId = :id AND serverStatus = :status")
    fun observeCountByServerStatus(id: String, status: String): Flow<Int>

    /** Unknown identities of this device not (yet) explained by a result row from the server. */
    @Query(
        "SELECT COUNT(DISTINCT normalizedIdentity) FROM inventory_events WHERE inventoryId = :id AND localVerdict = 'unknown' " +
            "AND (codeHash IS NULL OR codeHash NOT IN (SELECT codeHash FROM inventory_results WHERE inventoryId = :id))",
    )
    fun observeUnknownIdentities(id: String): Flow<Int>

    @Query("DELETE FROM inventory_events WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_events")
    suspend fun clear()
}

@Dao
interface InventoryResultDao {
    /** -1 when the code already has a winner. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(row: InventoryResultEntity): Long

    @Upsert
    suspend fun upsert(row: InventoryResultEntity)

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND codeHash = :hash")
    suspend fun get(id: String, hash: String): InventoryResultEntity?

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND codeHash IN (:hashes)")
    suspend fun forHashes(id: String, hashes: List<String>): List<InventoryResultEntity>

    @Query("SELECT * FROM inventory_results WHERE inventoryId = :id AND firstAcceptedEventId = :eventId")
    suspend fun forEvent(id: String, eventId: String): List<InventoryResultEntity>

    @Query("DELETE FROM inventory_results WHERE inventoryId = :id AND codeHash = :hash")
    suspend fun delete(id: String, hash: String)

    @Query("SELECT COUNT(*) FROM inventory_results WHERE inventoryId = :id AND classification = :classification")
    fun observeCount(id: String, classification: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_results WHERE inventoryId = :id AND winningDeviceId = :deviceId")
    fun observeCountForDevice(id: String, deviceId: String): Flow<Int>

    @Query("DELETE FROM inventory_results WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_results")
    suspend fun clear()
}

@Dao
interface InventoryOutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: InventoryOutboxEntity): Long

    @Query("SELECT * FROM inventory_outbox WHERE inventoryId = :id ORDER BY deviceSequence LIMIT :limit")
    suspend fun head(id: String, limit: Int): List<InventoryOutboxEntity>

    @Query("SELECT * FROM inventory_outbox WHERE inventoryId = :id AND id <= :ceiling ORDER BY deviceSequence LIMIT :limit")
    suspend fun headThrough(id: String, ceiling: Long, limit: Int): List<InventoryOutboxEntity>

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id AND id > :afterId")
    suspend fun countAfter(id: String, afterId: Long): Int

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id")
    fun observeCount(id: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_outbox")
    fun observeTotal(): Flow<Int>

    @Query("SELECT COUNT(*) FROM inventory_outbox WHERE inventoryId = :id")
    suspend fun count(id: String): Int

    @Query("DELETE FROM inventory_outbox WHERE id IN (:ids)")
    suspend fun deleteIds(ids: List<Long>)

    @Query("DELETE FROM inventory_outbox WHERE inventoryId = :id")
    suspend fun deleteForInventory(id: String)

    @Query("DELETE FROM inventory_outbox")
    suspend fun clear()
}
```

- [ ] **Step 5: Database, migration, module, wipe, meta**

`HandheldDatabase.kt`: add the six entities to `entities`, `version = 3`, and abstract DAO getters `inventoryTaskDao()`, `inventorySnapshotCodeDao()`, `inventoryTerminalStateDao()`, `inventoryEventDao()`, `inventoryResultDao()`, `inventoryOutboxDao()`.

`Migrations.kt` — append:

```kotlin
/** Version 2 (shift validation) → 3 (inventory check). Additive; shift tables are untouched. */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `device_config` ADD COLUMN `activeInventoryId` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_tasks` (`inventoryId` TEXT NOT NULL, `inventoryNumber` TEXT NOT NULL, " +
                "`productId` TEXT NOT NULL, `productName` TEXT NOT NULL, `productPrintName` TEXT, `gtin14` TEXT NOT NULL, " +
                "`mode` TEXT NOT NULL, `lineId` TEXT NOT NULL, `lineName` TEXT NOT NULL, `productionDateFrom` TEXT NOT NULL, " +
                "`productionDateTo` TEXT NOT NULL, `boxCapacity` INTEGER NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`snapshotFixedAt` TEXT NOT NULL, `contentDigest` TEXT NOT NULL, `combinedDigest` TEXT NOT NULL, " +
                "`codeCount` INTEGER NOT NULL, `expectedCount` INTEGER NOT NULL, `state` TEXT NOT NULL, `stagingCursor` TEXT, " +
                "`stagedCount` INTEGER NOT NULL, `joinedAt` INTEGER, `leftAt` INTEGER, PRIMARY KEY(`inventoryId`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_snapshot_codes` (`snapshotId` TEXT NOT NULL, `codeHash` TEXT NOT NULL, " +
                "`canonicalRaw` TEXT NOT NULL, `gtin14` TEXT NOT NULL, `serial` TEXT NOT NULL, `sourceStatus` TEXT NOT NULL, " +
                "`sourceState` TEXT, `sourceProductionDate` TEXT, `parentSscc` TEXT, `expected` INTEGER NOT NULL, " +
                "`protected` INTEGER NOT NULL, PRIMARY KEY(`snapshotId`, `codeHash`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_snapshot_codes_snapshotId_parentSscc` ON `inventory_snapshot_codes` (`snapshotId`, `parentSscc`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_terminal_state` (`inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`operatorId` TEXT, `activeProductionDate` TEXT, `nextDeviceSequence` INTEGER NOT NULL, `progressCursor` TEXT, " +
                "`progressResultRevision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`inventoryId`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_events` (`eventId` TEXT NOT NULL, `inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, " +
                "`deviceSequence` INTEGER NOT NULL, `operatorId` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `kind` TEXT NOT NULL, " +
                "`normalizedIdentity` TEXT NOT NULL, `codeHash` TEXT, `canonicalRaw` TEXT, `activeProductionDate` TEXT NOT NULL, " +
                "`localVerdict` TEXT NOT NULL, `claimedCount` INTEGER NOT NULL, `winnerEventId` TEXT, `winnerDeviceId` TEXT, " +
                "`winnerScannedAt` TEXT, `serverStatus` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_inventory_events_inventoryId_deviceSequence` ON `inventory_events` (`inventoryId`, `deviceSequence`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_events_inventoryId_normalizedIdentity` ON `inventory_events` (`inventoryId`, `normalizedIdentity`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_results` (`inventoryId` TEXT NOT NULL, `snapshotId` TEXT NOT NULL, `codeHash` TEXT NOT NULL, " +
                "`firstAcceptedEventId` TEXT NOT NULL, `winningDeviceId` TEXT NOT NULL, `winningScannedAt` TEXT NOT NULL, " +
                "`observedProductionDate` TEXT, `classification` TEXT NOT NULL, `source` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, " +
                "PRIMARY KEY(`inventoryId`, `codeHash`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_results_inventoryId_firstAcceptedEventId` ON `inventory_results` (`inventoryId`, `firstAcceptedEventId`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `inventory_outbox` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `inventoryId` TEXT NOT NULL, " +
                "`snapshotId` TEXT NOT NULL, `eventId` TEXT NOT NULL, `deviceSequence` INTEGER NOT NULL, `payloadJson` TEXT NOT NULL, " +
                "`createdAt` TEXT NOT NULL)",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_inventory_outbox_eventId` ON `inventory_outbox` (`eventId`)")
    }
}
```

`StorageModule.kt`: `.addMigrations(MIGRATION_1_2, MIGRATION_2_3)` and `@Provides` for the six DAOs (same style as the existing ones).

`DeviceWipe.kt`: before `db.metaDao().clear()` add `db.inventoryOutboxDao().clear(); db.inventoryEventDao().clear(); db.inventoryResultDao().clear(); db.inventoryTerminalStateDao().clear(); db.inventorySnapshotCodeDao().clear(); db.inventoryTaskDao().clear()`.

`MetaStore.kt` companion: `fun inventoryPin(inventoryId: String) = "inventory_pending_batch:$inventoryId"` and `const val INVENTORY_LAST_SUCCESS_AT = "inventory_sync_last_success_at"`.

- [ ] **Step 6: Run the storage tests**

Run: `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.storage.*" -q`
Expected: PASS. If Room reports a schema mismatch on migration, compare the message's expected table info with the SQL above and fix the SQL, never the entity.

- [ ] **Step 7: Commit**

`feat(handheld): Room v3 with inventory task, snapshot, terminal state, events, results and outbox`

---

### Task 4: Network — inventory DTOs and routes

**Files:**

- Create: `core/network/InventoryDtos.kt`
- Modify: `core/network/Dtos.kt` (`InventoryTaskDto`), `core/network/StationApi.kt`, `core/sync/SyncTransport.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/InventoryDtosTest.kt`; update `feature/hub/HubViewModelTest.kt`

**Interfaces:**

- Produces: `InventoryTaskDto` (full), `ResolveTaskRequest/Response`, `JoinInventoryRequest`, `InventoryManifestDto`, `InventoryBundleCodeDto`, `InventoryBundlePageDto`, `LeaveInventoryRequest/Response`, `ProgressPageDto`, `EventBatchResponseDto`; `StationApi.inventoryTasks(scope)`, `resolveInventoryBarcode`, `joinInventory`, `inventoryManifest`, `inventoryCodes`, `leaveInventory`; `SyncTransport.get(path)`.

- [ ] **Step 1: Write the failing test**

```kotlin
// core/network/InventoryDtosTest.kt
package app.markiro.handheld.core.network

import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class InventoryDtosTest {
    private val manifestJson = """{"inventoryId":"11111111-1111-4111-8111-111111111111","inventoryNumber":"INV-1",
        "snapshotId":"22222222-2222-4222-8222-222222222222","snapshotRevision":1,"snapshotFixedAt":"2026-08-25T01:02:03.000Z",
        "combinedDigest":"${"a".repeat(64)}","contentDigest":"${"b".repeat(64)}","codeCount":1,
        "productId":"33333333-3333-4333-8333-333333333333","productName":"Сидр","productPrintName":"Сидр сухой","egaisCode":null,
        "shelfLifeDays":184,"gtin14":"04600000000015","boxCapacity":12,"mode":"check","lineId":"44444444-4444-4444-8444-444444444444",
        "lineName":"Линия 1","productionDateFrom":"2026-08-01","productionDateTo":"2026-08-31","boxLabelTemplate":null,
        "limits":{"codePageSize":200,"eventBatchSize":100,"progressPageSize":200},"sscc":null,"ssccRevokedFrom":[],"ssccRevokedBlocks":[]}"""

    @Test
    fun manifestAndPageDecodeWithUnknownRepackFieldsIgnored() = runTest {
        val server = MockWebServer().also { it.start() }
        val api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build().create(StationApi::class.java)
        server.enqueue(MockResponse().setBody(manifestJson))
        val manifest = api.inventoryManifest("11111111-1111-4111-8111-111111111111")
        assertEquals("check", manifest.mode)
        assertEquals(200, manifest.limits.codePageSize)
        assertNull(manifest.productionDateFrom.takeIf { it != "2026-08-01" })
        server.enqueue(
            MockResponse().setBody(
                """{"snapshotId":"22222222-2222-4222-8222-222222222222","snapshotRevision":1,"snapshotFixedAt":"2026-08-25T01:02:03.000Z",
                "combinedDigest":"${"a".repeat(64)}","contentDigest":"${"b".repeat(64)}","cursor":null,"items":[{"codeHash":"${"c".repeat(64)}",
                "canonicalRaw":"010460000000001521S","gtin14":"04600000000015","serial":"S","sourceStatus":"INTRODUCED","sourceState":null,
                "sourceProductionDate":"2026-08-01","parentSscc":null,"expected":true,"protected":false}],"nextCursor":null,"pageDigest":"${"d".repeat(64)}"}""",
            ),
        )
        val page = api.inventoryCodes("11111111-1111-4111-8111-111111111111", null, 200)
        assertEquals(1, page.items.size)
        assertNull(page.nextCursor)
        assertEquals("/station/inventories/11111111-1111-4111-8111-111111111111/bundle/codes?limit=200", server.takeRequest().let { server.takeRequest(); it.path }.let { "/station/inventories/11111111-1111-4111-8111-111111111111/bundle/codes?limit=200" })
        server.shutdown()
    }

    @Test
    fun joinRequestOmitsAbsentOptionalFields() {
        val json = NetworkModule.json()
        assertEquals("""{"operatorId":"op"}""", json.encodeToString(JoinInventoryRequest.serializer(), JoinInventoryRequest("op")))
        assertEquals(
            """{"operatorId":"op","confirmDifferentLine":true}""",
            json.encodeToString(JoinInventoryRequest.serializer(), JoinInventoryRequest("op", confirmDifferentLine = true)),
        )
    }

    @Test
    fun taskListRequiresTheLineFields() {
        val json = NetworkModule.json()
        val ok = json.decodeFromString(
            InventoryTaskListResponse.serializer(),
            """{"items":[{"inventoryId":"i","inventoryNumber":"INV-1","productName":"P","productPrintName":null,"mode":"check",
               "lineId":"l","lineName":"L","productionDateFrom":"2026-08-01","productionDateTo":"2026-08-31"}]}""",
        )
        assertEquals("L", ok.items.single().lineName)
        val failed = runCatching { json.decodeFromString(InventoryTaskListResponse.serializer(), """{"items":[{"inventoryId":"i","inventoryNumber":"INV-1","productName":"P"}]}""") }
        assertEquals(true, failed.isFailure)
    }
}
```

Simplify the request-path assertion to `assertEquals("/station/inventories/11111111-1111-4111-8111-111111111111/bundle/manifest", server.takeRequest().path)` followed by `assertEquals("/station/inventories/11111111-1111-4111-8111-111111111111/bundle/codes?limit=200", server.takeRequest().path)` (the convoluted line above is a placeholder to replace).

- [ ] **Step 2: Run to verify it fails**

Run: `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.network.InventoryDtosTest" -q` → compilation error.

- [ ] **Step 3: DTOs**

Replace `InventoryTaskDto` in `Dtos.kt`:

```kotlin
/** `GET /station/inventory-tasks` item; every field is sent by the server. */
@Serializable
data class InventoryTaskDto(
    val inventoryId: String,
    val inventoryNumber: String,
    val productName: String,
    val productPrintName: String? = null,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
)
```

New `core/network/InventoryDtos.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ResolveTaskRequest(val barcode: String)

@Serializable
data class ResolveTaskResponse(val task: InventoryTaskDto, val deviceLineId: String? = null, val requiresDifferentLineConfirmation: Boolean)

/** Optional fields are omitted, not null: the server's strict schema rejects `null` for them. */
@Serializable
data class JoinInventoryRequest(val operatorId: String, val barcode: String? = null, val confirmDifferentLine: Boolean? = null)

@Serializable
data class BundleLimitsDto(val codePageSize: Int, val eventBatchSize: Int, val progressPageSize: Int)

/** Manifest for `check`; repack-only fields are kept opaque and ignored. */
@Serializable
data class InventoryManifestDto(
    val inventoryId: String,
    val inventoryNumber: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val snapshotFixedAt: String,
    val combinedDigest: String,
    val contentDigest: String,
    val codeCount: Int,
    val productId: String,
    val productName: String,
    val productPrintName: String? = null,
    val egaisCode: String? = null,
    val shelfLifeDays: Int? = null,
    val gtin14: String,
    val boxCapacity: Int,
    val mode: String,
    val lineId: String,
    val lineName: String,
    val productionDateFrom: String,
    val productionDateTo: String,
    val boxLabelTemplate: JsonElement? = null,
    val limits: BundleLimitsDto,
    val sscc: JsonElement? = null,
    val ssccRevokedFrom: JsonElement? = null,
    val ssccRevokedBlocks: JsonElement? = null,
)

@Serializable
data class InventoryBundleCodeDto(
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String? = null,
    val sourceProductionDate: String? = null,
    val parentSscc: String? = null,
    val expected: Boolean,
    val protected: Boolean,
)

@Serializable
data class InventoryBundlePageDto(
    val snapshotId: String,
    val snapshotRevision: Int,
    val snapshotFixedAt: String,
    val combinedDigest: String,
    val contentDigest: String,
    val cursor: String? = null,
    val items: List<InventoryBundleCodeDto>,
    val nextCursor: String? = null,
    val pageDigest: String,
)

@Serializable
data class LeaveInventoryRequest(val pendingEventCount: Int, val openBoxCount: Int)

@Serializable
data class LeaveInventoryResponse(val outcome: String)

@Serializable
data class ClaimWinnerDto(val codeHash: String, val eventId: String, val deviceId: String, val scannedAt: String)

@Serializable
data class ClaimOutcomeDto(val codeHash: String, val status: String, val winner: ClaimWinnerDto)

@Serializable
data class EventOutcomeDto(
    val eventId: String,
    val status: String,
    val reasonCode: String,
    val claimedCount: Int,
    val conflictCount: Int,
    val claims: List<ClaimOutcomeDto> = emptyList(),
)

@Serializable
data class EventBatchResponseDto(
    val inventoryId: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val batchId: String,
    val payloadDigest: String,
    val sequenceCeiling: Long,
    val resultRevision: Long,
    val outcomes: List<EventOutcomeDto>,
)

/** Progress items are a discriminated union on `kind`; repack-only kinds carry fields the check port ignores. */
@Serializable
data class ProgressItemDto(
    val id: String,
    val revision: Long,
    val correctedAt: String,
    val kind: String,
    val codeHash: String? = null,
    val classification: String? = null,
    val observedProductionDate: String? = null,
    val winner: ClaimWinnerDto? = null,
    val boxId: String? = null,
    val resultId: String? = null,
    val ownerDeviceId: String? = null,
    val removedAt: String? = null,
)

@Serializable
data class ProgressPageDto(
    val inventoryId: String,
    val snapshotId: String,
    val snapshotRevision: Int,
    val cursor: String? = null,
    val resultRevision: Long,
    val items: List<ProgressItemDto>,
    val nextCursor: String? = null,
)
```

`StationApi.kt`:

```kotlin
    /** `scope=all` (handheld only) lists every running inventory, not just the device line. */
    @GET("station/inventory-tasks")
    suspend fun inventoryTasks(@Query("scope") scope: String? = null): InventoryTaskListResponse

    @POST("station/inventory-tasks/resolve-barcode")
    suspend fun resolveInventoryBarcode(@Body body: ResolveTaskRequest): ResolveTaskResponse

    @POST("station/inventories/{id}/join")
    suspend fun joinInventory(@Path("id") id: String, @Body body: JoinInventoryRequest): InventoryManifestDto

    @GET("station/inventories/{id}/bundle/manifest")
    suspend fun inventoryManifest(@Path("id") id: String): InventoryManifestDto

    @GET("station/inventories/{id}/bundle/codes")
    suspend fun inventoryCodes(@Path("id") id: String, @Query("cursor") cursor: String?, @Query("limit") limit: Int): InventoryBundlePageDto

    @POST("station/inventories/{id}/leave")
    suspend fun leaveInventory(@Path("id") id: String, @Body body: LeaveInventoryRequest): LeaveInventoryResponse
```

(add `import retrofit2.http.Body`).

`SyncTransport.kt` — add next to `post`:

```kotlin
    suspend fun get(path: String): TransportResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url(baseUrl().trimEnd('/') + path).get().build()
            client.newCall(request).execute().use { response -> TransportResult.Ok(response.code, response.body?.string().orEmpty()) }
        } catch (e: IOException) {
            TransportResult.Failure(e)
        }
    }
```

`HubViewModelTest.kt`: the fake `inventoryTasks()` override becomes `override suspend fun inventoryTasks(scope: String?)` returning `InventoryTaskDto("i1", "7", "Вода 0,5 л", null, "check", "line-2", "Линия 2", "2026-08-01", "2026-08-31")`; add stub overrides for the five new `StationApi` methods (`throw UnsupportedOperationException()`). Do the same in any other `object : StationApi` fake (`grep -rln "object : StationApi" app/src/test`).

- [ ] **Step 4: Run the network and hub tests**

Run: `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.network.*" --tests "app.markiro.handheld.feature.hub.*" -q` → PASS.

- [ ] **Step 5: Commit**

`feat(handheld): inventory task, bundle, progress and batch DTOs with the station routes`

---

### Task 5: Inventory classifier (Kotlin port) against the fixtures

**Files:**

- Create: `core/inventory/ScanClassifier.kt`, `core/inventory/InventoryClassifier.kt`
- Test: `core/inventory/InventoryClassifierFixturesTest.kt`

**Interfaces:**

- Produces: `ScanClassifier.classify(raw): ScanInput`, `ScanClassifier.parseSscc(raw): String?`; `InventoryClassifier.classify(raw, ctx): InventoryClassification`, `InventoryClassifier.sourceDate(classification, ctx): SourceDate`; types `SnapshotRow`, `LocalClaim`, `Origin`, `BoxChild`, `Identity`, `InventoryClassification`, `ClassifierContext`, `SourceDate`.

- [ ] **Step 1: Write the fixture test**

```kotlin
package app.markiro.handheld.core.inventory

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InventoryClassifierFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("inventory-fixtures.json")) { "run pnpm --filter @markiro/domain fixtures:inventory" }
            .readText(),
    ).jsonObject

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.strOrNull(key: String) = get(key)?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private fun row(o: JsonObject) = SnapshotRow(
        codeHash = o.str("codeHash"), canonicalRaw = o.str("canonicalRaw"), gtin14 = o.str("gtin14"), serial = o.str("serial"),
        sourceStatus = o.str("sourceStatus"), sourceState = o.strOrNull("sourceState"), sourceProductionDate = o.strOrNull("sourceProductionDate"),
        expected = o.getValue("expected").jsonPrimitive.booleanOrNull == true, protected = o.getValue("protected").jsonPrimitive.booleanOrNull == true,
        parentSscc = o.strOrNull("parentSscc"),
    )

    private fun claim(o: JsonObject) = LocalClaim(o.str("codeHash"), o.str("eventId"), o.str("deviceId"), o.str("scannedAt"))

    private fun context(case: JsonObject): ClassifierContext {
        val rows = case.getValue("rows").jsonArray.map { row(it.jsonObject) }
        val claims = case.getValue("claims").jsonArray.map { claim(it.jsonObject) }.associateBy { it.codeHash }
        return object : ClassifierContext {
            override val taskGtin14 = case.str("taskGtin14")
            override fun snapshotCode(codeHash: String) = rows.firstOrNull { it.codeHash == codeHash }
            override fun snapshotChildren(sscc: String) = rows.filter { it.parentSscc == sscc }
            override fun localClaim(codeHash: String) = claims[codeHash]
        }
    }

    @Test
    fun classificationsMatchTheDomainPackage() {
        val cases = fixtures.getValue("classify").jsonArray
        assertTrue(cases.size >= 20)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val expected = case.getValue("expected").jsonObject
            val actual = InventoryClassifier.classify(case.str("raw"), context(case))
            assertEquals(name, expected.str("kind"), actual.kind)
            when (actual) {
                is InventoryClassification.Invalid -> assertEquals(name, expected.str("reason"), actual.reason)
                else -> {
                    val identity = actual.identity
                    assertEquals(name, expected.str("scanKind"), identity.scanKind)
                    when (identity) {
                        is Identity.Item -> {
                            assertEquals(name, expected.str("codeHash"), identity.codeHash)
                            assertEquals(name, expected.str("canonicalRaw"), identity.canonicalRaw)
                            assertEquals(name, expected.str("serial"), identity.serial)
                        }
                        is Identity.KnownBox -> {
                            assertEquals(name, expected.str("sscc"), identity.sscc)
                            val children = expected.getValue("children").jsonArray.map { it.jsonObject }
                            assertEquals(name, children.map { it.str("codeHash") }, identity.children.map { it.codeHash })
                            assertEquals(name, children.map { it.str("originClassification") }, identity.children.map { it.origin.wire })
                            assertEquals(name, children.map { it.get("firstWinning")?.takeIf { w -> w !is JsonNull }?.jsonObject?.str("eventId") }, identity.children.map { it.firstWinning?.eventId })
                        }
                        is Identity.OldBox -> assertEquals(name, expected.str("sscc"), identity.sscc)
                    }
                    if (actual is InventoryClassification.Duplicate) {
                        assertEquals(name, expected.getValue("firstWinning").jsonObject.str("eventId"), actual.firstWinning.eventId)
                    }
                    expected.strOrNull("sourceStatus")?.let { assertEquals(name, it, actual.sourceStatus) }
                }
            }
            val date = case.getValue("sourceDate").jsonObject
            val source = InventoryClassifier.sourceDate(actual, context(case))
            assertEquals(name, date.str("kind"), source.kind)
            if (source is SourceDate.Single) assertEquals(name, date.str("productionDate"), source.productionDate)
        }
    }

    @Test
    fun ssccWrappersAreStripped() {
        assertEquals("346006820000000014", ScanClassifier.parseSscc("]C100346006820000000014"))
        assertEquals("346006820000000014", ScanClassifier.parseSscc("(00)346006820000000014"))
        assertEquals("346006820000000014", ScanClassifier.parseSscc("00346006820000000014"))
        assertEquals(null, ScanClassifier.parseSscc("346006820000000015"))
        assertEquals(null, ScanClassifier.parseSscc("0".repeat(26)))
    }
}
```

- [ ] **Step 2: Run to verify it fails** — compilation error.

- [ ] **Step 3: Implement**

```kotlin
// core/inventory/ScanClassifier.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.ParsedKm

sealed interface ScanInput {
    data class Km(val km: ParsedKm) : ScanInput
    data class Gtin(val gtin14: String) : ScanInput
    data class Sscc(val sscc: String) : ScanInput
    data class Unknown(val raw: String) : ScanInput
}

/** Port of packages/domain/src/scan/classify.ts and gs1/sscc.ts `parseScannedSscc`. */
object ScanClassifier {
    private val GTIN_LENGTHS = setOf(8, 12, 13, 14)

    fun parseSscc(raw: String): String? {
        if (raw.length > 25) return null
        var rest = raw
        if (rest.startsWith("]C1")) rest = rest.substring(3)
        if (rest.startsWith("(00)")) rest = rest.substring(4) else if (rest.length == 20 && rest.startsWith("00")) rest = rest.substring(2)
        return rest.takeIf { it.length == 18 && it.all { c -> c in '0'..'9' } && KmCodec.hasValidCheckDigit(it) }
    }

    fun isValidGtin(value: String): Boolean = value.length in GTIN_LENGTHS && runCatching { KmCodec.normalizeGtin14(value) }.isSuccess

    fun classify(raw: String): ScanInput {
        val trimmed = raw.trim()
        parseSscc(trimmed)?.let { return ScanInput.Sscc(it) }
        if (isValidGtin(trimmed)) return ScanInput.Gtin(KmCodec.normalizeGtin14(trimmed))
        return runCatching { ScanInput.Km(KmCodec.canonicalize(raw)) }.getOrElse { ScanInput.Unknown(raw) }
    }
}
```

```kotlin
// core/inventory/InventoryClassifier.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec

data class SnapshotRow(
    val codeHash: String,
    val canonicalRaw: String,
    val gtin14: String,
    val serial: String,
    val sourceStatus: String,
    val sourceState: String?,
    val sourceProductionDate: String?,
    val expected: Boolean,
    val protected: Boolean,
    val parentSscc: String?,
)

data class LocalClaim(val codeHash: String, val eventId: String, val deviceId: String, val scannedAt: String)

enum class Origin(val wire: String) { EXPECTED("expected"), PROTECTED("protected"), KNOWN_INELIGIBLE("known-ineligible") }

data class BoxChild(val codeHash: String, val origin: Origin, val firstWinning: LocalClaim?)

sealed interface Identity {
    val scanKind: String

    data class Item(val codeHash: String, val canonicalRaw: String, val gtin14: String, val serial: String) : Identity {
        override val scanKind get() = "item"
    }

    data class KnownBox(val sscc: String, val children: List<BoxChild>) : Identity {
        override val scanKind get() = "known_box"
    }

    data class OldBox(val sscc: String) : Identity {
        override val scanKind get() = "old_box"
    }
}

/** Port of `InventoryScanClassification`; `sourceStatus` is set for protected / ineligible items. */
sealed interface InventoryClassification {
    val kind: String
    val identity: Identity
    val sourceStatus: String? get() = null

    data class Expected(override val identity: Identity) : InventoryClassification {
        override val kind get() = "expected"
    }

    data class Protected(override val identity: Identity, override val sourceStatus: String?) : InventoryClassification {
        override val kind get() = "protected"
    }

    data class KnownIneligible(override val identity: Identity, override val sourceStatus: String?) : InventoryClassification {
        override val kind get() = "known-ineligible"
    }

    data class Unknown(override val identity: Identity) : InventoryClassification {
        override val kind get() = "unknown"
    }

    data class Duplicate(override val identity: Identity, val firstWinning: LocalClaim) : InventoryClassification {
        override val kind get() = "duplicate"
    }

    /** `malformed`, `wrong_gtin` or `unsupported` (a bare GTIN). Carries no identity. */
    data class Invalid(val reason: String) : InventoryClassification {
        override val kind get() = "invalid"
        override val identity: Identity get() = throw IllegalStateException("invalid scan has no identity")
    }
}

interface ClassifierContext {
    val taskGtin14: String
    fun snapshotCode(codeHash: String): SnapshotRow?
    fun snapshotChildren(sscc: String): List<SnapshotRow>
    fun localClaim(codeHash: String): LocalClaim?
}

sealed interface SourceDate {
    val kind: String

    data object None : SourceDate {
        override val kind get() = "none"
    }

    data class Single(val scanKind: String, val productionDate: String) : SourceDate {
        override val kind get() = "single"
    }

    data object Mixed : SourceDate {
        override val kind get() = "mixed"
    }
}

/** Port of packages/domain/src/inventory/scan.ts; verified by InventoryClassifierFixturesTest. */
object InventoryClassifier {
    fun origin(row: SnapshotRow): Origin = when {
        row.sourceState == "MOVING_BY_UD" || row.protected -> Origin.PROTECTED
        row.expected -> Origin.EXPECTED
        else -> Origin.KNOWN_INELIGIBLE
    }

    private fun firstClaim(claims: List<LocalClaim>): LocalClaim =
        claims.sortedWith(compareBy({ it.scannedAt }, { it.deviceId }, { it.eventId })).first()

    fun classify(raw: String, ctx: ClassifierContext): InventoryClassification = when (val input = ScanClassifier.classify(raw)) {
        is ScanInput.Km -> classifyItem(input, ctx)
        is ScanInput.Sscc -> classifyBox(input.sscc, ctx)
        is ScanInput.Gtin -> InventoryClassification.Invalid("unsupported")
        is ScanInput.Unknown -> InventoryClassification.Invalid("malformed")
    }

    private fun classifyItem(input: ScanInput.Km, ctx: ClassifierContext): InventoryClassification {
        val km = input.km
        if (km.gtin14 != ctx.taskGtin14) return InventoryClassification.Invalid("wrong_gtin")
        val codeHash = KmCodec.hash(km)
        val identity = Identity.Item(codeHash, km.canonicalRaw, km.gtin14, km.serial)
        ctx.localClaim(codeHash)?.let { return InventoryClassification.Duplicate(identity, it) }
        val snapshot = ctx.snapshotCode(codeHash) ?: return InventoryClassification.Unknown(identity)
        return when (origin(snapshot)) {
            Origin.PROTECTED -> InventoryClassification.Protected(identity, snapshot.sourceStatus)
            Origin.KNOWN_INELIGIBLE -> InventoryClassification.KnownIneligible(identity, snapshot.sourceStatus)
            Origin.EXPECTED -> InventoryClassification.Expected(identity)
        }
    }

    private fun classifyBox(sscc: String, ctx: ClassifierContext): InventoryClassification {
        val rows = ctx.snapshotChildren(sscc)
        if (rows.isEmpty()) return InventoryClassification.Unknown(Identity.OldBox(sscc))
        val children = rows.map { BoxChild(it.codeHash, origin(it), ctx.localClaim(it.codeHash)) }
        val identity = Identity.KnownBox(sscc, children)
        val unclaimed = children.filter { it.firstWinning == null }
        if (unclaimed.isEmpty()) return InventoryClassification.Duplicate(identity, firstClaim(children.mapNotNull { it.firstWinning }))
        return when {
            unclaimed.any { it.origin == Origin.EXPECTED } -> InventoryClassification.Expected(identity)
            unclaimed.any { it.origin == Origin.PROTECTED } -> InventoryClassification.Protected(identity, null)
            else -> InventoryClassification.KnownIneligible(identity, null)
        }
    }

    /** Only an `expected` scan has a date of its own; a box takes the single date of its unclaimed expected children. */
    fun sourceDate(classification: InventoryClassification, ctx: ClassifierContext): SourceDate {
        if (classification !is InventoryClassification.Expected) return SourceDate.None
        return when (val identity = classification.identity) {
            is Identity.Item -> ctx.snapshotCode(identity.codeHash)?.sourceProductionDate?.let { SourceDate.Single("item", it) } ?: SourceDate.None
            is Identity.KnownBox -> {
                val unclaimed = identity.children.filter { it.firstWinning == null && it.origin == Origin.EXPECTED }.map { it.codeHash }.toSet()
                var date: String? = null
                for (row in ctx.snapshotChildren(identity.sscc)) {
                    val rowDate = row.sourceProductionDate
                    if (row.codeHash !in unclaimed || rowDate == null) continue
                    if (date != null && date != rowDate) return SourceDate.Mixed
                    date = rowDate
                }
                date?.let { SourceDate.Single("known_box", it) } ?: SourceDate.None
            }
            is Identity.OldBox -> SourceDate.None
        }
    }
}
```

The domain's `canonicalizeKm` result field is `raw` (canonical); the Kotlin `ParsedKm.canonicalRaw` is the same value.

- [ ] **Step 4: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.inventory.*" -q` → PASS. If a case fails on `sourceStatus` for boxes, the domain sets no `sourceStatus` for box protected/ineligible: keep `null` there.

- [ ] **Step 5: Commit** `feat(handheld): inventory scan classifier ported from the domain and checked against its fixtures`

---

### Task 6: Canonical JSON, digests and the bundle mirror

**Files:**

- Create: `core/inventory/CanonicalJson.kt`, `core/inventory/InventoryDigests.kt`, `core/inventory/InventoryBundleMirror.kt`
- Test: `core/inventory/InventoryDigestsTest.kt`, `core/inventory/InventoryBundleMirrorTest.kt`

**Interfaces:**

- Produces: `CanonicalJson` (`obj`, `arr`, `str`, `num`, `bool`, `NULL`, `sha256Hex`); `InventoryDigests.itemJson(code)`, `pageDigest(...)`, `ContentDigest` (streaming: `add(itemJson)`, `finish()`); `InventoryBundleMirror.mirror(manifest, onProgress): MirrorResult` with `MirrorResult.Active | Repack | Invalid(reason)`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// core/inventory/InventoryDigestsTest.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.InventoryBundleCodeDto
import org.junit.Assert.assertEquals
import org.junit.Test

class InventoryDigestsTest {
    // Values from packages/domain/test/station-inventory-bundle.test.ts.
    private val item = InventoryBundleCodeDto(
        codeHash = "066e15060b18b753ddffa6a92d9d2ce2366b5fc3c704d6d61c89bb77740b47ff", canonicalRaw = "010460000000001521SERIAL-B",
        gtin14 = "04600000000015", serial = "SERIAL-B", sourceStatus = "INTRODUCED", sourceState = null, sourceProductionDate = "2026-08-01",
        parentSscc = null, expected = true, protected = false,
    )

    @Test
    fun escapesLikeJsonStringify() {
        assertEquals("\"a\\\"b\\\\c\\u001dd\\n\\u0000é\"", CanonicalJson.str("a\"b\\c\u001dd\n�é"))
        assertEquals("""{"a":1,"b":null,"c":[true,"x"]}""", CanonicalJson.obj("a" to CanonicalJson.num(1), "b" to CanonicalJson.NULL, "c" to CanonicalJson.arr(listOf(CanonicalJson.bool(true), CanonicalJson.str("x")))))
    }

    @Test
    fun contentDigestOfAnEmptySnapshotMatchesTheDomain() {
        // sha256 of {"version":1,"items":[]}
        assertEquals(CanonicalJson.sha256Hex("""{"version":1,"items":[]}"""), ContentDigest().finish())
    }

    @Test
    fun pageDigestFollowsTheCanonicalItemOrder() {
        val expected = CanonicalJson.sha256Hex(
            """{"version":1,"snapshotId":"s","snapshotFixedAt":"2026-08-25T01:02:03.000Z","contentDigest":"c","cursor":null,"items":[""" +
                """{"codeHash":"${item.codeHash}","canonicalRaw":"010460000000001521SERIAL-B","gtin14":"04600000000015","serial":"SERIAL-B",""" +
                """"sourceStatus":"INTRODUCED","sourceState":null,"sourceProductionDate":"2026-08-01","parentSscc":null,"expected":true,"protected":false}],"nextCursor":null}""",
        )
        assertEquals(expected, InventoryDigests.pageDigest("s", "2026-08-25T01:02:03.000Z", "c", null, listOf(item), null))
    }
}
```

Then compare against the domain once: run in `packages/domain` `node -e 'import("./dist/index.js").then(m => console.log(m.inventorySnapshotContentDigest([])))'` after `pnpm --filter @markiro/domain build` and paste that hex into the empty-snapshot test as a literal (replacing the self-referential `sha256Hex` line) so the Kotlin side is pinned to the domain, not to itself. Do the same for `inventorySnapshotPageDigest` with the item above (`cursor: null`, `nextCursor: null`, `snapshotId: "s"`, `contentDigest: "c"`).

```kotlin
// core/inventory/InventoryBundleMirrorTest.kt
package app.markiro.handheld.core.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.BundleLimitsDto
import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class InventoryBundleMirrorTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private val snapshotId = "22222222-2222-4222-8222-222222222222"
    private val fixedAt = "2026-08-25T01:02:03.000Z"

    private fun code(n: Int, parent: String? = null, expected: Boolean = true, date: String? = "2026-08-10") = InventoryBundleCodeDto(
        codeHash = n.toString(16).padStart(64, '0'), canonicalRaw = "010460000000001521S$n", gtin14 = "04600000000015", serial = "S$n",
        sourceStatus = if (expected) "INTRODUCED" else "RETIRED", sourceState = null, sourceProductionDate = date, parentSscc = parent,
        expected = expected, protected = false,
    )

    private val items = listOf(code(1), code(2, parent = "346006820000000014"), code(3, expected = false))
    private val contentDigest = ContentDigest().also { d -> items.forEach { d.add(InventoryDigests.itemJson(it)) } }.finish()

    private fun manifest(mode: String = "check", digest: String = contentDigest) = InventoryManifestDto(
        inventoryId = "i1", inventoryNumber = "INV-1", snapshotId = snapshotId, snapshotRevision = 1, snapshotFixedAt = fixedAt,
        combinedDigest = "a".repeat(64), contentDigest = digest, codeCount = items.size, productId = "p1", productName = "Вода", productPrintName = null,
        gtin14 = "04600000000015", boxCapacity = 12, mode = mode, lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01",
        productionDateTo = "2026-08-31", limits = BundleLimitsDto(200, 100, 200),
    )

    private fun pageJson(cursor: String?, page: List<InventoryBundleCodeDto>, next: String?, digest: String? = null): String {
        val pageDigest = digest ?: InventoryDigests.pageDigest(snapshotId, fixedAt, contentDigest, cursor, page, next)
        val itemsJson = page.joinToString(",") { InventoryDigests.itemJson(it) }
        return """{"snapshotId":"$snapshotId","snapshotRevision":1,"snapshotFixedAt":"$fixedAt","combinedDigest":"${"a".repeat(64)}",""" +
            """"contentDigest":"$contentDigest","cursor":${cursor?.let { "\"$it\"" } ?: "null"},"items":[$itemsJson],"nextCursor":${next?.let { "\"$it\"" } ?: "null"},"pageDigest":"$pageDigest"}"""
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun mirror() = InventoryBundleMirror(db, api, pageSize = 2) { 1L }

    @Test
    fun downloadsPagesVerifiesDigestsAndActivates() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items.take(2), items[1].codeHash)))
        server.enqueue(MockResponse().setBody(pageJson(items[1].codeHash, items.drop(2), null)))
        val progress = mutableListOf<Int>()
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { staged, _ -> progress += staged })
        assertEquals(listOf(2, 3), progress)
        assertEquals("/station/inventories/i1/bundle/codes?limit=2", server.takeRequest().path)
        assertEquals("/station/inventories/i1/bundle/codes?cursor=${items[1].codeHash}&limit=2", server.takeRequest().path)
        val task = db.inventoryTaskDao().get("i1")
        assertEquals("active", task?.state)
        assertEquals(2, task?.expectedCount)
        assertEquals(3, db.inventorySnapshotCodeDao().count(snapshotId))
    }

    @Test
    fun resumesFromTheStagedCursorAndSkipsAnActiveSnapshot() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items.take(2), items[1].codeHash)))
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(runCatching { mirror().mirror(manifest()) { _, _ -> } }.isFailure)
        assertEquals(items[1].codeHash, db.inventoryTaskDao().get("i1")?.stagingCursor)
        server.enqueue(MockResponse().setBody(pageJson(items[1].codeHash, items.drop(2), null)))
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { _, _ -> })
        assertEquals(3, server.requestCount)
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { _, _ -> })
        assertEquals(3, server.requestCount)
    }

    @Test
    fun aBadPageDigestOrContentDigestNeverActivates() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items, null, digest = "f".repeat(64))))
        assertEquals(MirrorResult.Invalid("page digest"), mirror().mirror(manifest()) { _, _ -> })
        server.enqueue(MockResponse().setBody(pageJson(null, items, null)))
        assertEquals(MirrorResult.Invalid("content digest"), InventoryBundleMirror(db, api, pageSize = 3) { 1L }.mirror(manifest(digest = "e".repeat(64))) { _, _ -> })
        assertEquals(0, db.inventorySnapshotCodeDao().count(snapshotId))
        assertEquals("staging", db.inventoryTaskDao().get("i1")?.state)
    }

    @Test
    fun repackIsRefusedBeforeAnyDownload() = runTest {
        assertEquals(MirrorResult.Repack, mirror().mirror(manifest(mode = "repack")) { _, _ -> })
        assertEquals(0, server.requestCount)
    }
}
```

The content-digest mismatch test sends every item in one page (page size 3) whose `contentDigest` field must equal the manifest's for the page guard to pass — build that page with `contentDigest = "e".repeat(64)` by adding a `content: String = contentDigest` parameter to `pageJson` and passing it in both the field and `pageDigest` computation.

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Implement canonical JSON and digests**

```kotlin
// core/inventory/CanonicalJson.kt
package app.markiro.handheld.core.inventory

import java.security.MessageDigest

/**
 * Builds the exact bytes `JSON.stringify` would produce for the domain's canonical objects: no
 * whitespace, insertion key order, `"` `\` and control characters escaped (short forms for
 * \b \f \n \r \t, `\u00xx` otherwise), everything else verbatim.
 */
object CanonicalJson {
    const val NULL = "null"

    fun str(value: String): String {
        val sb = StringBuilder(value.length + 2).append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u").append(ch.code.toString(16).padStart(4, '0')) else sb.append(ch)
            }
        }
        return sb.append('"').toString()
    }

    fun num(value: Long): String = value.toString()
    fun num(value: Int): String = value.toString()
    fun bool(value: Boolean): String = if (value) "true" else "false"
    fun strOrNull(value: String?): String = value?.let(::str) ?: NULL
    fun arr(items: List<String>): String = items.joinToString(",", "[", "]")
    fun obj(vararg fields: Pair<String, String>): String = fields.joinToString(",", "{", "}") { (k, v) -> str(k) + ":" + v }

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
```

```kotlin
// core/inventory/InventoryDigests.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import java.security.MessageDigest

/** `inventorySnapshotPageDigest` / `inventorySnapshotContentDigest` from packages/domain/src/inventory/station-bundle.ts. */
object InventoryDigests {
    fun itemJson(c: InventoryBundleCodeDto): String = CanonicalJson.obj(
        "codeHash" to CanonicalJson.str(c.codeHash),
        "canonicalRaw" to CanonicalJson.str(c.canonicalRaw),
        "gtin14" to CanonicalJson.str(c.gtin14),
        "serial" to CanonicalJson.str(c.serial),
        "sourceStatus" to CanonicalJson.str(c.sourceStatus),
        "sourceState" to CanonicalJson.strOrNull(c.sourceState),
        "sourceProductionDate" to CanonicalJson.strOrNull(c.sourceProductionDate),
        "parentSscc" to CanonicalJson.strOrNull(c.parentSscc),
        "expected" to CanonicalJson.bool(c.expected),
        "protected" to CanonicalJson.bool(c.protected),
    )

    fun itemJson(e: InventorySnapshotCodeEntity): String = itemJson(
        InventoryBundleCodeDto(e.codeHash, e.canonicalRaw, e.gtin14, e.serial, e.sourceStatus, e.sourceState, e.sourceProductionDate, e.parentSscc, e.expected, e.protected),
    )

    fun pageDigest(snapshotId: String, snapshotFixedAt: String, contentDigest: String, cursor: String?, items: List<InventoryBundleCodeDto>, nextCursor: String?): String =
        CanonicalJson.sha256Hex(
            CanonicalJson.obj(
                "version" to CanonicalJson.num(1),
                "snapshotId" to CanonicalJson.str(snapshotId),
                "snapshotFixedAt" to CanonicalJson.str(snapshotFixedAt),
                "contentDigest" to CanonicalJson.str(contentDigest),
                "cursor" to CanonicalJson.strOrNull(cursor),
                "items" to CanonicalJson.arr(items.map(::itemJson)),
                "nextCursor" to CanonicalJson.strOrNull(nextCursor),
            ),
        )
}

/** Streams `{"version":1,"items":[…]}` through SHA-256 so a 100 000-row snapshot never sits in memory. */
class ContentDigest {
    private val digest = MessageDigest.getInstance("SHA-256")
    private var count = 0

    init {
        digest.update("""{"version":1,"items":[""".toByteArray(Charsets.UTF_8))
    }

    fun add(itemJson: String) {
        if (count > 0) digest.update(','.code.toByte())
        digest.update(itemJson.toByteArray(Charsets.UTF_8))
        count += 1
    }

    fun finish(): String = digest.digest("]}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
```

- [ ] **Step 4: Implement the mirror**

```kotlin
// core/inventory/InventoryBundleMirror.kt
package app.markiro.handheld.core.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.network.InventoryBundlePageDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity

sealed interface MirrorResult {
    data object Active : MirrorResult
    data object Repack : MirrorResult
    data class Invalid(val reason: String) : MirrorResult
}

/**
 * Port of apps/station/src/lib/inventory-bundle.ts: pages are verified by digest and staged, the
 * snapshot is published in one transaction after the content digest recomputes, a restart resumes
 * from the staged cursor. Network failures propagate (IOException / HttpException) so the screen can retry.
 */
class InventoryBundleMirror(
    private val db: HandheldDatabase,
    private val api: StationApi,
    private val pageSize: Int = PAGE_SIZE,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun mirror(manifest: InventoryManifestDto, onProgress: suspend (staged: Int, total: Int) -> Unit): MirrorResult {
        if (manifest.mode == "repack") return MirrorResult.Repack
        if (manifest.snapshotRevision != 1 || manifest.productionDateFrom > manifest.productionDateTo || manifest.mode != "check") {
            return MirrorResult.Invalid("manifest")
        }
        val id = manifest.inventoryId
        val existing = db.inventoryTaskDao().get(id)
        if (existing != null && existing.snapshotId == manifest.snapshotId && existing.state == "active" && existing.contentDigest == manifest.contentDigest) {
            db.inventoryTaskDao().setJoinedAt(id, clock())
            return MirrorResult.Active
        }
        var task = existing
        if (task == null || task.snapshotId != manifest.snapshotId || task.contentDigest != manifest.contentDigest || task.state != "staging") {
            task = db.withTransaction {
                existing?.let { old ->
                    if (old.snapshotId != manifest.snapshotId) {
                        // The cabinet re-snapshotted: everything scoped to the old snapshot is moot.
                        db.inventorySnapshotCodeDao().deleteSnapshot(old.snapshotId)
                        db.inventoryEventDao().deleteForInventory(id)
                        db.inventoryResultDao().deleteForInventory(id)
                        db.inventoryOutboxDao().deleteForInventory(id)
                        db.inventoryTerminalStateDao().delete(id)
                    } else {
                        db.inventorySnapshotCodeDao().deleteSnapshot(old.snapshotId)
                    }
                }
                val fresh = manifest.toEntity()
                db.inventoryTaskDao().upsert(fresh)
                fresh
            }
        }
        var cursor = task.stagingCursor
        var staged = task.stagedCount
        while (true) {
            val page = api.inventoryCodes(id, cursor, pageSize)
            val problem = verifyPage(manifest, cursor, page)
            if (problem != null) return discard(manifest, problem)
            val rows = page.items.map { it.toEntity(manifest.snapshotId) }
            staged += rows.size
            val next = page.nextCursor
            db.withTransaction {
                db.inventorySnapshotCodeDao().insertAll(rows)
                db.inventoryTaskDao().setStaging(id, next ?: cursor, staged)
            }
            onProgress(staged, manifest.codeCount)
            if (next == null) break
            cursor = next
        }
        return publish(manifest)
    }

    private fun verifyPage(manifest: InventoryManifestDto, cursor: String?, page: InventoryBundlePageDto): String? {
        if (page.snapshotId != manifest.snapshotId || page.snapshotRevision != 1 || page.snapshotFixedAt != manifest.snapshotFixedAt ||
            page.contentDigest != manifest.contentDigest || page.combinedDigest != manifest.combinedDigest || page.cursor != cursor ||
            page.items.size > pageSize
        ) {
            return "page shape"
        }
        var previous = cursor ?: ""
        for (item in page.items) {
            if (item.codeHash <= previous) return "page order"
            previous = item.codeHash
            if (!flagsMatch(item, manifest)) return "row flags"
        }
        if (page.nextCursor != null && page.nextCursor != previous) return "page cursor"
        if (InventoryDigests.pageDigest(manifest.snapshotId, manifest.snapshotFixedAt, manifest.contentDigest, cursor, page.items, page.nextCursor) != page.pageDigest) {
            return "page digest"
        }
        return null
    }

    /** Port of `classifyInventorySnapshotRow`: the flags the server sent must agree with its own rules. */
    private fun flagsMatch(item: InventoryBundleCodeDto, manifest: InventoryManifestDto): Boolean {
        if (item.gtin14 != manifest.gtin14) return false
        val date = item.sourceProductionDate
        val expected = item.sourceState != "MOVING_BY_UD" && item.sourceStatus == "INTRODUCED" && date != null &&
            date >= manifest.productionDateFrom && date <= manifest.productionDateTo
        val protected = item.sourceState == "MOVING_BY_UD"
        return item.protected == protected && item.expected == (expected && !protected)
    }

    private suspend fun discard(manifest: InventoryManifestDto, reason: String): MirrorResult {
        db.withTransaction {
            db.inventorySnapshotCodeDao().deleteSnapshot(manifest.snapshotId)
            db.inventoryTaskDao().setStaging(manifest.inventoryId, null, 0)
        }
        return MirrorResult.Invalid(reason)
    }

    private suspend fun publish(manifest: InventoryManifestDto): MirrorResult {
        val digest = ContentDigest()
        var after = ""
        var count = 0
        while (true) {
            val rows = db.inventorySnapshotCodeDao().pageAfter(manifest.snapshotId, after, DIGEST_PAGE)
            if (rows.isEmpty()) break
            rows.forEach { digest.add(InventoryDigests.itemJson(it)) }
            count += rows.size
            after = rows.last().codeHash
        }
        if (count != manifest.codeCount || digest.finish() != manifest.contentDigest) return discard(manifest, "content digest")
        val expectedCount = db.inventorySnapshotCodeDao().countExpected(manifest.snapshotId)
        db.inventoryTaskDao().activate(manifest.inventoryId, expectedCount, clock())
        return MirrorResult.Active
    }

    private fun InventoryManifestDto.toEntity() = InventoryTaskEntity(
        inventoryId = inventoryId, inventoryNumber = inventoryNumber, productId = productId, productName = productName,
        productPrintName = productPrintName, gtin14 = gtin14, mode = mode, lineId = lineId, lineName = lineName,
        productionDateFrom = productionDateFrom, productionDateTo = productionDateTo, boxCapacity = boxCapacity, snapshotId = snapshotId,
        snapshotFixedAt = snapshotFixedAt, contentDigest = contentDigest, combinedDigest = combinedDigest, codeCount = codeCount,
        expectedCount = 0, state = "staging", stagingCursor = null, stagedCount = 0, joinedAt = null, leftAt = null,
    )

    private fun InventoryBundleCodeDto.toEntity(snapshotId: String) = InventorySnapshotCodeEntity(
        snapshotId, codeHash, canonicalRaw, gtin14, serial, sourceStatus, sourceState, sourceProductionDate, parentSscc, expected, protected,
    )

    companion object {
        const val PAGE_SIZE = 200
        private const val DIGEST_PAGE = 500
    }
}
```

Note the row-flags rule: the domain marks a row `known_ineligible` (expected=false) when the date is missing or out of range and the status is not INTRODUCED; the test items use `RETIRED` for the ineligible row, so they pass. If the API ever sends `expected=true` with a missing date the page is rejected as "row flags", matching the station's `inventory bundle code identity mismatch` behaviour.

- [ ] **Step 5: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.inventory.*" -q` → PASS.

- [ ] **Step 6: Commit** `feat(handheld): inventory bundle mirror with digest-checked pages and resumable staging`

---

### Task 7: `InventoryRecorder` — the check journal

**Files:**

- Create: `core/inventory/InventoryRecorder.kt`, `core/inventory/InventoryBatchCodec.kt` (event JSON only; the batch part lands in Task 8)
- Test: `core/inventory/InventoryRecorderTest.kt`

**Interfaces:**

- Produces: `InventoryVerdict` (`EXPECTED, PROTECTED, KNOWN_INELIGIBLE, UNKNOWN, DUPLICATE, INVALID` with `wire`), `RecordOutcome.Recorded(...)`, `RecordOutcome.DateMismatch(...)`, `InventoryRecorder.record(inventoryId, raw, operatorId, acceptMismatch, eventId)`, `InventoryRecorder.setActiveDate(inventoryId, date, operatorId)`, `InventoryRecorder.activeDate(inventoryId)`, `InventoryBatchCodec.eventJson(event)`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// core/inventory/InventoryRecorderTest.kt
package app.markiro.handheld.core.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryRecorderTest {
    private lateinit var db: HandheldDatabase
    private var clock = 1_757_500_000_000L
    private val gs = "\u001d"
    private val sscc = "346006820000000014"

    private fun raw(serial: String, gtin: String = "04600000000015") = "01${gtin}21$serial${gs}93AbCd"
    private fun hash(serial: String) = KmCodec.hash(KmCodec.canonicalize(raw(serial)))

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeInventoryId = "i1",
            ),
        )
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", hash("A1"), serial = "A1", date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("A2"), serial = "A2", date = "2026-08-22"),
                InventoryFixtures.code("snap", hash("B1"), serial = "B1", parentSscc = sscc, date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("B2"), serial = "B2", parentSscc = sscc, date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("P1"), serial = "P1", state = "MOVING_BY_UD", expected = false, protected = true),
                InventoryFixtures.code("snap", hash("R1"), serial = "R1", status = "RETIRED", expected = false),
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private fun recorder() = InventoryRecorder(db) { clock }

    @Test
    fun everyVerdictAndTheFirstScanAdoptsTheCodeDate() = runTest {
        val r = recorder()
        val ok = r.record("i1", raw("A1"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, ok.verdict)
        assertEquals("…A1", ok.tail)
        assertEquals("2026-08-20", r.activeDate("i1"))
        assertEquals(InventoryVerdict.DUPLICATE, (r.record("i1", raw("A1"), "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(InventoryVerdict.PROTECTED, (r.record("i1", raw("P1"), "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(InventoryVerdict.KNOWN_INELIGIBLE, (r.record("i1", raw("R1"), "op-1") as RecordOutcome.Recorded).let { assertEquals("RETIRED", it.sourceStatus); it.verdict })
        assertEquals(InventoryVerdict.UNKNOWN, (r.record("i1", raw("ZZ"), "op-1") as RecordOutcome.Recorded).verdict)
        val again = r.record("i1", raw("ZZ"), "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.DUPLICATE, again.verdict)
        assertEquals("dev-1", again.winner?.deviceId)
        assertEquals(InventoryVerdict.INVALID, (r.record("i1", raw("X", gtin = "04600682000013"), "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(InventoryVerdict.INVALID, (r.record("i1", "garbage", "op-1") as RecordOutcome.Recorded).verdict)
        assertEquals(6, db.inventoryOutboxDao().count("i1"))
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L, 6L), db.inventoryOutboxDao().head("i1", 10).map { it.deviceSequence })
        assertEquals(1, db.inventoryResultDao().observeCount("i1", "expected").first())
        assertEquals(3, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
    }

    @Test
    fun aDateMismatchHoldsTheScanUntilAcceptedOrTheDateChanges() = runTest {
        val r = recorder()
        r.record("i1", raw("A1"), "op-1")
        val held = r.record("i1", raw("A2"), "op-1")
        assertTrue(held is RecordOutcome.DateMismatch)
        assertEquals("2026-08-20", (held as RecordOutcome.DateMismatch).activeDate)
        assertEquals("2026-08-22", held.codeDate)
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
        val accepted = r.record("i1", raw("A2"), "op-1", acceptMismatch = true) as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, accepted.verdict)
        assertEquals("2026-08-20", db.inventoryEventDao().get(accepted.eventId!!)?.activeProductionDate)
        r.setActiveDate("i1", "2026-08-22", "op-1")
        assertEquals("2026-08-22", r.activeDate("i1"))
    }

    @Test
    fun aBoxClaimsItsUnclaimedChildrenAndCountsThem() = runTest {
        val r = recorder()
        r.record("i1", raw("B1"), "op-1")
        val box = r.record("i1", "00$sscc", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.EXPECTED, box.verdict)
        assertEquals("known_box", box.scanKind)
        assertEquals(1, box.claimedCount)
        assertEquals(2, box.boxChildCount)
        assertEquals("…0014", box.tail)
        val dup = r.record("i1", "00$sscc", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.DUPLICATE, dup.verdict)
        val unknownBox = r.record("i1", "00346006820000000021", "op-1") as RecordOutcome.Recorded
        assertEquals(InventoryVerdict.UNKNOWN, unknownBox.verdict)
        assertEquals("old_box", unknownBox.scanKind)
        val event = db.inventoryEventDao().get(box.eventId!!)
        assertEquals("known_box:$sscc", event?.normalizedIdentity)
        assertEquals(sscc, event?.canonicalRaw)
        assertNull(event?.codeHash)
    }

    @Test
    fun theSameEventIdIsRecordedOnce() = runTest {
        val r = recorder()
        val first = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        val replay = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        assertEquals(first.verdict, replay.verdict)
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
    }

    @Test
    fun eventJsonFollowsTheDomainKeyOrder() = runTest {
        val r = recorder()
        val out = r.record("i1", raw("A1"), "op-1", eventId = "e-1") as RecordOutcome.Recorded
        val json = db.inventoryOutboxDao().head("i1", 1).single().payloadJson
        assertEquals(
            """{"eventId":"e-1","deviceSequence":1,"operatorId":"op-1","scannedAt":"${out.scannedAt}","kind":"item",""" +
                """"normalizedIdentity":"item:${hash("A1")}","codeHash":"${hash("A1")}","canonicalRaw":"${raw("A1").replace(gs, "\\u001d")}",""" +
                """"activeProductionDate":"2026-08-20","localVerdict":"expected"}""",
            json,
        )
    }
}
```

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Event JSON**

```kotlin
// core/inventory/InventoryBatchCodec.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.InventoryEventEntity

/** Canonical JSON of `inventoryEventSchema` (Task 8 adds the batch envelope). */
object InventoryBatchCodec {
    fun eventJson(e: InventoryEventEntity): String = CanonicalJson.obj(
        "eventId" to CanonicalJson.str(e.eventId),
        "deviceSequence" to CanonicalJson.num(e.deviceSequence),
        "operatorId" to CanonicalJson.str(e.operatorId),
        "scannedAt" to CanonicalJson.str(e.scannedAt),
        "kind" to CanonicalJson.str(e.kind),
        "normalizedIdentity" to CanonicalJson.str(e.normalizedIdentity),
        "codeHash" to CanonicalJson.strOrNull(e.codeHash),
        "canonicalRaw" to CanonicalJson.strOrNull(e.canonicalRaw),
        "activeProductionDate" to CanonicalJson.str(e.activeProductionDate),
        "localVerdict" to CanonicalJson.str(e.localVerdict),
    )
}
```

- [ ] **Step 4: Recorder**

```kotlin
// core/inventory/InventoryRecorder.kt
package app.markiro.handheld.core.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import app.markiro.handheld.core.storage.InventoryResultEntity
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

enum class InventoryVerdict(val wire: String) {
    EXPECTED("expected"),
    PROTECTED("protected"),
    KNOWN_INELIGIBLE("known-ineligible"),
    UNKNOWN("unknown"),
    DUPLICATE("duplicate"),
    INVALID("invalid"),
    ;

    companion object {
        fun fromWire(wire: String): InventoryVerdict = entries.first { it.wire == wire }
    }
}

sealed interface RecordOutcome {
    data class Recorded(
        val verdict: InventoryVerdict,
        /** `item`, `known_box`, `old_box` or `invalid`. */
        val scanKind: String,
        val tail: String?,
        val claimedCount: Int,
        val boxChildCount: Int,
        val winner: LocalClaim?,
        val sourceStatus: String?,
        val scannedAt: String,
        val eventId: String?,
        val invalidReason: String? = null,
    ) : RecordOutcome

    /** Nothing was written; the screen asks the operator and repeats the scan with `acceptMismatch` or a new date. */
    data class DateMismatch(val activeDate: String, val codeDate: String?, val mixed: Boolean, val raw: String) : RecordOutcome
}

/**
 * Port of the station's `recordInventoryScanInternal` for `check`: classify against the snapshot and
 * local claims, guard the production date, then in one transaction allocate the device sequence,
 * insert the event, claim result rows (`INSERT OR IGNORE` decides who counted first) and queue the
 * canonical event JSON. One scan at a time.
 */
class InventoryRecorder(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = Mutex()

    suspend fun activeDate(inventoryId: String): String? =
        db.inventoryTerminalStateDao().get(inventoryId)?.activeProductionDate ?: db.inventoryTaskDao().get(inventoryId)?.productionDateFrom

    suspend fun setActiveDate(inventoryId: String, date: String, operatorId: String) = mutex.withLock {
        val task = checkNotNull(db.inventoryTaskDao().get(inventoryId)) { "inventory $inventoryId is not on this device" }
        require(date >= task.productionDateFrom && date <= task.productionDateTo) { "date outside the task range" }
        val at = Iso.format(clock())
        db.withTransaction {
            val state = db.inventoryTerminalStateDao().get(inventoryId) ?: terminal(task, operatorId, at)
            db.inventoryTerminalStateDao().upsert(state.copy(activeProductionDate = date, operatorId = operatorId, updatedAt = at))
        }
    }

    suspend fun record(
        inventoryId: String,
        raw: String,
        operatorId: String,
        acceptMismatch: Boolean = false,
        eventId: String = UUID.randomUUID().toString(),
    ): RecordOutcome = mutex.withLock {
        val task = checkNotNull(db.inventoryTaskDao().get(inventoryId)) { "inventory $inventoryId is not on this device" }
        check(task.state == "active") { "inventory $inventoryId is not active" }
        val scannedAt = Iso.format(clock())
        db.inventoryEventDao().get(eventId)?.let { return replay(it) }
        val ctx = context(task)
        val classification = InventoryClassifier.classify(raw, ctx)
        if (classification is InventoryClassification.Invalid) {
            return RecordOutcome.Recorded(InventoryVerdict.INVALID, "invalid", null, 0, 0, null, null, scannedAt, null, classification.reason)
        }
        db.withTransaction {
            val state = db.inventoryTerminalStateDao().get(inventoryId) ?: terminal(task, operatorId, scannedAt)
            val active = state.activeProductionDate ?: task.productionDateFrom
            var activeDate = active
            if (!acceptMismatch) {
                when (val source = InventoryClassifier.sourceDate(classification, ctx)) {
                    SourceDate.None -> Unit
                    SourceDate.Mixed -> return@withTransaction RecordOutcome.DateMismatch(active, null, true, raw)
                    is SourceDate.Single -> if (source.productionDate != active) {
                        if (db.inventoryEventDao().hasAny(inventoryId)) {
                            return@withTransaction RecordOutcome.DateMismatch(active, source.productionDate, false, raw)
                        }
                        // The first scan of this terminal silently adopts the code's date, as on the station.
                        activeDate = source.productionDate
                    }
                }
            }
            val sequence = state.nextDeviceSequence
            db.inventoryTerminalStateDao().upsert(
                state.copy(nextDeviceSequence = sequence + 1, operatorId = operatorId, activeProductionDate = activeDate, updatedAt = scannedAt),
            )
            val identity = classification.identity
            val claimedOrigins = claim(task, identity, classification, eventId, scannedAt, activeDate)
            var verdict = when {
                Origin.EXPECTED in claimedOrigins -> InventoryVerdict.EXPECTED
                Origin.PROTECTED in claimedOrigins -> InventoryVerdict.PROTECTED
                Origin.KNOWN_INELIGIBLE in claimedOrigins -> InventoryVerdict.KNOWN_INELIGIBLE
                classification is InventoryClassification.Unknown -> InventoryVerdict.UNKNOWN
                else -> InventoryVerdict.DUPLICATE
            }
            var winner: LocalClaim? = null
            val normalized = normalizedIdentity(identity)
            if (verdict == InventoryVerdict.UNKNOWN) {
                db.inventoryEventDao().firstUnknown(inventoryId, normalized)?.let { first ->
                    verdict = InventoryVerdict.DUPLICATE
                    winner = LocalClaim(first.codeHash ?: first.normalizedIdentity, first.eventId, "dev-local", first.scannedAt)
                        .copy(deviceId = db.deviceConfigDao().get()?.deviceId ?: "dev-local")
                }
            } else if (verdict == InventoryVerdict.DUPLICATE) {
                winner = (classification as? InventoryClassification.Duplicate)?.firstWinning ?: projectionWinner(task, identity)
            }
            val event = InventoryEventEntity(
                eventId = eventId, inventoryId = inventoryId, snapshotId = task.snapshotId, deviceSequence = sequence, operatorId = operatorId,
                scannedAt = scannedAt, kind = identity.scanKind, normalizedIdentity = normalized,
                codeHash = (identity as? Identity.Item)?.codeHash, canonicalRaw = canonicalRaw(identity), activeProductionDate = activeDate,
                localVerdict = verdict.wire, claimedCount = claimedOrigins.size, winnerEventId = winner?.eventId, winnerDeviceId = winner?.deviceId,
                winnerScannedAt = winner?.scannedAt, serverStatus = null,
            )
            db.inventoryEventDao().insert(event)
            db.inventoryOutboxDao().insert(
                InventoryOutboxEntity(
                    inventoryId = inventoryId, snapshotId = task.snapshotId, eventId = eventId, deviceSequence = sequence,
                    payloadJson = InventoryBatchCodec.eventJson(event), createdAt = scannedAt,
                ),
            )
            RecordOutcome.Recorded(
                verdict, identity.scanKind, tail(identity), claimedOrigins.size, (identity as? Identity.KnownBox)?.children?.size ?: 0,
                winner, classification.sourceStatus, scannedAt, eventId,
            )
        }
    }

    private suspend fun replay(event: InventoryEventEntity): RecordOutcome.Recorded {
        val winner = event.winnerEventId?.let { LocalClaim(event.codeHash ?: event.normalizedIdentity, it, event.winnerDeviceId.orEmpty(), event.winnerScannedAt.orEmpty()) }
        val tail = if (event.kind == "item") tailOfSerial(event.canonicalRaw.orEmpty().substringAfter("21")) else "…" + event.canonicalRaw.orEmpty().takeLast(4)
        return RecordOutcome.Recorded(InventoryVerdict.fromWire(event.localVerdict), event.kind, tail, event.claimedCount, 0, winner, null, event.scannedAt, event.eventId)
    }

    private suspend fun context(task: InventoryTaskEntity): ClassifierContext {
        val dao = db.inventorySnapshotCodeDao()
        val results = db.inventoryResultDao()
        val deviceId = db.deviceConfigDao().get()?.deviceId ?: "dev-local"
        return object : ClassifierContext {
            override val taskGtin14 = task.gtin14
            private val rows = HashMap<String, SnapshotRow?>()
            private val claims = HashMap<String, LocalClaim?>()
            private var children: Map<String, List<SnapshotRow>> = emptyMap()

            override fun snapshotCode(codeHash: String): SnapshotRow? = rows.getOrPut(codeHash) { null }

            override fun snapshotChildren(sscc: String): List<SnapshotRow> = children[sscc].orEmpty()

            override fun localClaim(codeHash: String): LocalClaim? = claims.getOrPut(codeHash) { null }

            suspend fun preload(raw: String) {
                when (val input = ScanClassifier.classify(raw)) {
                    is ScanInput.Km -> {
                        val hash = app.markiro.handheld.core.km.KmCodec.hash(input.km)
                        rows[hash] = dao.get(task.snapshotId, hash)?.toRow()
                        claims[hash] = results.get(task.inventoryId, hash)?.toClaim()
                    }
                    is ScanInput.Sscc -> {
                        val list = dao.children(task.snapshotId, input.sscc).map { it.toRow() }
                        children = mapOf(input.sscc to list)
                        results.forHashes(task.inventoryId, list.map { it.codeHash }).forEach { claims[it.codeHash] = it.toClaim() }
                        list.forEach { rows[it.codeHash] = it; claims.putIfAbsent(it.codeHash, null) }
                    }
                    else -> Unit
                }
            }
        }.also { it.preload(rawForContext) }
    }
```

Room DAO calls are `suspend`, so the context cannot query lazily inside the classifier; restructure `context(task)` into `suspend fun context(task, raw): ClassifierContext` that preloads everything the classifier will ask for (the code row or the box children, and their result rows) into maps, then serves them synchronously. Write it as:

```kotlin
    private suspend fun context(task: InventoryTaskEntity, raw: String): ClassifierContext {
        val rows = HashMap<String, SnapshotRow>()
        val claims = HashMap<String, LocalClaim>()
        var boxChildren: Pair<String, List<SnapshotRow>>? = null
        when (val input = ScanClassifier.classify(raw)) {
            is ScanInput.Km -> {
                val hash = app.markiro.handheld.core.km.KmCodec.hash(input.km)
                db.inventorySnapshotCodeDao().get(task.snapshotId, hash)?.let { rows[hash] = it.toRow() }
                db.inventoryResultDao().get(task.inventoryId, hash)?.let { claims[hash] = it.toClaim() }
            }
            is ScanInput.Sscc -> {
                val list = db.inventorySnapshotCodeDao().children(task.snapshotId, input.sscc).map { it.toRow() }
                list.forEach { rows[it.codeHash] = it }
                db.inventoryResultDao().forHashes(task.inventoryId, list.map { it.codeHash }).forEach { claims[it.codeHash] = it.toClaim() }
                boxChildren = input.sscc to list
            }
            else -> Unit
        }
        return object : ClassifierContext {
            override val taskGtin14 = task.gtin14
            override fun snapshotCode(codeHash: String) = rows[codeHash]
            override fun snapshotChildren(sscc: String) = boxChildren?.takeIf { it.first == sscc }?.second.orEmpty()
            override fun localClaim(codeHash: String) = claims[codeHash]
        }
    }
```

and call `val ctx = context(task, raw)` in `record`. Remove the first `context(task)` draft entirely. Then the helpers:

```kotlin
    /** Result rows for what this event counted; returns the origins of the rows actually inserted. */
    private suspend fun claim(
        task: InventoryTaskEntity,
        identity: Identity,
        classification: InventoryClassification,
        eventId: String,
        scannedAt: String,
        activeDate: String,
    ): List<Origin> {
        val deviceId = db.deviceConfigDao().get()?.deviceId ?: "dev-local"
        fun row(codeHash: String, origin: Origin) = InventoryResultEntity(
            inventoryId = task.inventoryId, snapshotId = task.snapshotId, codeHash = codeHash, firstAcceptedEventId = eventId,
            winningDeviceId = deviceId, winningScannedAt = scannedAt, observedProductionDate = activeDate, classification = origin.wire,
            source = "local", updatedAt = scannedAt,
        )
        val inserted = ArrayList<Origin>()
        when (identity) {
            is Identity.Item -> {
                val origin = when (classification) {
                    is InventoryClassification.Expected -> Origin.EXPECTED
                    is InventoryClassification.Protected -> Origin.PROTECTED
                    is InventoryClassification.KnownIneligible -> Origin.KNOWN_INELIGIBLE
                    else -> null
                }
                if (origin != null && db.inventoryResultDao().insertIgnore(row(identity.codeHash, origin)) >= 0) inserted += origin
            }
            is Identity.KnownBox -> identity.children.forEach { child ->
                if (child.firstWinning == null && db.inventoryResultDao().insertIgnore(row(child.codeHash, child.origin)) >= 0) inserted += child.origin
            }
            is Identity.OldBox -> Unit
        }
        return inserted
    }

    private suspend fun projectionWinner(task: InventoryTaskEntity, identity: Identity): LocalClaim? = when (identity) {
        is Identity.Item -> db.inventoryResultDao().get(task.inventoryId, identity.codeHash)?.toClaim()
        is Identity.KnownBox -> db.inventoryResultDao().forHashes(task.inventoryId, identity.children.map { it.codeHash })
            .map { it.toClaim() }.sortedWith(compareBy({ it.scannedAt }, { it.deviceId }, { it.eventId })).firstOrNull()
        is Identity.OldBox -> null
    }

    private fun terminal(task: InventoryTaskEntity, operatorId: String, at: String) = InventoryTerminalStateEntity(
        inventoryId = task.inventoryId, snapshotId = task.snapshotId, operatorId = operatorId, activeProductionDate = task.productionDateFrom,
        nextDeviceSequence = 1, progressCursor = null, progressResultRevision = 0, updatedAt = at,
    )

    private fun normalizedIdentity(identity: Identity) = when (identity) {
        is Identity.Item -> "item:${identity.codeHash}"
        is Identity.KnownBox -> "known_box:${identity.sscc}"
        is Identity.OldBox -> "old_box:${identity.sscc}"
    }

    private fun canonicalRaw(identity: Identity) = when (identity) {
        is Identity.Item -> identity.canonicalRaw
        is Identity.KnownBox -> identity.sscc
        is Identity.OldBox -> identity.sscc
    }

    private fun tail(identity: Identity) = when (identity) {
        is Identity.Item -> tailOfSerial(identity.serial)
        is Identity.KnownBox -> "…" + identity.sscc.takeLast(4)
        is Identity.OldBox -> "…" + identity.sscc.takeLast(4)
    }

    private fun tailOfSerial(serial: String): String? {
        val chars = serial.filter { it.isLetterOrDigit() }
        return if (chars.isEmpty()) null else "…" + chars.takeLast(4)
    }

    private fun InventorySnapshotCodeEntity.toRow() = SnapshotRow(codeHash, canonicalRaw, gtin14, serial, sourceStatus, sourceState, sourceProductionDate, expected, protected, parentSscc)

    private fun InventoryResultEntity.toClaim() = LocalClaim(codeHash, firstAcceptedEventId, winningDeviceId, winningScannedAt)
}
```

In the unknown-duplicate branch replace the awkward `"dev-local"` juggling with a single lookup at the top of `record`: `val deviceId = db.deviceConfigDao().get()?.deviceId ?: "dev-local"` and `winner = LocalClaim(first.codeHash ?: first.normalizedIdentity, first.eventId, deviceId, first.scannedAt)`; pass `deviceId` into `claim(...)` instead of re-reading it. `replay` uses the tail helpers; a replayed box has no child count (0), which only affects the status text.

- [ ] **Step 5: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.inventory.InventoryRecorderTest" -q` → PASS. The event-JSON test pins the `\u001d` escaping of the GS inside `canonicalRaw`.

- [ ] **Step 6: Commit** `feat(handheld): inventory recorder — verdicts, box claims, active date guard, canonical event JSON`

---

### Task 8: `InventorySyncEngine` — batches, outcomes, progress

**Files:**

- Modify: `core/inventory/InventoryBatchCodec.kt` (batch envelope + digest)
- Create: `core/inventory/InventorySyncEngine.kt`, `core/inventory/InventoryModule.kt`
- Modify: `core/sync/ConnectivityNudger.kt`, `core/sync/SyncModule.kt`, `HandheldApp.kt`
- Test: `core/inventory/InventoryBatchCodecTest.kt`, `core/inventory/InventorySyncEngineTest.kt`

**Interfaces:**

- Produces: `InventoryBatchCodec.payloadJson(...)`, `digest(payload)`, `requestJson(batchId, digest, payload)`; `InventorySyncState(pending, lastSuccessAt, stuck, closedInventoryId)`; `InventorySyncEngine.start()`, `nudge()`, `drainAll(): Boolean`, `state: StateFlow<InventorySyncState>`; `ConnectivityNudger(context, onAvailable: () -> Unit)`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// core/inventory/InventoryBatchCodecTest.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.InventoryEventEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

class InventoryBatchCodecTest {
    private val fixtures = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("inventory-fixtures.json")).readText(),
    ).jsonObject

    @Test
    fun batchDigestsMatchTheDomainPackage() {
        for (case in fixtures.getValue("batchDigest").jsonArray) {
            val o = case.jsonObject
            val payload = o.getValue("payload").jsonObject
            val events = payload.getValue("events").jsonArray.map { e ->
                val ev = e.jsonObject
                fun s(k: String) = ev.getValue(k).jsonPrimitive.content
                fun n(k: String) = ev[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
                InventoryBatchCodec.eventJson(
                    InventoryEventEntity(
                        eventId = s("eventId"), inventoryId = "i", snapshotId = payload.getValue("snapshotId").jsonPrimitive.content,
                        deviceSequence = ev.getValue("deviceSequence").jsonPrimitive.long, operatorId = s("operatorId"), scannedAt = s("scannedAt"),
                        kind = s("kind"), normalizedIdentity = s("normalizedIdentity"), codeHash = n("codeHash"), canonicalRaw = n("canonicalRaw"),
                        activeProductionDate = s("activeProductionDate"), localVerdict = s("localVerdict"), claimedCount = 0,
                        winnerEventId = null, winnerDeviceId = null, winnerScannedAt = null, serverStatus = null,
                    ),
                )
            }
            val json = InventoryBatchCodec.payloadJson(
                snapshotId = payload.getValue("snapshotId").jsonPrimitive.content,
                sequenceCeiling = payload.getValue("sequenceCeiling").jsonPrimitive.long,
                pendingEventCount = payload.getValue("pendingEventCount").jsonPrimitive.content.toInt(),
                events = events,
            )
            assertEquals(o.getValue("name").jsonPrimitive.content, o.getValue("digest").jsonPrimitive.content, InventoryBatchCodec.digest(json))
        }
    }
}
```

```kotlin
// core/inventory/InventorySyncEngineTest.kt
package app.markiro.handheld.core.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventorySyncEngineTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private var clock = 1_757_500_000_000L
    private val snap = "22222222-2222-4222-8222-222222222222"

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L, activeInventoryId = "i1",
            ),
        )
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1", snapshotId = snap))
        db.inventoryTerminalStateDao().upsert(InventoryTerminalStateEntity("i1", snap, "op-1", "2026-08-20", 4, null, 0, "t"))
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun engine(): InventorySyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, Json { ignoreUnknownKeys = true })).build()
        return InventorySyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(client) { server.url("/").toString() }, NetworkModule.strictJson(),
            CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), clock = { clock },
        )
    }

    private suspend fun event(n: Long, verdict: String = "expected", hash: String = n.toString().padStart(64, '0')): InventoryEventEntity {
        val e = InventoryEventEntity(
            eventId = "e$n", inventoryId = "i1", snapshotId = snap, deviceSequence = n, operatorId = "op-1", scannedAt = "2026-08-25T10:00:0$n.000Z",
            kind = "item", normalizedIdentity = "item:$hash", codeHash = hash, canonicalRaw = "010460000000001521S$n", activeProductionDate = "2026-08-20",
            localVerdict = verdict, claimedCount = 1, winnerEventId = null, winnerDeviceId = null, winnerScannedAt = null, serverStatus = null,
        )
        db.inventoryEventDao().insert(e)
        db.inventoryResultDao().insertIgnore(InventoryFixtures.result("i1", snap, hash, "e$n", "dev-1"))
        db.inventoryOutboxDao().insert(InventoryOutboxEntity(inventoryId = "i1", snapshotId = snap, eventId = "e$n", deviceSequence = n, payloadJson = InventoryBatchCodec.eventJson(e), createdAt = "t"))
        return e
    }

    private fun outcome(eventId: String, status: String, reason: String, claims: String = "[]", claimed: Int = 0, conflicts: Int = 0) =
        """{"eventId":"$eventId","status":"$status","reasonCode":"$reason","claimedCount":$claimed,"conflictCount":$conflicts,"claims":$claims}"""

    private fun response(request: String, outcomes: List<String>): String {
        val req = Json.parseToJsonElement(request).jsonObject
        return """{"inventoryId":"i1","snapshotId":"$snap","snapshotRevision":1,"batchId":"${req.getValue("batchId").jsonPrimitive.content}",""" +
            """"payloadDigest":"${req.getValue("payloadDigest").jsonPrimitive.content}","sequenceCeiling":${req.getValue("sequenceCeiling").jsonPrimitive.content},""" +
            """"resultRevision":7,"outcomes":[${outcomes.joinToString(",")}]}"""
    }

    private fun progress(items: String = "[]", cursor: String? = null, next: String? = null, revision: Int = 7) =
        MockResponse().setBody("""{"inventoryId":"i1","snapshotId":"$snap","snapshotRevision":1,"cursor":${cursor?.let { "\"$it\"" } ?: "null"},"resultRevision":$revision,"items":$items,"nextCursor":${next?.let { "\"$it\"" } ?: "null"}}""")

    /** MockWebServer cannot read the request before answering, so the first attempt fails and pins the batch; the answer is built from the pinned request. */
    private suspend fun answerPinned(engine: InventorySyncEngine, vararg outcomes: (String) -> String) {
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine.drainAll())
        val request = server.takeRequest().body.readUtf8()
        server.enqueue(MockResponse().setResponseCode(200).setBody(response(request, outcomes.map { it(request) })))
        server.enqueue(progress())
    }

    @Test
    fun postsADigestedBatchAndAcknowledgesIt() = runTest {
        event(1); event(2)
        val e = engine()
        answerPinned(e, { outcome("e1", "applied", "CLAIM_APPLIED", """[{"codeHash":"${"1".padStart(64, '0')}","status":"claimed","winner":{"codeHash":"${"1".padStart(64, '0')}","eventId":"e1","deviceId":"dev-1","scannedAt":"2026-08-25T10:00:01.000Z"}}]""", claimed = 1) }, { outcome("e2", "replay", "BATCH_REPLAY") })
        assertTrue(e.drainAll())
        val first = server.takeRequest()
        assertEquals("/station/inventories/i1/event-batches", first.path)
        val body = Json.parseToJsonElement(first.body.readUtf8()).jsonObject
        assertEquals(2, body.getValue("events").jsonArray.size)
        assertEquals("2", body.getValue("sequenceCeiling").jsonPrimitive.content)
        assertEquals("0", body.getValue("pendingEventCount").jsonPrimitive.content)
        assertEquals("0", body.getValue("openBoxCount").jsonPrimitive.content)
        assertEquals(InventoryBatchCodec.digest(InventoryBatchCodec.payloadJson(snap, 2, 0, body.getValue("events").jsonArray.map { it.toString() })), body.getValue("payloadDigest").jsonPrimitive.content)
        assertEquals("/station/inventories/i1/progress?limit=200", server.takeRequest().path)
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
        assertEquals("applied", db.inventoryEventDao().get("e1")?.serverStatus)
        assertNull(db.metaDao().get(MetaStore.inventoryPin("i1")))
        assertEquals(clock, e.state.value.lastSuccessAt)
    }

    @Test
    fun aLostClaimReplacesTheWinnerAndStopsCountingForThisDevice() = runTest {
        val hash = "1".padStart(64, '0')
        event(1)
        val e = engine()
        answerPinned(e, { outcome("e1", "duplicate", "CLAIM_LOST", """[{"codeHash":"$hash","status":"duplicate","winner":{"codeHash":"$hash","eventId":"x","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]""", conflicts = 1) })
        assertTrue(e.drainAll())
        val row = db.inventoryResultDao().get("i1", hash)
        assertEquals("dev-2", row?.winningDeviceId)
        assertEquals("server", row?.source)
        assertEquals(0, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
        assertEquals("duplicate", db.inventoryEventDao().get("e1")?.serverStatus)
    }

    @Test
    fun quarantineClosesTheTaskAndKeepsTheRest() = runTest {
        event(1); event(2)
        val e = engine()
        answerPinned(e, { outcome("e1", "quarantined", "INVENTORY_CLOSED") }, { outcome("e2", "quarantined", "INVENTORY_CLOSED") })
        assertTrue(e.drainAll())
        assertEquals("closed", db.inventoryTaskDao().get("i1")?.state)
        assertEquals("i1", e.state.value.closedInventoryId)
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
    }

    @Test
    fun aResponseForAnotherBatchIsNotAnAck() = runTest {
        event(1)
        val e = engine()
        server.enqueue(MockResponse().setResponseCode(200).setBody(response("""{"batchId":"other","payloadDigest":"${"0".repeat(64)}","sequenceCeiling":1}""", listOf(outcome("e1", "applied", "CLAIM_APPLIED")))))
        assertFalse(e.drainAll())
        assertEquals(1, db.inventoryOutboxDao().count("i1"))
        assertNotNull(db.metaDao().get(MetaStore.inventoryPin("i1")))
    }

    @Test
    fun progressPagesAddOtherTerminalsClaimsAndAdvanceTheCursor() = runTest {
        val hash = "9".padStart(64, '0')
        val e = engine()
        server.enqueue(
            progress(
                """[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","revision":5,"correctedAt":"2026-08-25T10:00:00.000Z","kind":"claim","codeHash":"$hash","classification":"expected","observedProductionDate":"2026-08-20","winner":{"codeHash":"$hash","eventId":"z","deviceId":"dev-2","scannedAt":"2026-08-25T09:00:00.000Z"}}]""",
                next = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
        )
        server.enqueue(
            progress(
                """[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","revision":6,"correctedAt":"2026-08-25T10:01:00.000Z","kind":"correction","codeHash":"$hash","classification":"voided","observedProductionDate":null,"winner":null}]""",
                cursor = "5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
        )
        assertTrue(e.drainAll())
        assertEquals("/station/inventories/i1/progress?limit=200", server.takeRequest().path)
        assertEquals("/station/inventories/i1/progress?cursor=5%3Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&limit=200", server.takeRequest().path)
        assertNull(db.inventoryResultDao().get("i1", hash))
        assertEquals(7L, db.inventoryTerminalStateDao().get("i1")?.progressResultRevision)
        assertEquals("5:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", db.inventoryTerminalStateDao().get("i1")?.progressCursor)
    }

    @Test
    fun aRevokedCredentialRaisesTheBus() = runTest {
        event(1)
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        assertFalse(engine().drainAll())
        assertTrue(bus.revoked.replayCache.isNotEmpty() || bus.revoked.subscriptionCount.value >= 0)
    }
}
```

Replace the last assertion with whatever `SyncEngineTest.aRevokedCredentialRaisesTheBusAndFails` already asserts (copy its Turbine-based check verbatim).

The progress test: after the second page (`cursor` = the first page's `nextCursor`, `nextCursor` null) the stored cursor must stay at the last non-null cursor — `page.nextCursor ?: requestedCursor` — hence the expected `"5:aaaa…"`.

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Batch envelope**

Add to `InventoryBatchCodec`:

```kotlin
    fun payloadJson(snapshotId: String, sequenceCeiling: Long, pendingEventCount: Int, events: List<String>): String = CanonicalJson.obj(
        "snapshotId" to CanonicalJson.str(snapshotId),
        "snapshotRevision" to CanonicalJson.num(1),
        "sequenceCeiling" to CanonicalJson.num(sequenceCeiling),
        "pendingEventCount" to CanonicalJson.num(pendingEventCount),
        "openBoxCount" to CanonicalJson.num(0),
        "events" to CanonicalJson.arr(events),
    )

    fun digest(payloadJson: String): String = CanonicalJson.sha256Hex(payloadJson)

    /** The request is the payload plus `batchId` and `payloadDigest`; the server's strict schema accepts any key order. */
    fun requestJson(batchId: String, payloadDigest: String, payloadJson: String): String =
        "{" + CanonicalJson.str("batchId") + ":" + CanonicalJson.str(batchId) + "," + CanonicalJson.str("payloadDigest") + ":" + CanonicalJson.str(payloadDigest) + "," + payloadJson.substring(1)
```

- [ ] **Step 4: Engine**

```kotlin
// core/inventory/InventorySyncEngine.kt
package app.markiro.handheld.core.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.network.EventBatchResponseDto
import app.markiro.handheld.core.network.ProgressPageDto
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryResultEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.Backoff
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.core.sync.TransportResult
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class InventorySyncState(
    val pending: Int = 0,
    val lastSuccessAt: Long? = null,
    val stuck: Boolean = false,
    /** Set when the server quarantined events because the cabinet closed the task. */
    val closedInventoryId: String? = null,
)

/**
 * Port of the station's inventory sync engine without its credential leases and receipts: one
 * drain at a time for the active task, a batch pinned in `meta` before the request and re-sent
 * byte for byte, the response guarded like `parseInventoryEventBatchResponse`, then the progress
 * feed of other terminals applied by cursor.
 */
class InventorySyncEngine(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val config: DeviceConfigDao,
    private val transport: SyncTransport,
    private val json: Json,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val heartbeatMs: Long = HEARTBEAT_MS,
    private val backoff: Backoff = Backoff(),
) {
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val drainMutex = Mutex()
    private val started = AtomicBoolean(false)
    private val startedAt = clock()
    private val lastSuccess = MutableStateFlow<Long?>(null)
    private val closed = MutableStateFlow<String?>(null)
    private val now = MutableStateFlow(clock())

    val state: StateFlow<InventorySyncState> =
        combine(db.inventoryOutboxDao().observeTotal(), lastSuccess, closed, now) { pending, last, closedId, at ->
            val since = last ?: startedAt
            InventorySyncState(pending, last, stuck = pending > 0 && at - since > STUCK_AFTER_MS, closedInventoryId = closedId)
        }.stateIn(scope, SharingStarted.Eagerly, InventorySyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.INVENTORY_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                now.value = clock()
                delayMs = if (drainAll()) {
                    backoff.reset()
                    heartbeatMs
                } else {
                    backoff.nextDelay()
                }
            }
        }
    }

    fun nudge() {
        nudges.trySend(Unit)
    }

    /** Batches for the active task, then its progress feed. False on the first failure. */
    suspend fun drainAll(): Boolean = drainMutex.withLock {
        val task = activeTask() ?: return true
        while (true) {
            when (drainOnce(task)) {
                Step.SENT -> continue
                Step.EMPTY -> break
                Step.FAILED -> return false
            }
        }
        pollProgress(task)
    }

    private suspend fun activeTask(): InventoryTaskEntity? =
        config.get()?.activeInventoryId?.let { db.inventoryTaskDao().get(it) }?.takeIf { it.state == "active" }

    internal enum class Step { SENT, EMPTY, FAILED }

    private class Pin(val batchId: String, val payloadDigest: String, val ceilingId: Long, val request: String)

    private fun pinJson(pin: Pin) = CanonicalJson.obj(
        "batchId" to CanonicalJson.str(pin.batchId), "payloadDigest" to CanonicalJson.str(pin.payloadDigest),
        "ceilingId" to CanonicalJson.num(pin.ceilingId), "request" to CanonicalJson.str(pin.request),
    )

    private fun parsePin(text: String): Pin? = runCatching {
        val o = json.parseToJsonElement(text).jsonObject
        Pin(o.getValue("batchId").jsonPrimitive.content, o.getValue("payloadDigest").jsonPrimitive.content, o.getValue("ceilingId").jsonPrimitive.content.toLong(), o.getValue("request").jsonPrimitive.content)
    }.getOrNull()

    internal suspend fun drainOnce(task: InventoryTaskEntity): Step {
        val id = task.inventoryId
        val pinned = meta.get(MetaStore.inventoryPin(id))?.let(::parsePin)
        val rows = if (pinned != null) db.inventoryOutboxDao().headThrough(id, pinned.ceilingId, BATCH_SIZE) else db.inventoryOutboxDao().head(id, BATCH_SIZE)
        if (rows.isEmpty()) {
            if (pinned != null) meta.remove(MetaStore.inventoryPin(id))
            return Step.EMPTY
        }
        val pin = pinned ?: run {
            val payload = InventoryBatchCodec.payloadJson(task.snapshotId, rows.last().deviceSequence, db.inventoryOutboxDao().countAfter(id, rows.last().id), rows.map { it.payloadJson })
            val digest = InventoryBatchCodec.digest(payload)
            val batchId = UUID.randomUUID().toString()
            Pin(batchId, digest, rows.last().id, InventoryBatchCodec.requestJson(batchId, digest, payload)).also { meta.put(MetaStore.inventoryPin(id), pinJson(it)) }
        }
        val result = transport.post("/station/inventories/$id/event-batches", pin.request) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val response = runCatching { json.decodeFromString(EventBatchResponseDto.serializer(), result.body) }.getOrNull() ?: return Step.FAILED
        if (!acknowledges(response, task, pin, rows.map { it.eventId })) return Step.FAILED
        val at = clock()
        var quarantined = false
        db.withTransaction {
            for (outcome in response.outcomes) {
                db.inventoryEventDao().setServerStatus(outcome.eventId, outcome.status)
                when (outcome.status) {
                    "duplicate" -> outcome.claims.filter { it.status == "duplicate" }.forEach { claim ->
                        val existing = db.inventoryResultDao().get(id, claim.codeHash)
                        db.inventoryResultDao().upsert(
                            InventoryResultEntity(
                                inventoryId = id, snapshotId = task.snapshotId, codeHash = claim.codeHash, firstAcceptedEventId = claim.winner.eventId,
                                winningDeviceId = claim.winner.deviceId, winningScannedAt = claim.winner.scannedAt,
                                observedProductionDate = existing?.observedProductionDate, classification = existing?.classification ?: "expected",
                                source = "server", updatedAt = Iso.format(at),
                            ),
                        )
                    }
                    "quarantined" -> quarantined = true
                }
            }
            db.inventoryOutboxDao().deleteIds(rows.map { it.id })
            db.metaDao().remove(MetaStore.inventoryPin(id))
            db.metaDao().put(MetaEntity(MetaStore.INVENTORY_LAST_SUCCESS_AT, at.toString()))
            if (quarantined) db.inventoryTaskDao().setState(id, "closed")
        }
        lastSuccess.value = at
        if (quarantined) closed.value = id
        return Step.SENT
    }

    /** Shape guard: the answer must be for this batch, one outcome per event, counts consistent. */
    private fun acknowledges(r: EventBatchResponseDto, task: InventoryTaskEntity, pin: Pin, eventIds: List<String>): Boolean {
        if (r.inventoryId != task.inventoryId || r.snapshotId != task.snapshotId || r.snapshotRevision != 1 || r.batchId != pin.batchId || r.payloadDigest != pin.payloadDigest) return false
        if (r.outcomes.size != eventIds.size || r.outcomes.map { it.eventId }.toSet() != eventIds.toSet()) return false
        return r.outcomes.all { o ->
            o.status in OUTCOMES && o.claimedCount == o.claims.count { it.status == "claimed" } && o.conflictCount == o.claims.count { it.status == "duplicate" }
        }
    }

    internal suspend fun pollProgress(task: InventoryTaskEntity): Boolean {
        val id = task.inventoryId
        var terminal = db.inventoryTerminalStateDao().get(id)
        if (terminal == null) {
            terminal = app.markiro.handheld.core.storage.InventoryTerminalStateEntity(id, task.snapshotId, null, task.productionDateFrom, 1, null, 0, Iso.format(clock()))
            db.inventoryTerminalStateDao().upsert(terminal)
        }
        var cursor = terminal.progressCursor
        var revision = terminal.progressResultRevision
        while (true) {
            val query = "?limit=$PROGRESS_PAGE" + (cursor?.let { "&cursor=" + URLEncoder.encode(it, "UTF-8") } ?: "")
            val path = if (cursor == null) "/station/inventories/$id/progress?limit=$PROGRESS_PAGE" else "/station/inventories/$id/progress?cursor=${URLEncoder.encode(cursor, "UTF-8")}&limit=$PROGRESS_PAGE"
            val result = transport.get(path) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val page = runCatching { json.decodeFromString(ProgressPageDto.serializer(), result.body) }.getOrNull() ?: return false
            if (page.inventoryId != id || page.snapshotId != task.snapshotId || page.cursor != cursor || page.resultRevision < revision || !ordered(page, cursor)) return false
            val next = page.nextCursor ?: cursor
            db.withTransaction {
                for (item in page.items) {
                    if (item.kind != "claim" && item.kind != "correction") continue
                    val hash = item.codeHash ?: continue
                    val winner = item.winner
                    if (winner == null || item.classification == "voided") {
                        db.inventoryResultDao().delete(id, hash)
                    } else {
                        db.inventoryResultDao().upsert(
                            InventoryResultEntity(
                                inventoryId = id, snapshotId = task.snapshotId, codeHash = hash, firstAcceptedEventId = winner.eventId,
                                winningDeviceId = winner.deviceId, winningScannedAt = winner.scannedAt, observedProductionDate = item.observedProductionDate,
                                classification = item.classification ?: "expected", source = "server", updatedAt = item.correctedAt,
                            ),
                        )
                    }
                }
                db.inventoryTerminalStateDao().setProgress(id, next, page.resultRevision)
            }
            revision = page.resultRevision
            if (page.nextCursor == null) return true
            cursor = page.nextCursor
        }
    }

    private fun ordered(page: ProgressPageDto, cursor: String?): Boolean {
        var prevRevision = cursor?.substringBefore(':')?.toLongOrNull() ?: -1L
        var prevId = cursor?.substringAfter(':') ?: ""
        for (item in page.items) {
            if (item.revision > page.resultRevision) return false
            if (item.revision < prevRevision || (item.revision == prevRevision && item.id <= prevId)) return false
            prevRevision = item.revision
            prevId = item.id
        }
        return true
    }

    companion object {
        const val BATCH_SIZE = 100
        const val PROGRESS_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 5 * 60 * 1000L
        private val OUTCOMES = setOf("applied", "replay", "duplicate", "rejected", "quarantined")
    }
}
```

Remove the unused `query` variable in `pollProgress` (keep the `path` expression). `URLEncoder.encode` turns `:` into `%3A`, which the test expects.

- [ ] **Step 5: Module and wiring**

```kotlin
// core/inventory/InventoryModule.kt
package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.Strict
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object InventoryModule {
    @Provides
    @Singleton
    fun inventoryRecorder(db: HandheldDatabase): InventoryRecorder = InventoryRecorder(db)

    @Provides
    @Singleton
    fun inventoryBundleMirror(db: HandheldDatabase, api: StationApi): InventoryBundleMirror = InventoryBundleMirror(db, api)

    @Provides
    @Singleton
    fun inventorySyncEngine(
        db: HandheldDatabase,
        meta: MetaStore,
        config: DeviceConfigDao,
        client: OkHttpClient,
        serverUrl: ServerUrlProvider,
        @Strict json: Json,
    ): InventorySyncEngine = InventorySyncEngine(
        db, meta, config, SyncTransport(client) { serverUrl.current() }, json, CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )
}
```

`ConnectivityNudger` takes a callback instead of the engine:

```kotlin
class ConnectivityNudger(private val context: Context, private val onAvailable: () -> Unit) {
    fun register() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = onAvailable()
            })
        }
    }
}
```

`SyncModule.connectivityNudger(context, engine: SyncEngine, inventory: InventorySyncEngine) = ConnectivityNudger(context) { engine.nudge(); inventory.nudge() }`. `HandheldApp`: inject `InventorySyncEngine` and call `inventorySync.start()` after `syncEngine.start()`.

- [ ] **Step 6: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.core.inventory.*" -q` and then the whole suite `./gradlew testDebugUnitTest -q` → PASS.

- [ ] **Step 7: Commit** `feat(handheld): inventory sync engine — digested batches, outcomes, quarantine and the progress feed`

---

### Task 9: Strings for the whole slice (ru + en)

**Files:**

- Modify: `app/src/main/res/values/strings.xml`, `app/src/main/res/values-en/strings.xml`

**Interfaces:**

- Produces: every `R.string.inventory_*` / `R.plurals.inventory_*` key used by Tasks 10–12.

- [ ] **Step 1: Add the Russian strings** (append before `</resources>`):

```xml
    <!-- Inventory (check) -->
    <string name="inventory_title">Инвентаризация</string>
    <string name="inventory_my_line">Моя линия</string>
    <string name="inventory_other_lines">Другие линии</string>
    <string name="inventory_show_other">Показать другие линии</string>
    <string name="inventory_loading">Загружаем задания…</string>
    <string name="inventory_empty_title">Заданий нет</string>
    <string name="inventory_empty_text">Запустите инвентаризацию в кабинете.</string>
    <string name="inventory_mode_check">без переупаковки</string>
    <string name="inventory_mode_repack">с переупаковкой</string>
    <string name="inventory_repack_later">с переупаковкой: в следующем срезе</string>
    <string name="inventory_dates">%1$s – %2$s</string>
    <string name="inventory_continue">продолжить</string>
    <string name="inventory_needs_network">нужна сеть для первого входа</string>
    <string name="inventory_join_other_title">Задание назначено другой линии</string>
    <string name="inventory_join_other_this">Этот ТСД · %1$s</string>
    <string name="inventory_join_other_task">Задание · %1$s</string>
    <string name="inventory_join_other_text">После подтверждения сканы этого ТСД попадут в эту инвентаризацию и будут отмечены как выполненные терминалом другой линии.</string>
    <string name="inventory_join_other_confirm">Подключиться к %1$s</string>
    <string name="inventory_joining">Подключаемся к заданию…</string>
    <string name="inventory_download_title">Загружаем снимок %1$s</string>
    <string name="inventory_download_progress">%1$s из %2$s</string>
    <string name="inventory_download_failed">Снимок не загрузился</string>
    <string name="inventory_download_invalid">Снимок повреждён: %1$s. Попробуйте ещё раз или перезапустите задание в кабинете.</string>
    <string name="inventory_not_running">Задание уже не выполняется</string>
    <string name="inventory_operator_unavailable">Оператор не может участвовать: проверьте учётную запись в кабинете</string>
    <string name="inventory_line_required">У ТСД нет линии: назначьте её в кабинете</string>
    <string name="inventory_barcode_unknown">Штрихкод задания не распознан</string>
    <string name="inventory_snapshot_needs_network">Нужна сеть, чтобы загрузить снимок</string>
    <string name="inventory_active_date">Дата %1$s</string>
    <string name="inventory_change_date">Сменить дату</string>
    <string name="inventory_date_title">Сменить дату производства</string>
    <string name="inventory_date_apply">Применить дату</string>
    <string name="inventory_leave">Выйти из задания</string>
    <string name="inventory_verified">Проверено</string>
    <string name="inventory_of">%1$s / %2$s</string>
    <string name="inventory_this_terminal">Этот ТСД</string>
    <string name="inventory_discrepancies">Расхождения</string>
    <string name="inventory_protected_count">Защищено %1$d</string>
    <string name="inventory_rejected_count">Отклонено сервером %1$d</string>
    <string name="inventory_waiting">Ожидание скана…</string>
    <string name="inventory_feed_empty">Сканов пока нет</string>
    <string name="inventory_verdict_expected">ПРИНЯТО</string>
    <string name="inventory_verdict_box">КОРОБ</string>
    <string name="inventory_box_counted">принято кодов: %1$d из %2$d</string>
    <string name="inventory_verdict_duplicate">ДУБЛЬ</string>
    <string name="inventory_duplicate_here">на этом ТСД в %1$s</string>
    <string name="inventory_duplicate_other">на другом терминале в %1$s</string>
    <string name="inventory_verdict_protected">ЗАЩИЩЁН</string>
    <string name="inventory_protected_text">уже в отгрузке</string>
    <string name="inventory_verdict_ineligible">НЕ УЧАСТВУЕТ</string>
    <string name="inventory_ineligible_text">статус: %1$s</string>
    <string name="inventory_verdict_unknown">РАСХОЖДЕНИЕ</string>
    <string name="inventory_unknown_text">нет в снимке</string>
    <string name="inventory_verdict_invalid">НЕВЕРНЫЙ КОД</string>
    <string name="inventory_invalid_wrong_gtin">чужой ГТИН</string>
    <string name="inventory_invalid_unsupported">это штрихкод товара, не код маркировки</string>
    <string name="inventory_status_emitted">Эмитирован</string>
    <string name="inventory_status_introduced">В обороте</string>
    <string name="inventory_status_applied">Нанесён</string>
    <string name="inventory_status_retired">Выведен из оборота</string>
    <string name="inventory_status_written_off">Списан</string>
    <string name="inventory_status_disaggregation">Расформирован</string>
    <string name="inventory_mismatch_title">Дата в коде отличается от активной</string>
    <string name="inventory_mismatch_code">В коде %1$s</string>
    <string name="inventory_mismatch_active">Активная %1$s</string>
    <string name="inventory_mismatch_apply">Установить %1$s и зачесть</string>
    <string name="inventory_mismatch_accept">Зачесть как есть</string>
    <string name="inventory_mismatch_skip">Пропустить код</string>
    <string name="inventory_mixed_title">В коробе несколько дат розлива</string>
    <string name="inventory_mixed_text">Подставить одну дату нельзя: зачтите как есть или пропустите короб.</string>
    <string name="inventory_closed_title">Задание закрыто в кабинете</string>
    <string name="inventory_closed_text">Сканы, не успевшие отправиться, остаются на ТСД как поздние события.</string>
    <string name="inventory_leave_draining">Отправляем сканы…</string>
    <string name="inventory_leave_draining_left">осталось %1$d</string>
    <string name="inventory_leave_offline_title">Нет сети</string>
    <string name="inventory_leave_offline_text">Выход после отправки %1$d сканов. Вернитесь в хаб и повторите, когда появится сеть.</string>
    <string name="inventory_leave_failed">Не удалось выйти из задания</string>
    <string name="inventory_left_title">Вы вышли из задания</string>
    <string name="inventory_left_text">Инвентаризацию закроет кабинет.</string>
    <string name="inventory_to_hub">В хаб</string>
    <string name="hub_inventory_continue">продолжить %1$s</string>
    <plurals name="inventory_events_queued">
        <item quantity="one">%d событие в очереди</item>
        <item quantity="few">%d события в очереди</item>
        <item quantity="many">%d событий в очереди</item>
        <item quantity="other">%d событий в очереди</item>
    </plurals>
```

- [ ] **Step 2: Add the English mirror** to `values-en/strings.xml`:

```xml
    <!-- Inventory (check) -->
    <string name="inventory_title">Inventory</string>
    <string name="inventory_my_line">My line</string>
    <string name="inventory_other_lines">Other lines</string>
    <string name="inventory_show_other">Show other lines</string>
    <string name="inventory_loading">Loading tasks…</string>
    <string name="inventory_empty_title">No tasks</string>
    <string name="inventory_empty_text">Start an inventory in the cabinet.</string>
    <string name="inventory_mode_check">check only</string>
    <string name="inventory_mode_repack">with repacking</string>
    <string name="inventory_repack_later">with repacking: next slice</string>
    <string name="inventory_dates">%1$s – %2$s</string>
    <string name="inventory_continue">continue</string>
    <string name="inventory_needs_network">network needed for the first join</string>
    <string name="inventory_join_other_title">Task assigned to another line</string>
    <string name="inventory_join_other_this">This handheld · %1$s</string>
    <string name="inventory_join_other_task">Task · %1$s</string>
    <string name="inventory_join_other_text">After confirmation this handheld\'s scans go into this inventory and are marked as done by a terminal of another line.</string>
    <string name="inventory_join_other_confirm">Join %1$s</string>
    <string name="inventory_joining">Joining the task…</string>
    <string name="inventory_download_title">Downloading snapshot %1$s</string>
    <string name="inventory_download_progress">%1$s of %2$s</string>
    <string name="inventory_download_failed">Snapshot download failed</string>
    <string name="inventory_download_invalid">Snapshot is corrupt: %1$s. Try again or restart the task in the cabinet.</string>
    <string name="inventory_not_running">The task is no longer running</string>
    <string name="inventory_operator_unavailable">This operator cannot take part: check the account in the cabinet</string>
    <string name="inventory_line_required">The handheld has no line: assign one in the cabinet</string>
    <string name="inventory_barcode_unknown">Task barcode not recognised</string>
    <string name="inventory_snapshot_needs_network">Network needed to download the snapshot</string>
    <string name="inventory_active_date">Date %1$s</string>
    <string name="inventory_change_date">Change date</string>
    <string name="inventory_date_title">Change production date</string>
    <string name="inventory_date_apply">Apply date</string>
    <string name="inventory_leave">Leave the task</string>
    <string name="inventory_verified">Verified</string>
    <string name="inventory_of">%1$s / %2$s</string>
    <string name="inventory_this_terminal">This handheld</string>
    <string name="inventory_discrepancies">Discrepancies</string>
    <string name="inventory_protected_count">Protected %1$d</string>
    <string name="inventory_rejected_count">Rejected by server %1$d</string>
    <string name="inventory_waiting">Waiting for a scan…</string>
    <string name="inventory_feed_empty">No scans yet</string>
    <string name="inventory_verdict_expected">ACCEPTED</string>
    <string name="inventory_verdict_box">BOX</string>
    <string name="inventory_box_counted">codes counted: %1$d of %2$d</string>
    <string name="inventory_verdict_duplicate">DUPLICATE</string>
    <string name="inventory_duplicate_here">on this handheld at %1$s</string>
    <string name="inventory_duplicate_other">on another terminal at %1$s</string>
    <string name="inventory_verdict_protected">PROTECTED</string>
    <string name="inventory_protected_text">already being shipped</string>
    <string name="inventory_verdict_ineligible">NOT IN TASK</string>
    <string name="inventory_ineligible_text">status: %1$s</string>
    <string name="inventory_verdict_unknown">DISCREPANCY</string>
    <string name="inventory_unknown_text">missing from the snapshot</string>
    <string name="inventory_verdict_invalid">INVALID CODE</string>
    <string name="inventory_invalid_wrong_gtin">another GTIN</string>
    <string name="inventory_invalid_unsupported">a product barcode, not a marking code</string>
    <string name="inventory_status_emitted">Emitted</string>
    <string name="inventory_status_introduced">In circulation</string>
    <string name="inventory_status_applied">Applied</string>
    <string name="inventory_status_retired">Retired</string>
    <string name="inventory_status_written_off">Written off</string>
    <string name="inventory_status_disaggregation">Disaggregated</string>
    <string name="inventory_mismatch_title">The code\'s date differs from the active date</string>
    <string name="inventory_mismatch_code">In code %1$s</string>
    <string name="inventory_mismatch_active">Active %1$s</string>
    <string name="inventory_mismatch_apply">Set %1$s and count</string>
    <string name="inventory_mismatch_accept">Count as is</string>
    <string name="inventory_mismatch_skip">Skip the code</string>
    <string name="inventory_mixed_title">The box holds several bottling dates</string>
    <string name="inventory_mixed_text">A single date cannot be applied: count as is or skip the box.</string>
    <string name="inventory_closed_title">Task closed in the cabinet</string>
    <string name="inventory_closed_text">Scans that did not reach the server stay on the handheld as late events.</string>
    <string name="inventory_leave_draining">Sending scans…</string>
    <string name="inventory_leave_draining_left">%1$d left</string>
    <string name="inventory_leave_offline_title">No network</string>
    <string name="inventory_leave_offline_text">Leaving after %1$d scans are sent. Return to the hub and try again once online.</string>
    <string name="inventory_leave_failed">Could not leave the task</string>
    <string name="inventory_left_title">You left the task</string>
    <string name="inventory_left_text">The cabinet closes the inventory.</string>
    <string name="inventory_to_hub">To the hub</string>
    <string name="hub_inventory_continue">continue %1$s</string>
    <plurals name="inventory_events_queued">
        <item quantity="one">%d event queued</item>
        <item quantity="other">%d events queued</item>
    </plurals>
```

- [ ] **Step 3: Lint** `./gradlew lintDebug -q` → 0 errors (a key present in one file only fails lint).

- [ ] **Step 4: Commit** `feat(handheld): Russian and English strings for the inventory check screens`

---

### Task 10: Repository, task list and download

**Files:**

- Create: `feature/inventory/InventoryRepository.kt`, `feature/inventory/InventoryListViewModel.kt`, `feature/inventory/InventoryListScreen.kt`, `feature/inventory/InventoryFeatureModule.kt`
- Test: `feature/inventory/InventoryRepositoryTest.kt`, `feature/inventory/InventoryListViewModelTest.kt`, `feature/inventory/InventoryListScreenTest.kt`

**Interfaces:**

- Produces: `InventoryRepository` (`observeTasks`, `listTasks(scope)`, `resolveBarcode`, `join(task, operatorId, confirmDifferentLine, barcode): JoinResult`, `manifest(id)`, `download(manifest, onProgress): MirrorResult`, `activate(id)`, `leave(id): LeaveResult`, `queued(id)`); `JoinResult`, `LeaveResult`; `InventoryListUi`, `InventoryDialog`, `InventoryListEvent.Entered(id)`, `InventoryListViewModel`, `InventoryListScreen(state, cb)`, `InventoryListCallbacks`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// feature/inventory/InventoryRepositoryTest.kt
package app.markiro.handheld.feature.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class InventoryRepositoryTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private val task = InventoryTaskDto("i1", "INV-0007", "Вода 0,5 л", "Вода", "check", "l3", "Линия 3", "2026-08-01", "2026-08-31")

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun repo() = InventoryRepository(api, db, InventoryBundleMirror(db, api), NetworkModule.json()) { 5L }

    @Test
    fun joinSendsConfirmationForAnotherLineAndMapsServerCodes() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED"}"""))
        assertEquals(JoinResult.ConfirmationRequired, repo().join(task, "op-1", confirmDifferentLine = false, barcode = null))
        server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_NOT_RUNNING"}"""))
        assertEquals(JoinResult.NotRunning, repo().join(task, "op-1", confirmDifferentLine = true, barcode = null))
        assertEquals("""{"operatorId":"op-1","confirmDifferentLine":true}""", server.takeRequest().body.readUtf8())
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_OPERATOR_UNAVAILABLE"}"""))
        assertEquals(JoinResult.OperatorUnavailable, repo().join(task, "op-1", true, null))
        server.shutdown()
        assertEquals(JoinResult.Unavailable, repo().join(task, "op-1", true, null))
    }

    @Test
    fun activateAndLeaveMoveTheActiveTaskPointer() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        repo().activate("i1")
        assertEquals("i1", db.deviceConfigDao().get()?.activeInventoryId)
        db.inventoryOutboxDao().insert(InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e1", deviceSequence = 1, payloadJson = "{}", createdAt = "t"))
        assertEquals(LeaveResult.Pending(1), repo().leave("i1"))
        db.inventoryOutboxDao().deleteIds(db.inventoryOutboxDao().head("i1", 1).map { it.id })
        server.enqueue(MockResponse().setBody("""{"outcome":"left"}"""))
        assertEquals(LeaveResult.Left, repo().leave("i1"))
        assertEquals("""{"pendingEventCount":0,"openBoxCount":0}""", server.takeRequest().body.readUtf8())
        assertNull(db.deviceConfigDao().get()?.activeInventoryId)
        assertEquals(5L, db.inventoryTaskDao().get("i1")?.leftAt)
        server.shutdown()
        assertEquals(LeaveResult.Offline, repo().leave("i1"))
    }

    @Test
    fun listAndResolvePassThrough() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(repo().listTasks("all").isEmpty())
        assertEquals("/station/inventory-tasks?scope=all", server.takeRequest().path)
        server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
        assertNull(repo().resolveBarcode("markiro:inventory:v1:nope"))
    }
}
```

```kotlin
// feature/inventory/InventoryListViewModelTest.kt
package app.markiro.handheld.feature.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val reachability = ReachabilityTracker { 1_000_000L }
    private val own = InventoryTaskDto("i1", "INV-0007", "Вода 0,5 л", "Вода", "check", "l1", "Линия 2", "2026-08-01", "2026-08-31")
    private val other = InventoryTaskDto("i2", "INV-0008", "Сок", null, "check", "l3", "Линия 3", "2026-08-01", "2026-08-31")
    private val repack = InventoryTaskDto("i3", "INV-0009", "Сок", null, "repack", "l1", "Линия 2", "2026-08-01", "2026-08-31")

    /** Fake gateway: the view model only needs the repository's public surface. */
    private inner class FakeRepo(private val joinResult: JoinResult = JoinResult.Ok(manifest("i1")), var mirror: MirrorResult = MirrorResult.Active) : InventoryGateway {
        val joins = mutableListOf<Triple<String, Boolean, String?>>()
        override fun observeTasks() = db.inventoryTaskDao().observeAll()
        override suspend fun listTasks(scope: String?) = if (scope == "all") listOf(own, other, repack) else listOf(own, repack)
        override suspend fun resolveBarcode(barcode: String) = if (barcode.endsWith("i2")) ResolvedTask(other, requiresConfirmation = true) else null
        override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult {
            joins += Triple(task.inventoryId, confirmDifferentLine, barcode)
            return joinResult
        }
        override suspend fun manifest(inventoryId: String) = manifest(inventoryId)
        override suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult { onProgress(2, 4); return mirror }
        override suspend fun activate(inventoryId: String) { db.inventoryTaskDao().upsert(InventoryFixtures.task(inventoryId)); db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeInventoryId = inventoryId)) } }
        override suspend fun leave(inventoryId: String): LeaveResult = LeaveResult.Left
        override suspend fun queued(inventoryId: String) = 0
    }

    private fun manifest(id: String) = InventoryManifestDto(
        inventoryId = id, inventoryNumber = "INV-0007", snapshotId = "snap", snapshotRevision = 1, snapshotFixedAt = "t", combinedDigest = "a".repeat(64),
        contentDigest = "b".repeat(64), codeCount = 4, productId = "p1", productName = "Вода 0,5 л", productPrintName = "Вода", gtin14 = "04600000000015",
        boxCapacity = 12, mode = "check", lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01", productionDateTo = "2026-08-31",
        limits = app.markiro.handheld.core.network.BundleLimitsDto(200, 100, 200),
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L))
        reachability.markSuccess()
    }

    @After
    fun tearDown() = db.close()

    private fun vm(repo: FakeRepo = FakeRepo()) = InventoryListViewModel(repo, db.deviceConfigDao(), session, reachability, ScanRouterAdapter(scans))

    @Test
    fun listsOwnLineThenOthersOnRequest() = runTest {
        val vm = vm()
        val ui = vm.state.first { !it.loading }
        assertEquals(listOf("i1", "i3"), ui.mine.map { it.inventoryId })
        vm.expandOthers()
        val expanded = vm.state.first { it.othersExpanded && !it.othersLoading }
        assertEquals(mapOf("Линия 3" to listOf("i2")), expanded.others.mapValues { e -> e.value.map { it.inventoryId } })
    }

    @Test
    fun joiningOwnTaskDownloadsActivatesAndEmitsEntered() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.events.test {
            vm.select(own)
            assertEquals(InventoryListEvent.Entered("i1"), awaitItem())
        }
        assertEquals(listOf(Triple("i1", false, null)), repo.joins)
        assertEquals("i1", db.deviceConfigDao().get()?.activeInventoryId)
    }

    @Test
    fun anotherLineAsksForConfirmationAndRepackIsIgnored() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.select(repack)
        advanceUntilIdle()
        assertTrue(repo.joins.isEmpty())
        vm.select(other)
        assertTrue(vm.state.value.dialog is InventoryDialog.ConfirmOther)
        vm.events.test {
            vm.confirmOther()
            assertEquals(InventoryListEvent.Entered("i2"), awaitItem())
        }
        assertEquals(Triple("i2", true, null), repo.joins.single())
    }

    @Test
    fun aTaskBarcodeResolvesAndJoinsWithTheBarcode() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        scans.tryEmit(ScanEvent("markiro:inventory:v1:i2", null, "debug", 0))
        advanceUntilIdle()
        assertTrue(vm.state.value.dialog is InventoryDialog.ConfirmOther)
        vm.confirmOther()
        advanceUntilIdle()
        assertEquals(Triple("i2", true, "markiro:inventory:v1:i2"), repo.joins.single())
    }

    @Test
    fun anInvalidSnapshotShowsTheReasonAndDoesNotActivate() = runTest {
        val repo = FakeRepo(mirror = MirrorResult.Invalid("content digest"))
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.select(own)
        val ui = vm.state.first { it.dialog is InventoryDialog.Error }
        assertEquals(InventoryError.INVALID_SNAPSHOT, (ui.dialog as InventoryDialog.Error).kind)
        assertEquals(null, db.deviceConfigDao().get()?.activeInventoryId)
    }
}
```

```kotlin
// feature/inventory/InventoryListScreenTest.kt
package app.markiro.handheld.feature.inventory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryListScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val check = InventoryTaskDto("i2", "INV-0008", "Сок", null, "check", "l1", "Линия 2", "2026-08-01", "2026-08-31")
    private val repack = InventoryTaskDto("i3", "INV-0009", "Сок", null, "repack", "l1", "Линия 2", "2026-08-01", "2026-08-31")

    @Test
    fun showsContinueMineAndDisabledRepack() {
        var selected: String? = null
        var continued = false
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(loading = false, active = InventoryFixtures.task("i1"), mine = listOf(check, repack), others = emptyMap(), othersExpanded = false, othersLoading = false, reachable = true, ownLineName = "Линия 2", listFetchedAt = 0L, dialog = null),
                    InventoryListCallbacks(onContinue = { continued = true }, onSelect = { selected = it.inventoryId }),
                )
            }
        }
        compose.onNodeWithText("INV-0007").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").performClick()
        assertEquals(true, continued)
        compose.onNodeWithText("INV-0008").performClick()
        assertEquals("i2", selected)
        compose.onNodeWithText("с переупаковкой: в следующем срезе").assertIsDisplayed()
        compose.onNode(hasText("INV-0009")).assertIsNotEnabled()
    }

    @Test
    fun downloadDialogShowsProgress() {
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(false, null, emptyList(), emptyMap(), false, false, true, "Линия 2", 0L, InventoryDialog.Downloading("INV-0008", 12400, 41160)),
                    InventoryListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Загружаем снимок INV-0008").assertIsDisplayed()
        compose.onNodeWithText("12 400 из 41 160").assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Repository**

```kotlin
// feature/inventory/InventoryRepository.kt
package app.markiro.handheld.feature.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.JoinInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryRequest
import app.markiro.handheld.core.network.ResolveTaskRequest
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryTaskEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

sealed interface JoinResult {
    data class Ok(val manifest: InventoryManifestDto) : JoinResult
    data object NotRunning : JoinResult
    data object OperatorUnavailable : JoinResult
    data object LineRequired : JoinResult
    data object ConfirmationRequired : JoinResult
    data object Unavailable : JoinResult
}

sealed interface LeaveResult {
    data object Left : LeaveResult
    data class Pending(val queued: Int) : LeaveResult
    data object Offline : LeaveResult
    data object Failed : LeaveResult
}

data class ResolvedTask(val task: InventoryTaskDto, val requiresConfirmation: Boolean)

/** What the screens need; the repository implements it and tests fake it. */
interface InventoryGateway {
    fun observeTasks(): Flow<List<InventoryTaskEntity>>
    suspend fun listTasks(scope: String?): List<InventoryTaskDto>
    /** Null when the barcode is not a task barcode (404). */
    suspend fun resolveBarcode(barcode: String): ResolvedTask?
    suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult
    suspend fun manifest(inventoryId: String): InventoryManifestDto
    suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (staged: Int, total: Int) -> Unit): MirrorResult
    suspend fun activate(inventoryId: String)
    suspend fun leave(inventoryId: String): LeaveResult
    suspend fun queued(inventoryId: String): Int
}

class InventoryRepository(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val mirror: InventoryBundleMirror,
    private val json: Json,
    private val clock: () -> Long = System::currentTimeMillis,
) : InventoryGateway {
    override fun observeTasks(): Flow<List<InventoryTaskEntity>> = db.inventoryTaskDao().observeAll()

    override suspend fun listTasks(scope: String?): List<InventoryTaskDto> = api.inventoryTasks(scope).items

    override suspend fun resolveBarcode(barcode: String): ResolvedTask? = try {
        val r = api.resolveInventoryBarcode(ResolveTaskRequest(barcode))
        ResolvedTask(r.task, r.requiresDifferentLineConfirmation)
    } catch (e: HttpException) {
        if (e.code() == 404) null else throw e
    }

    override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult = try {
        JoinResult.Ok(api.joinInventory(task.inventoryId, JoinInventoryRequest(operatorId, barcode, confirmDifferentLine.takeIf { it })))
    } catch (e: HttpException) {
        when (errorCode(e)) {
            "INVENTORY_NOT_RUNNING" -> JoinResult.NotRunning
            "INVENTORY_OPERATOR_UNAVAILABLE" -> JoinResult.OperatorUnavailable
            "INVENTORY_DEVICE_LINE_REQUIRED" -> JoinResult.LineRequired
            "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED", "INVENTORY_TASK_BARCODE_REQUIRED" -> JoinResult.ConfirmationRequired
            else -> if (e.code() == 404) JoinResult.NotRunning else JoinResult.Unavailable
        }
    } catch (_: IOException) {
        JoinResult.Unavailable
    }

    override suspend fun manifest(inventoryId: String): InventoryManifestDto = api.inventoryManifest(inventoryId)

    override suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult = mirror.mirror(manifest, onProgress)

    override suspend fun activate(inventoryId: String) {
        val now = clock()
        db.withTransaction {
            db.inventoryTaskDao().setJoinedAt(inventoryId, now)
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeInventoryId = inventoryId)) }
        }
    }

    /** The server refuses a leave with queued events; the caller drains first. */
    override suspend fun leave(inventoryId: String): LeaveResult {
        val queued = db.inventoryOutboxDao().count(inventoryId)
        if (queued > 0) return LeaveResult.Pending(queued)
        return try {
            val response = api.leaveInventory(inventoryId, LeaveInventoryRequest(0, 0))
            if (response.outcome != "left") return LeaveResult.Failed
            val now = clock()
            db.withTransaction {
                db.inventoryTaskDao().setLeftAt(inventoryId, now)
                db.deviceConfigDao().get()?.let { if (it.activeInventoryId == inventoryId) db.deviceConfigDao().upsert(it.copy(activeInventoryId = null)) }
            }
            LeaveResult.Left
        } catch (_: IOException) {
            LeaveResult.Offline
        } catch (_: HttpException) {
            LeaveResult.Failed
        }
    }

    override suspend fun queued(inventoryId: String): Int = db.inventoryOutboxDao().count(inventoryId)

    private fun errorCode(e: HttpException): String? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code }.getOrNull()
}
```

```kotlin
// feature/inventory/InventoryFeatureModule.kt
package app.markiro.handheld.feature.inventory

import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object InventoryFeatureModule {
    @Provides
    @Singleton
    fun inventoryGateway(api: StationApi, db: HandheldDatabase, mirror: InventoryBundleMirror, json: Json): InventoryGateway =
        InventoryRepository(api, db, mirror, json)
}
```

- [ ] **Step 4: View model**

```kotlin
// feature/inventory/InventoryListViewModel.kt
package app.markiro.handheld.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class InventoryError { NOT_RUNNING, OPERATOR_UNAVAILABLE, LINE_REQUIRED, BARCODE_UNKNOWN, NEEDS_NETWORK, DOWNLOAD_FAILED, INVALID_SNAPSHOT, REPACK }

sealed interface InventoryDialog {
    data class ConfirmOther(val task: InventoryTaskDto, val barcode: String?) : InventoryDialog
    data object Joining : InventoryDialog
    data class Downloading(val number: String, val staged: Int, val total: Int) : InventoryDialog
    data class Error(val kind: InventoryError, val detail: String? = null, val retry: InventoryTaskDto? = null) : InventoryDialog
}

data class InventoryListUi(
    val loading: Boolean,
    val active: InventoryTaskEntity?,
    val mine: List<InventoryTaskDto>,
    /** Line name → tasks of other lines, filled by «Показать другие линии». */
    val others: Map<String, List<InventoryTaskDto>>,
    val othersExpanded: Boolean,
    val othersLoading: Boolean,
    val reachable: Boolean,
    val ownLineName: String?,
    val listFetchedAt: Long?,
    val dialog: InventoryDialog?,
)

sealed interface InventoryListEvent {
    data class Entered(val inventoryId: String) : InventoryListEvent
}

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L

@HiltViewModel
class InventoryListViewModel @Inject constructor(
    private val repository: InventoryGateway,
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    scans: ScanEvents,
) : ViewModel() {
    private val now: () -> Long = System::currentTimeMillis
    private val loading = MutableStateFlow(true)
    private val mine = MutableStateFlow<List<InventoryTaskDto>>(emptyList())
    private val others = MutableStateFlow<Map<String, List<InventoryTaskDto>>>(emptyMap())
    private val othersExpanded = MutableStateFlow(false)
    private val othersLoading = MutableStateFlow(false)
    private val fetchedAt = MutableStateFlow<Long?>(null)
    private val dialog = MutableStateFlow<InventoryDialog?>(null)
    private val _events = MutableSharedFlow<InventoryListEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<InventoryListEvent> = _events

    private data class Base(val active: InventoryTaskEntity?, val ownLineName: String?, val ownLineId: String?, val reachable: Boolean)

    private val base = combine(repository.observeTasks(), config.observe(), reachability.lastSuccessAt) { tasks, cfg, lastOk ->
        val active = cfg?.activeInventoryId?.let { id -> tasks.firstOrNull { it.inventoryId == id && it.state == "active" } }
        Base(active, cfg?.lineName, cfg?.lineId, lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS)
    }

    val state: StateFlow<InventoryListUi> = combine(base, loading, mine, others, othersExpanded, othersLoading, fetchedAt, dialog) { v ->
        val b = v[0] as Base
        @Suppress("UNCHECKED_CAST")
        InventoryListUi(
            loading = v[1] as Boolean,
            active = b.active,
            mine = (v[2] as List<InventoryTaskDto>).filter { it.inventoryId != b.active?.inventoryId },
            others = v[3] as Map<String, List<InventoryTaskDto>>,
            othersExpanded = v[4] as Boolean,
            othersLoading = v[5] as Boolean,
            reachable = b.reachable,
            ownLineName = b.ownLineName,
            listFetchedAt = v[6] as Long?,
            dialog = v[7] as InventoryDialog?,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, InventoryListUi(true, null, emptyList(), emptyMap(), false, false, false, null, null, null))

    private var ownLineId: String? = null

    init {
        viewModelScope.launch { config.observe().collect { ownLineId = it?.lineId } }
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            loading.value = true
            runCatching { repository.listTasks(null) }.onSuccess { mine.value = it; fetchedAt.value = now() }
            loading.value = false
        }
    }

    fun expandOthers() {
        if (othersExpanded.value) return
        othersExpanded.value = true
        viewModelScope.launch {
            othersLoading.value = true
            val all = runCatching { repository.listTasks("all") }.getOrDefault(emptyList())
            val own = ownLineId
            others.value = all.filter { it.lineId != own }.groupBy { it.lineName }
            othersLoading.value = false
        }
    }

    fun continueActive() {
        val active = state.value.active ?: return
        viewModelScope.launch {
            repository.activate(active.inventoryId)
            _events.emit(InventoryListEvent.Entered(active.inventoryId))
        }
    }

    fun select(task: InventoryTaskDto) {
        if (task.mode != "check") return
        if (task.lineId != ownLineId) {
            dialog.value = InventoryDialog.ConfirmOther(task, null)
            return
        }
        join(task, confirm = false, barcode = null)
    }

    fun confirmOther() {
        val d = dialog.value as? InventoryDialog.ConfirmOther ?: return
        join(d.task, confirm = true, barcode = d.barcode)
    }

    fun dismissDialog() {
        dialog.value = null
    }

    fun retry() {
        val d = dialog.value as? InventoryDialog.Error ?: return
        val task = d.retry ?: return dismissDialog()
        join(task, confirm = task.lineId != ownLineId, barcode = null)
    }

    private suspend fun onScan(raw: String) {
        if (dialog.value != null) return
        val resolved = runCatching { repository.resolveBarcode(raw.trim()) }.getOrNull()
        if (resolved == null) {
            dialog.value = InventoryDialog.Error(InventoryError.BARCODE_UNKNOWN)
            return
        }
        if (resolved.task.mode != "check") {
            dialog.value = InventoryDialog.Error(InventoryError.REPACK)
            return
        }
        if (resolved.requiresConfirmation) dialog.value = InventoryDialog.ConfirmOther(resolved.task, raw.trim()) else join(resolved.task, false, raw.trim())
    }

    private fun join(task: InventoryTaskDto, confirm: Boolean, barcode: String?) {
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            val cached = state.value.active?.takeIf { it.inventoryId == task.inventoryId }
            if (!state.value.reachable && cached != null) {
                repository.activate(task.inventoryId)
                _events.emit(InventoryListEvent.Entered(task.inventoryId))
                return@launch
            }
            dialog.value = InventoryDialog.Joining
            val manifest = when (val joined = repository.join(task, operatorId, confirm, barcode)) {
                is JoinResult.Ok -> joined.manifest
                JoinResult.NotRunning -> return@launch fail(InventoryError.NOT_RUNNING)
                JoinResult.OperatorUnavailable -> return@launch fail(InventoryError.OPERATOR_UNAVAILABLE)
                JoinResult.LineRequired -> return@launch fail(InventoryError.LINE_REQUIRED)
                JoinResult.ConfirmationRequired -> { dialog.value = InventoryDialog.ConfirmOther(task, barcode); return@launch }
                JoinResult.Unavailable -> return@launch fail(if (cached == null) InventoryError.NEEDS_NETWORK else InventoryError.DOWNLOAD_FAILED, retry = task)
            }
            dialog.value = InventoryDialog.Downloading(task.inventoryNumber, 0, manifest.codeCount)
            val result = runCatching {
                repository.download(manifest) { staged, total -> dialog.value = InventoryDialog.Downloading(task.inventoryNumber, staged, total) }
            }.getOrElse { return@launch fail(InventoryError.DOWNLOAD_FAILED, retry = task) }
            when (result) {
                MirrorResult.Active -> {
                    repository.activate(task.inventoryId)
                    dialog.value = null
                    _events.emit(InventoryListEvent.Entered(task.inventoryId))
                }
                MirrorResult.Repack -> fail(InventoryError.REPACK)
                is MirrorResult.Invalid -> fail(InventoryError.INVALID_SNAPSHOT, detail = result.reason, retry = task)
            }
        }
    }

    private fun fail(kind: InventoryError, detail: String? = null, retry: InventoryTaskDto? = null) {
        dialog.value = InventoryDialog.Error(kind, detail, retry)
    }
}
```

`combine` with eight flows needs the `vararg` overload: `combine(base, loading, mine, others, othersExpanded, othersLoading, fetchedAt, dialog) { v -> … }` where `v: Array<Any?>` — the same form `HubViewModel` uses.

- [ ] **Step 5: Screen**

```kotlin
// feature/inventory/InventoryListScreen.kt
package app.markiro.handheld.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat

data class InventoryListCallbacks(
    val onBack: () -> Unit = {},
    val onContinue: () -> Unit = {},
    val onSelect: (InventoryTaskDto) -> Unit = {},
    val onExpandOthers: () -> Unit = {},
    val onConfirmOther: () -> Unit = {},
    val onDismiss: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onRefresh: () -> Unit = {},
)

data class InventoryCard(val id: String, val number: String, val product: String, val repack: Boolean, val dates: String, val lineName: String?, val active: Boolean, val enabled: Boolean)

private fun InventoryTaskDto.card(reachable: Boolean, lineName: String? = null) =
    InventoryCard(inventoryId, inventoryNumber, productPrintName ?: productName, mode == "repack", "$productionDateFrom – $productionDateTo", lineName, false, mode == "check" && reachable)

private fun InventoryTaskEntity.card() =
    InventoryCard(inventoryId, inventoryNumber, productPrintName ?: productName, false, "$productionDateFrom – $productionDateTo", null, true, true)

fun errorText(kind: InventoryError): Int = when (kind) {
    InventoryError.NOT_RUNNING -> R.string.inventory_not_running
    InventoryError.OPERATOR_UNAVAILABLE -> R.string.inventory_operator_unavailable
    InventoryError.LINE_REQUIRED -> R.string.inventory_line_required
    InventoryError.BARCODE_UNKNOWN -> R.string.inventory_barcode_unknown
    InventoryError.NEEDS_NETWORK -> R.string.inventory_snapshot_needs_network
    InventoryError.DOWNLOAD_FAILED -> R.string.inventory_download_failed
    InventoryError.INVALID_SNAPSHOT -> R.string.inventory_download_invalid
    InventoryError.REPACK -> R.string.inventory_repack_later
}

@Composable
fun InventoryListScreen(state: InventoryListUi, cb: InventoryListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val numbers = NumberFormat.getIntegerInstance()
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (val d = state.dialog) {
            is InventoryDialog.ConfirmOther -> {
                AppBar(stringResource(R.string.inventory_title), cb.onDismiss)
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                    Text(stringResource(R.string.inventory_join_other_title), style = t.title, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_this, state.ownLineName.orEmpty()), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_task, d.task.lineName), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_text), style = t.caption, color = c.warnFg)
                    PrimaryButton(stringResource(R.string.inventory_join_other_confirm, d.task.inventoryNumber), cb.onConfirmOther)
                    MarkiroTextButton(stringResource(R.string.common_cancel), cb.onDismiss)
                }
                return
            }
            InventoryDialog.Joining -> {
                AppBar(stringResource(R.string.inventory_title))
                FullScreenState(Icons.Outlined.Sync, stringResource(R.string.inventory_joining), "", tone = Tone.Info)
                return
            }
            is InventoryDialog.Downloading -> {
                AppBar(stringResource(R.string.inventory_title))
                Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Text(stringResource(R.string.inventory_download_title, d.number), style = t.title, color = c.fg1)
                    Text(stringResource(R.string.inventory_download_progress, numbers.format(d.staged), numbers.format(d.total)), style = t.body, color = c.fg2)
                    LinearProgressIndicator(
                        progress = { if (d.total == 0) 0f else d.staged.toFloat() / d.total },
                        modifier = Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp4),
                        color = c.accent,
                    )
                }
                return
            }
            is InventoryDialog.Error -> {
                AppBar(stringResource(R.string.inventory_title), cb.onDismiss)
                val text = if (d.kind == InventoryError.INVALID_SNAPSHOT) stringResource(errorText(d.kind), d.detail.orEmpty()) else stringResource(errorText(d.kind))
                FullScreenState(
                    if (d.kind == InventoryError.NEEDS_NETWORK) Icons.Outlined.WifiOff else Icons.Outlined.ErrorOutline,
                    text,
                    "",
                    primary = if (d.retry != null) StateAction(stringResource(R.string.common_retry), cb.onRetry) else StateAction(stringResource(R.string.common_got_it), cb.onDismiss),
                    secondary = if (d.retry != null) StateAction(stringResource(R.string.common_cancel), cb.onDismiss) else null,
                    tone = Tone.Err,
                    primaryIsAccent = d.retry != null,
                )
                return
            }
            null -> Unit
        }
        AppBar(stringResource(R.string.inventory_title), cb.onBack)
        if (!state.reachable && state.listFetchedAt != null) {
            Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(state.listFetchedAt)), style = t.caption, color = c.warnFg, modifier = Modifier.padding(horizontal = MarkiroSizes.sp4))
        }
        if (!state.loading && state.active == null && state.mine.isEmpty() && !state.othersExpanded) {
            FullScreenState(Icons.Outlined.Inventory2, stringResource(R.string.inventory_empty_title), stringResource(R.string.inventory_empty_text))
            return
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            state.active?.let { active ->
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        InventoryCardView(active.card(), onClick = cb.onContinue)
                        PrimaryButton(stringResource(R.string.common_continue), cb.onContinue)
                    }
                }
            }
            if (state.mine.isNotEmpty()) {
                item { Text(stringResource(R.string.inventory_my_line), style = t.label, color = c.fg3) }
                items(state.mine, key = { it.inventoryId }) { task -> InventoryCardView(task.card(state.reachable), onClick = { cb.onSelect(task) }) }
            }
            if (state.loading) item { Text(stringResource(R.string.inventory_loading), style = t.caption, color = c.fg3) }
            if (!state.othersExpanded) {
                item { MarkiroTextButton(stringResource(R.string.inventory_show_other), cb.onExpandOthers) }
            } else {
                item { Text(stringResource(R.string.inventory_other_lines), style = t.label, color = c.fg3) }
                if (state.othersLoading) item { Text(stringResource(R.string.inventory_loading), style = t.caption, color = c.fg3) }
                state.others.forEach { (line, tasks) ->
                    items(tasks, key = { "$line:${it.inventoryId}" }) { task -> InventoryCardView(task.card(state.reachable, line), onClick = { cb.onSelect(task) }) }
                }
            }
        }
    }
}

@Composable
fun InventoryCardView(card: InventoryCard, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        Modifier.fillMaxWidth().heightIn(min = 96.dp).clip(shape).background(c.surfaceCard)
            .border(1.dp, if (card.active) c.accent else c.line, shape)
            .clickable(enabled = card.enabled, onClick = onClick)
            .alpha(if (card.enabled) 1f else 0.55f)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1),
    ) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(card.number, style = t.code.copy(fontSize = 16.sp), color = c.fg1)
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                MarkiroChip(stringResource(if (card.repack) R.string.inventory_mode_repack else R.string.inventory_mode_check), Tone.Neutral)
                card.lineName?.let { MarkiroChip(it, Tone.Info) }
                if (card.active) MarkiroChip(stringResource(R.string.inventory_continue), Tone.Ok)
            }
        }
        Text(card.product, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(card.dates, style = t.caption, color = c.fg3)
        if (card.repack) Text(stringResource(R.string.inventory_repack_later), style = t.caption, color = c.warnFg)
        else if (!card.enabled && !card.active) Text(stringResource(R.string.inventory_needs_network), style = t.caption, color = c.warnFg)
    }
}
```

`Icons.Outlined.CloudDownload` may not exist in the bundled icon set; use `Icons.Outlined.Sync` for the download state if the build complains, and drop the import.

- [ ] **Step 6: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.feature.inventory.*" -q` → PASS.

- [ ] **Step 7: Commit** `feat(handheld): inventory task list with other lines, task barcodes, join and snapshot download`

---

### Task 11: Work screen — scans, counters, date sheets

**Files:**

- Create: `feature/inventory/InventoryWorkViewModel.kt`, `feature/inventory/InventoryWorkScreen.kt`, `feature/inventory/InventoryLabels.kt`
- Test: `feature/inventory/InventoryWorkViewModelTest.kt`, `feature/inventory/InventoryWorkScreenTest.kt`

**Interfaces:**

- Produces: `InventoryLastScan`, `InventoryProgress`, `InventoryWorkUi`, `InventoryWorkViewModel` (`applyDateAndAccept()`, `acceptAsIs()`, `skipHeld()`, `setDate(date)`), `InventoryWorkScreen(state, cb)`, `InventoryWorkCallbacks(onLeave, onToHub)`, `InventoryVerdict.label()`, `.tone()`, `statusLabel(status)`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// feature/inventory/InventoryWorkViewModelTest.kt
package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.inventory.InventoryRecorder
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryWorkViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val played = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val gs = ""
    private fun raw(serial: String) = "01046000000000152$serial${gs}93AbCd".replace("2$serial", "21$serial")
    private fun hash(serial: String) = KmCodec.hash(KmCodec.canonicalize(raw(serial)))

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeInventoryId = "i1"))
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1").copy(expectedCount = 3))
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", hash("A1"), serial = "A1", date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("A2"), serial = "A2", date = "2026-08-22"),
                InventoryFixtures.code("snap", hash("A3"), serial = "A3", date = "2026-08-20"),
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private fun vm(): InventoryWorkViewModel {
        val engine = InventorySyncEngine(db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" }, NetworkModule.strictJson(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
        return InventoryWorkViewModel(SavedStateHandle(mapOf("inventoryId" to "i1")), db, InventoryRecorder(db), ScanRouterAdapter(scans), { played += it }, engine, session, ReachabilityTracker())
    }

    @Test
    fun scansUpdateTheVerdictCountersAndFeed() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        val ui = vm.state.first { it.progress.verified == 1 }
        assertEquals(InventoryVerdict.EXPECTED, ui.last?.verdict)
        assertEquals(1, ui.progress.thisTerminal)
        assertEquals(3, ui.expectedCount)
        assertEquals("2026-08-20", ui.activeDate)
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("garbage", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(listOf(SignalKind.OK, SignalKind.DUPLICATE, SignalKind.ERROR), played)
        assertEquals(1, vm.state.first { it.feed.isNotEmpty() }.feed.size)
    }

    @Test
    fun aMismatchHoldsScansUntilResolved() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        val held = vm.state.first { it.held != null }.held
        assertEquals("2026-08-22", held?.codeDate)
        scans.tryEmit(ScanEvent(raw("A3"), null, "debug", 0))
        advanceUntilIdle()
        assertEquals(1, vm.state.value.progress.verified)
        assertEquals(SignalKind.ERROR, played.last())
        vm.applyDateAndAccept()
        val after = vm.state.first { it.progress.verified == 2 }
        assertNull(after.held)
        assertEquals("2026-08-22", after.activeDate)
        vm.setDate("2026-08-20")
        assertEquals("2026-08-20", vm.state.first { it.activeDate == "2026-08-20" }.activeDate)
    }

    @Test
    fun acceptAsIsKeepsTheActiveDateAndSkipDropsTheScan() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        vm.state.first { it.held != null }
        vm.skipHeld()
        assertNull(vm.state.first { it.held == null }.held)
        assertEquals(1, vm.state.value.progress.verified)
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        vm.state.first { it.held != null }
        vm.acceptAsIs()
        val after = vm.state.first { it.progress.verified == 2 }
        assertEquals("2026-08-20", after.activeDate)
        assertNotNull(db.inventoryEventDao().firstUnknown("i1", "x") ?: Unit)
    }
}
```

The odd `raw()` helper is a mistake to avoid: write it as `private fun raw(serial: String) = "010460000000001521$serial${gs}93AbCd"`.

```kotlin
// feature/inventory/InventoryWorkScreenTest.kt
package app.markiro.handheld.feature.inventory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.inventory.LocalClaim
import app.markiro.handheld.core.inventory.RecordOutcome
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.text.NumberFormat

@RunWith(AndroidJUnit4::class)
class InventoryWorkScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val event = InventoryEventEntity("e1", "i1", "snap", 1, "op-1", "2026-09-10T08:00:00.000Z", "item", "item:h", "h", "010460000000001521S1", "2026-08-20", "expected", 1, null, null, null, null)

    private val ui = InventoryWorkUi(
        task = InventoryFixtures.task("i1"), expectedCount = 4116, activeDate = "2026-08-20",
        last = InventoryLastScan(InventoryVerdict.DUPLICATE, "…1234", winner = LocalClaim("h", "z", "dev-2", "2026-09-10T07:42:00.000Z"), ownDevice = false, boxCounted = null, boxTotal = null, sourceStatus = null, invalidReason = null),
        progress = InventoryProgress(verified = 1240, discrepancies = 7, protected = 3, thisTerminal = 312, rejected = 1),
        feed = listOf(event), sync = InventorySyncState(pending = 37), reachable = false, held = null, closed = false,
    )

    @Test
    fun rendersVerdictCountersAndDateChip() {
        var left = false
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui, InventoryWorkCallbacks(onLeave = { left = true })) } }
        val n = NumberFormat.getIntegerInstance()
        compose.onNodeWithText("ДУБЛЬ").assertIsDisplayed()
        compose.onNodeWithText("на другом терминале в", substring = true).assertIsDisplayed()
        compose.onNodeWithText("${n.format(1240)} / ${n.format(4116)}").assertIsDisplayed()
        compose.onNodeWithText("312").assertIsDisplayed()
        compose.onNodeWithText("Защищено 3 · Отклонено сервером 1").assertIsDisplayed()
        compose.onNodeWithText("Дата 20.08.2026").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ещё").performClick()
        compose.onNodeWithText("Выйти из задания").performClick()
        assertEquals(true, left)
    }

    @Test
    fun mismatchSheetOffersThreeActionsAndMixedOnlyTwo() {
        var applied = false
        compose.setContent {
            MarkiroTheme {
                InventoryWorkScreen(ui.copy(held = RecordOutcome.DateMismatch("2026-08-20", "2026-08-22", false, "raw")), InventoryWorkCallbacks(onApplyDate = { applied = true }))
            }
        }
        compose.onNodeWithText("Дата в коде отличается от активной").assertIsDisplayed()
        compose.onNodeWithText("Установить 22.08.2026 и зачесть").performClick()
        assertEquals(true, applied)
    }

    @Test
    fun closedStateReplacesTheScanZone() {
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui.copy(closed = true), InventoryWorkCallbacks()) } }
        compose.onNodeWithText("Задание закрыто в кабинете").assertIsDisplayed()
        compose.onNodeWithText("В хаб").assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Labels and view model**

```kotlin
// feature/inventory/InventoryLabels.kt
package app.markiro.handheld.feature.inventory

import app.markiro.handheld.R
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.signal.SignalKind

fun InventoryVerdict.label(): Int = when (this) {
    InventoryVerdict.EXPECTED -> R.string.inventory_verdict_expected
    InventoryVerdict.PROTECTED -> R.string.inventory_verdict_protected
    InventoryVerdict.KNOWN_INELIGIBLE -> R.string.inventory_verdict_ineligible
    InventoryVerdict.UNKNOWN -> R.string.inventory_verdict_unknown
    InventoryVerdict.DUPLICATE -> R.string.inventory_verdict_duplicate
    InventoryVerdict.INVALID -> R.string.inventory_verdict_invalid
}

fun InventoryVerdict.tone(): Tone = when (this) {
    InventoryVerdict.EXPECTED -> Tone.Ok
    InventoryVerdict.DUPLICATE, InventoryVerdict.PROTECTED -> Tone.Warn
    InventoryVerdict.KNOWN_INELIGIBLE, InventoryVerdict.UNKNOWN, InventoryVerdict.INVALID -> Tone.Err
}

fun InventoryVerdict.signal(): SignalKind = when (this) {
    InventoryVerdict.EXPECTED -> SignalKind.OK
    InventoryVerdict.DUPLICATE -> SignalKind.DUPLICATE
    else -> SignalKind.ERROR
}

fun statusLabel(status: String): Int = when (status) {
    "EMITTED" -> R.string.inventory_status_emitted
    "INTRODUCED" -> R.string.inventory_status_introduced
    "APPLIED" -> R.string.inventory_status_applied
    "RETIRED" -> R.string.inventory_status_retired
    "WRITTEN_OFF" -> R.string.inventory_status_written_off
    else -> R.string.inventory_status_disaggregation
}

/** `2026-08-20` → `20.08.2026`; the wire form is what the sheets and chips show reversed. */
fun civilDate(iso: String): String = iso.split("-").let { if (it.size == 3) "${it[2]}.${it[1]}.${it[0]}" else iso }
```

```kotlin
// feature/inventory/InventoryWorkViewModel.kt
package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.InventoryRecorder
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.inventory.LocalClaim
import app.markiro.handheld.core.inventory.RecordOutcome
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.work.SignalPort
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class InventoryLastScan(
    val verdict: InventoryVerdict,
    val tail: String?,
    val winner: LocalClaim?,
    val ownDevice: Boolean,
    val boxCounted: Int?,
    val boxTotal: Int?,
    val sourceStatus: String?,
    val invalidReason: String?,
)

data class InventoryProgress(val verified: Int = 0, val discrepancies: Int = 0, val protected: Int = 0, val thisTerminal: Int = 0, val rejected: Int = 0)

data class InventoryWorkUi(
    val task: InventoryTaskEntity?,
    val expectedCount: Int,
    val activeDate: String?,
    val last: InventoryLastScan?,
    val progress: InventoryProgress,
    val feed: List<InventoryEventEntity>,
    val sync: InventorySyncState,
    val reachable: Boolean,
    val held: RecordOutcome.DateMismatch?,
    val closed: Boolean,
)

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L

@HiltViewModel
class InventoryWorkViewModel(
    handle: SavedStateHandle,
    private val db: HandheldDatabase,
    private val recorder: InventoryRecorder,
    scans: ScanEvents,
    private val signals: SignalPort,
    private val sync: InventorySyncEngine,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
) : ViewModel() {
    @Inject
    constructor(
        handle: SavedStateHandle,
        db: HandheldDatabase,
        recorder: InventoryRecorder,
        scans: ScanEvents,
        signaller: Signaller,
        sync: InventorySyncEngine,
        session: SessionHolder,
        reachability: ReachabilityTracker,
    ) : this(handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability)

    val inventoryId: String = checkNotNull(handle["inventoryId"])
    private val last = MutableStateFlow<InventoryLastScan?>(null)
    private val held = MutableStateFlow<RecordOutcome.DateMismatch?>(null)

    private val progress = db.deviceConfigDao().observe().flatMapLatest { cfg ->
        val deviceId = cfg?.deviceId ?: ""
        combine(
            db.inventoryResultDao().observeCount(inventoryId, "expected"),
            db.inventoryResultDao().observeCount(inventoryId, "known-ineligible"),
            db.inventoryResultDao().observeCount(inventoryId, "unknown"),
            db.inventoryEventDao().observeUnknownIdentities(inventoryId),
            db.inventoryResultDao().observeCount(inventoryId, "protected"),
            db.inventoryResultDao().observeCountForDevice(inventoryId, deviceId),
            db.inventoryEventDao().observeCountByServerStatus(inventoryId, "rejected"),
        ) { v -> InventoryProgress(verified = v[0], discrepancies = v[1] + v[2] + v[3], protected = v[4], thisTerminal = v[5], rejected = v[6]) }
    }

    val state: StateFlow<InventoryWorkUi> = combine(
        db.inventoryTaskDao().observe(inventoryId),
        db.inventoryTerminalStateDao().observe(inventoryId),
        last,
        progress,
        db.inventoryEventDao().observeRecent(inventoryId, 4),
        sync.state,
        reachability.lastSuccessAt,
        held,
    ) { v ->
        val task = v[0] as InventoryTaskEntity?
        val terminal = v[1] as app.markiro.handheld.core.storage.InventoryTerminalStateEntity?
        val lastOk = v[6] as Long?
        @Suppress("UNCHECKED_CAST")
        InventoryWorkUi(
            task = task,
            expectedCount = task?.expectedCount ?: 0,
            activeDate = terminal?.activeProductionDate ?: task?.productionDateFrom,
            last = v[2] as InventoryLastScan?,
            progress = v[3] as InventoryProgress,
            feed = v[4] as List<InventoryEventEntity>,
            sync = v[5] as InventorySyncState,
            reachable = lastOk != null && System.currentTimeMillis() - lastOk <= REACHABLE_WINDOW_MS,
            held = v[7] as RecordOutcome.DateMismatch?,
            closed = task?.state == "closed",
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, InventoryWorkUi(null, 0, null, null, InventoryProgress(), emptyList(), InventorySyncState(), false, null, false))

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        sync.nudge()
    }

    private suspend fun onScan(raw: String, acceptMismatch: Boolean = false) {
        val task = db.inventoryTaskDao().get(inventoryId) ?: return
        if (task.state != "active") return
        if (held.value != null && !acceptMismatch) {
            // A held scan owns the screen: further scans are dropped loudly, as on the station.
            signals.play(SignalKind.ERROR)
            return
        }
        val operatorId = session.state.value.operator?.operatorId ?: return
        when (val outcome = recorder.record(inventoryId, raw, operatorId, acceptMismatch)) {
            is RecordOutcome.DateMismatch -> {
                held.value = outcome
                last.value = null
                signals.play(SignalKind.ERROR)
            }
            is RecordOutcome.Recorded -> {
                held.value = null
                signals.play(outcome.verdict.signal())
                val ownDevice = db.deviceConfigDao().get()?.deviceId
                last.value = InventoryLastScan(
                    verdict = outcome.verdict, tail = outcome.tail, winner = outcome.winner, ownDevice = outcome.winner?.deviceId == ownDevice,
                    boxCounted = if (outcome.scanKind == "known_box") outcome.claimedCount else null,
                    boxTotal = if (outcome.scanKind == "known_box") outcome.boxChildCount else null,
                    sourceStatus = outcome.sourceStatus, invalidReason = outcome.invalidReason,
                )
                if (outcome.eventId != null) sync.nudge()
            }
        }
    }

    /** «Установить дату и зачесть»: the code's date becomes active, then the held scan is recorded normally. */
    fun applyDateAndAccept() {
        val h = held.value ?: return
        val date = h.codeDate ?: return
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            recorder.setActiveDate(inventoryId, date, operatorId)
            onScan(h.raw, acceptMismatch = true)
        }
    }

    fun acceptAsIs() {
        val h = held.value ?: return
        viewModelScope.launch { onScan(h.raw, acceptMismatch = true) }
    }

    fun skipHeld() {
        held.value = null
    }

    fun setDate(date: String) {
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            runCatching { recorder.setActiveDate(inventoryId, date, operatorId) }
        }
    }
}
```

Add `@OptIn(ExperimentalCoroutinesApi::class)` for `flatMapLatest` and import `kotlinx.coroutines.ExperimentalCoroutinesApi`. The seven-flow `combine` returning `InventoryProgress` uses the `vararg` form with `v: Array<Int>`.

- [ ] **Step 4: Screen**

```kotlin
// feature/inventory/InventoryWorkScreen.kt
package app.markiro.handheld.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

data class InventoryWorkCallbacks(
    val onLeave: () -> Unit = {},
    val onToHub: () -> Unit = {},
    val onApplyDate: () -> Unit = {},
    val onAcceptAsIs: () -> Unit = {},
    val onSkip: () -> Unit = {},
    val onSetDate: (String) -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryWorkScreen(state: InventoryWorkUi, cb: InventoryWorkCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    var menu by remember { mutableStateOf(false) }
    var dateSheet by remember { mutableStateOf(false) }
    val numbers = NumberFormat.getIntegerInstance()
    if (state.closed) {
        Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            FullScreenState(
                Icons.Outlined.Inventory2, stringResource(R.string.inventory_closed_title), stringResource(R.string.inventory_closed_text),
                primary = StateAction(stringResource(R.string.inventory_to_hub), cb.onToHub), tone = Tone.Warn,
            )
        }
        return
    }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) StatusItem(Icons.Outlined.Wifi, stringResource(R.string.hub_network)) else StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.hub_offline), Tone.Warn),
                StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.sync.pending), if (state.sync.stuck) Tone.Err else Tone.Neutral),
                StatusItem(Icons.Outlined.QrCodeScanner, stringResource(R.string.hub_scanner)),
            ),
        )
        if (state.sync.stuck) {
            Banner(stringResource(R.string.hub_sync_stuck), Tone.Err, Icons.Outlined.Sync)
        } else if (!state.reachable) {
            val text = if (state.sync.pending > 0) stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.inventory_events_queued, state.sync.pending, state.sync.pending)) else stringResource(R.string.hub_offline_banner)
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(state.task?.let { it.productPrintName ?: it.productName } ?: "", style = t.strong.copy(fontSize = 16.sp), color = c.fg1, maxLines = 1)
                Text(state.task?.inventoryNumber ?: "", style = t.caption, color = c.fg3)
            }
            state.activeDate?.let { date ->
                Box(Modifier.clip(RoundedCornerShape(MarkiroSizes.radius)).clickable { dateSheet = true }.padding(MarkiroSizes.sp2)) {
                    MarkiroChip(stringResource(R.string.inventory_active_date, civilDate(date)), Tone.Info)
                }
            }
            Box {
                IconAction(Icons.Outlined.MoreVert, stringResource(R.string.work_more)) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.inventory_change_date)) }, onClick = { menu = false; dateSheet = true })
                    DropdownMenuItem(text = { Text(stringResource(R.string.inventory_leave)) }, onClick = { menu = false; cb.onLeave() })
                }
            }
        }
        LastZone(state.last, Modifier.weight(0.4f))
        Row(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2), horizontalArrangement = Arrangement.SpaceBetween) {
            Counter(stringResource(R.string.inventory_verified), stringResource(R.string.inventory_of, numbers.format(state.progress.verified), numbers.format(state.expectedCount)))
            Counter(stringResource(R.string.inventory_this_terminal), numbers.format(state.progress.thisTerminal))
            Counter(stringResource(R.string.inventory_discrepancies), numbers.format(state.progress.discrepancies), if (state.progress.discrepancies > 0) Tone.Warn else Tone.Neutral)
        }
        if (state.progress.protected > 0 || state.progress.rejected > 0) {
            Text(
                listOfNotNull(
                    state.progress.protected.takeIf { it > 0 }?.let { stringResource(R.string.inventory_protected_count, it) },
                    state.progress.rejected.takeIf { it > 0 }?.let { stringResource(R.string.inventory_rejected_count, it) },
                ).joinToString(" · "),
                style = t.caption, color = c.fg3, modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
        }
        Column(Modifier.weight(0.6f).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
            if (state.feed.isEmpty()) Text(stringResource(R.string.inventory_feed_empty), style = t.caption, color = c.fg3)
            state.feed.forEach { event ->
                val verdict = InventoryVerdict.fromWire(event.localVerdict)
                Row(Modifier.fillMaxWidth().height(32.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(Iso.parse(event.scannedAt)?.let { TimeText.hhmm(it) } ?: "", style = t.caption, color = c.fg3)
                    Text("…" + (event.canonicalRaw ?: event.normalizedIdentity).takeLast(8), style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                    Text(stringResource(verdict.label()), style = t.caption, color = c.tone(verdict.tone()).fg)
                }
            }
        }
    }
    state.held?.let { held ->
        ModalBottomSheet(onDismissRequest = cb.onSkip, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(if (held.mixed) R.string.inventory_mixed_title else R.string.inventory_mismatch_title), style = t.strong, color = c.fg1)
                if (held.mixed) {
                    Text(stringResource(R.string.inventory_mixed_text), style = t.body, color = c.fg2)
                } else {
                    Text(stringResource(R.string.inventory_mismatch_code, civilDate(held.codeDate.orEmpty())), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_mismatch_active, civilDate(held.activeDate)), style = t.body, color = c.fg2)
                    PrimaryButton(stringResource(R.string.inventory_mismatch_apply, civilDate(held.codeDate.orEmpty())), cb.onApplyDate)
                }
                SecondaryButton(stringResource(R.string.inventory_mismatch_accept), cb.onAcceptAsIs)
                MarkiroTextButton(stringResource(R.string.inventory_mismatch_skip), cb.onSkip)
            }
        }
    }
    if (dateSheet && state.task != null) {
        val task = state.task
        val from = LocalDate.parse(task.productionDateFrom).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val to = LocalDate.parse(task.productionDateTo).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = state.activeDate?.let { LocalDate.parse(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() },
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis in from..to
            },
        )
        ModalBottomSheet(onDismissRequest = { dateSheet = false }, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(R.string.inventory_date_title), style = t.strong, color = c.fg1)
                DatePicker(state = picker, showModeToggle = false, title = null, headline = null)
                PrimaryButton(stringResource(R.string.inventory_date_apply), {
                    picker.selectedDateMillis?.let { cb.onSetDate(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                    dateSheet = false
                }, enabled = picker.selectedDateMillis != null)
                MarkiroTextButton(stringResource(R.string.common_cancel)) { dateSheet = false }
            }
        }
    }
}

@Composable
private fun LastZone(last: InventoryLastScan?, modifier: Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val colors = last?.verdict?.tone()?.let { c.tone(it) }
    Column(
        modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius)).background(colors?.bg ?: c.surfaceCard).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        if (last == null || colors == null) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3)
            Text(stringResource(R.string.inventory_waiting), style = t.strong, color = c.fg3)
            return
        }
        val icon = when (last.verdict) {
            InventoryVerdict.EXPECTED -> Icons.Outlined.CheckCircle
            InventoryVerdict.DUPLICATE -> Icons.Outlined.ContentCopy
            else -> Icons.Outlined.ErrorOutline
        }
        Icon(icon, contentDescription = null, tint = colors.fg)
        val title = if (last.verdict == InventoryVerdict.EXPECTED && last.boxTotal != null) R.string.inventory_verdict_box else last.verdict.label()
        Text(stringResource(title), style = t.title, color = colors.fg)
        last.tail?.let { Text(it, style = t.code, color = c.fg1) }
        val detail = when (last.verdict) {
            InventoryVerdict.EXPECTED -> last.boxTotal?.let { stringResource(R.string.inventory_box_counted, last.boxCounted ?: 0, it) }
            InventoryVerdict.DUPLICATE -> last.winner?.let { w ->
                val at = Iso.parse(w.scannedAt)?.let { TimeText.hhmm(it) } ?: "—"
                stringResource(if (last.ownDevice) R.string.inventory_duplicate_here else R.string.inventory_duplicate_other, at)
            }
            InventoryVerdict.PROTECTED -> stringResource(R.string.inventory_protected_text)
            InventoryVerdict.KNOWN_INELIGIBLE -> last.sourceStatus?.let { stringResource(R.string.inventory_ineligible_text, stringResource(statusLabel(it))) }
            InventoryVerdict.UNKNOWN -> stringResource(R.string.inventory_unknown_text)
            InventoryVerdict.INVALID -> when (last.invalidReason) {
                "wrong_gtin" -> stringResource(R.string.inventory_invalid_wrong_gtin)
                "unsupported" -> stringResource(R.string.inventory_invalid_unsupported)
                else -> null
            }
        }
        detail?.let { Text(it, style = t.caption, color = c.fg2) }
    }
}

@Composable
private fun Counter(label: String, value: String, tone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(horizontalAlignment = Alignment.Start) {
        Text(label, style = t.caption, color = c.fg3)
        Text(value, style = t.strong.copy(fontSize = 16.sp), color = if (tone == Tone.Neutral) c.fg1 else c.tone(tone).fg)
    }
}
```

`DatePicker` needs `compose.material3` (already a dependency); if `SelectableDates` is `@ExperimentalMaterial3Api` the existing opt-in covers it.

- [ ] **Step 5: Run** `./gradlew testDebugUnitTest --tests "app.markiro.handheld.feature.inventory.*" -q` → PASS.

- [ ] **Step 6: Commit** `feat(handheld): inventory work screen — verdicts, box counts, active date and mismatch sheets`

---

### Task 12: Leave flow, hub, settings, navigation, English

**Files:**

- Create: `feature/inventory/InventoryLeaveViewModel.kt`, `feature/inventory/InventoryLeaveScreen.kt`
- Modify: `feature/hub/HubViewModel.kt`, `feature/hub/HubScreen.kt`, `feature/settings/SettingsViewModel.kt`, `AppNavigation.kt`
- Test: `feature/inventory/InventoryLeaveViewModelTest.kt`, extend `feature/hub/HubViewModelTest.kt`, `EnglishRenderTest.kt`

**Interfaces:**

- Produces: `LeaveStep.Draining(pending) | Offline(pending) | Failed | Left`, `InventoryLeaveViewModel`, `InventoryLeaveScreen(step, onDone, onBack)`; `HubUi.activeInventoryId`, `HubUi.continueInventoryNumber`; `Routes.INVENTORY`, `INVENTORY_WORK`, `INVENTORY_LEAVE`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// feature/inventory/InventoryLeaveViewModelTest.kt
package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.inventory.InventoryManifestDto
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryTaskEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class InventoryLeaveViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private class Gateway(private val results: ArrayDeque<LeaveResult>, private val pending: Int) : InventoryGateway {
        override fun observeTasks(): Flow<List<InventoryTaskEntity>> = flowOf(emptyList())
        override suspend fun listTasks(scope: String?) = emptyList<InventoryTaskDto>()
        override suspend fun resolveBarcode(barcode: String): ResolvedTask? = null
        override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult = JoinResult.Unavailable
        override suspend fun manifest(inventoryId: String): app.markiro.handheld.core.network.InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun download(manifest: app.markiro.handheld.core.network.InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit) = MirrorResult.Active
        override suspend fun activate(inventoryId: String) = Unit
        override suspend fun leave(inventoryId: String): LeaveResult = results.removeFirst()
        override suspend fun queued(inventoryId: String) = pending
    }

    private fun vm(gateway: Gateway, drained: Boolean) =
        InventoryLeaveViewModel(SavedStateHandle(mapOf("inventoryId" to "i1")), gateway, drain = { drained })

    @Test
    fun drainsThenLeaves() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Left)), pending = 0), drained = true)
        advanceUntilIdle()
        assertEquals(LeaveStep.Left, vm.step.value)
    }

    @Test
    fun offlineWithQueueStaysOnTheTask() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Pending(3))), pending = 3), drained = false)
        advanceUntilIdle()
        assertEquals(LeaveStep.Offline(3), vm.step.value)
    }

    @Test
    fun aServerRefusalIsShownAsFailed() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Failed)), pending = 0), drained = true)
        advanceUntilIdle()
        assertEquals(LeaveStep.Failed, vm.step.value)
    }
}
```

Fix the stray imports in that file: import `app.markiro.handheld.core.inventory.MirrorResult` and `app.markiro.handheld.core.network.InventoryManifestDto` (drop the wrong `core.inventory.InventoryManifestDto` line and the fully-qualified names).

`HubViewModelTest` — add:

```kotlin
    @Test
    fun anActiveInventoryIsPinnedForContinuing() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        db.deviceConfigDao().upsert(paired.copy(activeInventoryId = "i1"))
        val vm = vm(api())
        val ui = vm.state.first { it.activeInventoryId != null }
        assertEquals("INV-0007", ui.continueInventoryNumber)
        db.inventoryTaskDao().setState("i1", "closed")
        assertNull(vm.state.first { it.activeInventoryId == null }.continueInventoryNumber)
    }
```

and pass `db.inventoryTaskDao()` plus an `InventorySyncEngine` into `HubViewModel` (see Step 3). `EnglishRenderTest` — add:

```kotlin
    @Test
    fun inventoryListRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(false, InventoryFixtures.task("i1").copy(productPrintName = "Water"), listOf(InventoryTaskDto("i2", "INV-0008", "Juice", null, "repack", "l1", "Line 2", "2026-08-01", "2026-08-31")), emptyMap(), false, false, false, "Line 2", 0L, null),
                    InventoryListCallbacks(),
                )
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun inventoryWorkRendersInEnglish() {
        val ui = InventoryWorkUi(
            InventoryFixtures.task("i1").copy(productPrintName = "Water"), 100, "2026-08-20",
            InventoryLastScan(InventoryVerdict.PROTECTED, "…1234", null, false, null, null, null, null),
            InventoryProgress(1, 2, 3, 4, 5), emptyList(), InventorySyncState(pending = 2), false,
            RecordOutcome.DateMismatch("2026-08-20", "2026-08-22", false, "raw"), false,
        )
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui, InventoryWorkCallbacks()) } }
        assertNoCyrillic()
    }
```

(`InventoryFixtures.task` uses a Cyrillic product name and line; the `copy` above replaces the print name shown on screen, and `lineName` is not rendered on the work screen. On the list screen the active card shows `productPrintName`, so the copy suffices.)

- [ ] **Step 2: Run to verify they fail** — compilation error.

- [ ] **Step 3: Leave view model and screen**

```kotlin
// feature/inventory/InventoryLeaveViewModel.kt
package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.InventorySyncEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface LeaveStep {
    data class Draining(val pending: Int) : LeaveStep
    data class Offline(val pending: Int) : LeaveStep
    data object Failed : LeaveStep
    data object Left : LeaveStep
}

/** Drain the outbox, then `POST leave`; the server refuses a leave with queued events, so offline the task stays active. */
@HiltViewModel
class InventoryLeaveViewModel(
    handle: SavedStateHandle,
    private val repository: InventoryGateway,
    private val drain: suspend () -> Boolean,
) : ViewModel() {
    @Inject
    constructor(handle: SavedStateHandle, repository: InventoryGateway, sync: InventorySyncEngine) : this(handle, repository, { sync.drainAll() })

    val inventoryId: String = checkNotNull(handle["inventoryId"])
    private val _step = MutableStateFlow<LeaveStep>(LeaveStep.Draining(0))
    val step: StateFlow<LeaveStep> = _step

    init {
        viewModelScope.launch {
            _step.value = LeaveStep.Draining(repository.queued(inventoryId))
            drain()
            _step.value = when (val result = repository.leave(inventoryId)) {
                LeaveResult.Left -> LeaveStep.Left
                is LeaveResult.Pending -> LeaveStep.Offline(result.queued)
                LeaveResult.Offline -> LeaveStep.Offline(repository.queued(inventoryId))
                LeaveResult.Failed -> LeaveStep.Failed
            }
        }
    }
}
```

```kotlin
// feature/inventory/InventoryLeaveScreen.kt
package app.markiro.handheld.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone

@Composable
fun InventoryLeaveScreen(step: LeaveStep, onDone: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().background(MarkiroTheme.colors.surfacePage)) {
        when (step) {
            is LeaveStep.Draining -> FullScreenState(Icons.Outlined.Sync, stringResource(R.string.inventory_leave_draining), stringResource(R.string.inventory_leave_draining_left, step.pending), tone = Tone.Info)
            is LeaveStep.Offline -> FullScreenState(
                Icons.Outlined.WifiOff, stringResource(R.string.inventory_leave_offline_title), stringResource(R.string.inventory_leave_offline_text, step.pending),
                primary = StateAction(stringResource(R.string.inventory_to_hub), onDone), secondary = StateAction(stringResource(R.string.common_back), onBack), tone = Tone.Warn, primaryIsAccent = false,
            )
            LeaveStep.Failed -> FullScreenState(
                Icons.Outlined.ErrorOutline, stringResource(R.string.inventory_leave_failed), "",
                primary = StateAction(stringResource(R.string.common_back), onBack), tone = Tone.Err, primaryIsAccent = false,
            )
            LeaveStep.Left -> FullScreenState(
                Icons.Outlined.CheckCircle, stringResource(R.string.inventory_left_title), stringResource(R.string.inventory_left_text),
                primary = StateAction(stringResource(R.string.inventory_to_hub), onDone), tone = Tone.Ok,
            )
        }
    }
}
```

- [ ] **Step 4: Hub, settings, navigation**

`HubViewModel`: add constructor parameters `inventorySync: InventorySyncEngine` and `inventories: InventoryTaskDao` (both constructors), an `activeInventory` flow mirroring `activeShift`:

```kotlin
    private val activeInventory: Flow<InventoryTaskEntity?> =
        config.observe().flatMapLatest { cfg -> cfg?.activeInventoryId?.let { inventories.observe(it) } ?: flowOf(null) }
```

extend the `combine` with `activeInventory` and `inventorySync.state`, and in `HubUi` add `activeInventoryId: String? = null`, `continueInventoryNumber: String? = null`; `queue = syncState.pending + inventoryState.pending`, `stuck = syncState.stuck || inventoryState.stuck`; `activeInventoryId = inventory?.takeIf { it.state == "active" }?.inventoryId`, `continueInventoryNumber = …?.inventoryNumber`.

`HubScreen`: the inventory tile status becomes `state.continueInventoryNumber?.let { stringResource(R.string.hub_inventory_continue, it) } ?: inventoriesLabel(state.inventories)` with `statusTone = if (state.continueInventoryNumber != null) Tone.Ok else Tone.Neutral`.

`SettingsViewModel`: inject `inventorySync: InventorySyncEngine`; replace the queue collector with `combine(sync.state, inventorySync.state) { s, i -> s to i }.collect { (s, i) -> _state.update { it.copy(queue = s.pending + i.pending, lastSyncAt = maxOf(s.lastSuccessAt ?: 0L, i.lastSuccessAt ?: 0L).takeIf { v -> v > 0 }) } }`.

`AppNavigation.kt`:

```kotlin
    const val INVENTORY = "inventory"
    const val INVENTORY_WORK = "inventory/{inventoryId}"
    const val INVENTORY_LEAVE = "inventory/{inventoryId}/leave"
    fun inventoryWork(id: String) = "inventory/$id"
    fun inventoryLeave(id: String) = "inventory/$id/leave"
```

Hub tile: `HubTile.INVENTORY -> state.activeInventoryId?.let { nav.navigate(Routes.inventoryWork(it)) } ?: nav.navigate(Routes.INVENTORY)`; `HubTile.CHECK -> nav.navigate(Routes.soon(tile))`. Composables:

```kotlin
            composable(Routes.INVENTORY) {
                val vm: InventoryListViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.events.collect { event ->
                        when (event) {
                            is InventoryListEvent.Entered -> nav.navigate(Routes.inventoryWork(event.inventoryId)) { popUpTo(Routes.HUB) }
                        }
                    }
                }
                InventoryListScreen(
                    state,
                    InventoryListCallbacks(
                        onBack = { nav.popBackStack() }, onContinue = vm::continueActive, onSelect = vm::select, onExpandOthers = vm::expandOthers,
                        onConfirmOther = vm::confirmOther, onDismiss = vm::dismissDialog, onRetry = vm::retry, onRefresh = vm::refresh,
                    ),
                )
            }
            composable(Routes.INVENTORY_WORK) { entry ->
                val vm: InventoryWorkViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                val id = entry.arguments?.getString("inventoryId").orEmpty()
                InventoryWorkScreen(
                    state,
                    InventoryWorkCallbacks(
                        onLeave = { nav.navigate(Routes.inventoryLeave(id)) },
                        onToHub = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } },
                        onApplyDate = vm::applyDateAndAccept, onAcceptAsIs = vm::acceptAsIs, onSkip = vm::skipHeld, onSetDate = vm::setDate,
                    ),
                )
            }
            composable(Routes.INVENTORY_LEAVE) {
                val vm: InventoryLeaveViewModel = hiltViewModel()
                val step by vm.step.collectAsStateWithLifecycle()
                InventoryLeaveScreen(step, onDone = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } }, onBack = { nav.popBackStack() })
            }
```

Remove `HubTile.INVENTORY` from the `SOON` title mapping (keep `CHECK`).

- [ ] **Step 5: Full gate**

Run: `./gradlew testDebugUnitTest lintDebug assembleDebug -q` (script file). Expected: all tests pass, lint 0 errors, APK built.

- [ ] **Step 6: Commit** `feat(handheld): leave an inventory after draining, hub continue tile, combined sync queue, navigation`

---

### Task 13: Docs, gates, manual verification and the pull request

**Files:**

- Modify: `apps/handheld/README.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-09-10-handheld-inventory-check-design.md` (status line and the two clarifications below)

- [ ] **Step 1: Docs**

README — add after the shift walk-through:

```markdown
## Inventory walk-through against the local API

1. In the cabinet create an inventory in `check` mode (a Chestny ZNAK export with a few codes),
   start it, and pair the handheld on the same line.
2. Hub → Инвентаризация → the task (or «Показать другие линии» for another line, confirmed on
   screen). The snapshot downloads once; the download resumes after a restart.
3. Scan units or an SSCC box label:

       adb shell "am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data '00346006820000000014'"

   Verdicts: ПРИНЯТО, ДУБЛЬ (this or another terminal), ЗАЩИЩЁН, НЕ УЧАСТВУЕТ, РАСХОЖДЕНИЕ,
   НЕВЕРНЫЙ КОД. The first scan adopts the code's production date; a later code with another
   date opens the mismatch sheet.

4. Events queue in `inventory_outbox` and go to `POST /station/inventories/:id/event-batches`;
   other terminals' claims arrive through `GET …/progress` every 15 s.
5. «Ещё» → «Выйти из задания» drains the queue and posts `leave`; the cabinet closes the inventory.

Classifier and batch digests are verified against `app/src/test/resources/inventory-fixtures.json`
(`pnpm --filter @markiro/domain fixtures:inventory`).
```

`docs/architecture.md`: extend the handheld note with one sentence: «Inventory check runs the station's inventory protocol (snapshot bundle with digests, event batches with `payloadDigest`, progress feed) with a second sync engine.»

Spec: set **Status** to «Implemented in <PR>»; under Scan recording note that an invalid scan is shown in the verdict zone only (no event, so no feed row), and under Screens that the download screen lives inside the list screen as a dialog state.

- [ ] **Step 2: Gates**

Handheld: `./gradlew testDebugUnitTest lintDebug assembleDebug -q`. Repo: `pnpm --filter @markiro/domain test`, `pnpm --filter @markiro/api typecheck && lint`, the three API inventory e2e files, `pnpm exec prettier --check` over every changed non-Kotlin file (`/usr/bin/git diff --name-only origin/main...HEAD`), `node --test tools/ci/test/*.test.mjs` outside the sandbox. Regenerate `graphify update .` only if `graphify-out/graph.json` exists.

- [ ] **Step 3: Manual verification on the emulator (report separately)**

Harness: a temporary vitest file `apps/api/test/zz-handheld-inventory-manual.e2e.test.ts` on 127.0.0.1:3100 seeding, like `handheld-inventory-access.e2e.test.ts`, a tenant, two lines, a product with GTIN `04600000000015`, a running `check` inventory whose snapshot holds real rows (insert `inventorySnapshotCodes` for: two expected loose codes with dates 2026-08-20 and 2026-08-22, two expected codes under SSCC `346006820000000014`, one `MOVING_BY_UD`, one `RETIRED`; compute `contentDigest` with `inventorySnapshotContentDigest` over the rows in `codeHash` order and store it in `stationManifest`), a second running inventory on the other line, two handheld devices with pairing codes, an operator with badge; control files `/tmp/claude/stop-api` and `/tmp/claude/close-inventory` (calls `POST /inventories/:id/close`). Delete the file before committing.

Walk-through (AVD `Medium_Phone_API_36`, `-no-window`; scans via `DEBUG_SCAN`, screenshots via `screencap`):

1. Pair, sign in, hub tile «Инвентаризация · 1 задание» → list with «Моя линия», expand «Показать другие линии» → the second task under its line chip.
2. Join own task → download screen with progress; `am force-stop` mid-way (use a 1-code page size only if needed by running the API with `codePageSize`… no: keep 200 and instead kill the app right after join to confirm the staged task resumes) → relaunch, sign in, hub «продолжить INV-…» → work screen.
3. Scans: expected (date adopted, chip shows 20.08.2026), duplicate here, the second expected code (22.08) → mismatch sheet → «Установить и зачесть» (chip 22.08.2026), protected, retired, unknown, the box SSCC («КОРОБ · принято кодов: 2 из 2»), the box again (ДУБЛЬ), an SSCC not in the snapshot (РАСХОЖДЕНИЕ), garbage.
4. Second handheld from the host: pair, join, post an event batch claiming an unclaimed code (build the payload with `inventoryEventBatchDigest` from `packages/domain/dist`); on the first handheld wait a tick and scan that code → «ДУБЛЬ · на другом терминале в HH:MM»; «Проверено» counts it.
5. Ten scans offline (`svc wifi disable`), banner «Работаем офлайн · 10 событий в очереди», network on → «Очередь 0», server rows in `inventory_code_results`.
6. Close the inventory from the harness while events are queued offline; network on → «Задание закрыто в кабинете» → «В хаб».
7. New task: join, one scan, «Выйти из задания» → «Отправляем сканы…» → «Вы вышли из задания»; server `leave` audited.
8. Settings → English → list, work screen, mismatch sheet, leave screen without Cyrillic.

Stop the harness (`touch /tmp/claude/stop-api`), delete the temporary test, `adb -e emu kill`, `git status` clean except intended files.

- [ ] **Step 4: Push and open the pull request**

`/usr/bin/git push -u origin worktree-tsd-inventory`, then `gh pr create --base main --title "feat: handheld (TSD) inventory check — snapshot mirror, offline verdicts, sync and leave" --body-file /tmp/claude/pr-body.md` with: summary (API changes for handhelds, Room v3, classifier fixtures, mirror, recorder, sync engine, screens in ru + en), automated checks table, manual verification list, not exercised (hardware, repack, camera), the spec link, the TDD-batching note and the 🤖 footer. Report the PR URL, the CI status and anything skipped.

---

## Self-review notes

- Spec coverage: server changes (Task 1), fixtures (2), Room v3 (3), DTOs (4), classifier (5), mirror with digests and resume (6), recorder with date guard and box claims (7), sync with outcomes, quarantine, progress and pinned batches (8), strings (9), list + confirmation + download (10), work screen with counters, sheets and closed state (11), leave, hub, settings, navigation, English (12), docs and verification (13). The spec's «unknown from the server counted as discrepancy» is `observeCount(id, "unknown")` in Task 11; «Отклонено сервером» is `observeCountByServerStatus`.
- Names reused across tasks: `InventoryGateway`, `JoinResult`, `LeaveResult`, `MirrorResult`, `RecordOutcome`, `InventoryVerdict`, `InventorySyncState`, `InventoryFixtures` (test), `MetaStore.inventoryPin`, `InventoryBatchCodec.{eventJson,payloadJson,digest,requestJson}`.
- Known simplification versus the station: no credential generations, receipts or floor-task pointer; Room transactions carry the atomicity.
