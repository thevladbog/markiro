# Handheld (TSD) Shift Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The handheld lists and enters cabinet-created shifts, validates product codes offline with the station's rules, journals and syncs scans in the station's batch protocol, shows the team and sync conflicts, leaves or closes a shift from the device, and ships every screen in Russian and English.

**Architecture:** The Android app ports the line station's shift model to Kotlin: Room tables mirror the station's SQLite (`shift_mirror`, `codes_mirror`, `scan_events`, `outbox`, `conflicts_mirror`, `shift_close_outbox`, `meta`), a pure-Kotlin `KmCodec` reproduces `packages/domain`'s KM canonicalisation and hash (verified by fixtures exported from the domain package), a single-threaded `ScanRecorder` writes verdicts transactionally, and a `SyncEngine` drains the outbox to `POST /station/scans` with pinned batch ceilings, exponential backoff and conflict recording. Two small server changes give station credentials read access to `GET /shifts/:id/summary` (participants only) and `GET /lines`.

**Tech Stack:** Kotlin 2.2, Jetpack Compose + Material 3, Hilt, Room 2.7 (explicit migration 1 → 2), OkHttp 4 + Retrofit 3 + kotlinx.serialization, AudioTrack + Vibrator, Robolectric 4.15, MockWebServer, Turbine; NestJS 11 + Drizzle for the API; vitest for the domain fixtures.

**Spec:** `docs/superpowers/specs/2026-09-10-handheld-shift-validation-design.md`

## Global Constraints

- Every user-visible string lives in `apps/handheld/app/src/main/res/values/strings.xml` (Russian, default) and `values-en/strings.xml`; Composables use `stringResource` / `pluralStringResource`. No Cyrillic literals remain in Kotlin sources after Task 9 (`grep -rn '"[^"]*[А-Яа-яЁё]' app/src/main/kotlin` prints nothing).
- Scan status words: ru `ПРИНЯТО / НЕВЕРНЫЙ КОД / ЧУЖОЙ ГТИН / ДУБЛЬ`, en `ACCEPTED / WRONG CODE / WRONG GTIN / DUPLICATE`.
- Verdict wire values: `ok`, `duplicate`, `wrong_gtin`, `invalid`. Code hash: lowercase hex SHA-256 of `01<gtin14>21<serial>` (UTF-8). `code` is present in a scan item iff `verdict == "ok"`.
- Sync: batches are a contiguous prefix of `outbox` by `id`, at most 100 items; `batchId = "<deviceId>:<installId>:<maxId>"`; the ceiling and batch id are persisted before the request and reused on retry; `alreadyApplied: true` is success; a response without `applied: Int` and `alreadyApplied: Boolean` is a failure; backoff `2 s → 60 s` doubling; heartbeat 15 s; stuck after 15 min.
- Capabilities header on every authenticated request: `handheld-v1,subscription-state-v1,station-recovery-v1` (never `validation-dm-duplicate-v1`).
- Tones: `ok` 880 Hz sine 120 ms, `duplicate` 440 Hz triangle 300 ms, `error` 220 Hz square 450 ms; vibration `ok` 40 ms, `duplicate` 2 × 80 ms, `error` 2 × 150 ms.
- Close reasons: `production_defect`, `material_shortage`, `equipment_stop`, `production_order_changed`, `planned_quantity_error`, `other_production_deviation`; a reason is required iff `plannedQty != null && plannedQty != actualQty`.
- Room database version 2 with an explicit `MIGRATION_1_2`; never `fallbackToDestructiveMigration`.
- The handheld gate stays `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` in `apps/handheld`; the repo gate for touched TypeScript is prettier + eslint + typecheck + the affected vitest files.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; use `/usr/bin/git` (the rtk hook rewrites `git`).

**Deviations from the spec, decided while planning:** (1) «Другие линии» needs the line list, and `GET /lines` is cabinet-only today; Task 1 opens it to station credentials the same way as the summary. (2) Signal settings (mute, volume, vibration) live in `AppPreferences` (SharedPreferences) rather than the `meta` table, because the scan hot path must not await Room; the `meta` table keeps the sync keys and the install id.

---

## File structure

**Server (`apps/api`, `packages/domain`)**

- Modify `apps/api/src/modules/shifts/shifts.controller.ts` — station-or-cabinet access on `GET /shifts/:id/summary`.
- Modify `apps/api/src/modules/shifts/shifts.service.ts` — participant check for station callers in `getShiftSummary`.
- Modify `apps/api/src/modules/lines/lines.controller.ts` — station-or-cabinet access on `GET /lines`.
- Create `apps/api/test/handheld-shift-read.e2e.test.ts` — summary and lines access by device.
- Create `packages/domain/scripts/export-km-fixtures.ts`, `packages/domain/src/gs1/km-fixtures.ts` (the fixture table; exported so the test and the script share it) and `packages/domain/test/km-fixtures.test.ts`.
- Create `apps/handheld/app/src/test/resources/km-fixtures.json` (generated).

**Android (`apps/handheld/app/src/main/kotlin/app/markiro/handheld/`)**

- `core/storage/ShiftEntities.kt` (new entities), `core/storage/ShiftDaos.kt`, `core/storage/Migrations.kt`, `core/storage/MetaStore.kt`; modify `HandheldDatabase.kt`, `Entities.kt` (`activeShiftId`), `StorageModule.kt`, `DeviceWipe.kt`.
- `core/km/KmCodec.kt`, `core/km/ShiftValidator.kt`.
- `core/network/ShiftDtos.kt`, `core/network/SyncDtos.kt`; modify `Dtos.kt` (capabilities), `StationApi.kt`, `NetworkModule.kt`.
- `core/scan/ScanRecorder.kt`.
- `core/signal/Signaller.kt`, `core/signal/SignalModule.kt`; modify `feature/settings/AppPreferences.kt`.
- `core/sync/SyncTransport.kt`, `core/sync/SyncEngine.kt`, `core/sync/SyncModule.kt`; modify `HandheldApp.kt`.
- `res/values/strings.xml`, `res/values-en/strings.xml` (full), `res/values/plurals` inside the same files; modify every screen of the foundation.
- `feature/shift/ShiftRepository.kt`, `ShiftListViewModel.kt`, `ShiftListScreen.kt`, `ShiftCloser.kt`, `CloseViewModel.kt`, `CloseScreens.kt`, `ShiftModule.kt`.
- `feature/work/TeamRefresher.kt`, `WorkViewModel.kt`, `WorkScreen.kt`, `ConflictsScreen.kt`.
- Modify `feature/hub/HubViewModel.kt`, `HubScreen.kt`, `feature/settings/SettingsViewModel.kt`, `SettingsScreens.kt`, `AppNavigation.kt`.
- Tests under `app/src/test/kotlin/app/markiro/handheld/` mirroring each package.

---

### Task 1: Station read access to the shift summary and the line list

**Files:**
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts` (the `getShiftSummary` route)
- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (`getShiftSummary` signature and participant check)
- Modify: `apps/api/src/modules/lines/lines.controller.ts` (the `GET /lines` route)
- Modify: `apps/api/test/shift-summary.service.test.ts` (new signature)
- Test: `apps/api/test/handheld-shift-read.e2e.test.ts`

**Interfaces:**
- Consumes: `AllowStationOrPermissions`, `ApiCabinetOrStationAuth` from `../../lib/openapi`, `createTestStationDevice(app, agent, name, { kind })` from `test/support/auth.ts`, `schema.shiftDeviceParticipants`.
- Produces: `getShiftSummary(tenantId, id, deviceId: string | null)`; `GET /shifts/:id/summary` answers 200 to a participating device, 403 to a non-participating one; `GET /lines` answers 200 to any device of the tenant.

- [ ] **Step 1: Write the failing e2e test**

`apps/api/test/handheld-shift-read.e2e.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1";

describe.skipIf(!ready)("handheld shift reads", () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: "04600000000015", name: "Вода", status: "active" });
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Линия 2" }).returning();
    const [otherLine] = await db
      .insert(schema.lines)
      .values({ tenantId, name: "Линия 3" })
      .returning();
    const participant = await createTestStationDevice(app, agent, "ТСД 1", { kind: "handheld" });
    const stranger = await createTestStationDevice(app, agent, "ТСД 2", { kind: "handheld" });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", lineId: line!.id, plannedQty: 10 })
      .expect(201);
    return { agent, tenantId, shiftId: created.body.id as string, line: line!, otherLine: otherLine!, participant, stranger };
  }

  it("lets a participating device read the shift summary and refuses a stranger", async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post(`/shifts/${f.shiftId}/enter`)
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);

    const summary = await request(app.getHttpServer())
      .get(`/shifts/${f.shiftId}/summary`)
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);
    expect(summary.body.output).toEqual({ mode: "validation", acceptedUnits: 0 });
    expect(Array.isArray(summary.body.participants)).toBe(true);

    const refused = await request(app.getHttpServer())
      .get(`/shifts/${f.shiftId}/summary`)
      .set("x-api-key", f.stranger.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(403);
    expect(refused.body.message).toBe("Device is not a participant of this shift");

    // The cabinet keeps reading it.
    await f.agent.get(`/shifts/${f.shiftId}/summary`).expect(200);
  });

  it("lets a device list the tenant's lines", async () => {
    const f = await fixture();
    const lines = await request(app.getHttpServer())
      .get("/lines")
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);
    const names = (lines.body.items as { name: string }[]).map((item) => item.name).sort();
    expect(names).toEqual(["Линия 2", "Линия 3"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from the repo root, outside the sandbox, with the dev env):
```bash
bash .superpowers/with-dev-env.sh pnpm --config.verify-deps-before-run=false --filter @markiro/api exec vitest run handheld-shift-read
```
Expected: both tests FAIL with 403 on the device requests (`Cabinet session required` / station forbidden).

- [ ] **Step 3: Open the summary route to station credentials**

In `apps/api/src/modules/shifts/shifts.controller.ts` replace the `getShiftSummary` route:

```ts
  @Get(":id/summary")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read factual shift output and participants",
    description:
      "Cabinet users read any shift of the organisation; a station or handheld device reads only shifts it has entered.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftSummaryOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getShiftSummary(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<ShiftSummaryDto> {
    return this.shiftsService.getShiftSummary(
      req.tenantId!,
      id,
      req.authKind === "station" ? (req.deviceId ?? null) : null,
    );
  }
```

`ApiCabinetAuth` stays imported (other routes use it).

- [ ] **Step 4: Add the participant check to the service**

In `apps/api/src/modules/shifts/shifts.service.ts` change the signature and add the check at the top of the transaction:

```ts
  async getShiftSummary(
    tenantId: string,
    id: string,
    deviceId: string | null = null,
  ): Promise<ShiftSummaryDto> {
    return this.db.transaction(
      async (tx) => {
        if (deviceId !== null) {
          const [participant] = await tx
            .select({ deviceId: schema.shiftDeviceParticipants.deviceId })
            .from(schema.shiftDeviceParticipants)
            .where(
              and(
                eq(schema.shiftDeviceParticipants.tenantId, tenantId),
                eq(schema.shiftDeviceParticipants.shiftId, id),
                eq(schema.shiftDeviceParticipants.deviceId, deviceId),
              ),
            )
            .limit(1);
          if (!participant) {
            throw new ForbiddenException("Device is not a participant of this shift");
          }
        }
        // ...existing body unchanged from here...
```

`and`, `eq` and `ForbiddenException` are already imported in this file (check the import block; add `ForbiddenException` to the `@nestjs/common` import if it is missing).

The unit test `apps/api/test/shift-summary.service.test.ts` calls `getShiftSummary(tenantId, id)`; the default `deviceId = null` keeps it passing. If it asserts the exact `execute` call count, it still holds: the participant check uses `tx.select`, which the mock does not define, and is skipped for `null`.

- [ ] **Step 5: Open the line list to station credentials**

In `apps/api/src/modules/lines/lines.controller.ts`, on the `@Get()` list route replace `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)` with `@AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)` and its `@ApiCabinetAuth()` with `@ApiCabinetOrStationAuth()`; import both from their existing modules (`../../authorization/access-policy`, `../../lib/openapi`). The create, update and delete routes keep `RequirePermissions`. Add to the `@ApiOperation` description: "Devices read the list to browse shifts of other lines."

- [ ] **Step 6: Run the tests**

```bash
bash .superpowers/with-dev-env.sh pnpm --config.verify-deps-before-run=false --filter @markiro/api exec vitest run handheld-shift-read shift-summary shifts-openapi openapi-docs lines
```
Expected: all PASS. If `shifts-openapi.test.ts` or `openapi-docs.test.ts` pins the summary route's security scheme, update the expectation to the cabinet-or-station scheme (same as the bundle route).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm --config.verify-deps-before-run=false exec prettier --check apps/api/src/modules/shifts apps/api/src/modules/lines apps/api/test/handheld-shift-read.e2e.test.ts
pnpm --config.verify-deps-before-run=false --filter @markiro/api typecheck
pnpm --config.verify-deps-before-run=false --filter @markiro/api lint
/usr/bin/git add apps/api/src/modules/shifts apps/api/src/modules/lines apps/api/test/handheld-shift-read.e2e.test.ts apps/api/test/shift-summary.service.test.ts
/usr/bin/git commit -m "feat(api): let a device read its shift summary and the line list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared KM fixtures exported from the domain package

**Files:**
- Create: `packages/domain/src/gs1/km-fixtures.ts`
- Create: `packages/domain/scripts/export-km-fixtures.ts`
- Create: `packages/domain/test/km-fixtures.test.ts`
- Create: `apps/handheld/app/src/test/resources/km-fixtures.json` (generated)
- Modify: `packages/domain/package.json` (script), `packages/domain/tsconfig.test.json` (include `scripts`)

**Interfaces:**
- Consumes: `canonicalizeKm`, `kmHash`, `kmKey`, `DomainError` from `packages/domain/src`.
- Produces: `buildKmFixtures(): KmFixture[]` and a JSON file `[{ name, raw, expected }]` where `expected` is `{ canonicalRaw, gtin14, serial, ais, key, hash }` or `{ error }`; also verdict cases `{ name, raw, expectedGtin14, verdict }`.

- [ ] **Step 1: Write the failing drift test**

`packages/domain/test/km-fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildKmFixtures } from "../src/gs1/km-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/km-fixtures.json", import.meta.url),
);

describe("KM fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    const expected = JSON.stringify(buildKmFixtures(), null, 2) + "\n";
    expect(committed).toBe(expected);
  });

  it("cover every parser error code at least once", () => {
    const errors = new Set(
      buildKmFixtures()
        .map((fixture) => ("error" in fixture.expected ? fixture.expected.error : null))
        .filter((code): code is string => code !== null),
    );
    for (const code of [
      "KM_EMPTY",
      "KM_NO_GTIN",
      "KM_BAD_GTIN",
      "KM_NO_SERIAL",
      "KM_BAD_AI",
      "KM_EMPTY_AI",
      "KM_DUPLICATE_AI",
      "KM_BAD_ENCODING",
      "KM_BAD_CONTROL",
      "KM_TOO_LONG",
      "GTIN_INVALID",
    ]) {
      expect(errors, code).toContain(code);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --config.verify-deps-before-run=false --filter @markiro/domain exec vitest run km-fixtures
```
Expected: FAIL (module `km-fixtures` not found).

- [ ] **Step 3: Write the fixture table**

`packages/domain/src/gs1/km-fixtures.ts`:

```ts
import { DomainError } from "../errors.js";
import { canonicalizeKm, kmHash, kmKey } from "./km.js";
import { validateShiftScan } from "../scan/validate.js";

const GS = "\u001d";
const GTIN = "04600682000013";
const BASE = `01${GTIN}21abcDEF1234567`;

export interface KmParseFixture {
  name: string;
  raw: string;
  expected:
    | { canonicalRaw: string; gtin14: string; serial: string; ais: Record<string, string>; key: string; hash: string }
    | { error: string };
}

export interface KmVerdictFixture {
  name: string;
  raw: string;
  expectedGtin14: string;
  /** Hashes the handheld pretends are already in its journal. */
  knownHashes: string[];
  verdict: "ok" | "duplicate" | "wrong_gtin" | "invalid";
}

export interface KmFixtures {
  parse: KmParseFixture[];
  verdict: KmVerdictFixture[];
}

const PARSE_CASES: { name: string; raw: string }[] = [
  { name: "plain gtin and serial", raw: BASE },
  { name: "crypto tail 93", raw: `${BASE}${GS}93AbCd` },
  { name: "crypto tail 91 92 93", raw: `${BASE}${GS}91EE07${GS}92dGVzdA==${GS}93AbCd` },
  { name: "aim prefix", raw: `]d2${BASE}${GS}93AbCd` },
  { name: "leading and trailing space and tab", raw: ` \t${BASE}\t ` },
  { name: "aim prefix then space", raw: `]d2 ${BASE}` },
  { name: "serial with symbols", raw: `01${GTIN}21!\"%&'()*+,-./:;<=>?_` },
  { name: "serial of one character", raw: `01${GTIN}21x` },
  { name: "gtin13 zero padded", raw: `014600682000013` + `21x` },
  { name: "unicode serial", raw: `01${GTIN}21сериЯ` },
  { name: "exactly 1024 bytes", raw: `01${GTIN}21${"a".repeat(1024 - 18)}` },
  { name: "empty", raw: "" },
  { name: "only spaces", raw: "   " },
  { name: "sscc not a km", raw: "00346006820000000014" },
  { name: "plain gtin not a km", raw: GTIN },
  { name: "wrong first ai", raw: `02${GTIN}21x` },
  { name: "short gtin field", raw: `01046006820000` },
  { name: "gtin with letter", raw: `0104600682A00013` + `21x` },
  { name: "bad check digit", raw: `0104600682000014` + `21x` },
  { name: "missing serial ai", raw: `01${GTIN}` },
  { name: "empty serial", raw: `01${GTIN}21` },
  { name: "empty serial before gs", raw: `01${GTIN}21${GS}93AbCd` },
  { name: "terminal gs", raw: `${BASE}${GS}` },
  { name: "double gs", raw: `${BASE}${GS}${GS}93AbCd` },
  { name: "ai too short", raw: `${BASE}${GS}9` },
  { name: "ai two characters no value", raw: `${BASE}${GS}93` },
  { name: "non digit ai", raw: `${BASE}${GS}9xAbCd` },
  { name: "empty ai value then more", raw: `${BASE}${GS}91${GS}93AbCd` },
  { name: "duplicate ai", raw: `${BASE}${GS}93AbCd${GS}93EfGh` },
  { name: "newline inside", raw: `01${GTIN}21ab\ncd` },
  { name: "carriage return at end", raw: `${BASE}\r` },
  { name: "nul inside", raw: `01${GTIN}21ab\u0000cd` },
  { name: "del inside", raw: `01${GTIN}21ab\u007fcd` },
  { name: "replacement character", raw: `01${GTIN}21ab\ufffdcd` },
  { name: "unpaired high surrogate", raw: `01${GTIN}21ab\ud83dcd` },
  { name: "unpaired low surrogate", raw: `01${GTIN}21ab\ude00cd` },
  { name: "paired surrogate ok", raw: `01${GTIN}21ab😀cd` },
  { name: "1025 bytes", raw: `01${GTIN}21${"a".repeat(1024 - 17)}` },
  { name: "1024 bytes by utf8 not chars", raw: `01${GTIN}21${"я".repeat((1024 - 18) / 2)}` },
];

const VERDICT_CASES: KmVerdictFixture[] = [
  { name: "accepted", raw: `${BASE}${GS}93AbCd`, expectedGtin14: GTIN, knownHashes: [], verdict: "ok" },
  {
    name: "duplicate by hash ignoring crypto tail",
    raw: `${BASE}${GS}93ZZZZ`,
    expectedGtin14: GTIN,
    knownHashes: [kmHash(canonicalizeKm(`${BASE}${GS}93AbCd`))],
    verdict: "duplicate",
  },
  { name: "wrong gtin", raw: `${BASE}${GS}93AbCd`, expectedGtin14: "04600000000015", knownHashes: [], verdict: "wrong_gtin" },
  {
    name: "wrong gtin beats duplicate",
    raw: `${BASE}${GS}93AbCd`,
    expectedGtin14: "04600000000015",
    knownHashes: [kmHash(canonicalizeKm(BASE))],
    verdict: "wrong_gtin",
  },
  { name: "garbage is invalid", raw: "hello", expectedGtin14: GTIN, knownHashes: [], verdict: "invalid" },
  { name: "sscc is invalid", raw: "00346006820000000014", expectedGtin14: GTIN, knownHashes: [], verdict: "invalid" },
  { name: "plain gtin is invalid", raw: GTIN, expectedGtin14: GTIN, knownHashes: [], verdict: "invalid" },
  { name: "bad check digit is invalid", raw: `0104600682000014` + `21x`, expectedGtin14: GTIN, knownHashes: [], verdict: "invalid" },
];

export function buildKmFixtures(): KmFixtures {
  const parse = PARSE_CASES.map(({ name, raw }): KmParseFixture => {
    try {
      const km = canonicalizeKm(raw);
      return {
        name,
        raw,
        expected: {
          canonicalRaw: km.raw,
          gtin14: km.gtin14,
          serial: km.serial,
          ais: km.ais,
          key: kmKey(km),
          hash: kmHash(km),
        },
      };
    } catch (error) {
      if (error instanceof DomainError) return { name, raw, expected: { error: error.code } };
      throw error;
    }
  });
  const verdict = VERDICT_CASES.map((fixture) => {
    const known = new Set(fixture.knownHashes);
    const actual = validateShiftScan(fixture.raw, {
      expectedGtin14: fixture.expectedGtin14,
      isDuplicate: (key) => known.has(key),
    }).status;
    if (actual !== fixture.verdict) {
      throw new Error(`fixture ${fixture.name}: expected ${fixture.verdict}, domain says ${actual}`);
    }
    return fixture;
  });
  return { parse, verdict };
}
```

Adjust the drift test's second `it` to read `buildKmFixtures().parse` (the table is `{ parse, verdict }`, not a flat array):

```ts
      buildKmFixtures().parse
        .map((fixture) => ("error" in fixture.expected ? fixture.expected.error : null))
```

`DomainError` exposes `code` (see `packages/domain/src/errors.ts`); if the property is named differently there, use that name.

- [ ] **Step 4: Write the export script**

`packages/domain/scripts/export-km-fixtures.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKmFixtures } from "../src/gs1/km-fixtures.js";

const target = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/km-fixtures.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildKmFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
```

Add to `packages/domain/package.json` scripts:

```json
    "fixtures:km": "node --experimental-strip-types scripts/export-km-fixtures.ts",
```

Node ≥ 24 runs TypeScript with `--experimental-strip-types` (type-only syntax; the script and the fixture module use only erasable syntax). If the flag is rejected on the installed Node, use `node --import tsx scripts/export-km-fixtures.ts` after `pnpm add -D tsx --filter @markiro/domain`.

Add `"scripts"` to `packages/domain/tsconfig.test.json` `include` so the script is typechecked:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 5: Generate the fixtures and run the tests**

```bash
pnpm --config.verify-deps-before-run=false --filter @markiro/domain fixtures:km
pnpm --config.verify-deps-before-run=false --filter @markiro/domain exec vitest run km-fixtures km
```
Expected: the JSON appears (`parse` ≈ 40 entries, `verdict` 8 entries), both suites PASS. Open the JSON and confirm `"exactly 1024 bytes"` has a hash and `"1025 bytes"` is `KM_TOO_LONG`; `"1024 bytes by utf8 not chars"` has a hash (Cyrillic letters are 2 bytes each).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm --config.verify-deps-before-run=false exec prettier --write packages/domain/src/gs1/km-fixtures.ts packages/domain/scripts/export-km-fixtures.ts packages/domain/test/km-fixtures.test.ts
pnpm --config.verify-deps-before-run=false --filter @markiro/domain typecheck
pnpm --config.verify-deps-before-run=false --filter @markiro/domain lint
/usr/bin/git add packages/domain apps/handheld/app/src/test/resources/km-fixtures.json
/usr/bin/git commit -m "feat(domain): export KM parse and verdict fixtures for the handheld

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Room schema version 2 — shift mirror, journal, outbox, conflicts, closes, meta

**Files:**
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftEntities.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftDaos.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt`
- Modify: `core/storage/Entities.kt`, `core/storage/HandheldDatabase.kt`, `core/storage/StorageModule.kt`, `core/storage/DeviceWipe.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/ShiftStorageTest.kt`, `MigrationTest.kt`; modify `core/storage/StorageTest.kt` and `AppShellViewModelTest.kt` (DeviceWipe constructor)

**Interfaces:**
- Produces entities `ShiftEntity`, `CodeEntity`, `ScanEventEntity`, `OutboxEntity`, `ConflictEntity`, `ShiftCloseEntity`, `MetaEntity`; DAOs `ShiftDao`, `CodeDao`, `ScanEventDao`, `OutboxDao`, `ConflictDao`, `ShiftCloseDao`, `MetaDao`; `MetaStore` with `installId()`, `get/put/remove`; `DeviceConfigEntity.activeShiftId`; `MIGRATION_1_2`; `DeviceWipe(db, credential)`.

- [ ] **Step 1: Write the failing storage test**

`app/src/test/kotlin/app/markiro/handheld/core/storage/ShiftStorageTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import android.database.sqlite.SQLiteConstraintException
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun outboxRow(raw: String, verdict: String = "ok") = OutboxEntity(
        shiftId = "s1",
        raw = raw,
        verdict = verdict,
        scannedAt = "2026-09-10T10:00:00.000Z",
        operatorId = null,
        codeHash = if (verdict == "ok") "a".repeat(64) else null,
        gtin14 = if (verdict == "ok") "04600682000013" else null,
        serial = if (verdict == "ok") raw else null,
    )

    @Test
    fun outboxIdsAreStrictlyIncreasingEvenAfterDeletes() = runTest {
        val outbox = db.outboxDao()
        outbox.insert(outboxRow("a"))
        outbox.insert(outboxRow("b"))
        outbox.deleteThrough(2)
        outbox.insert(outboxRow("c"))
        val rows = outbox.head(10)
        assertEquals(listOf("c"), rows.map { it.raw })
        assertTrue(rows.single().id > 2)
    }

    @Test
    fun headThroughReturnsOnlyRowsUpToTheCeiling() = runTest {
        val outbox = db.outboxDao()
        repeat(5) { outbox.insert(outboxRow("r$it")) }
        val ceiling = outbox.head(3).last().id
        outbox.insert(outboxRow("late"))
        assertEquals(listOf("r0", "r1", "r2"), outbox.headThrough(ceiling, 100).map { it.raw })
        assertEquals(6, outbox.count().first())
    }

    @Test
    fun codeHashIsAPrimaryKeyAcrossShifts() = runTest {
        val codes = db.codeDao()
        codes.insert(CodeEntity("h1", "s1", "04600682000013", "x", "2026-09-10T10:00:00.000Z"))
        val again = runCatching { codes.insert(CodeEntity("h1", "s2", "04600682000013", "x", "2026-09-10T11:00:00.000Z")) }
        assertTrue(again.exceptionOrNull() is SQLiteConstraintException)
        assertEquals("2026-09-10T10:00:00.000Z", codes.get("h1")?.scannedAt)
        assertEquals(1, codes.countForShift("s1"))
        assertEquals(0, codes.countForShift("s2"))
    }

    @Test
    fun shiftCloseIsUniquePerShift() = runTest {
        val closes = db.shiftCloseDao()
        closes.insert(ShiftCloseEntity("e1", "s1", null, 10, 8, 0, "material_shortage", "2026-09-10T12:00:00.000Z", "pending", null, null))
        val second = runCatching { closes.insert(ShiftCloseEntity("e2", "s1", null, 10, 9, 0, null, "2026-09-10T12:01:00.000Z", "pending", null, null)) }
        assertTrue(second.exceptionOrNull() is SQLiteConstraintException)
        assertEquals("e1", closes.forShift("s1")?.eventId)
        closes.markConflict("e1", "multiple_devices", "2026-09-10T12:02:00.000Z")
        assertEquals("conflict", closes.forShift("s1")?.state)
        assertTrue(closes.pending().isEmpty())
    }

    @Test
    fun metaStoreCreatesOneInstallIdAndKeepsIt() = runTest {
        val meta = MetaStore(db.metaDao())
        val first = meta.installId()
        assertEquals(first, meta.installId())
        assertEquals(36, first.length)
        meta.put("k", "v")
        assertEquals("v", meta.get("k"))
        meta.remove("k")
        assertNull(meta.get("k"))
        assertNotEquals("", first)
    }

    @Test
    fun wipeClearsEveryTable() = runTest {
        db.shiftDao().upsert(sampleShift())
        db.codeDao().insert(CodeEntity("h1", "s1", "04600682000013", "x", "2026-09-10T10:00:00.000Z"))
        db.outboxDao().insert(outboxRow("a"))
        db.conflictDao().insertIgnore(listOf(ConflictEntity("h9", null, "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z")))
        db.metaDao().put(MetaEntity("install_id", "id"))
        DeviceWipe(db, InMemoryCredentialStore()).wipeAll()
        assertTrue(db.shiftDao().all().isEmpty())
        assertNull(db.codeDao().get("h1"))
        assertEquals(0, db.outboxDao().count().first())
        assertEquals(0, db.conflictDao().count().first())
        assertNull(db.metaDao().get("install_id"))
    }

    private fun sampleShift() = ShiftEntity(
        id = "s1", number = "SEP26-001", status = "planned", mode = "validation", productId = "p1",
        productName = "Вода", productPrintName = null, productGtin14 = null, lineId = "l1", lineName = "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null,
        boxCapacity = null, palletCapacity = null, palletsEnabled = false, validationPrintMode = "none",
        closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L,
    )
}
```

`app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt` (opens a hand-made version-1 database, then lets Room migrate; Room validates every table after the migration and throws if a column or index disagrees with the entities):

```kotlin
package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MigrationTest {
    @Test
    fun migratesAPairedVersionOneDatabaseAndKeepsTheConfig() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "migration-test.db"
        context.deleteDatabase(name)
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name).also { it.parentFile?.mkdirs() }, null).use { legacy ->
            legacy.execSQL(
                "CREATE TABLE `device_config` (`id` INTEGER NOT NULL, `deviceId` TEXT NOT NULL, `deviceName` TEXT NOT NULL, " +
                    "`tenantId` TEXT NOT NULL, `organizationName` TEXT NOT NULL, `lineId` TEXT, `lineName` TEXT, `kind` TEXT NOT NULL, " +
                    "`serverUrl` TEXT NOT NULL, `pairedAt` INTEGER NOT NULL, `rosterFetchedAt` INTEGER, `lastOperatorId` TEXT, " +
                    "`shiftsCount` INTEGER, `inventoryCount` INTEGER, `countsAt` INTEGER, PRIMARY KEY(`id`))",
            )
            legacy.execSQL(
                "CREATE TABLE `operators` (`operatorId` TEXT NOT NULL, `name` TEXT NOT NULL, `login` TEXT NOT NULL, `role` TEXT NOT NULL, " +
                    "`pinHash` TEXT NOT NULL, `badgeHash` TEXT, `active` INTEGER NOT NULL, PRIMARY KEY(`operatorId`))",
            )
            legacy.execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
            legacy.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, 'legacy')")
            legacy.execSQL(
                "INSERT INTO device_config VALUES (1, 'dev-1', 'ТСД 1', 't-1', 'ООО', 'l-2', 'Линия 2', 'handheld', 'http://x', 1, NULL, NULL, NULL, NULL, NULL)",
            )
            legacy.version = 1
        }
        val db = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
            .addMigrations(MIGRATION_1_2)
            .allowMainThreadQueries()
            .build()
        try {
            val config = db.deviceConfigDao().get()
            assertEquals("dev-1", config?.deviceId)
            assertEquals(null, config?.activeShiftId)
            db.outboxDao().insert(
                OutboxEntity(shiftId = "s", raw = "r", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null, gtin14 = null, serial = null),
            )
            assertEquals(1, db.outboxDao().head(1).size)
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }
}
```

The identity hash written by the test does not matter: Room compares it only when the version is unchanged; on 1 → 2 it runs the migration and then validates the tables structurally.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftStorageTest*' --tests '*MigrationTest*'
```
Expected: compilation FAILS (missing entities, DAOs, `MIGRATION_1_2`).

- [ ] **Step 3: Add the entities**

`core/storage/ShiftEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Cached `GET /shifts` rows, enriched by the bundle on entry. `bundleFetchedAt` marks an offline-enterable shift. */
@Entity(tableName = "shift_mirror")
data class ShiftEntity(
    @PrimaryKey val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val productId: String,
    val productName: String?,
    val productPrintName: String?,
    val productGtin14: String?,
    val lineId: String?,
    val lineName: String?,
    val counterpartyName: String?,
    val plannedQty: Int?,
    val plannedDate: String?,
    val productionDate: String?,
    val boxCapacity: Int?,
    val palletCapacity: Int?,
    val palletsEnabled: Boolean,
    val validationPrintMode: String,
    val closePolicyKind: String?,
    val closeOwnerDeviceId: String?,
    val openedAt: String?,
    val listFetchedAt: Long,
    val bundleFetchedAt: Long? = null,
    val enteredAt: Long? = null,
    val leftAt: Long? = null,
)

/** Accepted codes on this device, keyed by the KM hash device-wide (a code is one physical item). */
@Entity(tableName = "codes_mirror")
data class CodeEntity(
    @PrimaryKey val codeHash: String,
    val shiftId: String,
    val gtin14: String,
    val serial: String,
    val scannedAt: String,
)

/** Every scan with its final verdict; feeds the recent list and the counters. */
@Entity(tableName = "scan_events")
data class ScanEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val shiftId: String,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val operatorId: String?,
    val codeHash: String?,
)

/** Rows waiting for `POST /station/scans`; `id` order is the batch order and ids are never reused. */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val shiftId: String,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val operatorId: String?,
    val codeHash: String?,
    val gtin14: String?,
    val serial: String?,
)

@Entity(tableName = "conflicts_mirror")
data class ConflictEntity(
    @PrimaryKey val codeHash: String,
    val winningTerminalId: String?,
    val winningScannedAt: String,
    val detectedAt: String,
)

@Entity(
    tableName = "shift_close_outbox",
    indices = [Index(value = ["shiftId"], unique = true, name = "index_shift_close_outbox_shiftId")],
)
data class ShiftCloseEntity(
    @PrimaryKey val eventId: String,
    val shiftId: String,
    val operatorId: String?,
    val plannedQtySnapshot: Int?,
    val actualQty: Int,
    val closedBoxCount: Int,
    val reasonCode: String?,
    val closedAt: String,
    val state: String,
    val conflictCode: String?,
    val lastCheckedAt: String?,
)

@Entity(tableName = "meta")
data class MetaEntity(@PrimaryKey val key: String, val value: String)
```

In `core/storage/Entities.kt` add the last field of `DeviceConfigEntity`:

```kotlin
    val countsAt: Long? = null,
    /** Shift this handheld is working in or paused from; the hub pins «Продолжить» on it. */
    val activeShiftId: String? = null,
)
```

- [ ] **Step 4: Add the DAOs, the meta store and the migration**

`core/storage/ShiftDaos.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ShiftDao {
    @Query("SELECT * FROM shift_mirror ORDER BY plannedDate DESC, number DESC")
    fun observeAll(): Flow<List<ShiftEntity>>

    @Query("SELECT * FROM shift_mirror")
    suspend fun all(): List<ShiftEntity>

    @Query("SELECT * FROM shift_mirror WHERE id = :id")
    suspend fun get(id: String): ShiftEntity?

    @Query("SELECT * FROM shift_mirror WHERE id = :id")
    fun observe(id: String): Flow<ShiftEntity?>

    @Upsert
    suspend fun upsert(shift: ShiftEntity)

    @Upsert
    suspend fun upsertAll(shifts: List<ShiftEntity>)

    @Query("UPDATE shift_mirror SET status = :status WHERE id = :id")
    suspend fun setStatus(id: String, status: String)

    @Query("UPDATE shift_mirror SET leftAt = :at WHERE id = :id")
    suspend fun setLeftAt(id: String, at: Long?)

    @Query("DELETE FROM shift_mirror WHERE bundleFetchedAt IS NULL AND id NOT IN (:keep)")
    suspend fun dropListedExcept(keep: List<String>)

    @Query("DELETE FROM shift_mirror")
    suspend fun clear()
}

@Dao
interface CodeDao {
    @Query("SELECT * FROM codes_mirror WHERE codeHash = :hash")
    suspend fun get(hash: String): CodeEntity?

    /** ABORT on a duplicate hash: the caller turns the constraint failure into a `duplicate` verdict. */
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(code: CodeEntity)

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE shiftId = :shiftId")
    suspend fun countForShift(shiftId: String): Int

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE shiftId = :shiftId")
    fun observeCountForShift(shiftId: String): Flow<Int>

    @Query("DELETE FROM codes_mirror")
    suspend fun clear()
}

@Dao
interface ScanEventDao {
    @Insert
    suspend fun insert(event: ScanEventEntity): Long

    @Query("SELECT * FROM scan_events WHERE shiftId = :shiftId ORDER BY id DESC LIMIT :limit")
    fun observeRecent(shiftId: String, limit: Int): Flow<List<ScanEventEntity>>

    @Query("SELECT COUNT(*) FROM scan_events WHERE shiftId = :shiftId AND verdict = :verdict")
    fun observeCount(shiftId: String, verdict: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM scan_events WHERE shiftId = :shiftId AND verdict = :verdict")
    suspend fun count(shiftId: String, verdict: String): Int

    @Query("DELETE FROM scan_events")
    suspend fun clear()
}

@Dao
interface OutboxDao {
    @Insert
    suspend fun insert(row: OutboxEntity): Long

    @Query("SELECT * FROM outbox ORDER BY id LIMIT :limit")
    suspend fun head(limit: Int): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE id <= :ceiling ORDER BY id LIMIT :limit")
    suspend fun headThrough(ceiling: Long, limit: Int): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE id <= :ceiling")
    suspend fun deleteThrough(ceiling: Long)

    @Query("SELECT COUNT(*) FROM outbox")
    fun count(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun countNow(): Int

    @Query("DELETE FROM outbox")
    suspend fun clear()
}

@Dao
interface ConflictDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(rows: List<ConflictEntity>)

    @Query("SELECT * FROM conflicts_mirror ORDER BY detectedAt DESC")
    fun observeAll(): Flow<List<ConflictEntity>>

    @Query("SELECT COUNT(*) FROM conflicts_mirror")
    fun count(): Flow<Int>

    @Query("SELECT codeHash FROM conflicts_mirror WHERE codeHash > :after ORDER BY codeHash LIMIT :limit")
    suspend fun pageHashes(after: String, limit: Int): List<String>

    @Query("DELETE FROM conflicts_mirror WHERE codeHash IN (:hashes)")
    suspend fun delete(hashes: List<String>)

    @Query("DELETE FROM conflicts_mirror")
    suspend fun clear()
}

@Dao
interface ShiftCloseDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: ShiftCloseEntity)

    @Query("SELECT * FROM shift_close_outbox WHERE shiftId = :shiftId")
    suspend fun forShift(shiftId: String): ShiftCloseEntity?

    @Query("SELECT * FROM shift_close_outbox WHERE shiftId = :shiftId")
    fun observeForShift(shiftId: String): Flow<ShiftCloseEntity?>

    @Query("SELECT * FROM shift_close_outbox WHERE state = 'pending' ORDER BY closedAt")
    suspend fun pending(): List<ShiftCloseEntity>

    @Query("DELETE FROM shift_close_outbox WHERE eventId = :eventId")
    suspend fun delete(eventId: String)

    @Query("UPDATE shift_close_outbox SET state = 'conflict', conflictCode = :code, lastCheckedAt = :at WHERE eventId = :eventId")
    suspend fun markConflict(eventId: String, code: String, at: String)

    @Query("DELETE FROM shift_close_outbox")
    suspend fun clear()
}

@Dao
interface MetaDao {
    @Query("SELECT value FROM meta WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: MetaEntity)

    @Query("DELETE FROM meta WHERE `key` = :key")
    suspend fun remove(key: String)

    @Query("DELETE FROM meta")
    suspend fun clear()
}
```

`core/storage/MetaStore.kt`:

```kotlin
package app.markiro.handheld.core.storage

import java.util.UUID

/** Small key-value store for sync bookkeeping; the install id changes only with the database. */
class MetaStore(private val dao: MetaDao) {
    suspend fun get(key: String): String? = dao.get(key)

    suspend fun put(key: String, value: String) = dao.put(MetaEntity(key, value))

    suspend fun remove(key: String) = dao.remove(key)

    /** Random per-database id that keeps batch ids unique after a wipe that kept the enrollment. */
    suspend fun installId(): String = dao.get(INSTALL_ID) ?: UUID.randomUUID().toString().also { dao.put(MetaEntity(INSTALL_ID, it)) }

    companion object {
        const val INSTALL_ID = "install_id"
        const val SYNC_PENDING_BATCH_ID = "sync_pending_batch_id"
        const val SYNC_PENDING_CEILING = "sync_pending_ceiling"
        const val SYNC_LAST_SUCCESS_AT = "sync_last_success_at"
        const val SYNC_LAST_DENIED = "sync_last_denied"
    }
}
```

`core/storage/Migrations.kt` (column types follow Room's affinity for the Kotlin types above: `String` → `TEXT NOT NULL`, `String?` → `TEXT`, `Int`/`Long`/`Boolean` → `INTEGER NOT NULL`, nullable numbers → `INTEGER`):

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** Version 1 (foundation) → 2 (shift validation). Additive only; pairing and the roster survive. */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `device_config` ADD COLUMN `activeShiftId` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `shift_mirror` (`id` TEXT NOT NULL, `number` TEXT NOT NULL, `status` TEXT NOT NULL, " +
                "`mode` TEXT NOT NULL, `productId` TEXT NOT NULL, `productName` TEXT, `productPrintName` TEXT, `productGtin14` TEXT, " +
                "`lineId` TEXT, `lineName` TEXT, `counterpartyName` TEXT, `plannedQty` INTEGER, `plannedDate` TEXT, `productionDate` TEXT, " +
                "`boxCapacity` INTEGER, `palletCapacity` INTEGER, `palletsEnabled` INTEGER NOT NULL, `validationPrintMode` TEXT NOT NULL, " +
                "`closePolicyKind` TEXT, `closeOwnerDeviceId` TEXT, `openedAt` TEXT, `listFetchedAt` INTEGER NOT NULL, " +
                "`bundleFetchedAt` INTEGER, `enteredAt` INTEGER, `leftAt` INTEGER, PRIMARY KEY(`id`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `codes_mirror` (`codeHash` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `gtin14` TEXT NOT NULL, " +
                "`serial` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, PRIMARY KEY(`codeHash`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `scan_events` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`raw` TEXT NOT NULL, `verdict` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `operatorId` TEXT, `codeHash` TEXT)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`raw` TEXT NOT NULL, `verdict` TEXT NOT NULL, `scannedAt` TEXT NOT NULL, `operatorId` TEXT, `codeHash` TEXT, " +
                "`gtin14` TEXT, `serial` TEXT)",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `conflicts_mirror` (`codeHash` TEXT NOT NULL, `winningTerminalId` TEXT, " +
                "`winningScannedAt` TEXT NOT NULL, `detectedAt` TEXT NOT NULL, PRIMARY KEY(`codeHash`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `shift_close_outbox` (`eventId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `operatorId` TEXT, " +
                "`plannedQtySnapshot` INTEGER, `actualQty` INTEGER NOT NULL, `closedBoxCount` INTEGER NOT NULL, `reasonCode` TEXT, " +
                "`closedAt` TEXT NOT NULL, `state` TEXT NOT NULL, `conflictCode` TEXT, `lastCheckedAt` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_shift_close_outbox_shiftId` ON `shift_close_outbox` (`shiftId`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `meta` (`key` TEXT NOT NULL, `value` TEXT NOT NULL, PRIMARY KEY(`key`))")
    }
}
```

`core/storage/HandheldDatabase.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        DeviceConfigEntity::class,
        OperatorEntity::class,
        ShiftEntity::class,
        CodeEntity::class,
        ScanEventEntity::class,
        OutboxEntity::class,
        ConflictEntity::class,
        ShiftCloseEntity::class,
        MetaEntity::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class HandheldDatabase : RoomDatabase() {
    abstract fun deviceConfigDao(): DeviceConfigDao
    abstract fun operatorDao(): OperatorDao
    abstract fun shiftDao(): ShiftDao
    abstract fun codeDao(): CodeDao
    abstract fun scanEventDao(): ScanEventDao
    abstract fun outboxDao(): OutboxDao
    abstract fun conflictDao(): ConflictDao
    abstract fun shiftCloseDao(): ShiftCloseDao
    abstract fun metaDao(): MetaDao
}
```

`core/storage/DeviceWipe.kt` (takes the database so every table is cleared in one transaction):

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.withTransaction

/** Brief 07: a revoked or unbound device drops its credential and cache and returns to pairing. */
class DeviceWipe(private val db: HandheldDatabase, private val credential: CredentialStore) {
    suspend fun wipeAll() {
        credential.clear()
        db.withTransaction {
            db.outboxDao().clear()
            db.scanEventDao().clear()
            db.codeDao().clear()
            db.conflictDao().clear()
            db.shiftCloseDao().clear()
            db.shiftDao().clear()
            db.metaDao().clear()
            db.operatorDao().clear()
            db.deviceConfigDao().clear()
        }
    }
}
```

`core/storage/StorageModule.kt`: register the migration and the new providers.

```kotlin
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): HandheldDatabase =
        Room.databaseBuilder(context, HandheldDatabase::class.java, "handheld.db")
            .addMigrations(MIGRATION_1_2)
            .build()

    @Provides fun shiftDao(db: HandheldDatabase): ShiftDao = db.shiftDao()
    @Provides fun codeDao(db: HandheldDatabase): CodeDao = db.codeDao()
    @Provides fun scanEventDao(db: HandheldDatabase): ScanEventDao = db.scanEventDao()
    @Provides fun outboxDao(db: HandheldDatabase): OutboxDao = db.outboxDao()
    @Provides fun conflictDao(db: HandheldDatabase): ConflictDao = db.conflictDao()
    @Provides fun shiftCloseDao(db: HandheldDatabase): ShiftCloseDao = db.shiftCloseDao()
    @Provides @Singleton fun metaStore(db: HandheldDatabase): MetaStore = MetaStore(db.metaDao())

    @Provides
    fun deviceWipe(db: HandheldDatabase, credential: CredentialStore): DeviceWipe = DeviceWipe(db, credential)
```

Remove the old `deviceWipe(config, operators, credential)` provider.

- [ ] **Step 5: Fix the callers of `DeviceWipe`**

`AppShellViewModelTest.kt` builds `DeviceWipe(config, operators, credential)` with fakes. Replace the fakes with an in-memory Room database:

```kotlin
    private val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
        .allowMainThreadQueries()
        .build()
    private val config get() = db.deviceConfigDao()
    private val credential = InMemoryCredentialStore()
    private fun vm() = AppShellViewModel(config, session, revocation, DeviceWipe(db, credential), idleMs = 5 * 60 * 1000L)
```

Annotate the class with `@RunWith(AndroidJUnit4::class)`, seed `configFlow.value = paired` through `config.upsert(paired)` (the DAO is real now), and read back with `config.get()` in the assertions (`assertNull(config.get())` after revocation). Keep `MainDispatcherRule`; Room's `Flow` queries deliver on the test dispatcher through `allowMainThreadQueries()`. If `revocationWipesEverythingAndEmitsAnEvent` needs the flow to emit before `first()`, call `advanceUntilIdle()` after `upsert`.

`StorageTest.kt` may also construct `DeviceWipe`; update it the same way.

- [ ] **Step 6: Run the storage tests, then the whole suite**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.storage*' --tests '*AppShellViewModelTest*'
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest
```
Expected: PASS. If `MigrationTest` fails with `Migration didn't properly handle: <table>`, the message lists the expected vs found `TableInfo`; align the SQL in `Migrations.kt` (never the entity) until it passes.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): Room v2 with shift mirror, journal, outbox, conflicts, closes and meta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: `KmCodec` and `ShiftValidator` on the shared fixtures

**Files:**
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/km/KmCodec.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/km/ShiftValidator.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/km/KmFixturesTest.kt`

**Interfaces:**
- Consumes: `km-fixtures.json` from Task 2.
- Produces: `KmCodec.canonicalize(raw): ParsedKm` (throws `KmException(code)`), `KmCodec.key(km)`, `KmCodec.hash(km)`; `Verdict` enum with `wire`; `ShiftValidator.classify(raw, expectedGtin14): Classification` and `ShiftValidator.verdict(raw, expectedGtin14, isDuplicate)`.

- [ ] **Step 1: Write the failing fixture test**

`app/src/test/kotlin/app/markiro/handheld/core/km/KmFixturesTest.kt`:

```kotlin
package app.markiro.handheld.core.km

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KmFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("km-fixtures.json")) { "run pnpm --filter @markiro/domain fixtures:km" }
            .readText(),
    ).jsonObject

    @Test
    fun parseFixturesMatchTheDomainPackage() {
        val cases = fixtures.getValue("parse").jsonArray
        assertTrue(cases.size >= 35)
        for (case in cases) {
            val name = case.jsonObject.getValue("name").jsonPrimitive.content
            val raw = case.jsonObject.getValue("raw").jsonPrimitive.content
            val expected = case.jsonObject.getValue("expected").jsonObject
            val error = expected["error"]?.jsonPrimitive?.content
            if (error != null) {
                val thrown = runCatching { KmCodec.canonicalize(raw) }.exceptionOrNull()
                assertTrue("$name: expected $error, got ${thrown ?: "success"}", thrown is KmException)
                assertEquals(name, error, (thrown as KmException).code)
            } else {
                val km = KmCodec.canonicalize(raw)
                assertEquals(name, expected.getValue("canonicalRaw").jsonPrimitive.content, km.canonicalRaw)
                assertEquals(name, expected.getValue("gtin14").jsonPrimitive.content, km.gtin14)
                assertEquals(name, expected.getValue("serial").jsonPrimitive.content, km.serial)
                assertEquals(name, expected.getValue("ais").jsonObject.mapValues { it.value.jsonPrimitive.content }, km.ais)
                assertEquals(name, expected.getValue("key").jsonPrimitive.content, KmCodec.key(km))
                assertEquals(name, expected.getValue("hash").jsonPrimitive.content, KmCodec.hash(km))
            }
        }
    }

    @Test
    fun verdictFixturesFollowTheDomainOrder() {
        val cases = fixtures.getValue("verdict").jsonArray
        assertTrue(cases.size >= 8)
        for (case in cases) {
            val o = case.jsonObject
            val known = o.getValue("knownHashes").jsonArray.map { it.jsonPrimitive.content }.toSet()
            val verdict = ShiftValidator.verdict(
                o.getValue("raw").jsonPrimitive.content,
                o.getValue("expectedGtin14").jsonPrimitive.content,
            ) { it in known }
            assertEquals(o.getValue("name").jsonPrimitive.content, o.getValue("verdict").jsonPrimitive.content, verdict.wire)
        }
    }

    @Test
    fun hashIsSha256OfTheKey() {
        val km = KmCodec.canonicalize("010460068200001321x")
        assertEquals("0104600682000013" + "21x", KmCodec.key(km))
        assertEquals(64, KmCodec.hash(km).length)
        assertTrue(KmCodec.hash(km).all { it in '0'..'9' || it in 'a'..'f' })
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*KmFixturesTest*'
```
Expected: compilation FAILS (`KmCodec` missing).

- [ ] **Step 3: Port the codec**

`core/km/KmCodec.kt`:

```kotlin
package app.markiro.handheld.core.km

import java.security.MessageDigest

/** Same codes as `DomainError` in packages/domain (`KM_*`, `GTIN_INVALID`). */
class KmException(val code: String, message: String) : RuntimeException(message)

/** `canonicalRaw` is what the server re-parses; `ais` keeps the crypto tail for display only. */
data class ParsedKm(val canonicalRaw: String, val gtin14: String, val serial: String, val ais: Map<String, String>)

/**
 * Port of packages/domain/src/gs1/km.ts (`canonicalizeKm`, `parseKm`, `kmKey`, `kmHash`) and
 * gtin.ts / check-digit.ts. Verified against the fixtures the domain package exports; any
 * divergence makes the server reject a whole scan batch, so change both sides together.
 */
object KmCodec {
    const val GS = '\u001d'
    const val MAX_UTF8_BYTES = 1024
    private val GTIN_LENGTHS = setOf(8, 12, 13, 14)

    fun canonicalize(raw: String): ParsedKm {
        var s = trimEdges(raw)
        if (s.startsWith("]d2")) s = s.substring(3)
        s = trimEdges(s)
        if (s.contains('\ufffd')) throw KmException("KM_BAD_ENCODING", "KM contains a replacement character")
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c.isHighSurrogate()) {
                if (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) {
                    throw KmException("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate")
                }
                i += 2
                continue
            }
            if (c.isLowSurrogate()) throw KmException("KM_BAD_ENCODING", "KM contains an unpaired UTF-16 surrogate")
            if ((c.code < 0x20 && c != GS) || c.code == 0x7f) {
                throw KmException("KM_BAD_CONTROL", "KM contains a forbidden control character")
            }
            i += 1
        }
        if (s.toByteArray(Charsets.UTF_8).size > MAX_UTF8_BYTES) {
            throw KmException("KM_TOO_LONG", "KM exceeds the $MAX_UTF8_BYTES-byte UTF-8 limit")
        }
        return parse(s)
    }

    /** Structural parse of `01<gtin14>21<serial>[GS<ai><value>]*`, then GTIN check digit, then duplicate AIs. */
    fun parse(raw: String): ParsedKm {
        if (raw.isEmpty()) throw KmException("KM_EMPTY", "empty scan")
        var s = if (raw.startsWith("]d2")) raw.substring(3) else raw
        if (!s.startsWith("01")) throw KmException("KM_NO_GTIN", "KM must start with AI 01")
        val gtinField = s.substring(2, minOf(16, s.length))
        if (gtinField.length != 14 || !gtinField.all { it in '0'..'9' }) {
            throw KmException("KM_BAD_GTIN", "KM AI 01 GTIN must be 14 digits")
        }
        s = s.substring(16)
        if (!s.startsWith("21")) throw KmException("KM_NO_SERIAL", "KM must carry AI 21 serial")
        val gsAt = s.indexOf(GS)
        val serial = if (gsAt == -1) s.substring(2) else s.substring(2, gsAt)
        if (serial.isEmpty()) throw KmException("KM_NO_SERIAL", "KM serial is empty")
        val ordered = ArrayList<Pair<String, String>>()
        var rest = if (gsAt == -1) "" else s.substring(gsAt + 1)
        if (gsAt != -1 && rest.isEmpty()) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
        while (rest.isNotEmpty()) {
            if (rest.startsWith(GS)) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
            if (rest.length <= 2) throw KmException("KM_BAD_AI", "KM contains an incomplete trailing AI segment")
            val ai = rest.substring(0, 2)
            if (!ai.all { it in '0'..'9' }) throw KmException("KM_BAD_AI", "KM trailing AI must be two digits")
            val end = rest.indexOf(GS)
            val value = if (end == -1) rest.substring(2) else rest.substring(2, end)
            if (value.isEmpty()) throw KmException("KM_EMPTY_AI", "KM trailing AI $ai has an empty value")
            if (end == rest.length - 1) throw KmException("KM_EMPTY_AI", "KM contains an empty trailing AI segment")
            ordered += ai to value
            rest = if (end == -1) "" else rest.substring(end + 1)
        }
        val gtin14 = normalizeGtin14(gtinField)
        val ais = LinkedHashMap<String, String>()
        for ((ai, value) in ordered) {
            if (ais.containsKey(ai)) throw KmException("KM_DUPLICATE_AI", "KM contains duplicate trailing AI $ai")
            ais[ai] = value
        }
        return ParsedKm(raw, gtin14, serial, ais)
    }

    /** Canonical duplicate-detection identity; the crypto tail is deliberately excluded. */
    fun key(km: ParsedKm): String = "01${km.gtin14}21${km.serial}"

    fun hash(km: ParsedKm): String =
        MessageDigest.getInstance("SHA-256").digest(key(km).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun normalizeGtin14(input: String): String {
        if (input.isEmpty() || !input.all { it in '0'..'9' } || input.length !in GTIN_LENGTHS) {
            throw KmException("GTIN_INVALID", "not a GTIN: \"$input\"")
        }
        if (!hasValidCheckDigit(input)) throw KmException("GTIN_INVALID", "check digit mismatch: \"$input\"")
        return input.padStart(14, '0')
    }

    /** GS1 mod-10: the rightmost body digit carries weight 3, alternating leftwards. */
    fun checkDigit(body: String): Int {
        var sum = 0
        for (i in body.indices) {
            val digit = body[body.length - 1 - i] - '0'
            sum += if (i % 2 == 0) digit * 3 else digit
        }
        return (10 - (sum % 10)) % 10
    }

    fun hasValidCheckDigit(code: String): Boolean =
        code.length >= 2 && code.all { it in '0'..'9' } && checkDigit(code.dropLast(1)) == code.last() - '0'

    private fun trimEdges(s: String): String {
        var start = 0
        var end = s.length
        while (start < end && (s[start] == ' ' || s[start] == '\t')) start += 1
        while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t')) end -= 1
        return s.substring(start, end)
    }
}
```

`core/km/ShiftValidator.kt`:

```kotlin
package app.markiro.handheld.core.km

/** Wire values of `POST /station/scans` items. */
enum class Verdict(val wire: String) {
    OK("ok"),
    DUPLICATE("duplicate"),
    WRONG_GTIN("wrong_gtin"),
    INVALID("invalid"),
    ;

    companion object {
        fun fromWire(value: String): Verdict = entries.first { it.wire == value }
    }
}

/** Everything known before the journal is consulted; `Km` still needs the duplicate check. */
sealed interface Classification {
    data class Km(val km: ParsedKm, val hash: String) : Classification
    data class WrongGtin(val km: ParsedKm, val expectedGtin14: String) : Classification
    data class Invalid(val code: String) : Classification
}

/** Port of packages/domain/src/scan/validate.ts: invalid → wrong_gtin → duplicate → ok. */
object ShiftValidator {
    fun classify(raw: String, expectedGtin14: String): Classification {
        val km = try {
            KmCodec.canonicalize(raw)
        } catch (e: KmException) {
            return Classification.Invalid(e.code)
        }
        if (km.gtin14 != expectedGtin14) return Classification.WrongGtin(km, expectedGtin14)
        return Classification.Km(km, KmCodec.hash(km))
    }

    fun verdict(raw: String, expectedGtin14: String, isDuplicate: (String) -> Boolean): Verdict = when (val c = classify(raw, expectedGtin14)) {
        is Classification.Invalid -> Verdict.INVALID
        is Classification.WrongGtin -> Verdict.WRONG_GTIN
        is Classification.Km -> if (isDuplicate(c.hash)) Verdict.DUPLICATE else Verdict.OK
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*KmFixturesTest*'
```
Expected: 3 tests PASS. A failing fixture names the case; fix the codec, never the JSON.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/km apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/km
/usr/bin/git commit -m "feat(handheld): KM codec and shift verdict matching the domain fixtures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Shift, bundle, summary, line and sync DTOs; API endpoints; capabilities

**Files:**
- Modify: `core/network/Dtos.kt` (capabilities constant, full `ShiftDto`)
- Create: `core/network/ShiftDtos.kt`, `core/network/SyncDtos.kt`
- Modify: `core/network/StationApi.kt`, `core/network/NetworkModule.kt` (`@Strict` Json)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/DtosTest.kt`

**Interfaces:**
- Produces: `HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1"`, `UPDATE_REQUIRED_CODE = "STATION_UPDATE_REQUIRED"`; `ShiftDto` (full), `ValidationPrintDto`, `StationCloseAccessDto`, `BundleProductDto`, `ShiftBundleDto`, `ShiftSummaryDto`, `ShiftOutputDto`, `ParticipantDto`, `LineListResponse`; `ScanCodeDto`, `ScanItemDto`, `SyncBatchRequest`, `BatchConflictDto`, `ShiftCloseRequest`, `ShiftCloseResponse`, `ConflictStatusRequest`, `ConflictStatusResponse`; `StationApi.enter/bundle/summary/lines/shifts(status, lineId)`; `@Strict Json`.

- [ ] **Step 1: Write the failing DTO test**

`app/src/test/kotlin/app/markiro/handheld/core/network/DtosTest.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DtosTest {
    private val lenient = NetworkModule.json()
    private val strict = NetworkModule.strictJson()

    @Test
    fun shiftDtoDecodesTheCabinetPayloadAndIgnoresUnknownFields() {
        val json = """
            {"id":"6d8a1186-37ba-4f17-ad31-fa4582df28d5","number":"SEP26-003","status":"active","mode":"validation",
             "validationPrint":{"mode":"none","verification":"none","templateId":null,"snapshot":null,"policyRevision":null},
             "productId":"p1","productName":"Вода 0,5","productPrintName":null,"image":null,"lineId":"l2","lineName":"Линия 2",
             "counterpartyId":null,"counterpartyName":"Завод X","ssccIssuerCounterpartyId":null,"boxLabelTemplateId":null,
             "plannedQty":3000,"plannedDate":"2026-09-10","productionDate":null,"boxCapacity":20,"palletCapacity":null,
             "palletsEnabled":false,"createdFrom":"admin","openedAt":"2026-09-10T07:00:00.000Z","closedAt":null,"closeReason":null,
             "lateDataAt":null,"createdAt":"2026-09-10T06:00:00.000Z","stationCloseAccess":{"kind":"single_device","ownerDeviceId":"dev-1"}}
        """.trimIndent()
        val shift = lenient.decodeFromString(ShiftDto.serializer(), json)
        assertEquals("SEP26-003", shift.number)
        assertEquals("none", shift.validationPrint?.mode)
        assertEquals(3000, shift.plannedQty)
        assertEquals("single_device", shift.stationCloseAccess?.kind)
        assertEquals("dev-1", shift.stationCloseAccess?.ownerDeviceId)
    }

    @Test
    fun scanItemsEncodeExplicitNullsSoTheServerSchemaAccepts() {
        val item = ScanItemDto(
            shiftId = "s1", terminalId = "dev-1", raw = "hello", verdict = "invalid",
            scannedAt = "2026-09-10T10:00:00.000Z", code = null, operatorId = null,
        )
        val encoded = strict.encodeToString(ScanItemDto.serializer(), item)
        assertTrue(encoded, encoded.contains("\"code\":null"))
        assertTrue(encoded, encoded.contains("\"boxId\":null"))
        assertTrue(encoded, encoded.contains("\"operatorId\":null"))
        assertTrue(encoded, encoded.contains("\"terminalId\":\"dev-1\""))
    }

    @Test
    fun batchEncodingIsStableAcrossCalls() {
        val batch = SyncBatchRequest("dev:inst:3", listOf(ScanItemDto("s1", "dev-1", "r", "invalid", "t", null, null)))
        assertEquals(strict.encodeToString(SyncBatchRequest.serializer(), batch), strict.encodeToString(SyncBatchRequest.serializer(), batch))
    }

    @Test
    fun summaryOutputDecodesBothModes() {
        val validation = lenient.decodeFromString(ShiftSummaryDto.serializer(), """{"generatedAt":"t","output":{"mode":"validation","acceptedUnits":12},"participants":[],"unattributed":{"eventCount":0,"acceptedScans":0,"closedBoxes":0}}""")
        assertEquals(12, validation.output.acceptedUnits)
        assertNull(validation.output.closedBoxes)
        val aggregation = lenient.decodeFromString(ShiftSummaryDto.serializer(), """{"generatedAt":"t","output":{"mode":"aggregation","closedBoxes":3,"containedUnits":60},"participants":[]}""")
        assertEquals(3, aggregation.output.closedBoxes)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*DtosTest*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Write the DTOs**

In `core/network/Dtos.kt` replace the constants and the shift DTO:

```kotlin
const val HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1"
const val REVOKED_CODE = "STATION_CREDENTIAL_REVOKED"
const val UPDATE_REQUIRED_CODE = "STATION_UPDATE_REQUIRED"

@Serializable
data class ShiftDto(
    val id: String,
    val number: String,
    val status: String,
    val mode: String = "validation",
    val validationPrint: ValidationPrintDto? = null,
    val productId: String = "",
    val productName: String? = null,
    val productPrintName: String? = null,
    val lineId: String? = null,
    val lineName: String? = null,
    val counterpartyName: String? = null,
    val plannedQty: Int? = null,
    val plannedDate: String? = null,
    val productionDate: String? = null,
    val boxCapacity: Int? = null,
    val palletCapacity: Int? = null,
    val palletsEnabled: Boolean = false,
    val openedAt: String? = null,
    val closedAt: String? = null,
    val stationCloseAccess: StationCloseAccessDto? = null,
)
```

`core/network/ShiftDtos.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

@Serializable
data class ValidationPrintDto(val mode: String)

@Serializable
data class StationCloseAccessDto(val kind: String, val ownerDeviceId: String? = null)

@Serializable
data class BundleProductDto(val id: String, val gtin14: String, val name: String, val printName: String? = null)

/** `GET /shifts/:id/bundle`; label templates and SSCC blocks are ignored in this slice. */
@Serializable
data class ShiftBundleDto(val shift: ShiftDto, val product: BundleProductDto, val operators: List<OperatorDto> = emptyList())

@Serializable
data class ShiftOutputDto(
    val mode: String,
    val acceptedUnits: Int? = null,
    val closedBoxes: Int? = null,
    val containedUnits: Int? = null,
)

@Serializable
data class ParticipantDto(
    val employeeId: String,
    val fullName: String,
    val role: String? = null,
    val firstActivityAt: String,
    val lastActivityAt: String,
    val acceptedScans: Int,
    val closedBoxes: Int,
)

@Serializable
data class UnattributedDto(val eventCount: Int, val acceptedScans: Int, val closedBoxes: Int)

@Serializable
data class ShiftSummaryDto(
    val generatedAt: String,
    val output: ShiftOutputDto,
    val participants: List<ParticipantDto> = emptyList(),
    val unattributed: UnattributedDto? = null,
)

@Serializable
data class LineListResponse(val items: List<LineDto>)
```

`core/network/SyncDtos.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

@Serializable
data class ScanCodeDto(val codeHash: String, val gtin14: String, val serial: String)

/** One `POST /station/scans` item; `code` present iff `verdict == "ok"`, `boxId` always null here. */
@Serializable
data class ScanItemDto(
    val shiftId: String,
    val terminalId: String?,
    val raw: String,
    val verdict: String,
    val scannedAt: String,
    val code: ScanCodeDto?,
    val operatorId: String?,
    val boxId: String? = null,
)

@Serializable
data class SyncBatchRequest(val batchId: String, val items: List<ScanItemDto>)

@Serializable
data class BatchConflictDto(val codeHash: String, val winningTerminalId: String? = null, val winningScannedAt: String? = null)

@Serializable
data class ShiftCloseRequest(
    val eventId: String,
    val shiftId: String,
    val operatorId: String?,
    val plannedQtySnapshot: Int?,
    val actualQty: Int,
    val closedBoxCount: Int,
    val reasonCode: String?,
    val closedAt: String,
)

@Serializable
data class ShiftCloseResponse(val outcome: String, val conflictCode: String? = null)

@Serializable
data class ConflictStatusRequest(val codeHashes: List<String>)

@Serializable
data class ConflictStatusResponse(val reviewedCodeHashes: List<String> = emptyList())
```

`core/network/StationApi.kt`:

```kotlin
package app.markiro.handheld.core.network

import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/** Station-only endpoints; the handheld authenticates exactly like a station (`x-api-key`). */
interface StationApi {
    @GET("station/identity")
    suspend fun identity(): IdentityResponse

    @GET("station/operators")
    suspend fun operators(): RosterResponse

    /** Without `lineId` the server scopes a device to its own line plus unassigned shifts. */
    @GET("shifts")
    suspend fun shifts(@Query("status") status: String? = null, @Query("lineId") lineId: String? = null): ShiftListResponse

    @GET("station/inventory-tasks")
    suspend fun inventoryTasks(): InventoryTaskListResponse

    @POST("shifts/{id}/enter")
    suspend fun enter(@Path("id") id: String): ShiftDto

    @GET("shifts/{id}/bundle")
    suspend fun bundle(@Path("id") id: String): ShiftBundleDto

    @GET("shifts/{id}/summary")
    suspend fun summary(@Path("id") id: String): ShiftSummaryDto

    @GET("lines")
    suspend fun lines(): LineListResponse
}
```

In `core/network/NetworkModule.kt` add a qualifier and a strict Json (explicit nulls are required by the server's zod schemas, and the same data must always serialise to the same bytes for `batchId` idempotency):

```kotlin
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class Strict

    /** Sync payloads: explicit nulls (zod `.nullable()` requires the key) and stable output. */
    @Provides
    @Singleton
    @Strict
    fun strictJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = true
    }
```

Make `json()` and `strictJson()` `@JvmStatic`-free plain functions on the object so the test can call `NetworkModule.json()` directly (they already are).

- [ ] **Step 4: Run the tests and fix `HubViewModelTest`**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*DtosTest*' --tests '*HubViewModelTest*' --tests '*InterceptorsTest*'
```
Expected: PASS. `HubViewModelTest` constructs `ShiftDto("s1", "SEP26-001", "active")`; the defaults keep it compiling. `InterceptorsTest` may assert the old capabilities header value; update it to the new constant.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): shift, bundle, summary and sync DTOs with the recovery capability

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `ScanRecorder` — one scan at a time, one transaction per scan

**Files:**
- Create: `core/scan/ScanRecorder.kt`
- Create: `core/util/Iso.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/scan/ScanRecorderTest.kt`

**Interfaces:**
- Consumes: `HandheldDatabase`, `ShiftValidator`, `Verdict`.
- Produces: `ScanRecorder.record(shift: ShiftEntity, raw: String, operatorId: String?): ScanOutcome`; `ScanOutcome(verdict, km?, hash?, firstSeenAt?, scannedAt)`; `Iso.format(epochMillis)`.

- [ ] **Step 1: Write the failing test**

`app/src/test/kotlin/app/markiro/handheld/core/scan/ScanRecorderTest.kt`:

```kotlin
package app.markiro.handheld.core.scan

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScanRecorderTest {
    private lateinit var db: HandheldDatabase
    private var clock = 1_757_500_000_000L
    private val gs = "\u001d"
    private val shift = ShiftEntity(
        id = "s1", number = "SEP26-001", status = "active", mode = "validation", productId = "p1",
        productName = "Вода", productPrintName = null, productGtin14 = "04600682000013", lineId = "l1", lineName = "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null,
        boxCapacity = null, palletCapacity = null, palletsEnabled = false, validationPrintMode = "none",
        closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L, bundleFetchedAt = 1L,
    )

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun recorder() = ScanRecorder(db) { clock }

    @Test
    fun acceptsThenFlagsTheSameCodeAsDuplicateWithFirstSeen() = runTest {
        val r = recorder()
        val first = r.record(shift, "010460068200001321abc${gs}93AAAA", "op-1")
        assertEquals(Verdict.OK, first.verdict)
        assertEquals("abc", first.km?.serial)
        clock += 60_000
        val second = r.record(shift, "010460068200001321abc${gs}93BBBB", "op-1")
        assertEquals(Verdict.DUPLICATE, second.verdict)
        assertEquals(first.scannedAt, second.firstSeenAt)
        val outbox = db.outboxDao().head(10)
        assertEquals(listOf("ok", "duplicate"), outbox.map { it.verdict })
        assertNotNull(outbox[0].codeHash)
        assertNull(outbox[1].codeHash)
        assertEquals(1, db.codeDao().countForShift("s1"))
        assertEquals(2, db.scanEventDao().observeRecent("s1", 10).first().size)
    }

    @Test
    fun wrongGtinAndGarbageAreJournaledWithoutCodes() = runTest {
        val r = recorder()
        assertEquals(Verdict.WRONG_GTIN, r.record(shift, "010460000000001521x", null).verdict)
        assertEquals(Verdict.INVALID, r.record(shift, "hello", null).verdict)
        assertEquals(0, db.codeDao().countForShift("s1"))
        assertEquals(listOf("wrong_gtin", "invalid"), db.outboxDao().head(10).map { it.verdict })
        assertEquals(1, db.scanEventDao().count("s1", "invalid"))
    }

    @Test
    fun aCodeAlreadyInTheMirrorFromAnotherShiftIsADuplicate() = runTest {
        val r = recorder()
        val km = app.markiro.handheld.core.km.KmCodec.canonicalize("010460068200001321zzz")
        db.codeDao().insert(CodeEntity(app.markiro.handheld.core.km.KmCodec.hash(km), "other", km.gtin14, km.serial, "2026-09-01T00:00:00.000Z"))
        val outcome = r.record(shift, "010460068200001321zzz", null)
        assertEquals(Verdict.DUPLICATE, outcome.verdict)
        assertEquals("2026-09-01T00:00:00.000Z", outcome.firstSeenAt)
    }

    @Test
    fun concurrentScansOfOneCodeAcceptExactlyOnce() = runTest {
        val r = recorder()
        val outcomes = (1..20).map { async { r.record(shift, "010460068200001321race", null) } }.awaitAll()
        assertEquals(1, outcomes.count { it.verdict == Verdict.OK })
        assertEquals(19, outcomes.count { it.verdict == Verdict.DUPLICATE })
        assertEquals(1, db.codeDao().countForShift("s1"))
        assertEquals(20, db.outboxDao().countNow())
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ScanRecorderTest*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement**

`core/util/Iso.kt`:

```kotlin
package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** ISO-8601 UTC with milliseconds, the form the station sends and zod's `datetime()` accepts. */
object Iso {
    private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun format(epochMillis: Long): String = formatter.format(Instant.ofEpochMilli(epochMillis))

    fun parse(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
}
```

`core/scan/ScanRecorder.kt`:

```kotlin
package app.markiro.handheld.core.scan

import android.database.sqlite.SQLiteConstraintException
import androidx.room.withTransaction
import app.markiro.handheld.core.km.Classification
import app.markiro.handheld.core.km.ParsedKm
import app.markiro.handheld.core.km.ShiftValidator
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class ScanOutcome(
    val verdict: Verdict,
    val km: ParsedKm?,
    val hash: String?,
    /** For duplicates: when the code was first accepted on this device. */
    val firstSeenAt: String?,
    val scannedAt: String,
)

/**
 * Same rules as the station's `recordScan`: one scan at a time, the code row first (its primary
 * key turns a lost race into a `duplicate`), then the journal event, then the outbox row.
 * Room gives us a real transaction, so a failure leaves nothing behind.
 */
class ScanRecorder(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = Mutex()

    suspend fun record(shift: ShiftEntity, raw: String, operatorId: String?): ScanOutcome = mutex.withLock {
        val expectedGtin = checkNotNull(shift.productGtin14) { "shift ${shift.id} has no bundle" }
        val scannedAt = Iso.format(clock())
        db.withTransaction {
            when (val c = ShiftValidator.classify(raw, expectedGtin)) {
                is Classification.Invalid -> {
                    write(shift.id, raw, Verdict.INVALID, scannedAt, operatorId, null, null)
                    ScanOutcome(Verdict.INVALID, null, null, null, scannedAt)
                }
                is Classification.WrongGtin -> {
                    write(shift.id, raw, Verdict.WRONG_GTIN, scannedAt, operatorId, null, null)
                    ScanOutcome(Verdict.WRONG_GTIN, c.km, null, null, scannedAt)
                }
                is Classification.Km -> {
                    var verdict = Verdict.OK
                    var firstSeen: String? = null
                    val existing = db.codeDao().get(c.hash)
                    if (existing != null) {
                        verdict = Verdict.DUPLICATE
                        firstSeen = existing.scannedAt
                    } else {
                        try {
                            db.codeDao().insert(CodeEntity(c.hash, shift.id, c.km.gtin14, c.km.serial, scannedAt))
                        } catch (_: SQLiteConstraintException) {
                            verdict = Verdict.DUPLICATE
                            firstSeen = db.codeDao().get(c.hash)?.scannedAt
                        }
                    }
                    write(shift.id, raw, verdict, scannedAt, operatorId, if (verdict == Verdict.OK) c.km else null, if (verdict == Verdict.OK) c.hash else null)
                    ScanOutcome(verdict, c.km, c.hash, firstSeen, scannedAt)
                }
            }
        }
    }

    private suspend fun write(shiftId: String, raw: String, verdict: Verdict, scannedAt: String, operatorId: String?, km: ParsedKm?, hash: String?) {
        db.scanEventDao().insert(ScanEventEntity(shiftId = shiftId, raw = raw, verdict = verdict.wire, scannedAt = scannedAt, operatorId = operatorId, codeHash = hash))
        db.outboxDao().insert(
            OutboxEntity(
                shiftId = shiftId,
                raw = raw,
                verdict = verdict.wire,
                scannedAt = scannedAt,
                operatorId = operatorId,
                codeHash = hash,
                gtin14 = km?.gtin14,
                serial = km?.serial,
            ),
        )
    }
}
```

Provide it in `core/scan/ScanModule.kt`:

```kotlin
    @Provides
    @Singleton
    fun scanRecorder(db: HandheldDatabase): ScanRecorder = ScanRecorder(db)
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ScanRecorderTest*'
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): transactional scan recorder with device-wide duplicate detection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Signals — synthesised tones and vibration with settings

**Files:**
- Create: `core/signal/Signaller.kt`, `core/signal/SignalModule.kt`
- Modify: `feature/settings/AppPreferences.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/signal/SignallerTest.kt`

**Interfaces:**
- Consumes: `AppPreferences`.
- Produces: `SignalKind { OK, DUPLICATE, ERROR }`, `Signaller.play(kind)`, `Signaller.forVerdict(verdict)`, `TonePlayer` (seam), `AudioTrackTonePlayer`; `AppPreferences.soundMuted / soundVolume / vibrationEnabled`.

- [ ] **Step 1: Write the failing test**

`app/src/test/kotlin/app/markiro/handheld/core/signal/SignallerTest.kt`:

```kotlin
package app.markiro.handheld.core.signal

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.feature.settings.AppPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SignallerTest {
    private class RecordingTones : TonePlayer {
        val played = mutableListOf<Triple<Double, Int, Wave>>()
        override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) {
            played += Triple(hz, millis, wave)
        }
    }

    private class Buzzer : VibrationPort {
        val patterns = mutableListOf<LongArray>()
        override fun vibrate(pattern: LongArray) {
            patterns += pattern
        }
    }

    private val prefs = AppPreferences(ApplicationProvider.getApplicationContext())

    @Test
    fun mapsVerdictsToTheStationTones() {
        val tones = RecordingTones()
        val buzzer = Buzzer()
        val s = Signaller(prefs, tones, buzzer)
        s.play(Signaller.forVerdict(Verdict.OK))
        s.play(Signaller.forVerdict(Verdict.DUPLICATE))
        s.play(Signaller.forVerdict(Verdict.WRONG_GTIN))
        s.play(Signaller.forVerdict(Verdict.INVALID))
        assertEquals(
            listOf(Triple(880.0, 120, Wave.SINE), Triple(440.0, 300, Wave.TRIANGLE), Triple(220.0, 450, Wave.SQUARE), Triple(220.0, 450, Wave.SQUARE)),
            tones.played,
        )
        assertEquals(listOf(0L, 40L), buzzer.patterns[0].toList())
        assertEquals(listOf(0L, 80L, 80L, 80L), buzzer.patterns[1].toList())
        assertEquals(listOf(0L, 150L, 100L, 150L), buzzer.patterns[2].toList())
    }

    @Test
    fun mutedOrSilentSkipsTonesAndVibrationCanBeOff() {
        val tones = RecordingTones()
        val buzzer = Buzzer()
        prefs.soundMuted = true
        prefs.vibrationEnabled = false
        Signaller(prefs, tones, buzzer).play(SignalKind.OK)
        assertTrue(tones.played.isEmpty())
        assertTrue(buzzer.patterns.isEmpty())
        prefs.soundMuted = false
        prefs.soundVolume = 0f
        Signaller(prefs, tones, buzzer).play(SignalKind.OK)
        assertTrue(tones.played.isEmpty())
    }

    @Test
    fun aBrokenAudioPathNeverThrows() {
        val broken = object : TonePlayer {
            override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) = throw IllegalStateException("no audio")
        }
        val buzzer = object : VibrationPort {
            override fun vibrate(pattern: LongArray) = throw IllegalStateException("no vibrator")
        }
        prefs.soundMuted = false
        prefs.soundVolume = 1f
        prefs.vibrationEnabled = true
        Signaller(prefs, broken, buzzer).play(SignalKind.ERROR)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*SignallerTest*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement**

Add to `feature/settings/AppPreferences.kt`:

```kotlin
    var soundMuted: Boolean
        get() = prefs.getBoolean("sound_muted", false)
        set(value) = prefs.edit().putBoolean("sound_muted", value).apply()

    /** 0..1 */
    var soundVolume: Float
        get() = prefs.getFloat("sound_volume", 1f)
        set(value) = prefs.edit().putFloat("sound_volume", value.coerceIn(0f, 1f)).apply()

    var vibrationEnabled: Boolean
        get() = prefs.getBoolean("vibration_enabled", true)
        set(value) = prefs.edit().putBoolean("vibration_enabled", value).apply()
```

`core/signal/Signaller.kt`:

```kotlin
package app.markiro.handheld.core.signal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.VibrationEffect
import android.os.Vibrator
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.feature.settings.AppPreferences
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.exp
import kotlin.math.sin

enum class Wave { SINE, SQUARE, TRIANGLE }

enum class SignalKind(val hz: Double, val millis: Int, val wave: Wave, val vibration: LongArray) {
    OK(880.0, 120, Wave.SINE, longArrayOf(0, 40)),
    DUPLICATE(440.0, 300, Wave.TRIANGLE, longArrayOf(0, 80, 80, 80)),
    ERROR(220.0, 450, Wave.SQUARE, longArrayOf(0, 150, 100, 150)),
}

interface TonePlayer {
    fun play(hz: Double, millis: Int, wave: Wave, volume: Float)
}

interface VibrationPort {
    fun vibrate(pattern: LongArray)
}

/** Same three tones as the station's signal-sound.ts; every failure is swallowed so scanning never stops. */
class Signaller(private val prefs: AppPreferences, private val tones: TonePlayer, private val vibration: VibrationPort?) {
    fun play(kind: SignalKind) {
        val volume = prefs.soundVolume
        if (!prefs.soundMuted && volume > 0f) runCatching { tones.play(kind.hz, kind.millis, kind.wave, volume) }
        if (prefs.vibrationEnabled) runCatching { vibration?.vibrate(kind.vibration) }
    }

    companion object {
        fun forVerdict(verdict: Verdict): SignalKind = when (verdict) {
            Verdict.OK -> SignalKind.OK
            Verdict.DUPLICATE -> SignalKind.DUPLICATE
            Verdict.WRONG_GTIN, Verdict.INVALID -> SignalKind.ERROR
        }
    }
}

/** PCM synthesis through a static AudioTrack; the track releases itself when the marker is reached. */
class AudioTrackTonePlayer : TonePlayer {
    override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) {
        val rate = 44_100
        val frames = rate * millis / 1000
        val pcm = ShortArray(frames)
        for (i in 0 until frames) {
            val x = 2.0 * PI * hz * i / rate
            val v = when (wave) {
                Wave.SINE -> sin(x)
                Wave.SQUARE -> if (sin(x) >= 0) 0.5 else -0.5
                Wave.TRIANGLE -> (2.0 / PI) * asin(sin(x))
            }
            val envelope = exp(-4.0 * i / frames)
            pcm[i] = (v * envelope * volume * 0.8 * Short.MAX_VALUE).toInt().toShort()
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(frames * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(pcm, 0, frames)
        track.setNotificationMarkerPosition(frames)
        track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onMarkerReached(t: AudioTrack) = t.release()
            override fun onPeriodicNotification(t: AudioTrack) = Unit
        })
        track.play()
    }
}

class SystemVibration(context: Context) : VibrationPort {
    private val vibrator: Vibrator? = context.getSystemService(Vibrator::class.java)

    override fun vibrate(pattern: LongArray) {
        vibrator?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }
}
```

`core/signal/SignalModule.kt`:

```kotlin
package app.markiro.handheld.core.signal

import android.content.Context
import app.markiro.handheld.feature.settings.AppPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SignalModule {
    @Provides
    @Singleton
    fun signaller(@ApplicationContext context: Context, prefs: AppPreferences): Signaller =
        Signaller(prefs, AudioTrackTonePlayer(), SystemVibration(context))
}
```

Add `<uses-permission android:name="android.permission.VIBRATE" />` to `AndroidManifest.xml`.

- [ ] **Step 4: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*SignallerTest*'
```
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): scan signals with the station's tones and vibration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: `SyncEngine` — pinned batches, backoff, closes and conflict reconciliation

**Files:**
- Create: `core/sync/SyncTransport.kt`, `core/sync/Backoff.kt`, `core/sync/SyncEngine.kt`, `core/sync/ConnectivityNudger.kt`, `core/sync/SyncModule.kt`
- Modify: `HandheldApp.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/sync/BackoffTest.kt`, `SyncEngineTest.kt`

**Interfaces:**
- Consumes: `HandheldDatabase`, `MetaStore`, `DeviceConfigDao`, `@Strict Json`, `ServerUrlProvider`, `OkHttpClient` (authenticated), `RevocationBus`.
- Produces: `SyncState(pending, lastSuccessAt, stuck, conflicts)`, `SyncEngine.state: StateFlow<SyncState>`, `start()`, `nudge()`, `drainAll(): Boolean`; `SyncTransport.post(path, body): TransportResult`; `Backoff`.

- [ ] **Step 1: Write the failing tests**

`app/src/test/kotlin/app/markiro/handheld/core/sync/BackoffTest.kt`:

```kotlin
package app.markiro.handheld.core.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test
    fun doublesFromTwoSecondsToSixtyAndResets() {
        val b = Backoff(startMs = 2_000, capMs = 60_000)
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L), (1..7).map { b.nextDelay() })
        b.reset()
        assertEquals(2_000L, b.nextDelay())
    }
}
```

`app/src/test/kotlin/app/markiro/handheld/core/sync/SyncEngineTest.kt`:

```kotlin
package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
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
class SyncEngineTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private val strict = NetworkModule.strictJson()
    private var clock = 1_757_500_000_000L

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО", lineId = "l1",
                lineName = "Линия 2", kind = "handheld", serverUrl = server.url("/").toString(), pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor(RevocationInterceptor(bus, Json { ignoreUnknownKeys = true })).build()
        val transport = SyncTransport(client) { server.url("/").toString() }
        return SyncEngine(
            db = db, meta = MetaStore(db.metaDao()), config = db.deviceConfigDao(), transport = transport, json = strict,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), clock = { clock },
        )
    }

    private suspend fun outbox(raw: String, verdict: String = "ok") = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = verdict, scannedAt = "2026-09-10T10:00:00.000Z", operatorId = "op-1",
            codeHash = if (verdict == "ok") "a".repeat(64) else null,
            gtin14 = if (verdict == "ok") "04600682000013" else null,
            serial = if (verdict == "ok") raw else null,
        ),
    )

    private fun ok(applied: Int, conflicts: String = "[]") =
        MockResponse().setResponseCode(201).setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":$conflicts}""")

    @Test
    fun postsAContiguousPrefixAndAcksIt() = runTest {
        outbox("a")
        outbox("b", "invalid")
        outbox("c")
        server.enqueue(ok(3))
        assertTrue(engine().drainAll())
        val request = server.takeRequest()
        assertEquals("/station/scans", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        val installId = MetaStore(db.metaDao()).installId()
        assertEquals("dev-1:$installId:3", body.getValue("batchId").jsonPrimitive.content)
        val items = body.getValue("items").jsonArray
        assertEquals(3, items.size)
        assertEquals("dev-1", items[0].jsonObject.getValue("terminalId").jsonPrimitive.content)
        assertTrue(items[1].jsonObject.getValue("code").toString() == "null")
        assertEquals("a".repeat(64), items[0].jsonObject.getValue("code").jsonObject.getValue("codeHash").jsonPrimitive.content)
        assertEquals(0, db.outboxDao().countNow())
        assertNull(db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID))
        assertEquals(clock, db.metaDao().get(MetaStore.SYNC_LAST_SUCCESS_AT)?.toLong())
    }

    @Test
    fun retryResendsThePinnedBatchUnchangedEvenAfterNewScans() = runTest {
        outbox("a")
        outbox("b")
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        assertNotNull(db.metaDao().get(MetaStore.SYNC_PENDING_CEILING))
        outbox("late")
        server.enqueue(ok(2))
        server.enqueue(ok(1))
        assertTrue(e.drainAll())
        val first = server.takeRequest().body.readUtf8()
        val second = server.takeRequest().body.readUtf8()
        val third = server.takeRequest().body.readUtf8()
        assertEquals(first, second)
        assertEquals(2, Json.parseToJsonElement(second).jsonObject.getValue("items").jsonArray.size)
        assertEquals(1, Json.parseToJsonElement(third).jsonObject.getValue("items").jsonArray.size)
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun alreadyAppliedIsSuccess() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":true,"conflicts":[]}"""))
        assertTrue(engine().drainAll())
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun aMalformedOkIsNotAcked() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"ok"}"""))
        assertFalse(engine().drainAll())
        assertEquals(1, db.outboxDao().countNow())
        assertNotNull(db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID))
    }

    @Test
    fun conflictsAreRecordedAndBadOnesIgnored() = runTest {
        outbox("a")
        server.enqueue(
            ok(
                1,
                """[{"codeHash":"h1","winningTerminalId":"dev-2","winningScannedAt":"2026-09-10T09:00:00.000Z"},
                    {"codeHash":"h2","winningTerminalId":null,"winningScannedAt":"not a date"}]""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"reviewedCodeHashes":[]}"""))
        assertTrue(engine().drainAll())
        val rows = db.conflictDao().observeAll().first()
        assertEquals(listOf("h1"), rows.map { it.codeHash })
        assertEquals("dev-2", rows.single().winningTerminalId)
    }

    @Test
    fun pendingClosesAreDrainedAfterScansAndConflictsMarked() = runTest {
        db.shiftCloseDao().insert(ShiftCloseEntity("e1", "s1", "op-1", 10, 8, 0, "material_shortage", "2026-09-10T12:00:00.000Z", "pending", null, null))
        db.shiftCloseDao().insert(ShiftCloseEntity("e2", "s2", null, null, 3, 0, null, "2026-09-10T12:01:00.000Z", "pending", null, null))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"accepted"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"conflict","conflictCode":"multiple_devices"}"""))
        assertTrue(engine().drainAll())
        assertEquals("/station/shift-closures", server.takeRequest().path)
        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("s2", body.getValue("shiftId").jsonPrimitive.content)
        assertTrue(body.getValue("reasonCode").toString() == "null")
        assertNull(db.shiftCloseDao().forShift("s1"))
        assertEquals("conflict", db.shiftCloseDao().forShift("s2")?.state)
        assertEquals("multiple_devices", db.shiftCloseDao().forShift("s2")?.conflictCode)
    }

    @Test
    fun reconciliationDeletesReviewedConflicts() = runTest {
        db.conflictDao().insertIgnore(
            listOf(
                ConflictEntity("h1", "dev-2", "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"),
                ConflictEntity("h2", "dev-2", "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"),
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"reviewedCodeHashes":["h1","zzz"]}"""))
        assertTrue(engine().drainAll())
        val request = server.takeRequest()
        assertEquals("/station/conflicts/status", request.path)
        assertEquals(listOf("h2"), db.conflictDao().observeAll().first().map { it.codeHash })
    }

    @Test
    fun aRevokedCredentialRaisesTheBusAndFails() = runTest {
        outbox("a")
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
        bus.events.test {
            assertFalse(engine().drainAll())
            awaitItem()
        }
    }

    @Test
    fun stateReportsPendingAndStuck() = runTest {
        outbox("a")
        val e = engine()
        assertEquals(1, e.state.first { it.pending == 1 }.pending)
        assertFalse(e.state.value.stuck)
        clock += 16 * 60 * 1000L
        e.tick()
        assertTrue(e.state.first { it.stuck }.stuck)
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.sync*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement**

`core/sync/Backoff.kt`:

```kotlin
package app.markiro.handheld.core.sync

/** 2 s, 4 s, … capped; reset on success. Same numbers as the station's sync.ts. */
class Backoff(private val startMs: Long = 2_000, private val capMs: Long = 60_000) {
    private var current = startMs

    fun nextDelay(): Long {
        val delay = current
        current = minOf(current * 2, capMs)
        return delay
    }

    fun reset() {
        current = startMs
    }
}
```

`core/sync/SyncTransport.kt`:

```kotlin
package app.markiro.handheld.core.sync

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

sealed interface TransportResult {
    data class Ok(val code: Int, val body: String) : TransportResult
    data class Failure(val cause: Throwable) : TransportResult
}

/** Raw JSON in, raw JSON out: the engine controls the exact bytes so a retry is byte-identical. */
class SyncTransport(private val client: OkHttpClient, private val baseUrl: () -> String) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun post(path: String, body: String): TransportResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url(baseUrl().trimEnd('/') + path).post(body.toRequestBody(jsonType)).build()
            client.newCall(request).execute().use { response ->
                TransportResult.Ok(response.code, response.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            TransportResult.Failure(e)
        }
    }
}
```

`core/sync/SyncEngine.kt`:

```kotlin
package app.markiro.handheld.core.sync

import androidx.room.withTransaction
import app.markiro.handheld.core.network.BatchConflictDto
import app.markiro.handheld.core.network.ConflictStatusRequest
import app.markiro.handheld.core.network.ConflictStatusResponse
import app.markiro.handheld.core.network.ScanCodeDto
import app.markiro.handheld.core.network.ScanItemDto
import app.markiro.handheld.core.network.ShiftCloseRequest
import app.markiro.handheld.core.network.ShiftCloseResponse
import app.markiro.handheld.core.network.SyncBatchRequest
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.atomic.AtomicBoolean

data class SyncState(val pending: Int = 0, val lastSuccessAt: Long? = null, val stuck: Boolean = false, val conflicts: Int = 0)

/**
 * Port of the station's sync loop: one drain at a time, batches are a contiguous prefix of the
 * outbox pinned in `meta` before the request so a retry resends the same rows under the same
 * batch id, `alreadyApplied` is success, every other failure is retried with backoff.
 */
class SyncEngine(
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
    private val now = MutableStateFlow(clock())

    val state: StateFlow<SyncState> = combine(db.outboxDao().count(), db.conflictDao().count(), lastSuccess, now) { pending, conflicts, last, at ->
        val since = last ?: startedAt
        SyncState(pending = pending, lastSuccessAt = last, stuck = pending > 0 && at - since > STUCK_AFTER_MS, conflicts = conflicts)
    }.stateIn(scope, SharingStarted.Eagerly, SyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.SYNC_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                tick()
                delayMs = if (drainAll()) {
                    backoff.reset()
                    heartbeatMs
                } else {
                    backoff.nextDelay()
                }
            }
        }
    }

    /** A recorded scan, a regained network or the heartbeat; cheap and safe from any thread. */
    fun nudge() {
        nudges.trySend(Unit)
    }

    /** Re-evaluates the stuck flag against the clock. */
    fun tick() {
        now.value = clock()
    }

    /** Sends every pending batch, then closes, then reconciles conflicts. False on the first failure. */
    suspend fun drainAll(): Boolean = drainMutex.withLock {
        while (true) {
            when (drainOnce()) {
                Step.SENT -> continue
                Step.EMPTY -> break
                Step.FAILED -> return false
            }
        }
        if (!drainCloses()) return false
        reconcileConflicts()
        true
    }

    internal enum class Step { SENT, EMPTY, FAILED }

    internal suspend fun drainOnce(): Step {
        val cfg = config.get() ?: return Step.EMPTY
        val pendingCeiling = meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull()
        val rows = if (pendingCeiling != null) db.outboxDao().headThrough(pendingCeiling, BATCH_SIZE) else db.outboxDao().head(BATCH_SIZE)
        if (rows.isEmpty()) {
            if (pendingCeiling != null) clearPending()
            return Step.EMPTY
        }
        val maxId = rows.last().id
        val batchId = meta.get(MetaStore.SYNC_PENDING_BATCH_ID)?.takeIf { pendingCeiling != null } ?: run {
            val id = "${cfg.deviceId}:${meta.installId()}:$maxId"
            meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
            meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
            id
        }
        val body = json.encodeToString(SyncBatchRequest.serializer(), SyncBatchRequest(batchId, rows.map { it.toItem(cfg.deviceId) }))
        val result = transport.post("/station/scans", body) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val parsed = parseBatchResponse(result.body) ?: return Step.FAILED
        val at = clock()
        db.withTransaction {
            db.conflictDao().insertIgnore(parsed.conflicts.map { ConflictEntity(it.codeHash, it.winningTerminalId, it.winningScannedAt!!, Iso.format(at)) })
            db.outboxDao().deleteThrough(maxId)
            db.metaDao().remove(MetaStore.SYNC_PENDING_BATCH_ID)
            db.metaDao().remove(MetaStore.SYNC_PENDING_CEILING)
            parsed.denied?.let { db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_DENIED, it)) }
            db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_SUCCESS_AT, at.toString()))
        }
        lastSuccess.value = at
        return Step.SENT
    }

    private suspend fun clearPending() {
        meta.remove(MetaStore.SYNC_PENDING_BATCH_ID)
        meta.remove(MetaStore.SYNC_PENDING_CEILING)
    }

    private class BatchResponse(val applied: Int, val alreadyApplied: Boolean, val conflicts: List<BatchConflictDto>, val denied: String?)

    /** The station's shape guard: a captive portal answering 200 must never ack a batch. */
    private fun parseBatchResponse(body: String): BatchResponse? {
        val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val applied = obj["applied"]?.jsonPrimitive?.takeIf { !it.isString }?.intOrNull ?: return null
        val alreadyApplied = obj["alreadyApplied"]?.jsonPrimitive?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val conflicts = obj["conflicts"]?.takeIf { it !is JsonNull }?.jsonArray.orEmpty()
            .mapNotNull { runCatching { json.decodeFromJsonElement(BatchConflictDto.serializer(), it) }.getOrNull() }
            .filter { it.winningScannedAt != null && Iso.parse(it.winningScannedAt) != null }
        val denied = obj["denied"]?.takeIf { it !is JsonNull }?.toString()
        return BatchResponse(applied, alreadyApplied, conflicts, denied)
    }

    private suspend fun drainCloses(): Boolean {
        for (row in db.shiftCloseDao().pending()) {
            val body = json.encodeToString(ShiftCloseRequest.serializer(), row.toRequest())
            val result = transport.post("/station/shift-closures", body) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val response = runCatching { json.decodeFromString(ShiftCloseResponse.serializer(), result.body) }.getOrNull() ?: return false
            when (response.outcome) {
                "accepted", "already_resolved" -> db.shiftCloseDao().delete(row.eventId)
                "conflict" -> db.shiftCloseDao().markConflict(row.eventId, response.conflictCode ?: "multiple_devices", Iso.format(clock()))
                else -> return false
            }
        }
        return true
    }

    private suspend fun reconcileConflicts() {
        var after = ""
        while (true) {
            val page = db.conflictDao().pageHashes(after, RECONCILE_PAGE)
            if (page.isEmpty()) return
            val body = json.encodeToString(ConflictStatusRequest.serializer(), ConflictStatusRequest(page))
            val result = transport.post("/station/conflicts/status", body) as? TransportResult.Ok ?: return
            if (result.code !in 200..299) return
            val reviewed = runCatching { json.decodeFromString(ConflictStatusResponse.serializer(), result.body) }.getOrNull()?.reviewedCodeHashes ?: return
            val gone = reviewed.filter { it in page }
            if (gone.isNotEmpty()) db.conflictDao().delete(gone)
            if (page.size < RECONCILE_PAGE) return
            after = page.last()
        }
    }

    private fun OutboxEntity.toItem(deviceId: String) = ScanItemDto(
        shiftId = shiftId,
        terminalId = deviceId,
        raw = raw,
        verdict = verdict,
        scannedAt = scannedAt,
        code = if (verdict == "ok" && codeHash != null && gtin14 != null && serial != null) ScanCodeDto(codeHash, gtin14, serial) else null,
        operatorId = operatorId,
    )

    private fun ShiftCloseEntity.toRequest() = ShiftCloseRequest(
        eventId = eventId,
        shiftId = shiftId,
        operatorId = operatorId,
        plannedQtySnapshot = plannedQtySnapshot,
        actualQty = actualQty,
        closedBoxCount = closedBoxCount,
        reasonCode = reasonCode,
        closedAt = closedAt,
    )

    companion object {
        const val BATCH_SIZE = 100
        const val RECONCILE_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 15 * 60 * 1000L
    }
}
```

`core/sync/ConnectivityNudger.kt`:

```kotlin
package app.markiro.handheld.core.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/** Nudges the engine when any default network comes up; failures to register are ignored. */
class ConnectivityNudger(private val context: Context, private val engine: SyncEngine) {
    fun register() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = engine.nudge()
            })
        }
    }
}
```

`core/sync/SyncModule.kt`:

```kotlin
package app.markiro.handheld.core.sync

import android.content.Context
import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.network.Strict
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SyncModule {
    @Provides
    @Singleton
    fun syncEngine(
        db: HandheldDatabase,
        meta: MetaStore,
        config: DeviceConfigDao,
        client: OkHttpClient,
        serverUrl: ServerUrlProvider,
        @Strict json: Json,
    ): SyncEngine = SyncEngine(
        db = db,
        meta = meta,
        config = config,
        transport = SyncTransport(client) { serverUrl.current() },
        json = json,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )

    @Provides
    @Singleton
    fun connectivityNudger(@ApplicationContext context: Context, engine: SyncEngine): ConnectivityNudger = ConnectivityNudger(context, engine)
}
```

`HandheldApp.kt`:

```kotlin
package app.markiro.handheld

import android.app.Application
import app.markiro.handheld.core.sync.ConnectivityNudger
import app.markiro.handheld.core.sync.SyncEngine
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class HandheldApp : Application() {
    @Inject lateinit var syncEngine: SyncEngine

    @Inject lateinit var connectivity: ConnectivityNudger

    override fun onCreate() {
        super.onCreate()
        syncEngine.start()
        connectivity.register()
    }
}
```

The authenticated `OkHttpClient` already carries `BaseUrlInterceptor`, `ApiKeyInterceptor`, `CapabilitiesInterceptor`, `RevocationInterceptor` and `ReachabilityInterceptor`, so sync requests get the key, the capabilities and the revocation handling for free. `SyncTransport` builds the URL from `ServerUrlProvider.current()` and the interceptor rewrites it to the same origin.

- [ ] **Step 4: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.sync*'
```
Expected: 10 tests PASS. If `stateReportsPendingAndStuck` flakes on `first { }`, the `combine` runs on `Dispatchers.Unconfined` in the test scope; keep `Eagerly` and call `e.tick()` after the clock jump as written.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): outbox sync engine with pinned batches, backoff, closes and conflict reconciliation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Two languages — string resources for every screen, foundation migrated

**Files:**
- Modify: `app/src/main/res/values/strings.xml`, `app/src/main/res/values-en/strings.xml` (complete files below)
- Modify: `AppNavigation.kt`, `core/design/Components.kt`, `core/scan/VendorProfiles.kt`, `feature/hub/HubScreen.kt`, `feature/hub/HubViewModel.kt`, `feature/pairing/PairingScreen.kt`, `feature/settings/SettingsScreens.kt`, `feature/signin/SignInScreen.kt`, `app/build.gradle.kts` (lint)
- Test: `app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt`; update existing screen tests that match Russian text (they keep matching Russian: the default locale in Robolectric is the default `values/`, so nothing changes for them)

**Interfaces:**
- Produces: every key in the XML below; `VendorProfile.setupHintRes: Int`; `HubViewModel` resolves the scanner label through the application context.

- [ ] **Step 1: Write the failing English render test**

`app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt`:

```kotlin
package app.markiro.handheld

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodes
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubUi
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingUi
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInUi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

private val cyrillic = Regex("[А-Яа-яЁё]")
private val hasCyrillic = SemanticsMatcher("has Cyrillic text") { node ->
    val texts = node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
        listOfNotNull(node.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString())
    texts.any { cyrillic.containsMatchIn(it) }
}

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "en-rUS-w360dp-h640dp")
class EnglishRenderTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun foundationScreensRenderWithoutCyrillicInEnglish() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(HubUi("Test Plant", "Anna Ivanova", "Line 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false, scannerLabel = "Zebra"), onTile = {}, onSignOut = {})
            }
        }
        assertEquals(0, compose.onAllNodes(hasCyrillic).fetchSemanticsNodes().size)
        compose.setContent { MarkiroTheme { PairingScreen(PairingUi.Enter("", "https://x", true), PairingCallbacks()) } }
        assertEquals(0, compose.onAllNodes(hasCyrillic).fetchSemanticsNodes().size)
        compose.setContent { MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Anna Ivanova", lockMode = true), SignInCallbacks()) } }
        assertEquals(0, compose.onAllNodes(hasCyrillic).fetchSemanticsNodes().size)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*EnglishRenderTest*'
```
Expected: FAIL (Cyrillic literals render in English).

- [ ] **Step 3: Write both resource files**

`app/src/main/res/values/strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Маркиро ТСД</string>

    <string name="common_back">Назад</string>
    <string name="common_cancel">Отмена</string>
    <string name="common_retry">Повторить</string>
    <string name="common_continue">Продолжить</string>
    <string name="common_backspace">Стереть</string>
    <string name="common_data_as_of">данные на %1$s</string>
    <string name="common_no_data">нет данных</string>
    <string name="common_server_unavailable">Сервер недоступен</string>
    <string name="common_got_it">Понятно</string>

    <string name="pairing_brand">МАРКИРО</string>
    <string name="pairing_title">Привязать устройство</string>
    <string name="pairing_hint">Введите код из кабинета или нажмите триггер и наведите на штрих-код рядом с кодом.</string>
    <string name="pairing_server_url">Адрес сервера</string>
    <string name="pairing_binding_title">Привязываем устройство…</string>
    <string name="pairing_binding_text">Загружаем настройки, операторов и товары. Обычно это занимает меньше минуты.</string>
    <string name="pairing_success_title">ТСД привязан</string>
    <string name="pairing_go_sign_in">Перейти ко входу</string>
    <string name="pairing_invalid_title">Код не подошёл</string>
    <string name="pairing_invalid_text">Код недействителен или истёк. Обновите код в кабинете и введите новый.</string>
    <string name="pairing_invalid_action">Ввести новый код</string>
    <string name="pairing_locked_title">Слишком много попыток</string>
    <string name="pairing_locked_text">Устройство заблокировано на 15 минут. Подождите или сгенерируйте новый код в кабинете.</string>
    <string name="pairing_unavailable_text">Проверьте Wi-Fi и адрес сервера. Код пока не использован.</string>
    <string name="pairing_kind_title">Этот код выпущен для станции</string>
    <string name="pairing_kind_text">Добавьте в кабинете устройство типа «ТСД» и выпустите код для него. Этот код остаётся действительным для станции.</string>
    <string name="pairing_other_code">Ввести другой код</string>

    <string name="signin_scan_badge">Сканируйте бейдж</string>
    <string name="signin_scan_hint">нажмите триггер · или введите табельный номер ниже</string>
    <string name="signin_badge_unknown">Бейдж не найден</string>
    <string name="signin_roster_empty">Список операторов ещё не загружен</string>
    <string name="signin_login_field">Табельный №</string>
    <string name="signin_find_by_name">Найти по имени</string>
    <string name="signin_login_title">Табельный %1$s</string>
    <string name="signin_login_caption">табельный %1$s</string>
    <string name="signin_lock_hint">Введите PIN или сканируйте бейдж</string>
    <string name="signin_wrong_pin">Неверный PIN</string>
    <string name="signin_switch_operator">Сменить оператора</string>
    <string name="signin_not_me">Не тот сотрудник</string>
    <string name="signin_search_field">Фамилия или имя</string>
    <string name="signin_search_hint">Показаны первые 5 совпадений. Уточните запрос, если нужного нет.</string>
    <string name="signin_number_short">№ %1$s</string>
    <string name="signin_pin">PIN</string>

    <string name="hub_network">Сеть</string>
    <string name="hub_offline">Офлайн</string>
    <string name="hub_queue">Очередь %1$d</string>
    <string name="hub_printer">Принтер</string>
    <string name="hub_scanner">Сканер</string>
    <string name="hub_offline_banner">Работаем офлайн</string>
    <string name="hub_offline_banner_queue">Работаем офлайн · %1$s</string>
    <string name="hub_sync_stuck">Синхронизация застряла · проверьте сеть</string>
    <string name="hub_sign_out">Выйти</string>
    <string name="hub_tile_shift">Смена</string>
    <string name="hub_tile_inventory">Инвентаризация</string>
    <string name="hub_tile_check">Проверка кода</string>
    <string name="hub_tile_settings">Настройки</string>
    <string name="hub_check_status">нажмите триггер</string>
    <string name="hub_printer_not_set">принтер не настроен</string>
    <string name="hub_no_shifts">смен нет</string>
    <string name="hub_no_tasks">заданий нет</string>
    <string name="hub_shift_continue">продолжить %1$s</string>
    <plurals name="hub_shifts_available">
        <item quantity="one">%d доступна</item>
        <item quantity="few">%d доступны</item>
        <item quantity="many">%d доступны</item>
        <item quantity="other">%d доступны</item>
    </plurals>
    <plurals name="hub_inventory_tasks">
        <item quantity="one">%d задание</item>
        <item quantity="few">%d задания</item>
        <item quantity="many">%d заданий</item>
        <item quantity="other">%d заданий</item>
    </plurals>
    <plurals name="scans_queued">
        <item quantity="one">%d скан в очереди</item>
        <item quantity="few">%d скана в очереди</item>
        <item quantity="many">%d сканов в очереди</item>
        <item quantity="other">%d сканов в очереди</item>
    </plurals>
    <string name="soon_title">В следующем срезе</string>
    <string name="soon_text">Этот раздел появится в одном из следующих срезов.</string>
    <string name="scanner_source_builtin">встроенный</string>
    <string name="scanner_source_wedge">клавиатурный</string>
    <string name="scanner_source_debug">отладка</string>

    <string name="settings_title">Настройки</string>
    <string name="settings_scanner">Сканер</string>
    <string name="settings_language">Язык</string>
    <string name="settings_theme">Тема</string>
    <string name="theme_dark">Тёмная</string>
    <string name="theme_light">Светлая</string>
    <string name="theme_system">Как в системе</string>
    <string name="settings_about">ОБ УСТРОЙСТВЕ</string>
    <string name="settings_name">Имя</string>
    <string name="settings_server">Сервер</string>
    <string name="settings_version">Версия</string>
    <string name="settings_operators">Операторы</string>
    <string name="settings_operators_updated">обновлены %1$s</string>
    <string name="settings_operators_missing">не загружены</string>
    <string name="settings_unbind_note">Отвязать устройство можно только из кабинета.</string>
    <string name="settings_source_builtin">встроенный · %1$s</string>
    <string name="settings_source_wedge">клавиатурный wedge</string>
    <string name="settings_source_debug">отладка</string>
    <string name="settings_signals">СИГНАЛЫ</string>
    <string name="settings_sound">Звук</string>
    <string name="settings_on">включён</string>
    <string name="settings_off">выключен</string>
    <string name="settings_volume">Громкость</string>
    <string name="settings_vibration">Вибрация</string>
    <string name="settings_test_ok">Принят</string>
    <string name="settings_test_duplicate">Дубль</string>
    <string name="settings_test_error">Ошибка</string>
    <string name="settings_sync">Очередь синхронизации</string>
    <string name="settings_sync_value">%1$d · последняя отправка %2$s</string>
    <string name="settings_sync_never">%1$d · ещё не отправлялось</string>
    <string name="settings_install_id">Идентификатор</string>

    <string name="scanner_title">Сканер</string>
    <string name="scanner_sources">ИСТОЧНИК СКАНОВ</string>
    <string name="scanner_builtin_title">Встроенный сканер</string>
    <string name="scanner_wedge_title">Клавиатурный wedge</string>
    <string name="scanner_wedge_hint">универсальный запасной путь: сканер печатает код как клавиатура</string>
    <string name="scanner_profiles">ПРОФИЛЬ ВЕНДОРА</string>
    <string name="scanner_action">действие %1$s</string>
    <string name="scanner_test">ТЕСТОВЫЙ СКАН</string>
    <string name="scanner_test_hint">Нажмите триггер — здесь появится сырая строка с разделителями GS.</string>
    <string name="scanner_test_meta">%1$s · источник %2$s · %3$d симв.</string>
    <string name="scanner_symbology_unknown">символика неизвестна</string>
    <string name="scanner_debug_field">Отладочный скан (только debug)</string>
    <string name="scanner_debug_send">Отправить как скан</string>
    <string name="vendor_hint_datalogic">Настройки → Сканер → Wedge → Intent Wedge: включить, действие как выше, доставка Broadcast.</string>
    <string name="vendor_hint_honeywell">Настройки → Honeywell Settings → Scanning → Internal Scanner → Data Processing Settings → Data Intent: включить, Action = %1$s.</string>
    <string name="vendor_hint_zebra">DataWedge → профиль для app.markiro.handheld → Intent output: включить, Intent action = %1$s, delivery Broadcast.</string>

    <string name="shifts_title">Смены</string>
    <string name="shifts_my_line">Моя линия</string>
    <string name="shifts_other_lines">Другие линии</string>
    <string name="shifts_show_other">Показать другие линии</string>
    <string name="shifts_empty_title">Смен нет</string>
    <string name="shifts_empty_text">Создайте смену в кабинете.</string>
    <string name="shifts_loading">Загружаем смены…</string>
    <string name="shifts_mode_validation">валидация</string>
    <string name="shifts_mode_aggregation">+ агрегация</string>
    <string name="shifts_aggregation_later">агрегация: в следующем срезе</string>
    <string name="shifts_plan">план %1$d</string>
    <string name="shifts_no_plan">без плана</string>
    <string name="shifts_tolling">для: %1$s</string>
    <string name="shifts_needs_network">нужна сеть для первого входа</string>
    <string name="shifts_join_other_title">Войти в смену другой линии?</string>
    <string name="shifts_join_other_text">%1$s · %2$s. Ваша линия: %3$s.</string>
    <string name="shifts_enter">Войти</string>
    <string name="shifts_entering">Входим в смену…</string>
    <string name="shifts_update_required_title">Смена требует печати дубликата Data Matrix</string>
    <string name="shifts_update_required_text">На ТСД печать дубликатов пока недоступна. Используйте станцию или измените политику смены в кабинете.</string>
    <string name="shifts_closed_title">Смена уже закрыта</string>
    <string name="shifts_closed_text">Список обновлён.</string>
    <string name="shifts_status_planned">запланирована</string>
    <string name="shifts_status_active">идёт</string>

    <string name="signal_ok">ПРИНЯТО</string>
    <string name="signal_wrong_code">НЕВЕРНЫЙ КОД</string>
    <string name="signal_wrong_gtin">ЧУЖОЙ ГТИН</string>
    <string name="signal_duplicate">ДУБЛЬ</string>
    <string name="work_waiting">Ожидание скана…</string>
    <string name="work_first_seen">Первый скан в %1$s</string>
    <string name="work_total">Всего</string>
    <string name="work_this_terminal">Этот ТСД</string>
    <string name="work_errors">Ошибки %1$d · Дубли %2$d</string>
    <string name="work_feed_empty">Сканов ещё нет</string>
    <string name="work_more">Ещё</string>
    <string name="work_conflicts">Конфликты (%1$d)</string>
    <string name="work_leave">Выйти из смены</string>
    <string name="work_close">Закрыть смену</string>
    <string name="work_team_chip">+%1$d</string>
    <string name="work_team_title">Команда</string>
    <plurals name="work_team_scans">
        <item quantity="one">%d скан</item>
        <item quantity="few">%d скана</item>
        <item quantity="many">%d сканов</item>
        <item quantity="other">%d сканов</item>
    </plurals>
    <string name="work_team_last">последний %1$s</string>
    <string name="work_team_empty">Пока только вы</string>
    <string name="work_plan_of">%1$d / %2$d</string>

    <string name="close_confirm_title">Закрыть смену?</string>
    <string name="close_confirm_text">Принято %1$d, ошибок %2$d, дублей %3$d. Смену закроет это устройство.</string>
    <string name="close_action">Закрыть</string>
    <string name="close_reason_title">Почему план не выполнен?</string>
    <string name="close_reason_text">План %1$d, принято %2$d.</string>
    <string name="reason_production_defect">Брак производства</string>
    <string name="reason_material_shortage">Нехватка сырья или материалов</string>
    <string name="reason_equipment_stop">Остановка оборудования</string>
    <string name="reason_production_order_changed">Изменился производственный заказ</string>
    <string name="reason_planned_quantity_error">Ошибка в плановом количестве</string>
    <string name="reason_other_production_deviation">Другое отклонение производства</string>
    <string name="close_draining">Отправляем сканы…</string>
    <string name="close_draining_left">%1$d осталось</string>
    <string name="close_summary_title">Смена закрыта</string>
    <string name="close_summary_conflict">Смену закроет кабинет: работало несколько устройств</string>
    <string name="close_summary_pending">Закрытие отправится, когда появится сеть</string>
    <string name="close_summary_accepted">Принято</string>
    <string name="close_summary_errors">Ошибки</string>
    <string name="close_summary_duplicates">Дубли</string>
    <string name="close_summary_conflicts">Конфликты</string>
    <string name="close_to_hub">В хаб</string>

    <string name="conflicts_title">Конфликты синхронизации</string>
    <string name="conflicts_note">Код уже посчитан на другом терминале раньше. Разбор — в кабинете.</string>
    <string name="conflicts_empty">Конфликтов нет</string>
    <string name="conflicts_row">…%1$s · терминал …%2$s · %3$s</string>
    <string name="conflicts_unknown_terminal">неизвестен</string>
</resources>
```

`app/src/main/res/values-en/strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Markiro Handheld</string>

    <string name="common_back">Back</string>
    <string name="common_cancel">Cancel</string>
    <string name="common_retry">Retry</string>
    <string name="common_continue">Continue</string>
    <string name="common_backspace">Erase</string>
    <string name="common_data_as_of">data as of %1$s</string>
    <string name="common_no_data">no data</string>
    <string name="common_server_unavailable">Server unavailable</string>
    <string name="common_got_it">Got it</string>

    <string name="pairing_brand">MARKIRO</string>
    <string name="pairing_title">Pair the device</string>
    <string name="pairing_hint">Enter the code from the cabinet, or press the trigger and aim at the barcode next to the code.</string>
    <string name="pairing_server_url">Server address</string>
    <string name="pairing_binding_title">Pairing the device…</string>
    <string name="pairing_binding_text">Loading settings, operators and products. This usually takes under a minute.</string>
    <string name="pairing_success_title">Handheld paired</string>
    <string name="pairing_go_sign_in">Go to sign-in</string>
    <string name="pairing_invalid_title">Code not accepted</string>
    <string name="pairing_invalid_text">The code is invalid or expired. Issue a new code in the cabinet and enter it.</string>
    <string name="pairing_invalid_action">Enter a new code</string>
    <string name="pairing_locked_title">Too many attempts</string>
    <string name="pairing_locked_text">The device is locked for 15 minutes. Wait, or issue a new code in the cabinet.</string>
    <string name="pairing_unavailable_text">Check Wi-Fi and the server address. The code has not been used yet.</string>
    <string name="pairing_kind_title">This code was issued for a station</string>
    <string name="pairing_kind_text">Add a device of type “Handheld” in the cabinet and issue a code for it. This code stays valid for a station.</string>
    <string name="pairing_other_code">Enter another code</string>

    <string name="signin_scan_badge">Scan your badge</string>
    <string name="signin_scan_hint">press the trigger · or enter your employee number below</string>
    <string name="signin_badge_unknown">Badge not found</string>
    <string name="signin_roster_empty">The operator list has not been loaded yet</string>
    <string name="signin_login_field">Employee no.</string>
    <string name="signin_find_by_name">Find by name</string>
    <string name="signin_login_title">Employee no. %1$s</string>
    <string name="signin_login_caption">employee no. %1$s</string>
    <string name="signin_lock_hint">Enter your PIN or scan your badge</string>
    <string name="signin_wrong_pin">Wrong PIN</string>
    <string name="signin_switch_operator">Switch operator</string>
    <string name="signin_not_me">Not me</string>
    <string name="signin_search_field">Last or first name</string>
    <string name="signin_search_hint">The first 5 matches are shown. Refine the query if yours is missing.</string>
    <string name="signin_number_short">no. %1$s</string>
    <string name="signin_pin">PIN</string>

    <string name="hub_network">Network</string>
    <string name="hub_offline">Offline</string>
    <string name="hub_queue">Queue %1$d</string>
    <string name="hub_printer">Printer</string>
    <string name="hub_scanner">Scanner</string>
    <string name="hub_offline_banner">Working offline</string>
    <string name="hub_offline_banner_queue">Working offline · %1$s</string>
    <string name="hub_sync_stuck">Sync is stuck · check the network</string>
    <string name="hub_sign_out">Sign out</string>
    <string name="hub_tile_shift">Shift</string>
    <string name="hub_tile_inventory">Inventory</string>
    <string name="hub_tile_check">Code check</string>
    <string name="hub_tile_settings">Settings</string>
    <string name="hub_check_status">press the trigger</string>
    <string name="hub_printer_not_set">printer not set up</string>
    <string name="hub_no_shifts">no shifts</string>
    <string name="hub_no_tasks">no tasks</string>
    <string name="hub_shift_continue">continue %1$s</string>
    <plurals name="hub_shifts_available">
        <item quantity="one">%d available</item>
        <item quantity="other">%d available</item>
    </plurals>
    <plurals name="hub_inventory_tasks">
        <item quantity="one">%d task</item>
        <item quantity="other">%d tasks</item>
    </plurals>
    <plurals name="scans_queued">
        <item quantity="one">%d scan queued</item>
        <item quantity="other">%d scans queued</item>
    </plurals>
    <string name="soon_title">In a later release</string>
    <string name="soon_text">This section arrives in one of the next releases.</string>
    <string name="scanner_source_builtin">built-in</string>
    <string name="scanner_source_wedge">keyboard wedge</string>
    <string name="scanner_source_debug">debug</string>

    <string name="settings_title">Settings</string>
    <string name="settings_scanner">Scanner</string>
    <string name="settings_language">Language</string>
    <string name="settings_theme">Theme</string>
    <string name="theme_dark">Dark</string>
    <string name="theme_light">Light</string>
    <string name="theme_system">System</string>
    <string name="settings_about">ABOUT THIS DEVICE</string>
    <string name="settings_name">Name</string>
    <string name="settings_server">Server</string>
    <string name="settings_version">Version</string>
    <string name="settings_operators">Operators</string>
    <string name="settings_operators_updated">updated %1$s</string>
    <string name="settings_operators_missing">not loaded</string>
    <string name="settings_unbind_note">The device can only be unpaired from the cabinet.</string>
    <string name="settings_source_builtin">built-in · %1$s</string>
    <string name="settings_source_wedge">keyboard wedge</string>
    <string name="settings_source_debug">debug</string>
    <string name="settings_signals">SIGNALS</string>
    <string name="settings_sound">Sound</string>
    <string name="settings_on">on</string>
    <string name="settings_off">off</string>
    <string name="settings_volume">Volume</string>
    <string name="settings_vibration">Vibration</string>
    <string name="settings_test_ok">Accepted</string>
    <string name="settings_test_duplicate">Duplicate</string>
    <string name="settings_test_error">Error</string>
    <string name="settings_sync">Sync queue</string>
    <string name="settings_sync_value">%1$d · last sent %2$s</string>
    <string name="settings_sync_never">%1$d · nothing sent yet</string>
    <string name="settings_install_id">Install id</string>

    <string name="scanner_title">Scanner</string>
    <string name="scanner_sources">SCAN SOURCE</string>
    <string name="scanner_builtin_title">Built-in scanner</string>
    <string name="scanner_wedge_title">Keyboard wedge</string>
    <string name="scanner_wedge_hint">universal fallback: the scanner types the code like a keyboard</string>
    <string name="scanner_profiles">VENDOR PROFILE</string>
    <string name="scanner_action">action %1$s</string>
    <string name="scanner_test">TEST SCAN</string>
    <string name="scanner_test_hint">Press the trigger — the raw string with GS separators appears here.</string>
    <string name="scanner_test_meta">%1$s · source %2$s · %3$d chars</string>
    <string name="scanner_symbology_unknown">unknown symbology</string>
    <string name="scanner_debug_field">Debug scan (debug builds only)</string>
    <string name="scanner_debug_send">Send as a scan</string>
    <string name="vendor_hint_datalogic">Settings → Scanner → Wedge → Intent Wedge: enable, action as above, delivery Broadcast.</string>
    <string name="vendor_hint_honeywell">Settings → Honeywell Settings → Scanning → Internal Scanner → Data Processing Settings → Data Intent: enable, Action = %1$s.</string>
    <string name="vendor_hint_zebra">DataWedge → profile for app.markiro.handheld → Intent output: enable, Intent action = %1$s, delivery Broadcast.</string>

    <string name="shifts_title">Shifts</string>
    <string name="shifts_my_line">My line</string>
    <string name="shifts_other_lines">Other lines</string>
    <string name="shifts_show_other">Show other lines</string>
    <string name="shifts_empty_title">No shifts</string>
    <string name="shifts_empty_text">Create a shift in the cabinet.</string>
    <string name="shifts_loading">Loading shifts…</string>
    <string name="shifts_mode_validation">validation</string>
    <string name="shifts_mode_aggregation">+ aggregation</string>
    <string name="shifts_aggregation_later">aggregation: in a later release</string>
    <string name="shifts_plan">plan %1$d</string>
    <string name="shifts_no_plan">no plan</string>
    <string name="shifts_tolling">for: %1$s</string>
    <string name="shifts_needs_network">network needed for the first entry</string>
    <string name="shifts_join_other_title">Enter a shift of another line?</string>
    <string name="shifts_join_other_text">%1$s · %2$s. Your line: %3$s.</string>
    <string name="shifts_enter">Enter</string>
    <string name="shifts_entering">Entering the shift…</string>
    <string name="shifts_update_required_title">This shift requires printing a Data Matrix duplicate</string>
    <string name="shifts_update_required_text">Duplicate printing is not available on the handheld yet. Use a station or change the shift policy in the cabinet.</string>
    <string name="shifts_closed_title">The shift is already closed</string>
    <string name="shifts_closed_text">The list has been refreshed.</string>
    <string name="shifts_status_planned">planned</string>
    <string name="shifts_status_active">active</string>

    <string name="signal_ok">ACCEPTED</string>
    <string name="signal_wrong_code">WRONG CODE</string>
    <string name="signal_wrong_gtin">WRONG GTIN</string>
    <string name="signal_duplicate">DUPLICATE</string>
    <string name="work_waiting">Waiting for a scan…</string>
    <string name="work_first_seen">First scanned at %1$s</string>
    <string name="work_total">Total</string>
    <string name="work_this_terminal">This handheld</string>
    <string name="work_errors">Errors %1$d · Duplicates %2$d</string>
    <string name="work_feed_empty">No scans yet</string>
    <string name="work_more">More</string>
    <string name="work_conflicts">Conflicts (%1$d)</string>
    <string name="work_leave">Leave the shift</string>
    <string name="work_close">Close the shift</string>
    <string name="work_team_chip">+%1$d</string>
    <string name="work_team_title">Team</string>
    <plurals name="work_team_scans">
        <item quantity="one">%d scan</item>
        <item quantity="other">%d scans</item>
    </plurals>
    <string name="work_team_last">last %1$s</string>
    <string name="work_team_empty">Only you so far</string>
    <string name="work_plan_of">%1$d / %2$d</string>

    <string name="close_confirm_title">Close the shift?</string>
    <string name="close_confirm_text">Accepted %1$d, errors %2$d, duplicates %3$d. This device will close the shift.</string>
    <string name="close_action">Close</string>
    <string name="close_reason_title">Why was the plan not met?</string>
    <string name="close_reason_text">Plan %1$d, accepted %2$d.</string>
    <string name="reason_production_defect">Production defect</string>
    <string name="reason_material_shortage">Material shortage</string>
    <string name="reason_equipment_stop">Equipment stop</string>
    <string name="reason_production_order_changed">Production order changed</string>
    <string name="reason_planned_quantity_error">Planned quantity error</string>
    <string name="reason_other_production_deviation">Other production deviation</string>
    <string name="close_draining">Sending scans…</string>
    <string name="close_draining_left">%1$d left</string>
    <string name="close_summary_title">Shift closed</string>
    <string name="close_summary_conflict">The cabinet will close the shift: several devices worked in it</string>
    <string name="close_summary_pending">The close will be sent when the network is back</string>
    <string name="close_summary_accepted">Accepted</string>
    <string name="close_summary_errors">Errors</string>
    <string name="close_summary_duplicates">Duplicates</string>
    <string name="close_summary_conflicts">Conflicts</string>
    <string name="close_to_hub">To the hub</string>

    <string name="conflicts_title">Sync conflicts</string>
    <string name="conflicts_note">The code was already counted on another terminal earlier. Resolution happens in the cabinet.</string>
    <string name="conflicts_empty">No conflicts</string>
    <string name="conflicts_row">…%1$s · terminal …%2$s · %3$s</string>
    <string name="conflicts_unknown_terminal">unknown</string>
</resources>
```

- [ ] **Step 4: Replace the literals in the foundation screens**

Every literal listed by `grep -rn '"[^"]*[А-Яа-яЁё]' app/src/main/kotlin` maps to a key; replace it with `stringResource(R.string.<key>)` (or `stringResource(R.string.<key>, arg)` / `pluralStringResource(R.plurals.<key>, n, n)`) and add `import androidx.compose.ui.res.stringResource`, `import androidx.compose.ui.res.pluralStringResource`, `import app.markiro.handheld.R` where needed:

| File | Literal | Key |
| --- | --- | --- |
| `AppNavigation.kt` `Routes.soon("Смена")` etc. | route titles | pass the tile enum name and resolve in `ComingSoonScreen`: `soon/{tile}` → `ComingSoonScreen(title = stringResource(when (tile) { "SHIFT" -> R.string.hub_tile_shift; "INVENTORY" -> R.string.hub_tile_inventory; else -> R.string.hub_tile_check }))` |
| `Components.kt` | «Назад», «Стереть» | `common_back`, `common_backspace` (content descriptions) |
| `VendorProfiles.kt` | `setupHint = "…"` | `VendorProfile.setupHintRes: Int` = `R.string.vendor_hint_datalogic` / `_honeywell` / `_zebra`; `label` stays (brand names). Screens render `stringResource(profile.setupHintRes, profile.action)` |
| `HubScreen.kt` | «Сеть», «Офлайн», «Очередь 0», «Принтер», «Сканер», «Работаем офлайн», «Выйти», «Смена», «Инвентаризация», «Проверка кода», «Настройки», «нажмите триггер», «принтер не настроен», «данные на», `shiftsLabel`, `inventoriesLabel` | `hub_*`, `common_data_as_of`; `shiftsLabel(count)` becomes a `@Composable fun shiftsLabel(count: Int?): String = when (count) { null -> stringResource(R.string.common_no_data); 0 -> stringResource(R.string.hub_no_shifts); else -> pluralStringResource(R.plurals.hub_shifts_available, count, count) }` and the same for tasks |
| `HubViewModel.kt` | «клавиатурный», «отладка» | inject `@ApplicationContext context: Context` in the Hilt constructor and use `context.getString(R.string.scanner_source_wedge)` / `_debug` in the `scannerLabel` lambda (the primary constructor keeps the lambda) |
| `PairingScreen.kt` | all pairing strings | `pairing_*`, `common_server_unavailable`, `common_retry`, `common_got_it` |
| `SettingsScreens.kt` | all settings and scanner strings | `settings_*`, `theme_*`, `scanner_*`, `soon_*`; `sourceLabel(state)` becomes `@Composable` |
| `SignInScreen.kt` | all sign-in strings | `signin_*` |

`SimpleDateFormat("HH:mm", Locale.forLanguageTag("ru"))` becomes `DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())` in a shared helper `core/util/Clock.kt`:

```kotlin
package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object TimeText {
    private val hhmm = DateTimeFormatter.ofPattern("HH:mm")
    private val ddmm = DateTimeFormatter.ofPattern("dd.MM HH:mm")

    fun hhmm(epochMillis: Long): String = hhmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    fun ddmmHhmm(epochMillis: Long): String = ddmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))
}
```

Add to `app/build.gradle.kts` inside `android { }`:

```kotlin
    lint {
        error += listOf("MissingTranslation", "ExtraTranslation")
    }
```

- [ ] **Step 5: Run the grep, the tests and lint**

```bash
cd apps/handheld && grep -rn '"[^"]*[А-Яа-яЁё][^"]*"' app/src/main/kotlin ; echo "exit $?"
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug
```
Expected: the grep prints nothing (exit 1); all tests PASS (existing screen tests match the Russian defaults); lint reports no `MissingTranslation`.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): Russian and English string resources for every screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 10: Shift list and entry

**Files:**
- Create: `feature/shift/ShiftRepository.kt`, `feature/shift/ShiftListViewModel.kt`, `feature/shift/ShiftListScreen.kt`, `feature/shift/ShiftModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt`, `ShiftListScreenTest.kt`

**Interfaces:**
- Consumes: `StationApi`, `HandheldDatabase`, `RosterStore`, `OperatorDto.toRecord()`, `ReachabilityTracker`, `UPDATE_REQUIRED_CODE`.
- Produces: `ShiftRepository` (`observeShifts`, `refreshList`, `otherLines`, `shiftsOfLine`, `enter(shiftId, fallback): EnterResult`, `leave(shiftId)`), `EnterResult`, `ShiftDto.toEntity(existing, now)`; `ShiftListViewModel` with `ShiftListUi`, `ShiftDialog`, `events: SharedFlow<ShiftListEvent>`; `ShiftListScreen(state, callbacks)`.

- [ ] **Step 1: Write the failing tests**

`app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RosterStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class ShiftRepositoryTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private var clock = 1_757_500_000_000L

    private val shiftJson = """{"id":"s1","number":"SEP26-001","status":"planned","mode":"validation","validationPrint":{"mode":"none"},
        "productId":"p1","productName":"Вода","productPrintName":null,"lineId":"l1","lineName":"Линия 2","counterpartyName":null,
        "plannedQty":100,"plannedDate":"2026-09-10","productionDate":null,"boxCapacity":null,"palletCapacity":null,"palletsEnabled":false,
        "openedAt":null,"closedAt":null,"stationCloseAccess":{"kind":"admin_only"}}"""
    private val bundleJson = """{"shift":${shiftJson.replace("\"status\":\"planned\"", "\"status\":\"active\"")},
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода"},
        "labelTemplate":null,"boxLabelTemplate":null,"counterpartyGln":null,"sscc":null,"ssccRevokedFrom":[],
        "operators":[{"operatorId":"op-1","name":"Иванова Анна","login":"4127","role":"operator","pinHash":"x","badgeHash":null,"active":true}]}"""

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

    private fun repo() = ShiftRepository(api, db, RosterStore(db.operatorDao()), NetworkModule.json()) { clock }

    @Test
    fun refreshStoresTheListAndDropsVanishedListOnlyRows() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[$shiftJson]}"""))
        assertTrue(repo().refreshList())
        assertEquals("/shifts", server.takeRequest().path)
        assertEquals(listOf("s1"), db.shiftDao().observeAll().first().map { it.id })
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(repo().refreshList())
        assertTrue(db.shiftDao().observeAll().first().isEmpty())
    }

    @Test
    fun enterRecordsParticipationStoresTheBundleRosterAndActiveShift() = runTest {
        server.enqueue(MockResponse().setBody(shiftJson.replace("\"status\":\"planned\"", "\"status\":\"active\"")))
        server.enqueue(MockResponse().setBody(bundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1", null))
        assertEquals("/shifts/s1/enter", server.takeRequest().path)
        assertEquals("/shifts/s1/bundle", server.takeRequest().path)
        val shift = db.shiftDao().get("s1")
        assertEquals("04600682000013", shift?.productGtin14)
        assertEquals("active", shift?.status)
        assertNotNull(shift?.bundleFetchedAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
        assertEquals("Иванова Анна", db.operatorDao().all().single().name)
    }

    @Test
    fun updateRequiredAndClosedAreDistinguished() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"STATION_UPDATE_REQUIRED","message":"x"}"""))
        assertEquals(EnterResult.UpdateRequired, repo().enter("s1", null))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"Closed shifts cannot be entered"}"""))
        assertEquals(EnterResult.Closed, repo().enter("s1", null))
    }

    @Test
    fun offlineEntryWorksOnlyWithABundle() = runTest {
        server.shutdown()
        assertEquals(EnterResult.Unavailable, repo().enter("s1", null))
        val r = repo()
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(leftAt = 5L),
        )
        assertEquals(EnterResult.Ok, r.enter("s1", null))
        assertNull(db.shiftDao().get("s1")?.leftAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test
    fun aggregationShiftsAreRefused() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s2").copy(mode = "aggregation"))
        assertEquals(EnterResult.AggregationUnsupported, repo().enter("s2", null))
    }
}
```

`app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftEntityFixtures.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.storage.ShiftEntity

object ShiftEntityFixtures {
    fun listed(id: String, lineId: String? = "l1", mode: String = "validation", status: String = "planned") = ShiftEntity(
        id = id, number = "SEP26-${id.takeLast(1).padStart(3, '0')}", status = status, mode = mode, productId = "p1",
        productName = "Вода 0,5", productPrintName = null, productGtin14 = null, lineId = lineId, lineName = if (lineId == null) null else "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null, boxCapacity = null,
        palletCapacity = null, palletsEnabled = false, validationPrintMode = "none", closePolicyKind = null,
        closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L,
    )

    fun bundled(id: String) = listed(id, status = "active").copy(productGtin14 = "04600682000013", bundleFetchedAt = 1L, enteredAt = 1L)
}
```

`app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftListScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftListScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun showsContinueMineAndDisabledAggregation() {
        var selected: String? = null
        var continued = false
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(
                        loading = false,
                        continueShift = ShiftEntityFixtures.bundled("s1"),
                        mine = listOf(ShiftEntityFixtures.listed("s2"), ShiftEntityFixtures.listed("s3", mode = "aggregation")),
                        others = emptyList(), othersExpanded = false, othersLoading = false, listFetchedAt = 0L, reachable = true,
                        ownLineName = "Линия 2", dialog = null,
                    ),
                    ShiftListCallbacks(onContinue = { continued = true }, onSelect = { selected = it.id }),
                )
            }
        }
        compose.onNodeWithText("SEP26-001").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").performClick()
        assertEquals(true, continued)
        compose.onNodeWithText("SEP26-002").performClick()
        assertEquals("s2", selected)
        compose.onNodeWithText("агрегация: в следующем срезе").assertIsDisplayed()
        compose.onNodeWithText("SEP26-003").assertIsNotEnabled()
    }

    @Test
    fun offlineShowsTheCacheTimeAndTheEmptyState() {
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(false, null, emptyList(), emptyList(), false, false, listFetchedAt = 0L, reachable = false, ownLineName = null, dialog = null),
                    ShiftListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Смен нет").assertIsDisplayed()
        compose.onNodeWithText("данные на", substring = true).assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.shift*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement the repository**

`feature/shift/ShiftRepository.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.room.withTransaction
import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.UPDATE_REQUIRED_CODE
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.feature.pairing.toRecord
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

sealed interface EnterResult {
    data object Ok : EnterResult
    data object UpdateRequired : EnterResult
    data object Closed : EnterResult
    data object AggregationUnsupported : EnterResult
    data object Unavailable : EnterResult
}

fun ShiftDto.toEntity(existing: ShiftEntity?, now: Long) = ShiftEntity(
    id = id,
    number = number,
    status = status,
    mode = mode,
    productId = productId,
    productName = productName,
    productPrintName = productPrintName,
    productGtin14 = existing?.productGtin14,
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    palletCapacity = palletCapacity,
    palletsEnabled = palletsEnabled,
    validationPrintMode = validationPrint?.mode ?: "none",
    closePolicyKind = stationCloseAccess?.kind,
    closeOwnerDeviceId = stationCloseAccess?.ownerDeviceId,
    openedAt = openedAt,
    listFetchedAt = now,
    bundleFetchedAt = existing?.bundleFetchedAt,
    enteredAt = existing?.enteredAt,
    leftAt = existing?.leftAt,
)

/** Shift list cache, entry (server participation + bundle) and the local leave mark. */
class ShiftRepository(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val roster: RosterStore,
    private val json: Json,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeShifts(): Flow<List<ShiftEntity>> = db.shiftDao().observeAll()

    /** Own line plus unassigned shifts; rows without a bundle that vanished from the list are dropped. */
    suspend fun refreshList(): Boolean = try {
        val items = api.shifts().items
        val now = clock()
        db.withTransaction {
            val existing = db.shiftDao().all().associateBy { it.id }
            db.shiftDao().upsertAll(items.map { it.toEntity(existing[it.id], now) })
            db.shiftDao().dropListedExcept(items.map { it.id })
        }
        true
    } catch (_: IOException) {
        false
    } catch (_: HttpException) {
        false
    }

    suspend fun otherLines(ownLineId: String?): List<LineDto> = api.lines().items.filter { it.id != ownLineId }

    suspend fun shiftsOfLine(lineId: String): List<ShiftDto> = api.shifts(lineId = lineId).items.filter { it.status != "closed" }

    suspend fun enter(shiftId: String, fallback: ShiftDto?): EnterResult {
        val cached = db.shiftDao().get(shiftId)
        if ((cached?.mode ?: fallback?.mode) == "aggregation") return EnterResult.AggregationUnsupported
        return try {
            val entered = api.enter(shiftId)
            val bundle = api.bundle(shiftId)
            val now = clock()
            db.withTransaction {
                db.shiftDao().upsert(
                    bundle.shift.toEntity(cached, now).copy(
                        status = entered.status,
                        productGtin14 = bundle.product.gtin14,
                        productName = bundle.product.name,
                        productPrintName = bundle.product.printName ?: bundle.shift.productPrintName,
                        bundleFetchedAt = now,
                        enteredAt = now,
                        leftAt = null,
                    ),
                )
                if (bundle.operators.isNotEmpty()) roster.replace(bundle.operators.map { it.toRecord() })
                db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = shiftId, rosterFetchedAt = now)) }
            }
            EnterResult.Ok
        } catch (e: HttpException) {
            when {
                e.code() == 409 && errorCode(e) == UPDATE_REQUIRED_CODE -> EnterResult.UpdateRequired
                e.code() == 409 || e.code() == 404 -> EnterResult.Closed
                else -> EnterResult.Unavailable
            }
        } catch (_: IOException) {
            if (cached?.bundleFetchedAt != null) {
                enterOffline(cached)
                EnterResult.Ok
            } else {
                EnterResult.Unavailable
            }
        }
    }

    private suspend fun enterOffline(cached: ShiftEntity) {
        val now = clock()
        db.withTransaction {
            db.shiftDao().upsert(cached.copy(enteredAt = now, leftAt = null))
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = cached.id)) }
        }
    }

    suspend fun leave(shiftId: String) = db.shiftDao().setLeftAt(shiftId, clock())

    private fun errorCode(e: HttpException): String? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code }.getOrNull()
}
```

`feature/shift/ShiftModule.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RosterStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ShiftModule {
    @Provides
    @Singleton
    fun shiftRepository(api: StationApi, db: HandheldDatabase, roster: RosterStore, json: Json): ShiftRepository =
        ShiftRepository(api, db, roster, json)
}
```

(`json` here is the lenient, unqualified `Json`.)

- [ ] **Step 4: Implement the view model**

`feature/shift/ShiftListViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.ShiftEntity
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

data class OtherLine(val id: String, val name: String, val shifts: List<ShiftDto>)

sealed interface ShiftDialog {
    data class ConfirmOther(val shift: ShiftDto, val lineName: String) : ShiftDialog
    data object Entering : ShiftDialog
    data object UpdateRequired : ShiftDialog
    data object Closed : ShiftDialog
    data object Unavailable : ShiftDialog
}

data class ShiftListUi(
    val loading: Boolean,
    val continueShift: ShiftEntity?,
    val mine: List<ShiftEntity>,
    val others: List<OtherLine>,
    val othersExpanded: Boolean,
    val othersLoading: Boolean,
    val listFetchedAt: Long?,
    val reachable: Boolean,
    val ownLineName: String?,
    val dialog: ShiftDialog?,
)

sealed interface ShiftListEvent {
    data class Entered(val shiftId: String) : ShiftListEvent
}

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L

@HiltViewModel
class ShiftListViewModel @Inject constructor(
    private val repository: ShiftRepository,
    private val config: DeviceConfigDao,
    reachability: ReachabilityTracker,
) : ViewModel() {
    private val loading = MutableStateFlow(true)
    private val others = MutableStateFlow<List<OtherLine>>(emptyList())
    private val othersExpanded = MutableStateFlow(false)
    private val othersLoading = MutableStateFlow(false)
    private val dialog = MutableStateFlow<ShiftDialog?>(null)
    private val _events = MutableSharedFlow<ShiftListEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ShiftListEvent> = _events

    private val lists = combine(repository.observeShifts(), config.observe(), reachability.lastSuccessAt) { shifts, cfg, lastOk ->
        val open = shifts.filter { it.status != "closed" }
        val current = cfg?.activeShiftId?.let { id -> open.firstOrNull { it.id == id } }
        val mine = open.filter { it.id != current?.id && (it.lineId == cfg?.lineId || it.lineId == null) }
        Triple(current, mine, cfg)
    }

    val state: StateFlow<ShiftListUi> = combine(lists, loading, others, othersExpanded, othersLoading, dialog) { values ->
        @Suppress("UNCHECKED_CAST")
        val (current, mine, cfg) = values[0] as Triple<ShiftEntity?, List<ShiftEntity>, app.markiro.handheld.core.storage.DeviceConfigEntity?>
        ShiftListUi(
            loading = values[1] as Boolean,
            continueShift = current,
            mine = mine,
            others = values[2] as List<OtherLine>,
            othersExpanded = values[3] as Boolean,
            othersLoading = values[4] as Boolean,
            listFetchedAt = mine.maxOfOrNull { it.listFetchedAt } ?: current?.listFetchedAt,
            reachable = reachability.lastSuccessAt.value?.let { System.currentTimeMillis() - it <= REACHABLE_WINDOW_MS } ?: false,
            ownLineName = cfg?.lineName,
            dialog = values[5] as ShiftDialog?,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ShiftListUi(true, null, emptyList(), emptyList(), false, false, null, false, null, null))

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            loading.value = true
            repository.refreshList()
            loading.value = false
        }
    }

    fun expandOthers() {
        if (othersExpanded.value) return
        othersExpanded.value = true
        viewModelScope.launch {
            othersLoading.value = true
            val lines = runCatching { repository.otherLines(config.get()?.lineId) }.getOrDefault(emptyList())
            others.value = lines.map { line ->
                OtherLine(line.id, line.name, runCatching { repository.shiftsOfLine(line.id) }.getOrDefault(emptyList()))
            }
            othersLoading.value = false
        }
    }

    fun select(shift: ShiftEntity) {
        if (shift.mode == "aggregation") return
        if (shift.bundleFetchedAt == null && !state.value.reachable) {
            dialog.value = ShiftDialog.Unavailable
            return
        }
        enter(shift.id, null)
    }

    fun continueCurrent() {
        state.value.continueShift?.let { enter(it.id, null) }
    }

    fun selectOther(shift: ShiftDto, lineName: String) {
        dialog.value = ShiftDialog.ConfirmOther(shift, lineName)
    }

    fun confirmOther() {
        val d = dialog.value as? ShiftDialog.ConfirmOther ?: return
        enter(d.shift.id, d.shift)
    }

    fun dismissDialog() {
        dialog.value = null
    }

    private fun enter(shiftId: String, fallback: ShiftDto?) {
        viewModelScope.launch {
            dialog.value = ShiftDialog.Entering
            when (repository.enter(shiftId, fallback)) {
                EnterResult.Ok -> {
                    dialog.value = null
                    _events.emit(ShiftListEvent.Entered(shiftId))
                }
                EnterResult.UpdateRequired -> dialog.value = ShiftDialog.UpdateRequired
                EnterResult.Closed -> {
                    dialog.value = ShiftDialog.Closed
                    repository.refreshList()
                }
                EnterResult.AggregationUnsupported -> dialog.value = null
                EnterResult.Unavailable -> dialog.value = ShiftDialog.Unavailable
            }
        }
    }
}
```

- [ ] **Step 5: Implement the screen**

`feature/shift/ShiftListScreen.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
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
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.util.TimeText

data class ShiftListCallbacks(
    val onBack: () -> Unit = {},
    val onContinue: () -> Unit = {},
    val onSelect: (ShiftEntity) -> Unit = {},
    val onExpandOthers: () -> Unit = {},
    val onSelectOther: (ShiftDto, String) -> Unit = { _, _ -> },
    val onConfirmOther: () -> Unit = {},
    val onDismiss: () -> Unit = {},
    val onRefresh: () -> Unit = {},
)

/** Card content shared by cached rows and other-line rows. */
data class ShiftCard(
    val id: String,
    val number: String,
    val product: String,
    val plan: Int?,
    val aggregation: Boolean,
    val lineName: String?,
    val tolling: String?,
    val active: Boolean,
    val enabled: Boolean,
    val disabledReason: Int?,
)

private fun ShiftEntity.card(reachable: Boolean) = ShiftCard(
    id = id,
    number = number,
    product = productPrintName ?: productName ?: productId,
    plan = plannedQty,
    aggregation = mode == "aggregation",
    lineName = lineName,
    tolling = counterpartyName,
    active = status == "active",
    enabled = mode != "aggregation" && (bundleFetchedAt != null || reachable),
    disabledReason = when {
        mode == "aggregation" -> R.string.shifts_aggregation_later
        bundleFetchedAt == null && !reachable -> R.string.shifts_needs_network
        else -> null
    },
)

private fun ShiftDto.card(reachable: Boolean, lineName: String) = ShiftCard(
    id = id,
    number = number,
    product = productPrintName ?: productName ?: productId,
    plan = plannedQty,
    aggregation = mode == "aggregation",
    lineName = lineName,
    tolling = counterpartyName,
    active = status == "active",
    enabled = mode != "aggregation" && reachable,
    disabledReason = if (mode == "aggregation") R.string.shifts_aggregation_later else if (!reachable) R.string.shifts_needs_network else null,
)

@Composable
fun ShiftListScreen(state: ShiftListUi, cb: ShiftListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (val d = state.dialog) {
            is ShiftDialog.ConfirmOther -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.shifts_join_other_title),
                    stringResource(R.string.shifts_join_other_text, d.shift.number, d.lineName, state.ownLineName.orEmpty()),
                    primary = StateAction(stringResource(R.string.shifts_enter), cb.onConfirmOther),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                )
                return
            }
            ShiftDialog.Entering -> {
                AppBar(stringResource(R.string.shifts_title))
                FullScreenState(Icons.Outlined.Sync, stringResource(R.string.shifts_entering), "", tone = Tone.Info)
                return
            }
            ShiftDialog.UpdateRequired -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.SystemUpdate,
                    stringResource(R.string.shifts_update_required_title),
                    stringResource(R.string.shifts_update_required_text),
                    primary = StateAction(stringResource(R.string.common_got_it), cb.onDismiss),
                    tone = Tone.Warn,
                    primaryIsAccent = false,
                )
                return
            }
            ShiftDialog.Closed -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.shifts_closed_title),
                    stringResource(R.string.shifts_closed_text),
                    primary = StateAction(stringResource(R.string.common_got_it), cb.onDismiss),
                    primaryIsAccent = false,
                )
                return
            }
            ShiftDialog.Unavailable -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.WifiOff,
                    stringResource(R.string.common_server_unavailable),
                    stringResource(R.string.shifts_needs_network),
                    primary = StateAction(stringResource(R.string.common_retry), cb.onRefresh),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                    tone = Tone.Err,
                )
                return
            }
            null -> Unit
        }
        AppBar(stringResource(R.string.shifts_title), cb.onBack)
        if (!state.reachable && state.listFetchedAt != null) {
            Text(
                stringResource(R.string.common_data_as_of, TimeText.hhmm(state.listFetchedAt)),
                style = t.caption,
                color = c.warnFg,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
        }
        if (!state.loading && state.continueShift == null && state.mine.isEmpty() && !state.othersExpanded) {
            FullScreenState(Icons.Outlined.Factory, stringResource(R.string.shifts_empty_title), stringResource(R.string.shifts_empty_text))
            return
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            state.continueShift?.let { current ->
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        ShiftCardView(current.card(true), onClick = cb.onContinue)
                        PrimaryButton(stringResource(R.string.common_continue), cb.onContinue)
                    }
                }
            }
            if (state.mine.isNotEmpty()) {
                item { Text(stringResource(R.string.shifts_my_line), style = t.label, color = c.fg3) }
                items(state.mine, key = { it.id }) { shift -> ShiftCardView(shift.card(state.reachable), onClick = { cb.onSelect(shift) }) }
            }
            if (state.loading) item { Text(stringResource(R.string.shifts_loading), style = t.caption, color = c.fg3) }
            if (!state.othersExpanded) {
                item { MarkiroTextButton(stringResource(R.string.shifts_show_other), cb.onExpandOthers) }
            } else {
                item { Text(stringResource(R.string.shifts_other_lines), style = t.label, color = c.fg3) }
                if (state.othersLoading) item { Text(stringResource(R.string.shifts_loading), style = t.caption, color = c.fg3) }
                state.others.forEach { line ->
                    items(line.shifts, key = { "${line.id}:${it.id}" }) { dto ->
                        ShiftCardView(dto.card(state.reachable, line.name), onClick = { cb.onSelectOther(dto, line.name) })
                    }
                }
            }
        }
    }
}

@Composable
fun ShiftCardView(card: ShiftCard, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        Modifier.fillMaxWidth().heightIn(min = 96.dp).clip(shape).background(c.surfaceCard)
            .border(1.dp, if (card.active) c.accent else c.line, shape)
            .clickable(enabled = card.enabled, onClick = onClick)
            .alpha(if (card.enabled) 1f else 0.55f)
            .padding(14.dp)
            .semantics { },
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1),
    ) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(card.number, style = t.code.copy(fontSize = 16.sp), color = c.fg1)
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                MarkiroChip(stringResource(R.string.shifts_mode_validation), Tone.Neutral)
                if (card.aggregation) MarkiroChip(stringResource(R.string.shifts_mode_aggregation), Tone.Info)
                if (card.active) MarkiroChip(stringResource(R.string.shifts_status_active), Tone.Ok)
            }
        }
        Text(card.product, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(
            listOfNotNull(
                card.plan?.let { stringResource(R.string.shifts_plan, it) } ?: stringResource(R.string.shifts_no_plan),
                card.lineName,
                card.tolling?.let { stringResource(R.string.shifts_tolling, it) },
            ).joinToString(" · "),
            style = t.caption,
            color = c.fg3,
        )
        card.disabledReason?.let { Text(stringResource(it), style = t.caption, color = c.warnFg) }
    }
}
```

`PaddingValues` is imported inline above; move it to the import block (`androidx.compose.foundation.layout.PaddingValues`).

- [ ] **Step 6: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.shift*'
```
Expected: PASS. `assertIsNotEnabled` on the aggregation card needs `clickable(enabled = false)` to publish the disabled semantics; it does.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): shift list with continue, other lines and entry through enter and bundle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Work screen — scans, verdicts, counters, feed, team

**Files:**
- Create: `feature/work/TeamRefresher.kt`, `feature/work/WorkViewModel.kt`, `feature/work/WorkScreen.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt`, `WorkScreenTest.kt`

**Interfaces:**
- Consumes: `ScanEvents`, `ScanRecorder`, `Signaller`, `SyncEngine`, `HandheldDatabase`, `SessionHolder`, `ReachabilityTracker`, `StationApi`.
- Produces: `WorkUi`, `LastScan`, `TeamState`, `WorkViewModel(shiftId)` (`leave()`), `WorkScreen(state, callbacks)`, `WorkCallbacks`.

- [ ] **Step 1: Write the failing tests**

`app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.work

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRecorder
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val played = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val gs = "\u001d"

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
    }

    @After
    fun tearDown() = db.close()

    private fun vm(): WorkViewModel {
        val engine = SyncEngine(db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" }, NetworkModule.strictJson(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
        return WorkViewModel(
            SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
            object : SignalPort { override fun play(kind: SignalKind) { played += kind } }, engine, session, ReachabilityTracker(),
            TeamRefresher { null }, null,
        )
    }

    @Test
    fun scansUpdateTheLastZoneCountersAndFeed() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(Verdict.OK, vm.state.value.last?.verdict)
        assertEquals("abc", vm.state.value.last?.tail)
        assertEquals(1, vm.state.value.thisTerminal)
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93BBBB", null, "debug", 0))
        scans.tryEmit(ScanEvent("010460000000001521x", null, "debug", 0))
        scans.tryEmit(ScanEvent("garbage", null, "debug", 0))
        advanceUntilIdle()
        val s = vm.state.value
        assertEquals(Verdict.INVALID, s.last?.verdict)
        assertEquals(1, s.thisTerminal)
        assertEquals(2, s.errors)
        assertEquals(1, s.duplicates)
        assertEquals(4, s.feed.size)
        assertEquals(listOf(SignalKind.OK, SignalKind.DUPLICATE, SignalKind.ERROR, SignalKind.ERROR), played)
        assertNotNull(db.outboxDao().head(1).firstOrNull())
    }

    @Test
    fun duplicateCarriesTheFirstSeenTime() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321dup", null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321dup", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(Verdict.DUPLICATE, vm.state.value.last?.verdict)
        assertNotNull(vm.state.value.last?.firstSeenAt)
    }
}
```

`app/src/test/kotlin/app/markiro/handheld/feature/work/WorkScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val ui = WorkUi(
        shift = ShiftEntityFixtures.bundled("s1"),
        last = LastScan(Verdict.DUPLICATE, "…1234567", firstSeenAt = "2026-09-10T07:42:00.000Z", at = "2026-09-10T08:00:00.000Z"),
        total = 1240, plan = 3000, thisTerminal = 312, errors = 4, duplicates = 2,
        feed = listOf(ScanEventEntity(1, "s1", "raw", "ok", "2026-09-10T08:00:00.000Z", null, "h")),
        sync = SyncState(pending = 37), reachable = false,
        team = TeamState(participants = emptyList(), acceptedUnits = 1240, at = 0L),
    )

    @Test
    fun rendersVerdictCountersBannerAndOverflowActions() {
        var closed = false
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks(onClose = { closed = true })) } }
        compose.onNodeWithText("ДУБЛЬ").assertIsDisplayed()
        compose.onNodeWithText("Первый скан в", substring = true).assertIsDisplayed()
        compose.onNodeWithText("1 240 / 3 000").assertIsDisplayed()
        compose.onNodeWithText("312").assertIsDisplayed()
        compose.onNodeWithText("Ошибки 4 · Дубли 2").assertIsDisplayed()
        compose.onNodeWithText("Работаем офлайн · 37 сканов в очереди").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ещё").performClick()
        compose.onNodeWithText("Закрыть смену").performClick()
        assertEquals(true, closed)
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.work*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement**

`feature/work/TeamRefresher.kt`:

```kotlin
package app.markiro.handheld.feature.work

import app.markiro.handheld.core.network.ParticipantDto
import app.markiro.handheld.core.network.StationApi

data class TeamState(val participants: List<ParticipantDto>, val acceptedUnits: Int?, val at: Long)

/** `GET /shifts/:id/summary`; null on any failure (403 until the device is a participant, offline, ...). */
fun interface TeamRefresher {
    suspend fun refresh(shiftId: String): TeamState?
}

class ApiTeamRefresher(private val api: StationApi, private val clock: () -> Long = System::currentTimeMillis) : TeamRefresher {
    override suspend fun refresh(shiftId: String): TeamState? = runCatching {
        val summary = api.summary(shiftId)
        TeamState(summary.participants, summary.output.acceptedUnits, clock())
    }.getOrNull()
}
```

`feature/work/WorkViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.work

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanOutcome
import app.markiro.handheld.core.scan.ScanRecorder
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftRepository
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Seam for the signaller so tests can record kinds. */
fun interface SignalPort {
    fun play(kind: SignalKind)
}

data class LastScan(val verdict: Verdict, val tail: String, val firstSeenAt: String?, val at: String)

data class WorkUi(
    val shift: ShiftEntity?,
    val last: LastScan?,
    val total: Int,
    val plan: Int?,
    val thisTerminal: Int,
    val errors: Int,
    val duplicates: Int,
    val feed: List<ScanEventEntity>,
    val sync: SyncState,
    val reachable: Boolean,
    val team: TeamState?,
)

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private const val TEAM_REFRESH_MS = 60_000L

@HiltViewModel
class WorkViewModel(
    handle: SavedStateHandle,
    private val db: HandheldDatabase,
    private val recorder: ScanRecorder,
    scans: ScanEvents,
    private val signals: SignalPort,
    private val sync: SyncEngine,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    private val team: TeamRefresher,
    private val repository: ShiftRepository?,
) : ViewModel() {
    @Inject
    constructor(
        handle: SavedStateHandle,
        db: HandheldDatabase,
        recorder: ScanRecorder,
        scans: ScanEvents,
        signaller: Signaller,
        sync: SyncEngine,
        session: SessionHolder,
        reachability: ReachabilityTracker,
        team: TeamRefresher,
        repository: ShiftRepository,
    ) : this(handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability, team, repository)

    val shiftId: String = checkNotNull(handle["shiftId"])
    private val last = MutableStateFlow<LastScan?>(null)
    private val teamState = MutableStateFlow<TeamState?>(null)

    private val counters = combine(
        db.codeDao().observeCountForShift(shiftId),
        db.scanEventDao().observeCount(shiftId, Verdict.INVALID.wire),
        db.scanEventDao().observeCount(shiftId, Verdict.WRONG_GTIN.wire),
        db.scanEventDao().observeCount(shiftId, Verdict.DUPLICATE.wire),
    ) { mine, invalid, wrong, dup -> Counters(mine, invalid + wrong, dup) }

    private data class Counters(val mine: Int, val errors: Int, val duplicates: Int)

    val state: StateFlow<WorkUi> = combine(
        db.shiftDao().observe(shiftId), last, counters, db.scanEventDao().observeRecent(shiftId, 4), sync.state, reachability.lastSuccessAt, teamState,
    ) { values ->
        @Suppress("UNCHECKED_CAST")
        val shift = values[0] as ShiftEntity?
        val c = values[2] as Counters
        val teamNow = values[6] as TeamState?
        val lastOk = values[5] as Long?
        WorkUi(
            shift = shift,
            last = values[1] as LastScan?,
            total = teamNow?.acceptedUnits ?: c.mine,
            plan = shift?.plannedQty,
            thisTerminal = c.mine,
            errors = c.errors,
            duplicates = c.duplicates,
            feed = values[3] as List<ScanEventEntity>,
            sync = values[4] as SyncState,
            reachable = lastOk != null && System.currentTimeMillis() - lastOk <= REACHABLE_WINDOW_MS,
            team = teamNow,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WorkUi(null, null, 0, null, 0, 0, 0, emptyList(), SyncState(), false, null))

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        viewModelScope.launch {
            while (isActive) {
                teamState.value = team.refresh(shiftId) ?: teamState.value
                delay(TEAM_REFRESH_MS)
            }
        }
    }

    private suspend fun onScan(raw: String) {
        val shift = db.shiftDao().get(shiftId) ?: return
        if (shift.productGtin14 == null || shift.status == "closed") return
        val outcome = recorder.record(shift, raw, session.state.value.operator?.operatorId)
        signals.play(Signaller.forVerdict(outcome.verdict))
        last.value = outcome.toLastScan(raw)
        sync.nudge()
    }

    private fun ScanOutcome.toLastScan(raw: String) = LastScan(
        verdict = verdict,
        tail = (km?.serial ?: raw).let { if (it.length > 8) "…" + it.takeLast(8) else it },
        firstSeenAt = firstSeenAt,
        at = scannedAt,
    )

    fun leave() {
        viewModelScope.launch { repository?.leave(shiftId) }
    }
}
```

Provide `TeamRefresher` in `ShiftModule`:

```kotlin
    @Provides
    fun teamRefresher(api: StationApi): TeamRefresher = ApiTeamRefresher(api)
```

`feature/work/WorkScreen.kt`:

```kotlin
package app.markiro.handheld.feature.work

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
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
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
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat

data class WorkCallbacks(
    val onLeave: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onConflicts: () -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkScreen(state: WorkUi, cb: WorkCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    var menu by remember { mutableStateOf(false) }
    var teamSheet by remember { mutableStateOf(false) }
    val numbers = NumberFormat.getIntegerInstance()
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) StatusItem(Icons.Outlined.Wifi, stringResource(R.string.hub_network)) else StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.hub_offline), Tone.Warn),
                StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.sync.pending), if (state.sync.stuck) Tone.Err else Tone.Neutral),
                StatusItem(Icons.Outlined.Print, stringResource(R.string.hub_printer)),
                StatusItem(Icons.Outlined.QrCodeScanner, stringResource(R.string.hub_scanner)),
            ),
        )
        if (state.sync.stuck) {
            Banner(stringResource(R.string.hub_sync_stuck), Tone.Err, Icons.Outlined.Sync)
        } else if (!state.reachable) {
            val text = if (state.sync.pending > 0) {
                stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.scans_queued, state.sync.pending, state.sync.pending))
            } else {
                stringResource(R.string.hub_offline_banner)
            }
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        // Shift header
        Row(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(state.shift?.let { it.productPrintName ?: it.productName } ?: "", style = t.strong.copy(fontSize = 16.sp), color = c.fg1, maxLines = 1)
                Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
                    Text(state.shift?.number ?: "", style = t.caption, color = c.fg3)
                    state.shift?.counterpartyName?.let { MarkiroChip(stringResource(R.string.shifts_tolling, it), Tone.Info) }
                }
            }
            val others = (state.team?.participants?.size ?: 1) - 1
            if (others > 0) {
                Box(Modifier.clip(RoundedCornerShape(MarkiroSizes.radius)).clickable { teamSheet = true }.padding(MarkiroSizes.sp2)) {
                    MarkiroChip(stringResource(R.string.work_team_chip, others), Tone.Accent)
                }
            }
            Box {
                IconAction(Icons.Outlined.MoreVert, stringResource(R.string.work_more)) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.work_conflicts, state.sync.conflicts)) }, onClick = { menu = false; cb.onConflicts() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.work_leave)) }, onClick = { menu = false; cb.onLeave() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.work_close)) }, onClick = { menu = false; cb.onClose() })
                }
            }
        }
        LastScanZone(state.last, Modifier.weight(0.4f))
        // Counters
        Row(
            Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Counter(stringResource(R.string.work_total), state.plan?.let { stringResource(R.string.work_plan_of, state.total, it).replace(state.total.toString(), numbers.format(state.total)).replace(it.toString(), numbers.format(it)) } ?: numbers.format(state.total))
            Counter(stringResource(R.string.work_this_terminal), numbers.format(state.thisTerminal))
            Counter("", stringResource(R.string.work_errors, state.errors, state.duplicates), tone = if (state.errors + state.duplicates > 0) Tone.Warn else Tone.Neutral)
        }
        // Feed
        Column(Modifier.weight(0.6f).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
            if (state.feed.isEmpty()) Text(stringResource(R.string.work_feed_empty), style = t.caption, color = c.fg3)
            state.feed.forEach { event ->
                val verdict = Verdict.fromWire(event.verdict)
                Row(Modifier.fillMaxWidth().height(32.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(Iso.parse(event.scannedAt)?.let { TimeText.hhmm(it) } ?: "", style = t.caption, color = c.fg3)
                    Text("…" + event.raw.takeLast(8), style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                    Text(stringResource(verdict.label()), style = t.caption, color = c.tone(verdict.tone()).fg)
                }
            }
        }
    }
    if (teamSheet) {
        ModalBottomSheet(onDismissRequest = { teamSheet = false }, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                Text(stringResource(R.string.work_team_title), style = t.strong, color = c.fg1)
                val participants = state.team?.participants.orEmpty()
                if (participants.isEmpty()) Text(stringResource(R.string.work_team_empty), style = t.caption, color = c.fg3)
                participants.forEach { p ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(p.fullName, style = t.body, color = c.fg1)
                        Text(
                            pluralStringResource(R.plurals.work_team_scans, p.acceptedScans, p.acceptedScans) + " · " +
                                stringResource(R.string.work_team_last, Iso.parse(p.lastActivityAt)?.let { TimeText.hhmm(it) } ?: "—"),
                            style = t.caption,
                            color = c.fg3,
                        )
                    }
                }
                state.team?.let { Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it.at)), style = t.caption, color = c.fg3) }
            }
        }
    }
}

fun Verdict.label(): Int = when (this) {
    Verdict.OK -> R.string.signal_ok
    Verdict.DUPLICATE -> R.string.signal_duplicate
    Verdict.WRONG_GTIN -> R.string.signal_wrong_gtin
    Verdict.INVALID -> R.string.signal_wrong_code
}

fun Verdict.tone(): Tone = when (this) {
    Verdict.OK -> Tone.Ok
    Verdict.DUPLICATE -> Tone.Warn
    Verdict.WRONG_GTIN, Verdict.INVALID -> Tone.Err
}

@Composable
private fun LastScanZone(last: LastScan?, modifier: Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val tone = last?.verdict?.tone()
    val colors = tone?.let { c.tone(it) }
    Column(
        modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(colors?.bg ?: c.surfaceCard).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (last == null) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3)
            Text(stringResource(R.string.work_waiting), style = t.strong, color = c.fg3)
        } else {
            val icon = when (last.verdict) {
                Verdict.OK -> Icons.Outlined.CheckCircle
                Verdict.DUPLICATE -> Icons.Outlined.ContentCopy
                else -> Icons.Outlined.ErrorOutline
            }
            Icon(icon, contentDescription = null, tint = colors!!.fg)
            Text(stringResource(last.verdict.label()), style = t.title, color = colors.fg)
            Text(last.tail, style = t.code, color = c.fg1)
            last.firstSeenAt?.let { seen ->
                Text(stringResource(R.string.work_first_seen, Iso.parse(seen)?.let { TimeText.hhmm(it) } ?: seen), style = t.caption, color = c.fg2)
            }
        }
    }
}

@Composable
private fun Counter(label: String, value: String, tone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(horizontalAlignment = Alignment.Start) {
        if (label.isNotEmpty()) Text(label, style = t.caption, color = c.fg3)
        Text(value, style = t.strong.copy(fontSize = 16.sp), color = if (tone == Tone.Neutral) c.fg1 else c.tone(tone).fg)
    }
}
```

`ToneColors` (from `Tokens.kt`) exposes `fg` and `bg`; if its fields are named differently, use those names. `NumberFormat.getIntegerInstance()` renders `1 240` in Russian (narrow no-break space) and `1,240` in English; the screen test expects the Russian grouping — assert with `onNodeWithText(NumberFormat.getIntegerInstance().format(1240) + " / " + NumberFormat.getIntegerInstance().format(3000))` if the literal space does not match.

- [ ] **Step 4: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.work*'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): work screen with verdict zone, counters, feed and team sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 12: Leave and close the shift

**Files:**
- Create: `feature/shift/ShiftCloser.kt`, `feature/shift/CloseViewModel.kt`, `feature/shift/CloseScreens.kt`
- Modify: `feature/shift/ShiftModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftCloserTest.kt`, `CloseViewModelTest.kt`, `CloseScreensTest.kt`

**Interfaces:**
- Consumes: `HandheldDatabase`, `SyncEngine.drainAll()`, `SessionHolder`.
- Produces: `ShiftCloser.preview(shiftId): Preview?`, `ShiftCloser.close(shiftId, operatorId, reasonCode): ShiftCloseEntity`, `ShiftCloser.REASONS`; `CloseStep`, `CloseOutcome`, `CloseViewModel` (`confirm()`, `selectReason(code)`, `submitReason()`, `cancel`); `CloseScreen(step, callbacks)`, `CloseCallbacks`.

- [ ] **Step 1: Write the failing tests**

`app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftCloserTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEventEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftCloserTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 3))
        db.codeDao().insert(CodeEntity("h1", "s1", "04600682000013", "a", "2026-09-10T10:00:00.000Z"))
        db.codeDao().insert(CodeEntity("h2", "s1", "04600682000013", "b", "2026-09-10T10:01:00.000Z"))
        db.scanEventDao().insert(ScanEventEntity(shiftId = "s1", raw = "x", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null))
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun previewCountsAndRequiresAReasonWhenThePlanIsMissed() = runTest {
        val p = ShiftCloser(db).preview("s1")!!
        assertEquals(2, p.accepted)
        assertEquals(1, p.errors)
        assertEquals(3, p.plan)
        assertTrue(p.reasonRequired)
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        assertFalse(ShiftCloser(db).preview("s1")!!.reasonRequired)
    }

    @Test
    fun closeWritesOnePendingRowClosesLocallyAndClearsTheActiveShift() = runTest {
        val closer = ShiftCloser(db) { 1_757_500_000_000L }
        val row = closer.close("s1", "op-1", "material_shortage")
        assertEquals("pending", row.state)
        assertEquals(3, row.plannedQtySnapshot)
        assertEquals(2, row.actualQty)
        assertEquals("material_shortage", row.reasonCode)
        assertEquals("closed", db.shiftDao().get("s1")?.status)
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        val again = closer.close("s1", "op-1", "equipment_stop")
        assertEquals(row.eventId, again.eventId)
    }

    @Test
    fun closeRefusesAMissingReasonWhenRequired() = runTest {
        val result = runCatching { ShiftCloser(db).close("s1", null, null) }
        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        assertNull(db.shiftCloseDao().forShift("s1"))
        assertEquals("active", db.shiftDao().get("s1")?.status)
    }
}
```

`app/src/test/kotlin/app/markiro/handheld/feature/shift/CloseViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(DeviceConfigEntity(deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 5))
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun vm(): CloseViewModel {
        val engine = SyncEngine(db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { server.url("/").toString() }, NetworkModule.strictJson(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
        return CloseViewModel(SavedStateHandle(mapOf("shiftId" to "s1")), ShiftCloser(db), engine, db, SessionHolder())
    }

    @Test
    fun planMissRequiresAReasonThenDrainsAndReportsAccepted() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"accepted"}"""))
        val vm = vm()
        advanceUntilIdle()
        assertTrue(vm.step.value is CloseStep.Confirm)
        vm.confirm()
        advanceUntilIdle()
        assertTrue(vm.step.value is CloseStep.Reason)
        vm.selectReason("equipment_stop")
        vm.submitReason()
        advanceUntilIdle()
        val summary = vm.step.value as CloseStep.Summary
        assertEquals(CloseOutcome.ACCEPTED, summary.outcome)
        assertEquals("/station/shift-closures", server.takeRequest().path)
    }

    @Test
    fun offlineCloseEndsInPending() = runTest {
        server.shutdown()
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        val vm = vm()
        advanceUntilIdle()
        vm.confirm()
        advanceUntilIdle()
        assertEquals(CloseOutcome.PENDING, (vm.step.value as CloseStep.Summary).outcome)
        assertEquals("pending", db.shiftCloseDao().forShift("s1")?.state)
    }

    @Test
    fun conflictIsReported() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"conflict","conflictCode":"multiple_devices"}"""))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        val vm = vm()
        advanceUntilIdle()
        vm.confirm()
        advanceUntilIdle()
        assertEquals(CloseOutcome.CONFLICT, (vm.step.value as CloseStep.Summary).outcome)
    }
}
```

`app/src/test/kotlin/app/markiro/handheld/feature/shift/CloseScreensTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun reasonStepListsTheSixReasonsAndSubmits() {
        var picked: String? = null
        var submitted = false
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Reason(ShiftCloser.Preview(8, 1, 0, 10, reasonRequired = true, alreadyClosed = false), selected = "equipment_stop"),
                    CloseCallbacks(onSelectReason = { picked = it }, onSubmitReason = { submitted = true }),
                )
            }
        }
        compose.onNodeWithText("Почему план не выполнен?").assertIsDisplayed()
        compose.onNodeWithText("Нехватка сырья или материалов").performClick()
        assertEquals("material_shortage", picked)
        compose.onNodeWithText("Закрыть").performClick()
        assertEquals(true, submitted)
    }

    @Test
    fun summaryShowsTheConflictNote() {
        compose.setContent {
            MarkiroTheme { CloseScreen(CloseStep.Summary(8, 1, 0, 2, CloseOutcome.CONFLICT), CloseCallbacks()) }
        }
        compose.onNodeWithText("Смену закроет кабинет: работало несколько устройств").assertIsDisplayed()
        compose.onNodeWithText("В хаб").assertIsDisplayed()
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftCloserTest*' --tests '*CloseViewModelTest*' --tests '*CloseScreensTest*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Implement the closer**

`feature/shift/ShiftCloser.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import android.database.sqlite.SQLiteConstraintException
import androidx.room.withTransaction
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.util.Iso
import java.util.UUID

/** Port of the station's closeShiftOffline: the close is a durable local fact before any network. */
class ShiftCloser(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    data class Preview(val accepted: Int, val errors: Int, val duplicates: Int, val plan: Int?, val reasonRequired: Boolean, val alreadyClosed: Boolean)

    suspend fun preview(shiftId: String): Preview? {
        val shift = db.shiftDao().get(shiftId) ?: return null
        val accepted = db.codeDao().countForShift(shiftId)
        val errors = db.scanEventDao().count(shiftId, Verdict.INVALID.wire) + db.scanEventDao().count(shiftId, Verdict.WRONG_GTIN.wire)
        val duplicates = db.scanEventDao().count(shiftId, Verdict.DUPLICATE.wire)
        return Preview(
            accepted = accepted,
            errors = errors,
            duplicates = duplicates,
            plan = shift.plannedQty,
            reasonRequired = reasonRequired(shift.plannedQty, accepted),
            alreadyClosed = db.shiftCloseDao().forShift(shiftId) != null,
        )
    }

    /** Idempotent per shift: a second call returns the stored row and re-applies the local close. */
    suspend fun close(shiftId: String, operatorId: String?, reasonCode: String?): ShiftCloseEntity = db.withTransaction {
        db.shiftCloseDao().forShift(shiftId)?.let { existing ->
            finishLocally(shiftId)
            return@withTransaction existing
        }
        val shift = db.shiftDao().get(shiftId) ?: error("shift $shiftId is not on this device")
        val accepted = db.codeDao().countForShift(shiftId)
        val reason = reasonCode?.takeIf { it in REASONS }
        require(!reasonRequired(shift.plannedQty, accepted) || reason != null) { "A valid close reason is required" }
        val row = ShiftCloseEntity(
            eventId = UUID.randomUUID().toString(),
            shiftId = shiftId,
            operatorId = operatorId,
            plannedQtySnapshot = shift.plannedQty,
            actualQty = accepted,
            closedBoxCount = 0,
            reasonCode = reason,
            closedAt = Iso.format(clock()),
            state = "pending",
            conflictCode = null,
            lastCheckedAt = null,
        )
        try {
            db.shiftCloseDao().insert(row)
        } catch (_: SQLiteConstraintException) {
            finishLocally(shiftId)
            return@withTransaction checkNotNull(db.shiftCloseDao().forShift(shiftId))
        }
        finishLocally(shiftId)
        row
    }

    private suspend fun finishLocally(shiftId: String) {
        db.shiftDao().setStatus(shiftId, "closed")
        db.deviceConfigDao().get()?.let { if (it.activeShiftId == shiftId) db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
    }

    companion object {
        val REASONS = listOf(
            "production_defect",
            "material_shortage",
            "equipment_stop",
            "production_order_changed",
            "planned_quantity_error",
            "other_production_deviation",
        )

        fun reasonRequired(plannedQty: Int?, actualQty: Int): Boolean = plannedQty != null && plannedQty != actualQty
    }
}
```

- [ ] **Step 4: Implement the view model and screens**

`feature/shift/CloseViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class CloseOutcome { ACCEPTED, CONFLICT, PENDING }

sealed interface CloseStep {
    data object Loading : CloseStep
    data class Confirm(val preview: ShiftCloser.Preview) : CloseStep
    data class Reason(val preview: ShiftCloser.Preview, val selected: String?) : CloseStep
    data class Draining(val pending: Int) : CloseStep
    data class Summary(val accepted: Int, val errors: Int, val duplicates: Int, val conflicts: Int, val outcome: CloseOutcome) : CloseStep
}

@HiltViewModel
class CloseViewModel @Inject constructor(
    handle: SavedStateHandle,
    private val closer: ShiftCloser,
    private val sync: SyncEngine,
    private val db: HandheldDatabase,
    private val session: SessionHolder,
) : ViewModel() {
    val shiftId: String = checkNotNull(handle["shiftId"])
    private val _step = MutableStateFlow<CloseStep>(CloseStep.Loading)
    val step: StateFlow<CloseStep> = _step

    init {
        viewModelScope.launch {
            val preview = closer.preview(shiftId)
            _step.value = if (preview == null) CloseStep.Summary(0, 0, 0, 0, CloseOutcome.PENDING) else CloseStep.Confirm(preview)
        }
    }

    fun confirm() {
        val preview = (_step.value as? CloseStep.Confirm)?.preview ?: return
        if (preview.reasonRequired) _step.value = CloseStep.Reason(preview, null) else finish(preview, null)
    }

    fun selectReason(code: String) {
        val current = _step.value as? CloseStep.Reason ?: return
        _step.value = current.copy(selected = code)
    }

    fun submitReason() {
        val current = _step.value as? CloseStep.Reason ?: return
        val reason = current.selected ?: return
        finish(current.preview, reason)
    }

    private fun finish(preview: ShiftCloser.Preview, reason: String?) {
        viewModelScope.launch {
            _step.value = CloseStep.Draining(sync.state.value.pending)
            closer.close(shiftId, session.state.value.operator?.operatorId, reason)
            val watcher = launch { sync.state.collect { if (_step.value is CloseStep.Draining) _step.value = CloseStep.Draining(it.pending) } }
            sync.drainAll()
            watcher.cancel()
            val row = db.shiftCloseDao().forShift(shiftId)
            val outcome = when (row?.state) {
                null -> CloseOutcome.ACCEPTED
                "conflict" -> CloseOutcome.CONFLICT
                else -> CloseOutcome.PENDING
            }
            val conflicts = db.conflictDao().count().first()
            _step.value = CloseStep.Summary(preview.accepted, preview.errors, preview.duplicates, conflicts, outcome)
        }
    }
}
```

Provide `ShiftCloser` in `ShiftModule`:

```kotlin
    @Provides
    fun shiftCloser(db: HandheldDatabase): ShiftCloser = ShiftCloser(db)
```

`feature/shift/CloseScreens.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone

data class CloseCallbacks(
    val onConfirm: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onSelectReason: (String) -> Unit = {},
    val onSubmitReason: () -> Unit = {},
    val onDone: () -> Unit = {},
)

fun reasonLabel(code: String): Int = when (code) {
    "production_defect" -> R.string.reason_production_defect
    "material_shortage" -> R.string.reason_material_shortage
    "equipment_stop" -> R.string.reason_equipment_stop
    "production_order_changed" -> R.string.reason_production_order_changed
    "planned_quantity_error" -> R.string.reason_planned_quantity_error
    else -> R.string.reason_other_production_deviation
}

@Composable
fun CloseScreen(step: CloseStep, cb: CloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (step) {
            CloseStep.Loading -> FullScreenState(Icons.Outlined.Sync, "", "", tone = Tone.Info)
            is CloseStep.Confirm -> {
                AppBar(stringResource(R.string.work_close), cb.onCancel)
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.close_confirm_title),
                    stringResource(R.string.close_confirm_text, step.preview.accepted, step.preview.errors, step.preview.duplicates),
                    primary = StateAction(stringResource(R.string.close_action), cb.onConfirm),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
                )
            }
            is CloseStep.Reason -> {
                AppBar(stringResource(R.string.close_reason_title), cb.onCancel)
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                    Text(stringResource(R.string.close_reason_text, step.preview.plan ?: 0, step.preview.accepted), style = t.caption, color = c.fg3)
                    ShiftCloser.REASONS.forEach { code ->
                        ReasonRow(stringResource(reasonLabel(code)), selected = step.selected == code) { cb.onSelectReason(code) }
                    }
                    PrimaryButton(stringResource(R.string.close_action), cb.onSubmitReason, enabled = step.selected != null)
                }
            }
            is CloseStep.Draining -> FullScreenState(
                Icons.Outlined.Sync,
                stringResource(R.string.close_draining),
                stringResource(R.string.close_draining_left, step.pending),
                tone = Tone.Info,
            )
            is CloseStep.Summary -> {
                AppBar(stringResource(R.string.close_summary_title))
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                    SummaryRow(stringResource(R.string.close_summary_accepted), step.accepted.toString())
                    SummaryRow(stringResource(R.string.close_summary_errors), step.errors.toString())
                    SummaryRow(stringResource(R.string.close_summary_duplicates), step.duplicates.toString())
                    SummaryRow(stringResource(R.string.close_summary_conflicts), step.conflicts.toString())
                    val (note, tone) = when (step.outcome) {
                        CloseOutcome.ACCEPTED -> R.string.close_summary_title to Tone.Ok
                        CloseOutcome.CONFLICT -> R.string.close_summary_conflict to Tone.Warn
                        CloseOutcome.PENDING -> R.string.close_summary_pending to Tone.Info
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        androidx.compose.material3.Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = c.tone(tone).fg)
                        Text(stringResource(note), style = t.body, color = c.tone(tone).fg)
                    }
                    PrimaryButton(stringResource(R.string.close_to_hub), cb.onDone)
                }
            }
        }
    }
}

@Composable
private fun ReasonRow(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clip(shape).background(c.surfaceCard)
            .border(1.dp, if (selected) c.accent else c.line, shape).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape), contentAlignment = Alignment.Center) {
            if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent))
        }
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
    }
}

@Composable
private fun SummaryRow(label: String, value: String) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth().height(40.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.code.copy(fontSize = 18.sp), color = c.fg1)
    }
}
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftCloserTest*' --tests '*CloseViewModelTest*' --tests '*CloseScreensTest*'
```
Expected: PASS. In `CloseViewModelTest`, `SyncEngine.drainAll()` runs synchronously inside the view model coroutine on the test dispatcher; the `MockWebServer` call happens on `Dispatchers.IO` through `SyncTransport`, so `advanceUntilIdle()` alone is enough only because `runTest` waits for the IO continuation; if a test flakes, wrap the assertions in `vm.step.first { it is CloseStep.Summary }`.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): leave and close a shift with reasons, drain and summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Conflicts screen, hub and settings integration, navigation

**Files:**
- Create: `feature/work/ConflictsScreen.kt` (screen + `ConflictsViewModel`)
- Modify: `feature/hub/HubViewModel.kt`, `feature/hub/HubScreen.kt`, `feature/settings/SettingsViewModel.kt`, `feature/settings/SettingsScreens.kt`, `AppNavigation.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/work/ConflictsScreenTest.kt`; update `feature/hub/HubViewModelTest.kt`, `HubScreenTest.kt`

**Interfaces:**
- Produces: `HubUi.queue`, `HubUi.stuck`, `HubUi.activeShiftId`, `HubUi.continueShiftNumber`; `Routes.SHIFTS`, `WORK`, `CLOSE`, `CONFLICTS` with `work(id)`, `close(id)`, `conflicts(id)`; settings signal controls.

- [ ] **Step 1: Write the failing tests**

`app/src/test/kotlin/app/markiro/handheld/feature/work/ConflictsScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.ConflictEntity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConflictsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun listsConflictsWithTerminalTailAndTime() {
        compose.setContent {
            MarkiroTheme {
                ConflictsScreen(listOf(ConflictEntity("abcdef0123456789", "8f3c2a1b-terminal-dev2", "2026-09-10T06:12:00.000Z", "2026-09-10T07:00:00.000Z")), onBack = {})
            }
        }
        compose.onNodeWithText("…23456789 · терминал …l-dev2", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Разбор — в кабинете", substring = true).assertIsDisplayed()
    }

    @Test
    fun emptyState() {
        compose.setContent { MarkiroTheme { ConflictsScreen(emptyList(), onBack = {}) } }
        compose.onNodeWithText("Конфликтов нет").assertIsDisplayed()
    }
}
```

Update `feature/hub/HubScreenTest.kt`: add `queue = 37, stuck = false, activeShiftId = "s1", continueShiftNumber = "SEP26-001"` to the `HubUi` constructions (named arguments) and assert `compose.onNodeWithText("продолжить SEP26-001").assertIsDisplayed()` and `compose.onNodeWithText("Очередь 37").assertIsDisplayed()` in the first test; in the offline test assert `"Работаем офлайн · 37 сканов в очереди"`.

Update `feature/hub/HubViewModelTest.kt`: `HubViewModel` gains `sync: SyncEngine` and `shifts: ShiftDao`. Convert the test to Robolectric with an in-memory `HandheldDatabase` (as in `SyncEngineTest`), build a real `SyncEngine` over a `SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" }` (never started), use `db.deviceConfigDao()` instead of the hand-written fake, and pass `db.shiftDao()`. Add one test: with `activeShiftId = "s1"` and a bundled shift row, `state.continueShiftNumber == "SEP26-001"`.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ConflictsScreenTest*' --tests '*feature.hub*'
```
Expected: compilation FAILS.

- [ ] **Step 3: Conflicts screen**

`feature/work/ConflictsScreen.kt`:

```kotlin
package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.ConflictDao
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class ConflictsViewModel @Inject constructor(dao: ConflictDao) : ViewModel() {
    val rows: StateFlow<List<ConflictEntity>> = dao.observeAll().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
}

@Composable
fun ConflictsScreen(rows: List<ConflictEntity>, onBack: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.conflicts_title), onBack)
        if (rows.isEmpty()) {
            FullScreenState(Icons.Outlined.CheckCircle, stringResource(R.string.conflicts_empty), stringResource(R.string.conflicts_note))
            return
        }
        Text(stringResource(R.string.conflicts_note), style = t.caption, color = c.fg3, modifier = Modifier.padding(horizontal = MarkiroSizes.sp4))
        LazyColumn(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            items(rows, key = { it.codeHash }) { row ->
                Text(
                    stringResource(
                        R.string.conflicts_row,
                        row.codeHash.takeLast(8),
                        row.winningTerminalId?.takeLast(6) ?: stringResource(R.string.conflicts_unknown_terminal),
                        Iso.parse(row.winningScannedAt)?.let { TimeText.hhmm(it) } ?: row.winningScannedAt,
                    ),
                    style = t.code.copy(fontSize = 14.sp),
                    color = c.fg1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
```

- [ ] **Step 4: Hub integration**

`HubUi` gains `val queue: Int = 0, val stuck: Boolean = false, val activeShiftId: String? = null, val continueShiftNumber: String? = null`. `HubViewModel`'s primary constructor gains `private val sync: SyncEngine` and `shifts: ShiftDao` (after `reachability`); the Hilt constructor passes them through. The `state` combine becomes:

```kotlin
    private val activeShift = config.observe().flatMapLatest { cfg -> cfg?.activeShiftId?.let { shifts.observe(it) } ?: flowOf(null) }

    val state: StateFlow<HubUi> = combine(config.observe(), session.state, reachability.lastSuccessAt, tick, sync.state, activeShift) { values ->
        val cfg = values[0] as DeviceConfigEntity?
        val ses = values[1] as SessionState
        val lastOk = values[2] as Long?
        val syncState = values[4] as SyncState
        val current = values[5] as ShiftEntity?
        HubUi(
            organization = cfg?.organizationName.orEmpty(),
            operatorName = ses.operator?.name.orEmpty(),
            lineName = cfg?.lineName,
            shifts = cfg?.shiftsCount,
            inventories = cfg?.inventoryCount,
            countsAt = cfg?.countsAt,
            reachable = lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS,
            scannerLabel = scannerLabel(),
            queue = syncState.pending,
            stuck = syncState.stuck,
            activeShiftId = current?.takeIf { it.status != "closed" }?.id,
            continueShiftNumber = current?.takeIf { it.status != "closed" }?.number,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HubUi())
```

(`combine` with six flows takes the `Array` form; `flatMapLatest` needs `@OptIn(ExperimentalCoroutinesApi::class)`.)

`HubScreen`: the status strip's queue item becomes `StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.queue), if (state.stuck) Tone.Err else Tone.Neutral)`; the banner logic mirrors the work screen (stuck → `hub_sync_stuck` in `Tone.Err`, offline with a queue → `hub_offline_banner_queue` with the plural, offline → `hub_offline_banner`); the shift tile's status is `state.continueShiftNumber?.let { stringResource(R.string.hub_shift_continue, it) } ?: (shiftsLabel(state.shifts) + stamp)`, with `statusTone = Tone.Ok` when continuing.

- [ ] **Step 5: Settings integration**

`SettingsUi` gains `soundMuted: Boolean, soundVolume: Float, vibrationEnabled: Boolean, queue: Int, lastSyncAt: Long?, installId: String`. `SettingsViewModel` receives `Signaller`, `SyncEngine`, `MetaStore`; it initialises the new fields from `AppPreferences`, `sync.state.value` and `meta.installId()` (in `init` via `viewModelScope.launch`), keeps `queue`/`lastSyncAt` updated by collecting `sync.state`, and exposes:

```kotlin
    fun toggleSound() { app.soundMuted = !app.soundMuted; _state.update { it.copy(soundMuted = app.soundMuted) } }
    fun setVolume(v: Float) { app.soundVolume = v; _state.update { it.copy(soundVolume = app.soundVolume) } }
    fun toggleVibration() { app.vibrationEnabled = !app.vibrationEnabled; _state.update { it.copy(vibrationEnabled = app.vibrationEnabled) } }
    fun testSignal(kind: SignalKind) = signaller.play(kind)
```

`SettingsScreen` adds, between the theme row and «ОБ УСТРОЙСТВЕ», a `settings_signals` label, `SettingRow(settings_sound, on/off)` toggling, a `Slider` (Material 3) for volume bound to `setVolume`, `SettingRow(settings_vibration, on/off)`, and a `Row` of three `SecondaryButton`s (`settings_test_ok/duplicate/error`) calling `testSignal`. The about section gains `InfoRow(settings_sync, settings_sync_value(queue, TimeText.hhmm(lastSyncAt)) or settings_sync_never(queue))` and `InfoRow(settings_install_id, installId.takeLast(8))`. Extend the new callbacks through `SettingsScreen`'s parameter list (`onToggleSound`, `onVolume`, `onToggleVibration`, `onTest`).

- [ ] **Step 6: Navigation**

In `AppNavigation.kt`:

```kotlin
object Routes {
    const val PAIRING = "pairing"
    const val SIGN_IN = "signin"
    const val HUB = "hub"
    const val SETTINGS = "settings"
    const val SCANNER = "settings/scanner"
    const val SHIFTS = "shifts"
    const val WORK = "work/{shiftId}"
    const val CLOSE = "close/{shiftId}"
    const val CONFLICTS = "conflicts/{shiftId}"
    const val SOON = "soon/{tile}"
    fun work(id: String) = "work/$id"
    fun close(id: String) = "close/$id"
    fun conflicts(id: String) = "conflicts/$id"
    fun soon(tile: HubTile) = "soon/${tile.name}"
}
```

Hub tile handling:

```kotlin
HubTile.SHIFT -> state.activeShiftId?.let { nav.navigate(Routes.work(it)) } ?: nav.navigate(Routes.SHIFTS)
HubTile.INVENTORY, HubTile.CHECK -> nav.navigate(Routes.soon(tile))
HubTile.SETTINGS -> nav.navigate(Routes.SETTINGS)
```

New destinations:

```kotlin
composable(Routes.SHIFTS) {
    val vm: ShiftListViewModel = hiltViewModel()
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        vm.events.collect { event ->
            when (event) { is ShiftListEvent.Entered -> nav.navigate(Routes.work(event.shiftId)) { popUpTo(Routes.HUB) } }
        }
    }
    ShiftListScreen(
        state,
        ShiftListCallbacks(
            onBack = { nav.popBackStack() }, onContinue = vm::continueCurrent, onSelect = vm::select, onExpandOthers = vm::expandOthers,
            onSelectOther = vm::selectOther, onConfirmOther = vm::confirmOther, onDismiss = vm::dismissDialog, onRefresh = vm::refresh,
        ),
    )
}
composable(Routes.WORK) { entry ->
    val vm: WorkViewModel = hiltViewModel()
    val state by vm.state.collectAsStateWithLifecycle()
    val shiftId = entry.arguments?.getString("shiftId").orEmpty()
    WorkScreen(
        state,
        WorkCallbacks(
            onLeave = { vm.leave(); nav.popBackStack(Routes.HUB, inclusive = false) },
            onClose = { nav.navigate(Routes.close(shiftId)) },
            onConflicts = { nav.navigate(Routes.conflicts(shiftId)) },
        ),
    )
}
composable(Routes.CLOSE) {
    val vm: CloseViewModel = hiltViewModel()
    val step by vm.step.collectAsStateWithLifecycle()
    CloseScreen(
        step,
        CloseCallbacks(
            onConfirm = vm::confirm, onCancel = { nav.popBackStack() }, onSelectReason = vm::selectReason, onSubmitReason = vm::submitReason,
            onDone = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } },
        ),
    )
}
composable(Routes.CONFLICTS) {
    val vm: ConflictsViewModel = hiltViewModel()
    val rows by vm.rows.collectAsStateWithLifecycle()
    ConflictsScreen(rows, onBack = { nav.popBackStack() })
}
composable(Routes.SOON) { entry ->
    val tile = entry.arguments?.getString("tile")
    ComingSoonScreen(
        stringResource(if (tile == HubTile.INVENTORY.name) R.string.hub_tile_inventory else R.string.hub_tile_check),
        onBack = { nav.popBackStack() },
    )
}
```

The session guard in `MarkiroApp` (`sessionState.operator == null` → sign-in) already covers the new routes; the lock event sends the operator to the PIN screen and, after unlocking, the hub pins «Продолжить» because `activeShiftId` survives.

- [ ] **Step 7: Run the whole gate**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```
Expected: `BUILD SUCCESSFUL`, all tests PASS, lint: 0 errors.

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add apps/handheld
/usr/bin/git commit -m "feat(handheld): conflicts screen, hub queue and continue tile, signal settings, shift navigation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Docs, full gate, manual verification, pull request

**Files:**
- Modify: `apps/handheld/README.md`, `docs/architecture.md` (one sentence), `.prettierignore` (this plan)
- No new code.

- [ ] **Step 1: Document the slice**

Append to `apps/handheld/README.md` after «Debug aids»:

```markdown
## Shift walk-through against the local API

1. In the cabinet create a product with a GTIN, a line, and a validation shift on that line; add the handheld as «ТСД» on the same line and pair.
2. Hub → Смена → pick the shift. Send scans (a GS separator must be quoted for the remote shell):

       adb shell "am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data '0104600682000013' '21abc<GS>93AbCd'"

   The app replaces `<GS>` with U+001D. The same code twice is a duplicate; another GTIN is «ЧУЖОЙ ГТИН»; anything else is «НЕВЕРНЫЙ КОД».
3. Scans queue in `outbox` and go to `POST /station/scans` in batches of 100 (`Очередь N` in the status strip). `adb shell svc wifi disable` shows the offline banner with the count; re-enable and watch it drain.
4. «Ещё» → «Закрыть смену» closes the shift from the device; a plan mismatch asks for a reason. If another device entered the same shift the summary says the cabinet will close it.

The KM parser is verified against `app/src/test/resources/km-fixtures.json`, generated by `pnpm --filter @markiro/domain fixtures:km`; regenerate it whenever `packages/domain/src/gs1/km.ts` changes.
```

In `docs/architecture.md`, after the `handheld/` line in the surfaces block, add:

```
              validates codes offline with the station's rules and syncs scan batches
              through the same /station/scans protocol
```

Add `docs/superpowers/plans/2026-09-10-handheld-shift-validation.md` to `.prettierignore` next to the foundation plan.

- [ ] **Step 2: Full gates**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
pnpm --config.verify-deps-before-run=false exec prettier --check apps/api packages/domain docs/architecture.md .prettierignore
pnpm --config.verify-deps-before-run=false --filter @markiro/api --filter @markiro/domain lint
pnpm --config.verify-deps-before-run=false --filter @markiro/api --filter @markiro/domain typecheck
pnpm --config.verify-deps-before-run=false --filter @markiro/domain test
bash .superpowers/with-dev-env.sh pnpm --config.verify-deps-before-run=false --filter @markiro/api exec vitest run handheld-shift-read shifts-openapi openapi-docs shift-summary
node --test tools/ci/affected.test.mjs
```
Expected: all green. The CI classifier already maps `apps/handheld/` to `handheld_android` and `packages/domain` / `apps/api` to the API and app jobs.

- [ ] **Step 3: Manual verification on the emulator (report separately)**

Reuse the foundation harness pattern (a throwaway vitest file under `apps/api/test/` booting the API on `127.0.0.1:3100` with `.superpowers/with-dev-env.sh`; delete it before committing). The harness creates: a tenant, a product `04600682000013`, line «Линия 2», operators (login 4127 / PIN 1234 / badge 735519), a second handheld device, a validation shift with `plannedQty = 10` on the line, and pairing codes for both devices; it watches `/tmp/claude/close-from-cabinet` to close the shift from the cabinet.

1. Pair, sign in, hub shows «1 доступна»; Смена → list shows the shift with «план 10 · Линия 2».
2. Enter; scan accepted (`010460068200001321abc<GS>93AAAA`), the same again (ДУБЛЬ with «Первый скан в HH:MM»), another GTIN (`010460000000001521x` → ЧУЖОЙ ГТИН), garbage (НЕВЕРНЫЙ КОД); each with its tone and vibration; counters and feed update; cabinet shows the scans with the handheld as terminal.
3. Network off (`svc wifi disable; svc data disable`): ten scans queue, banner «Работаем офлайн · 10 сканов в очереди»; network on: queue drains to 0; the cabinet's shift summary shows the accepted count.
4. Second device pairs and enters the same shift: first device's chip shows «+1» within a minute; close from the first device → summary with «Смену закроет кабинет»; close from the cabinet.
5. Fresh shift: close with plan not met → reason screen → «Смена закрыта»; the cabinet shows the reason and the device.
6. Kill the app mid-drain (`am force-stop` while 100+ scans queue with the API paused): on restart the same batch id is resent and the server answers `alreadyApplied` (harness logs the batch ids).
7. Settings → Язык → English: pairing, hub, shift list, work screen and close flow show English only.
8. Record screenshots and outcomes in the PR description; list Datalogic/Honeywell hardware as not exercised.

- [ ] **Step 4: Push and open the pull request**

```bash
/usr/bin/git add apps/handheld/README.md docs/architecture.md .prettierignore docs/superpowers/plans/2026-09-10-handheld-shift-validation.md
/usr/bin/git commit -m "docs(handheld): shift walk-through and architecture note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
/usr/bin/git push -u origin worktree-tsd-shift
gh pr create --base main --title "feat: handheld (TSD) shift validation — offline scans, sync and close" --body-file /tmp/claude/pr-body.md
```

PR body (`/tmp/claude/pr-body.md`):

```markdown
## Summary
- API: station credentials read `GET /shifts/:id/summary` for shifts they entered and `GET /lines`
- Domain: KM parse/verdict fixtures exported to the handheld with a drift test
- Handheld: shift list and entry (`/enter` + bundle), offline KM validation with the station's verdict order, transactional journal and outbox, sync engine with pinned batch ceilings and backoff, conflicts list and reconciliation, team chip, leave and close with reasons, signals (tones + vibration), Russian and English on every screen

## Automated checks
- `packages/domain`: fixture drift test; `apps/api`: e2e for device summary/lines access
- `apps/handheld`: `testDebugUnitTest lintDebug assembleDebug` (KM fixtures, storage and migration, recorder, sync engine, closer, screens, English render)

## Manual verification (emulator, local API)
- <filled from Task 14 step 3>

Not exercised: Datalogic/Honeywell hardware, vendor intents, keyboard wedge on a physical device.

Spec: docs/superpowers/specs/2026-09-10-handheld-shift-validation-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-review notes

- Spec coverage: server summary/lines access (Task 1), fixtures (Task 2), storage (Task 3), codec and verdict (Task 4), DTOs and capabilities (Task 5), recorder (Task 6), signals (Task 7), sync engine incl. closes and reconciliation (Task 8), two languages incl. the foundation migration (Task 9), shift list and entry incl. duplicate-DM refusal and offline rules (Task 10), work screen incl. team and counters (Task 11), leave/close incl. reasons and outcomes (Task 12), conflicts, hub queue/continue, settings signals and sync info, navigation (Task 13), docs, gates, manual verification, PR (Task 14).
- Deviations recorded in the header: `GET /lines` opened to devices; signal settings in `AppPreferences`.
- Type consistency: `Verdict.wire` values are used by `ScanRecorder`, `OutboxEntity.verdict`, `ScanItemDto.verdict` and the counters; `MetaStore` keys are shared by `SyncEngine` and its tests; `ShiftCloser.Preview` is consumed by `CloseStep`; `EnterResult` by `ShiftListViewModel`; `TeamState` by `WorkUi`; `HubUi.activeShiftId` by the navigation.
