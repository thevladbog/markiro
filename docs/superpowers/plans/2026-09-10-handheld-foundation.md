# Handheld (TSD) Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `handheld` device kind to the server and cabinet, and ship an Android app (`apps/handheld`) that pairs by code, signs an operator in offline, shows the hub with live counts, and receives scans from the built-in scanner.

**Architecture:** On the wire the handheld is a station device: a `kind` column on `station_devices` distinguishes it for the cabinet and the pairing check, while every station-only endpoint stays unchanged. The Android app is a single Gradle module with `core/*` packages (design, scan, network, storage, auth) and `feature/*` packages (pairing, signin, hub, settings), Hilt-wired, Compose UI themed from the `hh/*` tokens.

**Tech Stack:** TypeScript (NestJS, Drizzle, Zod, Vitest) for server and cabinet; Kotlin 2.2, Jetpack Compose + Material 3, Hilt, Room, OkHttp + Retrofit + kotlinx.serialization, Navigation Compose, Robolectric for the app.

Spec: `docs/superpowers/specs/2026-09-10-handheld-foundation-design.md`. Design brief: `docs/design-briefs/10-tsd-handheld.md`.

## Global Constraints

- Every server-side query stays tenant-scoped; new tests assert cross-tenant denial where a new read path is added (`AGENTS.md`).
- Migrations are additive; never edit an applied migration. Next migration index is `0123`.
- Device kind values: exactly `station` and `handheld`. Unified device types: `station`, `kiosk`, `handheld`.
- Handheld client capability string: `handheld-v1`. Pairing mismatch error code: `PAIR_KIND_MISMATCH` (HTTP 401, body `{ "code": "PAIR_KIND_MISMATCH" }`).
- Quota: handheld consumes the `stations` entitlement.
- Android: `applicationId = "app.markiro.handheld"`, `minSdk 28`, `targetSdk 35`, `compileSdk 35`, portrait only, RU default locale with EN resources, fonts bundled (no runtime network dependency for assets).
- PHC verifier contract: `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`, SHA-256, 32-byte key, 16-byte salt, canonical base64 with padding, minimum 10 000 iterations, constant-time compare.
- Scan events preserve the GS1 group separator `\u001d` in `raw`.
- Report automated checks separately from anything not exercised (Datalogic/Honeywell hardware, vendor intents, Play distribution).
- Commit messages follow the repo style (`feat(api): …`, `feat(handheld): …`, `test(...)`, `docs(...)`) and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run server tests with the development environment loaded (`set -a; source .env; set +a`) and `pnpm --filter @markiro/db build` after touching `packages/db`.
- Android commands run from `apps/handheld` with `./gradlew`. The first Gradle run downloads dependencies from `dl.google.com` and `repo1.maven.org`; if the sandbox blocks them, run that one command with the sandbox disabled.

---

## Part A — Server and cabinet

### Task 1: `station_devices.kind` column and migration

**Files:**
- Modify: `packages/db/src/schema/platform.ts:452-475` (the `stationDevices` table)
- Create: `packages/db/migrations/0123_<generated-name>.sql` (via `drizzle-kit generate`) plus `meta/0123_snapshot.json` and the `_journal.json` entry
- Test: `packages/db/test/station-device-kind-migration.test.ts`

**Interfaces:**
- Produces: column `schema.stationDevices.kind` (`text`, not null, default `"station"`), check `station_devices_kind_check`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/db/test/station-device-kind-migration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stationDevices } from "../src/schema/platform.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

it("declares station kind as a non-null text column defaulting to station", () => {
  const column = getTableConfig(stationDevices).columns.find((column) => column.name === "kind");
  expect(column).toMatchObject({ notNull: true, hasDefault: true });
});

describe.skipIf(!process.env.DATABASE_URL)("station device kind migration", () => {
  const name = `markiro_station_kind_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "station-kind-migration-"));
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: folder,
      targetFolder: legacy,
      lastIncludedIndex: 122,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('legacy-kind','Legacy','legacy-kind',now())",
    );
    await pool.query(
      "INSERT INTO station_devices (tenant_id, name) VALUES ('legacy-kind', 'Legacy terminal')",
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills existing stations as kind station", async () => {
    const rows = await pool.query(
      "SELECT kind FROM station_devices WHERE tenant_id = 'legacy-kind'",
    );
    expect(rows.rows).toEqual([{ kind: "station" }]);
  });

  it("accepts handheld and rejects any other kind", async () => {
    await pool.query(
      "INSERT INTO station_devices (tenant_id, name, kind) VALUES ('legacy-kind', 'TSD 1', 'handheld')",
    );
    await expect(
      pool.query(
        "INSERT INTO station_devices (tenant_id, name, kind) VALUES ('legacy-kind', 'Tablet', 'tablet')",
      ),
    ).rejects.toMatchObject({ constraint: "station_devices_kind_check" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/db test -- station-device-kind-migration
```
Expected: the schema test FAILS (`column` is `undefined`); the DB tests fail with `column "kind" does not exist`.

- [ ] **Step 3: Add the column and check to the Drizzle schema**

In `packages/db/src/schema/platform.ts`, inside `stationDevices`, add the column after `name` and the check after the line foreign key:

```ts
export const stationDevices = pgTable(
  "station_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** `station` (line terminal) or `handheld` (TSD). Same credential and endpoints. */
    kind: text("kind").notNull().default("station"),
    // References better-auth's apikey.id (text). Not a composite tenant FK:
    // apikey is a Better Auth-managed table without a (tenant_id, id) unique.
    apiKeyId: text("api_key_id"),
    lineId: uuid("line_id"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    unique("station_devices_tenant_id_uq").on(t.tenantId, t.id),
    foreignKey({
      name: "station_devices_tenant_line_fk",
      columns: [t.tenantId, t.lineId],
      foreignColumns: [lines.tenantId, lines.id],
    }),
    check("station_devices_kind_check", sql`${t.kind} in ('station', 'handheld')`),
  ],
);
```

`check` and `sql` are already imported in this file (used by `code_registry_hash_check`).

- [ ] **Step 4: Generate the migration**

Run:
```bash
pnpm --filter @markiro/db db:generate
```
Expected: a new file `packages/db/migrations/0123_<name>.sql` whose content is exactly:

```sql
ALTER TABLE "station_devices" ADD COLUMN "kind" text DEFAULT 'station' NOT NULL;--> statement-breakpoint
ALTER TABLE "station_devices" ADD CONSTRAINT "station_devices_kind_check" CHECK ("station_devices"."kind" in ('station', 'handheld'));
```

If the generated SQL contains anything else (a drift from an unrelated schema change), stop and report it; do not hand-edit the drift away.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/db test -- station-device-kind-migration && pnpm --filter @markiro/db build
```
Expected: 3 tests PASS; build succeeds (consumers read `dist`).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations packages/db/test/station-device-kind-migration.test.ts
git commit -m "feat(db): add station_devices.kind for handheld terminals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `kind` on `/station-devices`

**Files:**
- Modify: `apps/api/src/modules/station-devices/dto.ts`
- Modify: `apps/api/src/modules/station-devices/station-devices.service.ts`
- Modify: `apps/api/test/support/auth.ts:96-100` (optional `kind` for test devices)
- Test: `apps/api/test/station-devices.service.test.ts`, `apps/api/test/station-devices.e2e.test.ts`

**Interfaces:**
- Produces: `stationDeviceKinds = ["station", "handheld"] as const`, `type StationDeviceKind`, `StationDeviceDto.kind`, `CreateStationDeviceDto.kind` (default `"station"`), `UpdateStationDeviceDto.kind?`; `createTestStationDevice(app, agent, name, { kind })`.
- Rule: `kind` may change only while `apiKeyId === null && pairedAt === null`; otherwise `409 Conflict`.

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/test/station-devices.service.test.ts` (inside the existing `describe`, after the last `it`):

```ts
  it("stores the requested kind on create and defaults to station", async () => {
    const insertValues = vi.fn().mockImplementation((values: { kind: string }) => ({
      returning: () =>
        Promise.resolve([
          {
            id: "device-2",
            tenantId: "tenant-1",
            name: "TSD 1",
            kind: values.kind,
            lineId: null,
            apiKeyId: null,
            enrolledAt: new Date("2026-09-10T09:00:00Z"),
            pairedAt: null,
            revokedAt: null,
            lastSeenAt: null,
          },
        ]),
    }));
    const db = {
      insert: () => ({ values: insertValues }),
      transaction: (callback: (tx: Db) => Promise<unknown>) => callback(db as unknown as Db),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    const handheld = await service.create("tenant-1", {
      name: "TSD 1",
      lineId: null,
      kind: "handheld",
    });
    expect(handheld.kind).toBe("handheld");
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", kind: "handheld" }),
    );
  });

  it("refuses to change the kind of a paired device", async () => {
    const paired = {
      device: {
        id: "device-3",
        tenantId: "tenant-1",
        name: "Paired",
        kind: "station",
        lineId: null,
        apiKeyId: "key-1",
        enrolledAt: new Date("2026-09-10T09:00:00Z"),
        pairedAt: new Date("2026-09-10T09:05:00Z"),
        revokedAt: null,
        lastSeenAt: null,
      },
      lineName: null,
    };
    const db = {
      select: () => ({
        from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([paired]) }) }),
      }),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    await expect(service.update("tenant-1", "device-3", { kind: "handheld" })).rejects.toMatchObject(
      { status: 409 },
    );
  });
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run:
```bash
pnpm --filter @markiro/api test -- station-devices.service
```
Expected: FAIL — `kind` is not part of `CreateStationDeviceDto` (type error) and `update` resolves instead of rejecting.

- [ ] **Step 3: Extend the DTOs**

Replace the top of `apps/api/src/modules/station-devices/dto.ts` (everything through `UpdateStationDeviceDto`) with:

```ts
import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";

/** `station` is the line terminal; `handheld` is the Android TSD. Same credential and endpoints. */
export const stationDeviceKinds = ["station", "handheld"] as const;
export type StationDeviceKind = (typeof stationDeviceKinds)[number];

/** POST /station-devices body. A station exists before it has a credential. */
export const createStationDeviceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  lineId: z.string().uuid().nullable(),
  kind: z.enum(stationDeviceKinds).default("station"),
});
export type CreateStationDeviceDto = z.infer<typeof createStationDeviceSchema>;

/** PATCH /station-devices/:id body. Omitted fields are preserved; `kind` is fixed once paired. */
export const updateStationDeviceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  lineId: z.string().uuid().nullable().optional(),
  kind: z.enum(stationDeviceKinds).optional(),
});
export type UpdateStationDeviceDto = z.infer<typeof updateStationDeviceSchema>;
```

In `StationDeviceDto` add `kind: StationDeviceKind;` after `name`. In `stationDeviceOpenApiSchema` add `"kind"` to `required` (after `"name"`) and the property:

```ts
    kind: { type: "string", enum: [...stationDeviceKinds] },
```

- [ ] **Step 4: Store and guard `kind` in the service**

In `apps/api/src/modules/station-devices/station-devices.service.ts`:

Change the imports line to include `ConflictException`:

```ts
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
```

In `create`, pass the kind:

```ts
          .values({ tenantId, name: dto.name, lineId: dto.lineId, kind: dto.kind, apiKeyId: null })
```

In `update`, replace the `set` block with:

```ts
    const set: { name?: string; lineId?: string | null; kind?: "station" | "handheld" } = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.lineId !== undefined) set.lineId = dto.lineId;
    if (dto.kind !== undefined && dto.kind !== current.device.kind) {
      // The kind decides which app may redeem the pairing code; a paired
      // device already runs one of them, so the kind is fixed from then on.
      if (current.device.apiKeyId !== null || current.device.pairedAt !== null) {
        throw new ConflictException("Device kind is fixed after pairing");
      }
      set.kind = dto.kind;
    }
    if (Object.keys(set).length === 0) return this.toDto(current);
```

In `toDto`, add `kind: device.kind as StationDeviceKind,` after `name` and import the type:

```ts
import {
  stationDeviceLifecycle,
  type CreateStationDeviceDto,
  type ListStationDevicesResponseDto,
  type StationDeviceDto,
  type StationDeviceKind,
  type UpdateStationDeviceDto,
} from "./dto";
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run:
```bash
pnpm --filter @markiro/api test -- station-devices.service
```
Expected: PASS (existing tests plus the two new ones).

- [ ] **Step 6: Let the e2e helper create handhelds**

In `apps/api/test/support/auth.ts`, change the `createTestStationDevice` signature and the create call:

```ts
export async function createTestStationDevice(
  app: INestApplication,
  agent: ReturnType<typeof request.agent>,
  name: string,
  options: { kind?: "station" | "handheld" } = {},
): Promise<{ apiKey: string; deviceId: string; body: { apiKey: string; deviceId: string } }> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("createTestStationDevice is restricted to tests");
  }
  const db = app.get<Db>(DB);

  const created = await agent
    .post("/station-devices")
    .send({ name, lineId: null, kind: options.kind ?? "station" })
    .expect(201);
```

Everything below that line stays as it is.

- [ ] **Step 7: Write the failing e2e test**

Append to `apps/api/test/station-devices.e2e.test.ts` inside the `describe`:

```ts
  it("creates a handheld, keeps kind editable until pairing, then fixes it", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const defaulted = await agent
      .post("/station-devices")
      .send({ name: "Terminal", lineId: null })
      .expect(201);
    expect(defaulted.body.kind).toBe("station");

    const created = await agent
      .post("/station-devices")
      .send({ name: "TSD 1", lineId: null, kind: "handheld" })
      .expect(201);
    expect(created.body.kind).toBe("handheld");

    const flipped = await agent
      .patch(`/station-devices/${created.body.id}`)
      .send({ kind: "station" })
      .expect(200);
    expect(flipped.body.kind).toBe("station");

    const paired = await createTestStationDevice(app!, agent, "Paired TSD", { kind: "handheld" });
    await agent
      .patch(`/station-devices/${paired.deviceId}`)
      .send({ kind: "station" })
      .expect(409);
    const list = await agent.get("/station-devices").expect(200);
    const row = list.body.items.find((item: { id: string }) => item.id === paired.deviceId);
    expect(row.kind).toBe("handheld");
  });
```

- [ ] **Step 8: Run the e2e test**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/api test -- station-devices.e2e
```
Expected: PASS (the implementation from Steps 3–6 is already in place; this step proves the HTTP contract end to end). If the suite is skipped because `DATABASE_URL` is unset, load `.env` and start the dev database first (`docker compose -f docker-compose.dev.yml up -d`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/station-devices apps/api/test/support/auth.ts apps/api/test/station-devices.service.test.ts apps/api/test/station-devices.e2e.test.ts
git commit -m "feat(api): accept and expose station device kind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `handheld` in the unified `/devices` list

**Files:**
- Modify: `apps/api/src/modules/devices/dto.ts:5`
- Modify: `apps/api/src/modules/devices/devices.service.ts`
- Test: `apps/api/test/devices.e2e.test.ts`

**Interfaces:**
- Produces: `deviceTypes = ["station", "kiosk", "handheld"] as const`; `DeviceDto.type` is `"handheld"` for `kind === "handheld"`.

- [ ] **Step 1: Write the failing e2e test**

Append inside the `describe` of `apps/api/test/devices.e2e.test.ts` (reuse the file's existing `signUpAndActivate`/agent helpers exactly as the neighbouring tests do; the listing below assumes `agent` is created the same way as in the test "filters before counting and pages the combined result"):

```ts
  it("lists a handheld with its own type and filters it apart from stations", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Line 2" }).returning();
    await agent.post("/station-devices").send({ name: "Terminal", lineId: null }).expect(201);
    const handheld = await agent
      .post("/station-devices")
      .send({ name: "TSD 1", lineId: line!.id, kind: "handheld" })
      .expect(201);

    const onlyHandhelds = await agent.get("/devices?type=handheld").expect(200);
    expect(onlyHandhelds.body.total).toBe(1);
    expect(onlyHandhelds.body.items[0]).toMatchObject({
      id: handheld.body.id,
      type: "handheld",
      name: "TSD 1",
      place: { id: line!.id, name: "Line 2" },
      status: "awaiting_pairing",
      paired: false,
    });

    const onlyStations = await agent.get("/devices?type=station").expect(200);
    expect(onlyStations.body.items.map((item: { name: string }) => item.name)).toEqual([
      "Terminal",
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/api test -- devices.e2e
```
Expected: FAIL — `GET /devices?type=handheld` answers 400 (enum rejects the value).

- [ ] **Step 3: Extend the type enum and mapping**

In `apps/api/src/modules/devices/dto.ts`:

```ts
export const deviceTypes = ["station", "kiosk", "handheld"] as const;
```

and update the `place` description in `deviceOpenApiSchema`:

```ts
      description:
        "A station's or handheld's assigned line (id + name) or a kiosk's free-form location (id is always null).",
```

In `apps/api/src/modules/devices/devices.service.ts`, add `kind: schema.stationDevices.kind,` to the station select (after `name`), add `kind: string;` to the `stationDto` parameter type (after `name: string;`), and change the returned type:

```ts
      type: station.kind === "handheld" ? "handheld" : "station",
```

- [ ] **Step 4: Run the e2e tests to verify they pass**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/api test -- devices.e2e
```
Expected: PASS (all cases in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/devices apps/api/test/devices.e2e.test.ts
git commit -m "feat(api): list handheld terminals in the unified devices view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Pairing returns `kind` and rejects a kind mismatch

**Files:**
- Modify: `apps/api/src/modules/station-pairing/dto.ts`
- Modify: `apps/api/src/modules/station-pairing/station-pairing.service.ts`
- Modify: `apps/api/src/modules/station-pairing/station-pair.controller.ts`
- Test: `apps/api/test/station-pairing.e2e.test.ts`

**Interfaces:**
- Produces: `PairStationResultDto.device.kind: StationDeviceKind`; `StationPairErrorCode` includes `"PAIR_KIND_MISMATCH"`; `StationPairingService.redeem(code, source, options: { includeSubscription: boolean; handheldClient: boolean })`.
- Consumes: `StationDeviceKind` from Task 2.

- [ ] **Step 1: Write the failing e2e test**

Append a new `describe` block at the end of `apps/api/test/station-pairing.e2e.test.ts`, mirroring the file's existing `beforeAll` app setup (copy the same `app`, `db`, `agent` setup the first `describe` uses; the block below assumes `app`, `db` and a signed-in `agent` with an active organization, created with the file's `signUpAndActivate` helper):

```ts
describe.skipIf(!ready)("handheld pairing kind check", () => {
  let handheldId = "";
  let stationId = "";

  beforeAll(async () => {
    const [line] = await db
      .insert(schema.lines)
      .values({ tenantId: await currentTenantId(), name: "Line 2" })
      .returning();
    const handheld = await agent
      .post("/station-devices")
      .send({ name: "TSD kind", lineId: line!.id, kind: "handheld" })
      .expect(201);
    handheldId = handheld.body.id as string;
    const station = await agent
      .post("/station-devices")
      .send({ name: "Station kind", lineId: line!.id })
      .expect(201);
    stationId = station.body.id as string;
  });

  async function issue(deviceId: string): Promise<string> {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    return issued.body.code as string;
  }

  it("keeps a handheld code live when a station client redeems it, then pairs the handheld client", async () => {
    const code = await issue(handheldId);
    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code })
      .expect(401);
    expect(rejected.body).toEqual({ code: "PAIR_KIND_MISMATCH" });

    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", "handheld-v1,subscription-state-v1")
      .send({ code })
      .expect(201);
    expect(paired.body.device).toMatchObject({ id: handheldId, kind: "handheld" });
    expect(paired.body.credential.apiKey).toEqual(expect.any(String));

    const identity = await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", paired.body.credential.apiKey as string)
      .expect(200);
    expect(identity.body.device.kind).toBe("handheld");
  });

  it("rejects a station code redeemed by the handheld client", async () => {
    const code = await issue(stationId);
    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", "handheld-v1")
      .send({ code })
      .expect(401);
    expect(rejected.body).toEqual({ code: "PAIR_KIND_MISMATCH" });

    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code })
      .expect(201);
    expect(paired.body.device.kind).toBe("station");
  });
});
```

`currentTenantId()` is a two-line helper you add next to the file's other helpers, reading the tenant of the signed-in agent the same way the first `describe` obtains `tenantId` (store the value returned by `signUpAndActivate` in a module-level variable and return it).

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/api test -- station-pairing.e2e
```
Expected: FAIL — the first `POST /station/pair` without the capability answers 201 (no mismatch check yet).

- [ ] **Step 3: Extend the pairing DTOs**

In `apps/api/src/modules/station-pairing/dto.ts`:

```ts
import type { StationDeviceKind } from "../station-devices/dto";

export type StationPairErrorCode =
  | "PAIR_INVALID"
  | "PAIR_EXPIRED"
  | "PAIR_LOCKED"
  | "PAIR_RATE_LIMITED"
  | "PAIR_KIND_MISMATCH";
```

Extend the OpenAPI enum:

```ts
      enum: ["PAIR_INVALID", "PAIR_EXPIRED", "PAIR_LOCKED", "PAIR_RATE_LIMITED", "PAIR_KIND_MISMATCH"],
```

Add `kind: StationDeviceKind;` to `PairStationResultDto.device` after `name`.

- [ ] **Step 4: Check the kind in the service**

In `station-pairing.service.ts`:

1. Change the `redeem` signature and the call into `attemptRedeem`:

```ts
  async redeem(
    code: string,
    source: string,
    options: { includeSubscription: boolean; handheldClient: boolean },
  ): Promise<PairStationResultDto> {
```

and inside it:

```ts
      result = await this.attemptRedeem(code, now, auditContext, options);
```

2. Change `attemptRedeem`'s last parameter to `options: { includeSubscription: boolean; handheldClient: boolean }` and use `options.includeSubscription` where `includeSubscription` was used.

3. Add `kind: schema.stationDevices.kind,` to both `select({...})` blocks that read a station (`identity` and the one in `attemptRedeem` after the expiry check).

4. In `attemptRedeem`, right after `if (!station) throw new StationPairingException("PAIR_INVALID");` and before `assertWriteAccess`, add:

```ts
    // A handheld code must be redeemed by the handheld app and a station code
    // by the station. The code stays live and its attempt counter untouched:
    // this is a client mix-up, not a guess. The per-source rate limit above
    // still applies.
    if ((station.kind === "handheld") !== options.handheldClient) {
      throw new StationPairingException("PAIR_KIND_MISMATCH");
    }
```

5. Add `kind: station.kind as StationDeviceKind,` to the `device` objects returned by both `identity` and `attemptRedeem` (after `name`), importing the type:

```ts
import type { StationDeviceKind } from "../station-devices/dto";
```

- [ ] **Step 5: Pass the capability from the controller**

In `station-pair.controller.ts`, change the `pair` handler body:

```ts
    return this.pairing.redeem(body.code, ip, {
      includeSubscription: hasCapability(capabilities, "subscription-state-v1"),
      handheldClient: hasCapability(capabilities, "handheld-v1"),
    });
```

Update the `@ApiOperation` description of `pair`:

```ts
    description:
      "Unauthenticated by design: an unpaired station has no credential, so the single-use code and its rate limiter are the boundary. A handheld app sends `handheld-v1` in x-station-capabilities; a code issued for the other kind answers PAIR_KIND_MISMATCH and stays live.",
```

Add `kind` to the `identity` OpenAPI device schema: `required: ["id", "name", "kind", "tenantId", "organizationName", "line"]` and `kind: { type: "string", enum: ["station", "handheld"] },`.

- [ ] **Step 6: Run the pairing tests to verify they pass**

Run:
```bash
set -a; source .env; set +a; pnpm --filter @markiro/api test -- station-pairing
```
Expected: PASS for the e2e file and the existing unit tests. Fix any TypeScript error caused by other callers of `redeem` (search with `grep -rn "\.redeem(" apps/api/src apps/api/test`; each must pass the options object).

- [ ] **Step 7: Typecheck the API**

Run:
```bash
pnpm --filter @markiro/api typecheck
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/station-pairing apps/api/test/station-pairing.e2e.test.ts
git commit -m "feat(api): pair handheld terminals with a kind check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Cabinet — add and list a «ТСД»

**Files:**
- Modify: `apps/admin/src/pages/devices/api.ts:5-33,154-170`
- Modify: `apps/admin/src/pages/devices/index.tsx:29`
- Modify: `apps/admin/src/pages/devices/DeviceDrawer.tsx`
- Modify: `apps/admin/src/i18n/ru.json:3056-3059`, `apps/admin/src/i18n/en.json:3056-3059`
- Test: `apps/admin/test/devices-handheld.test.tsx`

**Interfaces:**
- Produces: `DeviceType = "station" | "kiosk" | "handheld"`; `CreateStationInput.kind?: "station" | "handheld"`; drawer type option `pages.devices.type.handheld`.

- [ ] **Step 1: Write the failing tests**

Create `apps/admin/test/devices-handheld.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DevicesPage } from "../src/pages/devices/index.js";

vi.mock("../src/layout/useActiveOrg.js", () => ({
  useActiveOrg: () => ({ orgId: "org-1", orgName: "Factory" }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

const HANDHELD_ROW = {
  id: "hh-1",
  type: "handheld",
  name: "ТСД 1",
  place: { id: "line-2", name: "Линия 2" },
  status: "awaiting_pairing",
  lastSeenAt: null,
  paired: false,
};

function renderPage(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: ["admin"],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.OPERATIONS_WRITE,
                CABINET_CAPABILITY.CREDENTIALS_MANAGE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

it("renders a handheld row with its type and offers the type filter", async () => {
  await i18n.changeLanguage("ru");
  const urls: string[] = [];
  renderPage(
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/devices"))
        return response({ items: [HANDHELD_ROW], page: 1, pageSize: 8, total: 1 });
      if (url === "/api/lines") return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  await screen.findByText("ТСД 1");
  expect(screen.getAllByText("ТСД").length).toBeGreaterThan(0);

  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Тип" }));
  await user.click(await screen.findByRole("option", { name: "ТСД" }));
  expect(urls.some((url) => url.includes("type=handheld"))).toBe(true);
});

it("creates a handheld bound to a line and shows the pairing code", async () => {
  await i18n.changeLanguage("ru");
  const posted: unknown[] = [];
  renderPage(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines")
        return response({ items: [{ id: "line-2", name: "Линия 2" }] });
      if (url === "/api/station-devices" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return response({ id: "hh-new", name: "ТСД 1" });
      }
      if (url === "/api/station-devices/hh-new/pairing-code" && init?.method === "POST")
        return response({ code: "12345678", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const drawer = await screen.findByRole("dialog", { name: "Новое устройство" });

  const user = userEvent.setup();
  await user.click(within(drawer).getByRole("combobox", { name: "Тип" }));
  await user.click(await screen.findByRole("option", { name: "ТСД" }));
  expect(within(drawer).queryByRole("link", { name: "Скачать Station для Windows" })).toBeNull();
  await user.click(within(drawer).getByRole("combobox", { name: "Линия" }));
  await user.click(await screen.findByRole("option", { name: "Линия 2" }));
  fireEvent.change(within(drawer).getByLabelText("Название"), { target: { value: "ТСД 1" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Создать" }));

  expect(await screen.findAllByText("1234 5678")).toHaveLength(2);
  expect(posted).toEqual([{ name: "ТСД 1", lineId: "line-2", kind: "handheld" }]);
  expect(within(drawer).getAllByText("ТСД").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @markiro/admin test -- devices-handheld
```
Expected: FAIL — no "ТСД" text and no such option.

- [ ] **Step 3: Extend the API client types**

In `apps/admin/src/pages/devices/api.ts`:

```ts
export type DeviceType = "station" | "kiosk" | "handheld";
/** Stations and handhelds share the station endpoints and the station pairing mutation. */
export type StationKind = "station" | "handheld";
export function isStationLike(type: DeviceType): boolean {
  return type === "station" || type === "handheld";
}
```

Add `kind?: StationKind;` to `CreateStationInput` and `UpdateStationInput`. In `clearDevicePairingCodeMutations`, look mutations up by the endpoint family:

```ts
    .findAll({ mutationKey: pairingMutationKey(isStationLike(type) ? "station" : "kiosk") })
```

- [ ] **Step 4: Add the type to the list and filter**

In `apps/admin/src/pages/devices/index.tsx` line 29:

```ts
const deviceTypes: readonly DeviceType[] = ["station", "kiosk", "handheld"];
```

- [ ] **Step 5: Teach the drawer the third type**

In `apps/admin/src/pages/devices/DeviceDrawer.tsx`:

1. Import `isStationLike` from `./api.js` (add to the existing import list).
2. Replace the `types` memo:

```ts
  const types = useMemo(
    () => [
      ...(allowStation
        ? [
            { value: "station", label: t("pages.devices.type.station") },
            { value: "handheld", label: t("pages.devices.type.handheld") },
          ]
        : []),
      ...(allowKiosk ? [{ value: "kiosk", label: t("pages.devices.type.kiosk") }] : []),
    ],
    [allowKiosk, allowStation, t],
  );
```

3. In `issue`, choose the endpoint by family:

```ts
        const code = isStationLike(target.type)
          ? await issueStation.mutateAsync(target.id)
          : await issueKiosk.mutateAsync(target.id);
```

4. In `submit`, the reassign branch: `if (isStationLike(device.type))` instead of `device.type === "station"`. The create branch:

```ts
      const created = isStationLike(type)
        ? await createStation.mutateAsync({
            name,
            lineId: place || null,
            kind: type === "handheld" ? "handheld" : "station",
          })
        : await createKiosk.mutateAsync({
            name,
            location: place || null,
            dayLimitPerEmployee: 5,
            showPrices: true,
          });
      const placeName = isStationLike(type)
        ? (lines.data?.find((line) => line.id === place)?.name ?? null)
        : place || null;
      if (isStationLike(type) || canIssueKiosk)
        await issue({ id: created.id, type, name: created.name, placeName });
      else setError(t("pages.devices.drawer.createdWithoutCode"));
```

5. `const canIssue = (target && isStationLike(target.type)) || canIssueKiosk;`
6. Keep `isStationContext` as `=== "station"` (the Windows download hint is station-only).
7. The place picker condition: `{isStationLike(type) ? (` instead of `{type === "station" ? (`.

- [ ] **Step 6: Add the strings**

`apps/admin/src/i18n/ru.json` (inside `pages.devices.type`):

```json
        "station": "Станция",
        "kiosk": "Киоск",
        "handheld": "ТСД"
```

`apps/admin/src/i18n/en.json`:

```json
        "station": "Station",
        "kiosk": "Kiosk",
        "handheld": "Handheld"
```

- [ ] **Step 7: Run the admin tests**

Run:
```bash
pnpm --filter @markiro/admin test -- devices
```
Expected: PASS for `devices-handheld`, `devices`, `devices-kiosk-panels`, `device-pairing`.

- [ ] **Step 8: Typecheck and lint the admin app**

Run:
```bash
pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint
```
Expected: clean. Fix any `DeviceType` exhaustiveness errors by using `isStationLike`.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/pages/devices apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/devices-handheld.test.tsx
git commit -m "feat(admin): add handheld terminals to the devices cabinet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: CI job and repository ignores for `apps/handheld`

**Files:**
- Modify: `tools/ci/affected.mjs`
- Modify: `tools/ci/test/affected.test.mjs`, `tools/ci/test/required-results.test.mjs`, `tools/ci/test/workflow.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.prettierignore`, `.gitignore`, `.graphifyignore`

**Interfaces:**
- Produces: classifier output `handheld_android`; workflow job `handheld-android` running `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` in `apps/handheld`.

- [ ] **Step 1: Write the failing classifier tests**

In `tools/ci/test/affected.test.mjs`: add `"handheld_android"` at the end of `jobNames`, add `handheld_android: false` at the end of `signerOnly.jobs`, and append this test:

```js
test("routes handheld app changes to the Android job only", () => {
  const result = classifyChangedFiles([
    "apps/handheld/app/src/main/AndroidManifest.xml",
    "apps/handheld/gradle/libs.versions.toml",
  ]);
  assert.equal(result.full, false);
  assert.deepEqual(enabledJobs(result), ["handheld_android"]);
});
```

In `tools/ci/test/required-results.test.mjs`, append `["handheld_android", "handheld-android"],` to `jobPairs`.

In `tools/ci/test/workflow.test.mjs`, append `["handheld-android", "handheld_android"],` to `heavyJobs`.

- [ ] **Step 2: Run the CI tool tests to verify they fail**

Run:
```bash
node --test tools/ci/test
```
Expected: FAIL — unknown job `handheld_android`.

- [ ] **Step 3: Extend the classifier**

In `tools/ci/affected.mjs`, add `"handheld_android",` as the last entry of `HEAVY_JOBS`, and in `jobsForPath` add before the `appMatch` block:

```js
  if (path.startsWith("apps/handheld/")) return ["handheld_android"];
```

- [ ] **Step 4: Add the workflow job**

In `.github/workflows/ci.yml`:

1. Add to `classify-changes.outputs`: `handheld_android: ${{ steps.affected.outputs.handheld_android }}`.
2. Add the job before `ci-required` (the two new actions are pinned to the commit SHAs of their `v6` tags, resolved on 2026-09-10 with `gh api repos/<owner>/<repo>/commits/v6 --jq .sha`; re-resolve if the tags have moved):

```yaml
  handheld-android:
    needs: classify-changes
    if: needs.classify-changes.outputs.handheld_android == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        working-directory: apps/handheld
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: actions/setup-java@de7274f081f381c8f8158605e0321c36c376e2e6 # v6
        with:
          distribution: temurin
          java-version: "17"
      - uses: gradle/actions/setup-gradle@9c971963bec38e04b3d30dcc455b5382be2fdbfb # v6
      - name: Unit tests, lint, debug build
        run: ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

The `ubuntu-latest` image ships the Android SDK; `compileSdk 35` and build-tools resolve from it (the Gradle Android plugin installs missing components when `android.builder.sdkDownload=true`, which is the default).

3. Add `- handheld-android` to `ci-required.needs`.

- [ ] **Step 5: Ignore the Gradle project where the TypeScript tooling walks**

Append to `.prettierignore`:

```
# Android app: Gradle project, formatted by ktlint/Android Studio, not Prettier.
apps/handheld/
```

Append to `.gitignore`:

```
# Android handheld app build outputs and machine-local SDK paths.
apps/handheld/**/build/
apps/handheld/.gradle/
apps/handheld/local.properties
apps/handheld/.kotlin/
```

Append to `.graphifyignore`:

```
# Gradle outputs are generated, not source.
apps/handheld/build/
apps/handheld/app/build/
```

- [ ] **Step 6: Run the CI tool tests and the workflow lint**

Run:
```bash
node --test tools/ci/test && pnpm format:check
```
Expected: all `tools/ci` tests PASS; Prettier reports no files to fix (the YAML change is formatted like its neighbours).

- [ ] **Step 7: Commit**

```bash
git add tools/ci .github/workflows/ci.yml .prettierignore .gitignore .graphifyignore
git commit -m "ci: add the handheld Android job to selective CI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part B — Android app core

### Task 7: Gradle project skeleton that builds and runs one unit test

**Files:**
- Create: `apps/handheld/settings.gradle.kts`, `apps/handheld/build.gradle.kts`, `apps/handheld/gradle.properties`, `apps/handheld/gradle/libs.versions.toml`, `apps/handheld/.gitignore`
- Create: `apps/handheld/app/build.gradle.kts`, `apps/handheld/app/proguard-rules.pro`
- Create: `apps/handheld/app/src/main/AndroidManifest.xml`, `apps/handheld/app/src/main/kotlin/app/markiro/handheld/HandheldApp.kt`, `apps/handheld/app/src/main/kotlin/app/markiro/handheld/MainActivity.kt`
- Create: `apps/handheld/app/src/main/res/values/strings.xml`, `res/values-en/strings.xml`, `res/values/themes.xml`, `res/values/ic_launcher_background.xml`, `res/drawable/ic_launcher_foreground.xml`, `res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `apps/handheld/app/src/test/resources/robolectric.properties`, `apps/handheld/app/src/test/kotlin/app/markiro/handheld/BuildConfigTest.kt`
- Generate: `apps/handheld/gradlew`, `apps/handheld/gradlew.bat`, `apps/handheld/gradle/wrapper/*` (committed)

**Interfaces:**
- Produces: `BuildConfig.SAAS_SERVER_URL` (`"https://admin.markiro.app"`, the origin the edge proxies `/station/*` and `/shifts` to), `BuildConfig.SERVER_URL_EDITABLE` (true in debug), `BuildConfig.DEBUG_SCAN_SOURCE` (true in debug); Hilt application `HandheldApp`; activity `MainActivity : AppCompatActivity`.

- [ ] **Step 1: Create the Gradle files**

`apps/handheld/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "markiro-handheld"
include(":app")
```

`apps/handheld/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}
```

`apps/handheld/gradle.properties`:

```
org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

`apps/handheld/gradle/libs.versions.toml` (these are floors; if a version does not resolve, take the closest newer stable and note it in the commit message):

```toml
[versions]
agp = "8.11.1"
kotlin = "2.2.0"
ksp = "2.2.0-2.0.2"
composeBom = "2025.07.00"
activityCompose = "1.10.1"
appcompat = "1.7.1"
coreKtx = "1.16.0"
lifecycle = "2.9.2"
navigation = "2.9.2"
hilt = "2.57"
hiltNavigation = "1.2.0"
room = "2.7.2"
retrofit = "3.0.0"
okhttp = "4.12.0"
serialization = "1.9.0"
coroutines = "1.10.2"
securityCrypto = "1.1.0"
junit = "4.13.2"
robolectric = "4.15.1"
testCore = "1.7.0"
testExtJunit = "1.3.0"
turbine = "1.2.1"

[libraries]
androidx-core-ktx = { module = "androidx.core:core-ktx", version.ref = "coreKtx" }
androidx-appcompat = { module = "androidx.appcompat:appcompat", version.ref = "appcompat" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activityCompose" }
androidx-lifecycle-runtime-compose = { module = "androidx.lifecycle:lifecycle-runtime-compose", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel-compose = { module = "androidx.lifecycle:lifecycle-viewmodel-compose", version.ref = "lifecycle" }
androidx-lifecycle-process = { module = "androidx.lifecycle:lifecycle-process", version.ref = "lifecycle" }
androidx-navigation-compose = { module = "androidx.navigation:navigation-compose", version.ref = "navigation" }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
compose-material3 = { module = "androidx.compose.material3:material3" }
compose-material-icons = { module = "androidx.compose.material:material-icons-extended" }
compose-ui-test-junit4 = { module = "androidx.compose.ui:ui-test-junit4" }
compose-ui-test-manifest = { module = "androidx.compose.ui:ui-test-manifest" }
hilt-android = { module = "com.google.dagger:hilt-android", version.ref = "hilt" }
hilt-compiler = { module = "com.google.dagger:hilt-android-compiler", version.ref = "hilt" }
hilt-navigation-compose = { module = "androidx.hilt:hilt-navigation-compose", version.ref = "hiltNavigation" }
room-runtime = { module = "androidx.room:room-runtime", version.ref = "room" }
room-ktx = { module = "androidx.room:room-ktx", version.ref = "room" }
room-compiler = { module = "androidx.room:room-compiler", version.ref = "room" }
retrofit = { module = "com.squareup.retrofit2:retrofit", version.ref = "retrofit" }
retrofit-serialization = { module = "com.squareup.retrofit2:converter-kotlinx-serialization", version.ref = "retrofit" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-mockwebserver = { module = "com.squareup.okhttp3:mockwebserver", version.ref = "okhttp" }
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
kotlinx-coroutines-android = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-android", version.ref = "coroutines" }
kotlinx-coroutines-test = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test", version.ref = "coroutines" }
androidx-security-crypto = { module = "androidx.security:security-crypto", version.ref = "securityCrypto" }
junit = { module = "junit:junit", version.ref = "junit" }
robolectric = { module = "org.robolectric:robolectric", version.ref = "robolectric" }
androidx-test-core = { module = "androidx.test:core-ktx", version.ref = "testCore" }
androidx-test-ext-junit = { module = "androidx.test.ext:junit", version.ref = "testExtJunit" }
turbine = { module = "app.cash.turbine:turbine", version.ref = "turbine" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
```

`apps/handheld/app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "app.markiro.handheld"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.markiro.handheld"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The edge proxies /station/*, /shifts and /products on the admin host to the API.
        buildConfigField("String", "SAAS_SERVER_URL", "\"https://admin.markiro.app\"")
        buildConfigField("boolean", "SERVER_URL_EDITABLE", "false")
        buildConfigField("boolean", "DEBUG_SCAN_SOURCE", "false")
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "SERVER_URL_EDITABLE", "true")
            buildConfigField("boolean", "DEBUG_SCAN_SOURCE", "true")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.security.crypto)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.turbine)
}
```

`apps/handheld/app/proguard-rules.pro`: an empty file with one comment line `# Release keeps minification off in this slice.`

`apps/handheld/.gitignore`:

```
build/
.gradle/
.kotlin/
local.properties
.idea/
*.iml
captures/
```

- [ ] **Step 2: Create the manifest, resources and entry points**

`apps/handheld/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <application
        android:name=".HandheldApp"
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="false"
        android:theme="@style/Theme.Markiro">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:screenOrientation="portrait"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

`res/values/strings.xml` (Russian is the default locale):

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Маркиро ТСД</string>
</resources>
```

`res/values-en/strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Markiro Handheld</string>
</resources>
```

`res/values/themes.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Markiro" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:windowBackground">#131216</item>
        <item name="android:statusBarColor">#131216</item>
    </style>
</resources>
```

`res/values/ic_launcher_background.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#17161A</color>
</resources>
```

`res/drawable/ic_launcher_foreground.xml` (a simple accent mark; the real icon comes with the release slice):

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#3DDC7A"
        android:pathData="M34,74 L34,34 L44,34 L54,52 L64,34 L74,34 L74,74 L65,74 L65,50 L54,68 L43,50 L43,74 Z" />
</vector>
```

`res/mipmap-anydpi-v26/ic_launcher.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

`app/src/main/kotlin/app/markiro/handheld/HandheldApp.kt`:

```kotlin
package app.markiro.handheld

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class HandheldApp : Application()
```

`app/src/main/kotlin/app/markiro/handheld/MainActivity.kt` (replaced by the navigation shell in Task 16):

```kotlin
package app.markiro.handheld

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.material3.Text
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Text("Маркиро") }
    }
}
```

`app/src/test/resources/robolectric.properties`:

```
sdk=34
```

- [ ] **Step 3: Write the unit test**

`app/src/test/kotlin/app/markiro/handheld/BuildConfigTest.kt`:

```kotlin
package app.markiro.handheld

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildConfigTest {
    @Test
    fun applicationIdIsFixed() {
        assertEquals("app.markiro.handheld", BuildConfig.APPLICATION_ID)
    }

    @Test
    fun debugBuildEnablesEmulatorAids() {
        assertTrue(BuildConfig.SERVER_URL_EDITABLE)
        assertTrue(BuildConfig.DEBUG_SCAN_SOURCE)
        assertEquals("https://admin.markiro.app", BuildConfig.SAAS_SERVER_URL)
    }
}
```

- [ ] **Step 4: Generate the wrapper and run the test**

Run (from `apps/handheld`; the first run downloads the toolchain, so disable the sandbox for it if the download is refused):

```bash
cd apps/handheld && gradle wrapper --gradle-version 8.14.3 --distribution-type bin && ./gradlew --no-daemon testDebugUnitTest
```

Expected: `BUILD SUCCESSFUL`, 2 tests passed. (There is nothing to make fail first here: the build itself is the deliverable.)

- [ ] **Step 5: Run lint and the debug build**

Run:
```bash
cd apps/handheld && ./gradlew --no-daemon lintDebug assembleDebug
```
Expected: `BUILD SUCCESSFUL`; `app/build/outputs/apk/debug/app-debug.apk` exists.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld
git commit -m "feat(handheld): scaffold the Android app with Hilt, Compose and a unit test gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Design system — tokens, fonts, theme and the `hh/*` composables

**Files:**
- Create: `apps/handheld/app/src/main/res/font/plex_sans_regular.ttf`, `plex_sans_medium.ttf`, `plex_sans_semibold.ttf`, `plex_sans_bold.ttf`, `plex_mono_regular.ttf`, `plex_mono_medium.ttf`, `plex_mono_semibold.ttf`; `apps/handheld/FONT-LICENSES.md`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/design/Tokens.kt`, `Type.kt`, `Theme.kt`, `Components.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/design/ComponentsTest.kt`

**Interfaces:**
- Produces: `MarkiroTheme(dark: Boolean, content)`, `MarkiroTheme.colors: MarkiroPalette`, `MarkiroTheme.type: MarkiroTypography`, `MarkiroSizes`; composables `StatusStrip(items)`, `AppBar(title, onBack, actions)`, `IconAction`, `PrimaryButton`, `SecondaryButton`, `DestructiveButton`, `MarkiroTextButton`, `Keypad(onDigit, onBackspace, onConfirm, confirmEnabled)`, `PinDots(total, filled)`, `Tile(icon, label, status, onClick, modifier, statusTone)`, `MarkiroChip(text, tone)`, `Banner(text, tone, icon)`, `FullScreenState(icon, title, text, primary, secondary, tone, primaryIsAccent)`; `enum Tone { Neutral, Ok, Err, Warn, Info, Accent }`; `data class StatusItem(icon, label, tone)`; `data class StateAction(label, onClick)`.

- [ ] **Step 1: Bundle the fonts**

Download the OFL-licensed TTFs from the Google Fonts repository and rename them (run from `apps/handheld/app/src/main/res/font`, create the directory first):

```bash
base=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -sSLo plex_sans_regular.ttf  $base/ibmplexsans/IBMPlexSans-Regular.ttf
curl -sSLo plex_sans_medium.ttf   $base/ibmplexsans/IBMPlexSans-Medium.ttf
curl -sSLo plex_sans_semibold.ttf $base/ibmplexsans/IBMPlexSans-SemiBold.ttf
curl -sSLo plex_sans_bold.ttf     $base/ibmplexsans/IBMPlexSans-Bold.ttf
curl -sSLo plex_mono_regular.ttf  $base/ibmplexmono/IBMPlexMono-Regular.ttf
curl -sSLo plex_mono_medium.ttf   $base/ibmplexmono/IBMPlexMono-Medium.ttf
curl -sSLo plex_mono_semibold.ttf $base/ibmplexmono/IBMPlexMono-SemiBold.ttf
file *.ttf
```

Expected: `file` reports `TrueType Font data` for all seven. Write `apps/handheld/FONT-LICENSES.md`:

```markdown
# Bundled fonts

IBM Plex Sans and IBM Plex Mono, © IBM Corp., licensed under the SIL Open Font License 1.1
(https://openfontlicense.org). Files taken from https://github.com/google/fonts/tree/main/ofl.
Bundled so the handheld renders without any network dependency (AGENTS.md: offline factory path).
```

- [ ] **Step 2: Write the failing component test**

`app/src/test/kotlin/app/markiro/handheld/core/design/ComponentsTest.kt`:

```kotlin
package app.markiro.handheld.core.design

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComponentsTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun keypadReportsDigitsBackspaceAndConfirm() {
        val typed = StringBuilder()
        var confirmed = 0
        compose.setContent {
            MarkiroTheme(dark = true) {
                Keypad(
                    onDigit = { typed.append(it) },
                    onBackspace = { typed.setLength(maxOf(0, typed.length - 1)) },
                    onConfirm = { confirmed++ },
                    confirmEnabled = true,
                )
            }
        }
        compose.onNodeWithText("4").performClick()
        compose.onNodeWithText("8").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNode(hasContentDescription("Стереть")).performClick()
        compose.onNodeWithText("OK").performClick()
        assertEquals("48", typed.toString())
        assertEquals(1, confirmed)
    }

    @Test
    fun fullScreenStateShowsTitleTextAndAction() {
        var pressed = false
        compose.setContent {
            MarkiroTheme(dark = true) {
                FullScreenState(
                    icon = Icons.Outlined.Key,
                    title = "Код не подошёл",
                    text = "Обновите код в кабинете.",
                    primary = StateAction("Ввести новый код") { pressed = true },
                    tone = Tone.Err,
                )
            }
        }
        compose.onNodeWithText("Код не подошёл").assertIsDisplayed()
        compose.onNodeWithText("Ввести новый код").performClick()
        assertEquals(true, pressed)
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ComponentsTest*'`
Expected: compilation FAILS (`MarkiroTheme`, `Keypad`, `FullScreenState`, `StateAction`, `Tone` unresolved).

- [ ] **Step 4: Write the tokens**

`core/design/Tokens.kt`:

```kotlin
package app.markiro.handheld.core.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** One entry per token in packages/ui/src/tokens.css; values copied verbatim. */
data class MarkiroPalette(
    val surfacePage: Color,
    val surfaceCard: Color,
    val surfacePanel: Color,
    val surfaceOverlay: Color,
    val fg1: Color,
    val fg2: Color,
    val fg3: Color,
    val fgDisabled: Color,
    val line: Color,
    val lineStrong: Color,
    val accent: Color,
    val fgOnAccent: Color,
    val okFg: Color, val okBg: Color, val okBorder: Color, val okSolid: Color, val fgOnOk: Color,
    val errFg: Color, val errBg: Color, val errBorder: Color, val errSolid: Color, val fgOnErr: Color,
    val warnFg: Color, val warnBg: Color, val warnBorder: Color, val warnSolid: Color, val fgOnWarn: Color,
    val infoFg: Color, val infoBg: Color, val infoBorder: Color, val infoSolid: Color, val fgOnInfo: Color,
    val focusRing: Color,
)

object MarkiroColors {
    val Dark = MarkiroPalette(
        surfacePage = Color(0xFF131216), surfaceCard = Color(0xFF1C1B21), surfacePanel = Color(0xFF232228),
        surfaceOverlay = Color(0xA6000000),
        fg1 = Color(0xFFFAFAF8), fg2 = Color(0xFFB6B3AB), fg3 = Color(0xFF8E8B83), fgDisabled = Color(0xFF5B5952),
        line = Color(0xFF2E2D33), lineStrong = Color(0xFF45444B),
        accent = Color(0xFF3DDC7A), fgOnAccent = Color(0xFF0B2A17),
        okFg = Color(0xFF3DDC7A), okBg = Color(0xFF142E1D), okBorder = Color(0xFF1F4A2E), okSolid = Color(0xFF3DDC7A), fgOnOk = Color(0xFF0B2A17),
        errFg = Color(0xFFFF6B5E), errBg = Color(0xFF391A16), errBorder = Color(0xFF5C2A24), errSolid = Color(0xFFFF6B5E), fgOnErr = Color(0xFF391A16),
        warnFg = Color(0xFFFFB84D), warnBg = Color(0xFF33250E), warnBorder = Color(0xFF543E19), warnSolid = Color(0xFFFFB84D), fgOnWarn = Color(0xFF33250E),
        infoFg = Color(0xFF6DB2FF), infoBg = Color(0xFF152740), infoBorder = Color(0xFF234066), infoSolid = Color(0xFF6DB2FF), fgOnInfo = Color(0xFF152740),
        focusRing = Color(0xFF6DB2FF),
    )
    val Light = MarkiroPalette(
        surfacePage = Color(0xFFFAFAF8), surfaceCard = Color(0xFFFFFFFF), surfacePanel = Color(0xFFF0EFEA),
        surfaceOverlay = Color(0x8C17161A),
        fg1 = Color(0xFF17161A), fg2 = Color(0xFF45433E), fg3 = Color(0xFF6B6862), fgDisabled = Color(0xFFA5A29A),
        line = Color(0xFFE0DED7), lineStrong = Color(0xFFC9C6BD),
        accent = Color(0xFF0FAF56), fgOnAccent = Color(0xFF0B2A17),
        okFg = Color(0xFF116335), okBg = Color(0xFFE7F6EC), okBorder = Color(0xFFCFE8D8), okSolid = Color(0xFF0FAF56), fgOnOk = Color(0xFF0B2A17),
        errFg = Color(0xFFA1231A), errBg = Color(0xFFFDEAE7), errBorder = Color(0xFFF2D4D0), errSolid = Color(0xFFC0392B), fgOnErr = Color(0xFFFFFFFF),
        warnFg = Color(0xFF8A4C07), warnBg = Color(0xFFFDF0DC), warnBorder = Color(0xFFEFDFBE), warnSolid = Color(0xFFDD9420), fgOnWarn = Color(0xFF33250E),
        infoFg = Color(0xFF1A4F9C), infoBg = Color(0xFFE5EFFC), infoBorder = Color(0xFFD2E2F7), infoSolid = Color(0xFF2E6FD0), fgOnInfo = Color(0xFFFFFFFF),
        focusRing = Color(0xFF1A4F9C),
    )
}

object MarkiroSizes {
    val controlPrimary = 64.dp
    val controlRow = 56.dp
    val controlIcon = 48.dp
    val key = 72.dp
    val statusStrip = 32.dp
    val appBar = 56.dp
    val radius = 8.dp
    val sp1 = 4.dp
    val sp2 = 8.dp
    val sp3 = 12.dp
    val sp4 = 16.dp
    val sp5 = 20.dp
    val sp6 = 24.dp
}

enum class Tone { Neutral, Ok, Err, Warn, Info, Accent }

/** Foreground / background / border for a tone, so screens never pick raw colors. */
data class ToneColors(val fg: Color, val bg: Color, val border: Color, val solid: Color, val onSolid: Color)

fun MarkiroPalette.tone(tone: Tone): ToneColors = when (tone) {
    Tone.Neutral -> ToneColors(fg2, surfacePanel, line, surfacePanel, fg1)
    Tone.Ok -> ToneColors(okFg, okBg, okBorder, okSolid, fgOnOk)
    Tone.Err -> ToneColors(errFg, errBg, errBorder, errSolid, fgOnErr)
    Tone.Warn -> ToneColors(warnFg, warnBg, warnBorder, warnSolid, fgOnWarn)
    Tone.Info -> ToneColors(infoFg, infoBg, infoBorder, infoSolid, fgOnInfo)
    Tone.Accent -> ToneColors(accent, surfaceCard, accent, accent, fgOnAccent)
}
```

- [ ] **Step 5: Write the type ramp and theme**

`core/design/Type.kt`:

```kotlin
package app.markiro.handheld.core.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R

val PlexSans = FontFamily(
    Font(R.font.plex_sans_regular, FontWeight.Normal),
    Font(R.font.plex_sans_medium, FontWeight.Medium),
    Font(R.font.plex_sans_semibold, FontWeight.SemiBold),
    Font(R.font.plex_sans_bold, FontWeight.Bold),
)

val PlexMono = FontFamily(
    Font(R.font.plex_mono_regular, FontWeight.Normal),
    Font(R.font.plex_mono_medium, FontWeight.Medium),
    Font(R.font.plex_mono_semibold, FontWeight.SemiBold),
)

private const val TABULAR = "tnum"

/** The handheld ramp from brief 10; counters and codes are tabular mono. */
data class MarkiroTypography(
    val body: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 16.sp, lineHeight = 22.sp),
    val strong: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    val title: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    val caption: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 13.sp, lineHeight = 18.sp),
    val label: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
    val code: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = TABULAR),
    val counter: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = TABULAR),
    val counterLg: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 56.sp, lineHeight = 60.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = TABULAR),
    val key: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 28.sp, lineHeight = 32.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = TABULAR),
)
```

`core/design/Theme.kt`:

```kotlin
package app.markiro.handheld.core.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

private val LocalPalette = staticCompositionLocalOf { MarkiroColors.Dark }
private val LocalTypography = staticCompositionLocalOf { MarkiroTypography() }

@Composable
fun MarkiroTheme(dark: Boolean = true, content: @Composable () -> Unit) {
    val palette = if (dark) MarkiroColors.Dark else MarkiroColors.Light
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = palette.accent,
        onPrimary = palette.fgOnAccent,
        background = palette.surfacePage,
        onBackground = palette.fg1,
        surface = palette.surfaceCard,
        onSurface = palette.fg1,
        surfaceVariant = palette.surfacePanel,
        onSurfaceVariant = palette.fg2,
        outline = palette.line,
        outlineVariant = palette.lineStrong,
        error = palette.errSolid,
        onError = palette.fgOnErr,
    )
    CompositionLocalProvider(LocalPalette provides palette, LocalTypography provides MarkiroTypography()) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

object MarkiroTheme {
    val colors: MarkiroPalette
        @Composable @ReadOnlyComposable get() = LocalPalette.current
    val type: MarkiroTypography
        @Composable @ReadOnlyComposable get() = LocalTypography.current
}
```

- [ ] **Step 6: Write the components**

`core/design/Components.kt`:

```kotlin
package app.markiro.handheld.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Backspace
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class StatusItem(val icon: ImageVector, val label: String, val tone: Tone = Tone.Neutral)
data class StateAction(val label: String, val onClick: () -> Unit)

@Composable
fun StatusStrip(items: List<StatusItem>, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    Row(
        modifier = modifier.fillMaxWidth().height(MarkiroSizes.statusStrip).background(c.surfacePanel)
            .padding(horizontal = MarkiroSizes.sp4),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { item ->
            val color = if (item.tone == Tone.Neutral) c.fg2 else c.tone(item.tone).fg
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                Icon(item.icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
                Text(item.label, style = MarkiroTheme.type.caption, color = color)
            }
        }
    }
}

@Composable
fun AppBar(title: String, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    val c = MarkiroTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().height(MarkiroSizes.appBar).background(c.surfacePage)
            .padding(start = if (onBack == null) MarkiroSizes.sp4 else MarkiroSizes.sp1, end = MarkiroSizes.sp1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) IconAction(Icons.AutoMirrored.Outlined.ArrowBack, "Назад", onBack)
        Text(
            title,
            style = MarkiroTheme.type.title.copy(fontSize = 20.sp, lineHeight = 26.sp),
            color = c.fg1,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

@Composable
fun IconAction(icon: ImageVector, description: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier.size(MarkiroSizes.controlIcon).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = description, tint = MarkiroTheme.colors.fg1, modifier = Modifier.size(24.dp)) }
}

@Composable
private fun ButtonShell(
    height: Dp,
    background: Color,
    border: Color?,
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        modifier = Modifier.fillMaxWidth().height(height).clip(shape)
            .background(if (enabled) background else MarkiroTheme.colors.surfacePanel)
            .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .clickable(enabled = enabled, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
fun PrimaryButton(label: String, onClick: () -> Unit, enabled: Boolean = true, icon: ImageVector? = null) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlPrimary, c.accent, null, enabled, onClick) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = c.fgOnAccent, modifier = Modifier.size(26.dp))
            Spacer(Modifier.size(MarkiroSizes.sp2))
        }
        Text(label, style = MarkiroTheme.type.strong, color = if (enabled) c.fgOnAccent else c.fgDisabled)
    }
}

@Composable
fun SecondaryButton(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlRow, c.surfaceCard, c.lineStrong, enabled, onClick) {
        Text(label, style = MarkiroTheme.type.strong, color = if (enabled) c.fg1 else c.fgDisabled)
    }
}

@Composable
fun DestructiveButton(label: String, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlPrimary, c.errSolid, null, true, onClick) {
        Text(label, style = MarkiroTheme.type.strong, color = c.fgOnErr)
    }
}

@Composable
fun MarkiroTextButton(label: String, onClick: () -> Unit, tone: Tone = Tone.Accent) {
    val color = MarkiroTheme.colors.tone(tone).fg
    Row(
        modifier = Modifier.fillMaxWidth().height(MarkiroSizes.controlIcon).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) { Text(label, style = MarkiroTheme.type.body.copy(fontWeight = FontWeight.SemiBold), color = color) }
}

@Composable
fun Keypad(onDigit: (Char) -> Unit, onBackspace: () -> Unit, onConfirm: () -> Unit, confirmEnabled: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
        listOf("123", "456", "789").forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
                row.forEach { digit -> Key(Modifier.weight(1f), onClick = { onDigit(digit) }) { KeyLabel(digit.toString()) } }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
            Key(Modifier.weight(1f).semantics { contentDescription = "Стереть" }, onClick = onBackspace) {
                Icon(Icons.Outlined.Backspace, contentDescription = null, tint = MarkiroTheme.colors.fg1, modifier = Modifier.size(26.dp))
            }
            Key(Modifier.weight(1f), onClick = { onDigit('0') }) { KeyLabel("0") }
            Key(Modifier.weight(1f), onClick = onConfirm, accent = true, enabled = confirmEnabled) {
                Text("OK", style = MarkiroTheme.type.strong.copy(fontSize = 20.sp), color = MarkiroTheme.colors.fgOnAccent)
            }
        }
    }
}

@Composable
private fun KeyLabel(text: String) = Text(text, style = MarkiroTheme.type.key, color = MarkiroTheme.colors.fg1)

@Composable
private fun Key(modifier: Modifier, onClick: () -> Unit, accent: Boolean = false, enabled: Boolean = true, content: @Composable () -> Unit) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Box(
        modifier = modifier.height(MarkiroSizes.key).clip(shape)
            .background(if (accent) (if (enabled) c.accent else c.surfacePanel) else c.surfaceCard)
            .then(if (accent) Modifier else Modifier.border(1.dp, c.line, shape))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
fun PinDots(total: Int, filled: Int) {
    val c = MarkiroTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3), verticalAlignment = Alignment.CenterVertically) {
        repeat(total) { index ->
            Box(Modifier.size(14.dp).clip(CircleShape).background(if (index < filled) c.fg1 else c.lineStrong))
        }
    }
}

@Composable
fun Tile(icon: ImageVector, label: String, status: String, onClick: () -> Unit, modifier: Modifier = Modifier, statusTone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        modifier = modifier.height(116.dp).clip(shape).background(c.surfaceCard).border(1.dp, c.line, shape)
            .clickable(onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.Bottom,
    ) {
        Icon(icon, contentDescription = null, tint = c.fg1, modifier = Modifier.size(28.dp))
        Spacer(Modifier.height(MarkiroSizes.sp2))
        Text(label, style = MarkiroTheme.type.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(status, style = MarkiroTheme.type.caption, color = if (statusTone == Tone.Neutral) c.fg3 else c.tone(statusTone).fg, maxLines = 2)
    }
}

@Composable
fun MarkiroChip(text: String, tone: Tone = Tone.Neutral) {
    val t = MarkiroTheme.colors.tone(tone)
    Box(Modifier.clip(RoundedCornerShape(999.dp)).background(t.bg).padding(horizontal = 10.dp, vertical = MarkiroSizes.sp1)) {
        Text(text, style = MarkiroTheme.type.caption.copy(fontWeight = FontWeight.Medium), color = t.fg)
    }
}

@Composable
fun Banner(text: String, tone: Tone, icon: ImageVector) {
    val t = MarkiroTheme.colors.tone(tone)
    Row(
        modifier = Modifier.fillMaxWidth().background(t.bg).padding(horizontal = MarkiroSizes.sp4, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = t.fg, modifier = Modifier.size(20.dp))
        Text(text, style = MarkiroTheme.type.body.copy(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = t.fg)
    }
}

@Composable
fun FullScreenState(
    icon: ImageVector,
    title: String,
    text: String,
    primary: StateAction? = null,
    secondary: StateAction? = null,
    tone: Tone = Tone.Neutral,
    primaryIsAccent: Boolean = true,
) {
    val c = MarkiroTheme.colors
    Column(
        modifier = Modifier.fillMaxSize().padding(MarkiroSizes.sp6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, tint = if (tone == Tone.Neutral) c.fg3 else c.tone(tone).fg, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(MarkiroSizes.sp3))
        Text(title, style = MarkiroTheme.type.title, color = c.fg1, textAlign = TextAlign.Center)
        Spacer(Modifier.height(MarkiroSizes.sp3))
        Text(text, style = MarkiroTheme.type.body, color = c.fg2, textAlign = TextAlign.Center)
        if (primary != null) {
            Spacer(Modifier.height(MarkiroSizes.sp6))
            if (primaryIsAccent) PrimaryButton(primary.label, primary.onClick) else SecondaryButton(primary.label, primary.onClick)
        }
        if (secondary != null) {
            Spacer(Modifier.height(MarkiroSizes.sp2))
            MarkiroTextButton(secondary.label, secondary.onClick)
        }
    }
}
```

- [ ] **Step 7: Run the component tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ComponentsTest*'`
Expected: 2 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/handheld/app/src/main/res/font apps/handheld/FONT-LICENSES.md apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/design apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/design
git commit -m "feat(handheld): design tokens, Plex fonts and hh components in Compose

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Offline operator auth — PHC verifier and roster rules

**Files:**
- Create: `app/src/main/kotlin/app/markiro/handheld/core/auth/PhcVerifier.kt`, `OperatorRecord.kt`, `OperatorAuth.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/auth/PhcVerifierTest.kt`, `OperatorAuthTest.kt`

**Interfaces:**
- Produces: `object PhcVerifier { fun verify(secret: String, phc: String): Boolean }`; `data class OperatorRecord(operatorId, name, login, role, pinHash, badgeHash: String?, active: Boolean)`; `interface OperatorRoster { suspend fun operators(): List<OperatorRecord> }`; `class OperatorAuth(roster, verifier) { suspend fun byLogin(login, pin): OperatorRecord?; suspend fun byLoginOnly(login): OperatorRecord?; suspend fun byBadge(code): OperatorRecord?; suspend fun search(prefix): List<OperatorRecord> }` with `companion { DUMMY_PHC; fun padLogin(login): String? }`.

- [ ] **Step 1: Write the failing verifier tests**

The vectors were produced with Node's `pbkdf2Sync` exactly as `apps/station/test/crypto.test.ts` and `apps/api/src/lib/pin-hash.ts` do (SHA-256, 32-byte key, base64 with padding).

`core/auth/PhcVerifierTest.kt`:

```kotlin
package app.markiro.handheld.core.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhcVerifierTest {
    // salt = bytes 0..15, secret "1234", 100000 iterations
    private val v1 = "pbkdf2\$sha256\$100000\$AAECAwQFBgcICQoLDA0ODw==\$hp5sg1DFvrCsw5n7qsO2DSIEM4lrJqZHc00NjxWG4fo="
    // salt = bytes 255..240, secret "4821", 100000 iterations (the server's pin-hash.ts layout)
    private val v2 = "pbkdf2\$sha256\$100000\$//79/Pv6+fj39vX08/Lx8A==\$vnKOJ9tCMFhFLJvDRw80Z7LCYxPrUj6dT6uhgeSIwVM="
    // salt = bytes (i*17)%256, secret "735519", exactly the 10000-iteration floor
    private val v3 = "pbkdf2\$sha256\$10000\$ABEiM0RVZneImaq7zN3u/w==\$73dv9sAwMBY3IQrFX3Cp8pxM5Qn8KjP8pPTRAPs+xkc="
    // same as v1 but 1 iteration: correct digest for that cost, still refused
    private val v4 = "pbkdf2\$sha256\$1\$AAECAwQFBgcICQoLDA0ODw==\$i/F57D1qcIBBiv5AzlKB8LqqXqCNwubIJuZH8P6K1uI="

    @Test fun verifiesKnownVectors() {
        assertTrue(PhcVerifier.verify("1234", v1))
        assertTrue(PhcVerifier.verify("4821", v2))
        assertTrue(PhcVerifier.verify("735519", v3))
    }

    @Test fun rejectsWrongSecret() {
        assertFalse(PhcVerifier.verify("0000", v1))
        assertFalse(PhcVerifier.verify("", v1))
    }

    @Test fun rejectsIterationsBelowTheFloor() {
        assertFalse(PhcVerifier.verify("1234", v4))
    }

    @Test fun rejectsMalformedOrNonCanonicalStrings() {
        assertFalse(PhcVerifier.verify("1234", "not-a-phc"))
        assertFalse(PhcVerifier.verify("1234", "argon2\$x\$y\$z\$w"))
        assertFalse(PhcVerifier.verify("1234", v1.replace("DA0ODw==", "DA0ODw")))
        assertFalse(PhcVerifier.verify("1234", v1.substring(0, v1.length - 4)))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*PhcVerifierTest*'`
Expected: compilation FAILS (`PhcVerifier` unresolved).

- [ ] **Step 3: Implement the verifier**

`core/auth/PhcVerifier.kt`:

```kotlin
package app.markiro.handheld.core.auth

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Byte-for-byte port of apps/station/src/lib/crypto.ts and packages/domain/src/crypto/phc.ts:
 * `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`, 32-byte key, 16-byte salt, canonical base64
 * with padding, a 10 000-iteration floor and a constant-time comparison.
 */
object PhcVerifier {
    private const val MIN_ITERATIONS = 10_000
    private const val KEY_BYTES = 32
    private const val SALT_BYTES = 16

    fun verify(secret: String, phc: String): Boolean {
        val parts = phc.split('$')
        if (parts.size != 5 || parts[0] != "pbkdf2" || parts[1] != "sha256") return false
        val iterations = parts[2].toIntOrNull() ?: return false
        if (iterations < MIN_ITERATIONS) return false
        val salt = decodeCanonical(parts[3], SALT_BYTES) ?: return false
        val expected = decodeCanonical(parts[4], KEY_BYTES) ?: return false
        val actual = derive(secret, salt, iterations)
        return MessageDigest.isEqual(actual, expected)
    }

    private fun derive(secret: String, salt: ByteArray, iterations: Int): ByteArray {
        // PBKDF2WithHmacSHA256 encodes the password as UTF-8 on Android 26+ and on the JVM,
        // matching TextEncoder in the station and Buffer.from(secret) on the server.
        val spec = PBEKeySpec(secret.toCharArray(), salt, iterations, KEY_BYTES * 8)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    private fun decodeCanonical(value: String, expectedBytes: Int): ByteArray? {
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (decoded.size != expectedBytes) return null
        if (Base64.getEncoder().encodeToString(decoded) != value) return null
        return decoded
    }
}
```

- [ ] **Step 4: Run the verifier tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*PhcVerifierTest*'`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing operator auth tests**

`core/auth/OperatorAuthTest.kt`:

```kotlin
package app.markiro.handheld.core.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OperatorAuthTest {
    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "PIN:1234", "BADGE:735519", true)
    private val petr = OperatorRecord("op-2", "Иванов Пётр", "3310", "operator", "PIN:9999", null, true)
    private val gone = OperatorRecord("op-3", "Ивлев Сергей", "2201", "operator", "PIN:1234", "BADGE:1", false)
    private val roster = object : OperatorRoster {
        override suspend fun operators() = listOf(anna, petr, gone)
    }
    private val verified = mutableListOf<String>()
    private val auth = OperatorAuth(roster) { secret, phc ->
        verified += phc
        phc == "PIN:$secret" || phc == "BADGE:$secret"
    }

    @Test fun padsShortLoginsOnly() {
        assertEquals("041", OperatorAuth.padLogin("41"))
        assertEquals("4127", OperatorAuth.padLogin("4127"))
        assertEquals("0012", OperatorAuth.padLogin("0012"))
        assertNull(OperatorAuth.padLogin("41a"))
        assertNull(OperatorAuth.padLogin("1234567890123"))
    }

    @Test fun signsInByLoginAndPin() = runTest {
        assertEquals(anna, auth.byLogin("4127", "1234"))
        assertNull(auth.byLogin("4127", "0000"))
        assertNull(auth.byLogin("2201", "1234"))
        assertNull(auth.byLogin("4127", "12"))
    }

    @Test fun unknownLoginStillRunsOneVerification() = runTest {
        verified.clear()
        assertNull(auth.byLogin("7777", "1234"))
        assertEquals(1, verified.size)
        assertEquals(OperatorAuth.DUMMY_PHC, verified.single())
    }

    @Test fun signsInByBadgeAmongActiveOperatorsOnly() = runTest {
        assertEquals(anna, auth.byBadge("735519"))
        assertNull(auth.byBadge("1"))
        assertNull(auth.byBadge(""))
    }

    @Test fun searchesActiveOperatorsByWordPrefixLimitedToFive() = runTest {
        assertEquals(listOf(anna, petr), auth.search("ив"))
        assertEquals(listOf(anna), auth.search("Анна"))
        assertEquals(emptyList<OperatorRecord>(), auth.search(""))
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*OperatorAuthTest*'`
Expected: compilation FAILS.

- [ ] **Step 7: Implement the record and auth rules**

`core/auth/OperatorRecord.kt`:

```kotlin
package app.markiro.handheld.core.auth

/** One row of the roster mirror the server delivers at pairing and on `GET /station/operators`. */
data class OperatorRecord(
    val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String?,
    val active: Boolean,
)

interface OperatorRoster {
    suspend fun operators(): List<OperatorRecord>
}
```

`core/auth/OperatorAuth.kt`:

```kotlin
package app.markiro.handheld.core.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Same rules as apps/station/src/lib/auth.ts: login first, one verification per attempt, active only. */
class OperatorAuth(
    private val roster: OperatorRoster,
    private val verifier: (secret: String, phc: String) -> Boolean = PhcVerifier::verify,
) {
    suspend fun byLogin(login: String, pin: String): OperatorRecord? {
        if (!PIN.matches(pin)) return null
        if (!LOGIN.matches(login)) return null
        val operator = roster.operators().firstOrNull { it.active && it.login == login }
        // Verify against a dummy when the login is unknown so timing does not reveal valid logins.
        val ok = withContext(Dispatchers.Default) { verifier(pin, operator?.pinHash ?: DUMMY_PHC) }
        return if (ok) operator else null
    }

    /** Name lookup for the PIN step; no verification happens here. */
    suspend fun byLoginOnly(login: String): OperatorRecord? =
        roster.operators().firstOrNull { it.active && it.login == login }

    suspend fun byBadge(code: String): OperatorRecord? {
        if (code.isEmpty()) return null
        val candidates = roster.operators().filter { it.active && it.badgeHash != null }
        return withContext(Dispatchers.Default) {
            candidates.firstOrNull { verifier(code, it.badgeHash!!) }
        }
    }

    suspend fun search(prefix: String): List<OperatorRecord> {
        val needle = prefix.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return roster.operators()
            .filter { it.active && it.name.lowercase().split(' ').any { word -> word.startsWith(needle) } }
            .take(5)
    }

    companion object {
        private val PIN = Regex("^\\d{4,6}$")
        private val LOGIN = Regex("^\\d{3,12}$")

        /** A structurally valid verifier whose plaintext is irrelevant; used to equalise work. */
        const val DUMMY_PHC =
            "pbkdf2\$sha256\$100000\$AAECAwQFBgcICQoLDA0ODw==\$hp5sg1DFvrCsw5n7qsO2DSIEM4lrJqZHc00NjxWG4fo="

        /** Pads 1–2 digit entries to the three-digit minimum; longer values keep their leading zeroes. */
        fun padLogin(login: String): String? {
            if (!Regex("^\\d{1,12}$").matches(login)) return null
            return login.padStart(3, '0')
        }
    }
}
```

- [ ] **Step 8: Run the auth tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*OperatorAuthTest*'`
Expected: 5 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/auth apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/auth
git commit -m "feat(handheld): offline operator verification compatible with the station PHC contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Local storage — Room config and roster, Keystore-backed credential

**Files:**
- Create: `core/storage/Entities.kt`, `core/storage/Daos.kt`, `core/storage/HandheldDatabase.kt`, `core/storage/CredentialStore.kt`, `core/storage/RosterStore.kt`, `core/storage/DeviceWipe.kt`, `core/storage/StorageModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/storage/StorageTest.kt`

**Interfaces:**
- Produces: `DeviceConfigEntity` (singleton row `id = 1`), `OperatorEntity`, `DeviceConfigDao { observe(): Flow<DeviceConfigEntity?>; suspend get(); suspend count(); suspend upsert(); suspend clear() }`, `OperatorDao { suspend all(); suspend replaceAll(list); suspend clear() }`, `interface CredentialStore { fun read(): String?; fun write(apiKey: String); fun clear() }`, `InMemoryCredentialStore`, `class RosterStore(dao) : OperatorRoster { suspend fun replace(records) }`, `class DeviceWipe(config, operators, credential) { suspend fun wipeAll() }`.

- [ ] **Step 1: Write the failing storage test**

`core/storage/StorageTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StorageTest {
    private lateinit var db: HandheldDatabase

    @Before fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After fun close() = db.close()

    @Test fun configIsASingletonRowObservedAsAFlow() = runTest {
        val dao = db.deviceConfigDao()
        dao.observe().test {
            assertNull(awaitItem())
            dao.upsert(sampleConfig())
            assertEquals("dev-1", awaitItem()?.deviceId)
            dao.upsert(sampleConfig().copy(deviceName = "ТСД 2"))
            assertEquals("ТСД 2", awaitItem()?.deviceName)
            cancelAndIgnoreRemainingEvents()
        }
        assertEquals(1, db.deviceConfigDao().count())
    }

    @Test fun rosterStoreReplacesTheWholeMirror() = runTest {
        val store = RosterStore(db.operatorDao())
        store.replace(listOf(record("op-1", "Анна"), record("op-2", "Пётр")))
        store.replace(listOf(record("op-3", "Ольга")))
        assertEquals(listOf("Ольга"), store.operators().map { it.name })
    }

    @Test fun wipeClearsConfigRosterAndCredential() = runTest {
        val credential = InMemoryCredentialStore().apply { write("mk_live_secret") }
        db.deviceConfigDao().upsert(sampleConfig())
        RosterStore(db.operatorDao()).replace(listOf(record("op-1", "Анна")))
        DeviceWipe(db.deviceConfigDao(), db.operatorDao(), credential).wipeAll()
        assertNull(db.deviceConfigDao().get())
        assertEquals(emptyList<OperatorEntity>(), db.operatorDao().all())
        assertNull(credential.read())
    }

    private fun sampleConfig() = DeviceConfigEntity(
        deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО «Родник»",
        lineId = "line-2", lineName = "Линия 2", kind = "handheld", serverUrl = "https://admin.markiro.app",
        pairedAt = 1_757_500_000_000L,
    )

    private fun record(id: String, name: String) =
        OperatorRecord(id, name, "4127", "operator", "pbkdf2\$sha256\$100000\$x\$y", null, true)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*StorageTest*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement entities, DAOs and the database**

`core/storage/Entities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.PrimaryKey

/** Exactly one row (`id = 1`): the device is paired to one organisation at a time. */
@Entity(tableName = "device_config")
data class DeviceConfigEntity(
    @PrimaryKey val id: Int = 1,
    val deviceId: String,
    val deviceName: String,
    val tenantId: String,
    val organizationName: String,
    val lineId: String?,
    val lineName: String?,
    val kind: String,
    val serverUrl: String,
    val pairedAt: Long,
    val rosterFetchedAt: Long? = null,
    val lastOperatorId: String? = null,
    val shiftsCount: Int? = null,
    val inventoryCount: Int? = null,
    val countsAt: Long? = null,
)

/** Roster mirror; hashes are PHC verifiers, never plaintext. */
@Entity(tableName = "operators")
data class OperatorEntity(
    @PrimaryKey val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String?,
    val active: Boolean,
)
```

`core/storage/Daos.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface DeviceConfigDao {
    @Query("SELECT * FROM device_config WHERE id = 1")
    fun observe(): Flow<DeviceConfigEntity?>

    @Query("SELECT * FROM device_config WHERE id = 1")
    suspend fun get(): DeviceConfigEntity?

    @Query("SELECT COUNT(*) FROM device_config")
    suspend fun count(): Int

    @Upsert
    suspend fun upsert(config: DeviceConfigEntity)

    @Query("DELETE FROM device_config")
    suspend fun clear()
}

@Dao
interface OperatorDao {
    @Query("SELECT * FROM operators")
    suspend fun all(): List<OperatorEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<OperatorEntity>)

    @Query("DELETE FROM operators")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<OperatorEntity>) {
        clear()
        insertAll(rows)
    }
}
```

`core/storage/HandheldDatabase.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(entities = [DeviceConfigEntity::class, OperatorEntity::class], version = 1, exportSchema = false)
abstract class HandheldDatabase : RoomDatabase() {
    abstract fun deviceConfigDao(): DeviceConfigDao
    abstract fun operatorDao(): OperatorDao
}
```

- [ ] **Step 4: Implement the credential store, roster store and wipe**

`core/storage/CredentialStore.kt`:

```kotlin
package app.markiro.handheld.core.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The device API key. Never logged, never in Room. */
interface CredentialStore {
    fun read(): String?
    fun write(apiKey: String)
    fun clear()
}

class EncryptedCredentialStore(context: Context) : CredentialStore {
    private val prefs: SharedPreferences by lazy {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "handheld-credential",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun read(): String? = prefs.getString(KEY, null)
    override fun write(apiKey: String) { prefs.edit().putString(KEY, apiKey).commit() }
    override fun clear() { prefs.edit().remove(KEY).commit() }

    private companion object { const val KEY = "api_key" }
}

class InMemoryCredentialStore : CredentialStore {
    private var value: String? = null
    override fun read(): String? = value
    override fun write(apiKey: String) { value = apiKey }
    override fun clear() { value = null }
}
```

`core/storage/RosterStore.kt`:

```kotlin
package app.markiro.handheld.core.storage

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster

class RosterStore(private val dao: OperatorDao) : OperatorRoster {
    override suspend fun operators(): List<OperatorRecord> = dao.all().map {
        OperatorRecord(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active)
    }

    suspend fun replace(records: List<OperatorRecord>) = dao.replaceAll(
        records.map { OperatorEntity(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) },
    )
}
```

`core/storage/DeviceWipe.kt`:

```kotlin
package app.markiro.handheld.core.storage

/** Brief 07: a revoked or unbound device drops its credential and cache and returns to pairing. */
class DeviceWipe(
    private val config: DeviceConfigDao,
    private val operators: OperatorDao,
    private val credential: CredentialStore,
) {
    suspend fun wipeAll() {
        credential.clear()
        operators.clear()
        config.clear()
    }
}
```

`core/storage/StorageModule.kt`:

```kotlin
package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRoster
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object StorageModule {
    @Provides @Singleton
    fun database(@ApplicationContext context: Context): HandheldDatabase =
        Room.databaseBuilder(context, HandheldDatabase::class.java, "handheld.db").build()

    @Provides fun deviceConfigDao(db: HandheldDatabase): DeviceConfigDao = db.deviceConfigDao()
    @Provides fun operatorDao(db: HandheldDatabase): OperatorDao = db.operatorDao()

    @Provides @Singleton
    fun credentialStore(@ApplicationContext context: Context): CredentialStore = EncryptedCredentialStore(context)

    @Provides @Singleton fun rosterStore(dao: OperatorDao): RosterStore = RosterStore(dao)
    @Provides fun roster(store: RosterStore): OperatorRoster = store
    @Provides fun operatorAuth(roster: OperatorRoster): OperatorAuth = OperatorAuth(roster)
    @Provides fun deviceWipe(config: DeviceConfigDao, operators: OperatorDao, credential: CredentialStore): DeviceWipe =
        DeviceWipe(config, operators, credential)
}
```

- [ ] **Step 5: Run the storage tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*StorageTest*'`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage
git commit -m "feat(handheld): Room config and roster mirror with a Keystore-backed credential

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Network — station API client, pairing call, revocation and reachability

**Files:**
- Create: `core/network/Dtos.kt`, `core/network/StationApi.kt`, `core/network/Interceptors.kt`, `core/network/PairingClient.kt`, `core/network/NetworkModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/PairingClientTest.kt`, `InterceptorsTest.kt`

**Interfaces:**
- Produces: `HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1"`, `REVOKED_CODE`; DTOs `PairResponse(device, credential, operators)`, `DeviceDto(id, name, kind, tenantId, organizationName, line: LineDto?)`, `LineDto(id, name)`, `CredentialDto(apiKey, serverUrl)`, `OperatorDto`, `IdentityResponse(device)`, `RosterResponse(items)`, `ShiftDto(id, number, status, lineId?)`, `ShiftListResponse(items)`, `InventoryTaskDto(inventoryId, inventoryNumber, productName)`, `InventoryTaskListResponse(items)`, `ErrorBody(code?)`; `interface StationApi { identity(); operators(); shifts(status); inventoryTasks() }`; `enum PairingError { INVALID, EXPIRED, LOCKED, RATE_LIMITED, KIND_MISMATCH, UNAVAILABLE, INVALID_RESPONSE }`, `sealed interface PairingResult { Success(response); Failure(error) }`, `class PairingClient(client, json) { suspend fun redeem(serverUrl, code): PairingResult }`; `class ServerUrlProvider(configDao, fallback) { var debugOverride; fun current() }`; `class RevocationBus { val events: SharedFlow<Unit>; fun raise() }`; `class ReachabilityTracker { val lastSuccessAt: StateFlow<Long?>; fun markSuccess() }`; `ApiKeyInterceptor`, `CapabilitiesInterceptor`, `RevocationInterceptor`, `ReachabilityInterceptor`, `BaseUrlInterceptor`; Hilt qualifier `@Bare`.

- [ ] **Step 1: Write the failing tests**

`core/network/PairingClientTest.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairingClientTest {
    private val server = MockWebServer()
    private val client = PairingClient(OkHttpClient(), Json { ignoreUnknownKeys = true })

    @Before fun start() = server.start()
    @After fun stop() = server.shutdown()

    private fun base() = server.url("/").toString().trimEnd('/')

    @Test fun parsesAProvisioningResponseAndSendsTheHandheldCapability() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""
            {"device":{"id":"dev-1","name":"ТСД 1","kind":"handheld","tenantId":"t-1","organizationName":"ООО «Родник»","line":{"id":"line-2","name":"Линия 2"}},
             "credential":{"apiKey":"mk_live_abc","serverUrl":"https://admin.markiro.app"},
             "operators":[{"operatorId":"op-1","name":"Иванова Анна","login":"4127","role":"operator","pinHash":"pbkdf2${'$'}sha256${'$'}100000${'$'}a${'$'}b","badgeHash":null,"active":true}],
             "subscription":{"access":"managed","status":"active","startsAt":null,"endsAt":null}}
        """.trimIndent()))
        val result = client.redeem(base(), "48124812")
        val success = result as PairingResult.Success
        assertEquals("handheld", success.response.device.kind)
        assertEquals("Линия 2", success.response.device.line?.name)
        assertEquals("mk_live_abc", success.response.credential.apiKey)
        assertEquals(1, success.response.operators.size)
        val request = server.takeRequest()
        assertEquals("/station/pair", request.path)
        assertEquals(HANDHELD_CAPABILITIES, request.getHeader("x-station-capabilities"))
        assertTrue(request.body.readUtf8().contains("\"code\":\"48124812\""))
    }

    @Test fun mapsEveryPairingErrorCode() = runTest {
        val cases = mapOf(
            "PAIR_INVALID" to PairingError.INVALID,
            "PAIR_EXPIRED" to PairingError.EXPIRED,
            "PAIR_LOCKED" to PairingError.LOCKED,
            "PAIR_RATE_LIMITED" to PairingError.RATE_LIMITED,
            "PAIR_KIND_MISMATCH" to PairingError.KIND_MISMATCH,
        )
        for ((code, expected) in cases) {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"$code"}"""))
            val result = client.redeem(base(), "00000000")
            assertEquals(expected, (result as PairingResult.Failure).error)
        }
    }

    @Test fun treatsUnreachableServersAndGarbageAsDistinctFailures() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("not json"))
        assertEquals(PairingError.INVALID_RESPONSE, (client.redeem(base(), "11111111") as PairingResult.Failure).error)
        assertEquals(PairingError.INVALID, (client.redeem(base(), "12") as PairingResult.Failure).error)
        server.shutdown()
        assertEquals(PairingError.UNAVAILABLE, (client.redeem("http://127.0.0.1:1", "11111111") as PairingResult.Failure).error)
    }
}
```

`core/network/InterceptorsTest.kt`:

```kotlin
package app.markiro.handheld.core.network

import app.cash.turbine.test
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class InterceptorsTest {
    private val server = MockWebServer()
    private val credential = InMemoryCredentialStore()
    private val reachability = ReachabilityTracker()
    private val revocation = RevocationBus()
    private val client = OkHttpClient.Builder()
        .addInterceptor(ApiKeyInterceptor(credential))
        .addInterceptor(CapabilitiesInterceptor())
        .addInterceptor(RevocationInterceptor(revocation))
        .addInterceptor(ReachabilityInterceptor(reachability))
        .build()

    @Before fun start() = server.start()
    @After fun stop() = server.shutdown()

    @Test fun sendsTheKeyAndCapabilitiesAndRecordsSuccess() {
        credential.write("mk_live_abc")
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(Request.Builder().url(server.url("/station/identity")).build()).execute().close()
        val request = server.takeRequest()
        assertEquals("mk_live_abc", request.getHeader("x-api-key"))
        assertEquals(HANDHELD_CAPABILITIES, request.getHeader("x-station-capabilities"))
        assertNotNull(reachability.lastSuccessAt.value)
    }

    @Test fun omitsTheKeyHeaderWhenUnpaired() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(Request.Builder().url(server.url("/station/pair")).build()).execute().close()
        assertNull(server.takeRequest().getHeader("x-api-key"))
    }

    @Test fun raisesRevocationOnTheDocumentedRejectionOnly() = runTest {
        credential.write("mk_live_abc")
        revocation.events.test {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
            client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close()
            awaitItem()
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"PAIR_INVALID"}"""))
            client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close()
            expectNoEvents()
        }
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.network*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement the DTOs and API**

`core/network/Dtos.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable

const val HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1"
const val REVOKED_CODE = "STATION_CREDENTIAL_REVOKED"

@Serializable data class PairRequest(val code: String)
@Serializable data class LineDto(val id: String, val name: String)
@Serializable data class DeviceDto(
    val id: String,
    val name: String,
    val kind: String = "station",
    val tenantId: String,
    val organizationName: String,
    val line: LineDto? = null,
)
@Serializable data class CredentialDto(val apiKey: String, val serverUrl: String)
@Serializable data class OperatorDto(
    val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String? = null,
    val active: Boolean,
)
@Serializable data class PairResponse(val device: DeviceDto, val credential: CredentialDto, val operators: List<OperatorDto>)
@Serializable data class IdentityResponse(val device: DeviceDto)
@Serializable data class RosterResponse(val items: List<OperatorDto>)
@Serializable data class ShiftDto(val id: String, val number: String, val status: String, val lineId: String? = null)
@Serializable data class ShiftListResponse(val items: List<ShiftDto>)
@Serializable data class InventoryTaskDto(val inventoryId: String, val inventoryNumber: String, val productName: String)
@Serializable data class InventoryTaskListResponse(val items: List<InventoryTaskDto>)
@Serializable data class ErrorBody(val code: String? = null)
```

`core/network/StationApi.kt`:

```kotlin
package app.markiro.handheld.core.network

import retrofit2.http.GET
import retrofit2.http.Query

/** Station-only endpoints; the handheld authenticates exactly like a station (`x-api-key`). */
interface StationApi {
    @GET("station/identity") suspend fun identity(): IdentityResponse
    @GET("station/operators") suspend fun operators(): RosterResponse
    @GET("shifts") suspend fun shifts(@Query("status") status: String? = null): ShiftListResponse
    @GET("station/inventory-tasks") suspend fun inventoryTasks(): InventoryTaskListResponse
}
```

- [ ] **Step 4: Implement the interceptors, URL provider and buses**

`core/network/Interceptors.kt`:

```kotlin
package app.markiro.handheld.core.network

import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

class ApiKeyInterceptor(private val credential: CredentialStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val key = credential.read() ?: return chain.proceed(chain.request())
        return chain.proceed(chain.request().newBuilder().header("x-api-key", key).build())
    }
}

class CapabilitiesInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response =
        chain.proceed(chain.request().newBuilder().header("x-station-capabilities", HANDHELD_CAPABILITIES).build())
}

/** Emits once per rejected credential; the app shell wipes and returns to pairing. */
class RevocationBus {
    private val flow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = flow
    fun raise() { flow.tryEmit(Unit) }
}

class RevocationInterceptor(
    private val bus: RevocationBus,
    private val json: Json = Json { ignoreUnknownKeys = true },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code == 401) {
            val body = response.peekBody(2048).string()
            val code = runCatching { json.decodeFromString(ErrorBody.serializer(), body).code }.getOrNull()
            if (code == REVOKED_CODE) bus.raise()
        }
        return response
    }
}

/** Last time any request got an HTTP response; drives the «Сеть» indicator. */
class ReachabilityTracker(private val now: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow<Long?>(null)
    val lastSuccessAt: StateFlow<Long?> = state
    fun markSuccess() { state.value = now() }
}

class ReachabilityInterceptor(private val tracker: ReachabilityTracker) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        tracker.markSuccess()
        return response
    }
}

/** The paired server URL from config; the debug build may override it before pairing. */
class ServerUrlProvider(private val config: DeviceConfigDao, private val fallback: String) {
    @Volatile var debugOverride: String? = null
    fun current(): String = debugOverride ?: runBlocking { config.get()?.serverUrl } ?: fallback
}

/** Retrofit needs a base URL at build time; the real origin is only known after pairing. */
class BaseUrlInterceptor(private val provider: ServerUrlProvider) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val base = provider.current().trimEnd('/').toHttpUrlOrNull() ?: return chain.proceed(chain.request())
        val rebuilt = chain.request().url.newBuilder().scheme(base.scheme).host(base.host).port(base.port).build()
        return chain.proceed(chain.request().newBuilder().url(rebuilt).build())
    }
}
```

`core/network/PairingClient.kt`:

```kotlin
package app.markiro.handheld.core.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

enum class PairingError { INVALID, EXPIRED, LOCKED, RATE_LIMITED, KIND_MISMATCH, UNAVAILABLE, INVALID_RESPONSE }

sealed interface PairingResult {
    data class Success(val response: PairResponse) : PairingResult
    data class Failure(val error: PairingError) : PairingResult
}

/** The one unauthenticated request an unpaired device makes. The response carries the key: never log it. */
class PairingClient(private val client: OkHttpClient, private val json: Json) {
    suspend fun redeem(serverUrl: String, code: String): PairingResult = withContext(Dispatchers.IO) {
        if (!CODE.matches(code)) return@withContext PairingResult.Failure(PairingError.INVALID)
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code))
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/station/pair")
            .header("x-station-capabilities", HANDHELD_CAPABILITIES)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) return@use PairingResult.Failure(errorFrom(text))
                runCatching { json.decodeFromString(PairResponse.serializer(), text) }
                    .map<PairResponse, PairingResult> { PairingResult.Success(it) }
                    .getOrElse { PairingResult.Failure(PairingError.INVALID_RESPONSE) }
            }
        } catch (_: IOException) {
            PairingResult.Failure(PairingError.UNAVAILABLE)
        }
    }

    private fun errorFrom(body: String): PairingError =
        when (runCatching { json.decodeFromString(ErrorBody.serializer(), body).code }.getOrNull()) {
            "PAIR_EXPIRED" -> PairingError.EXPIRED
            "PAIR_LOCKED" -> PairingError.LOCKED
            "PAIR_RATE_LIMITED" -> PairingError.RATE_LIMITED
            "PAIR_KIND_MISMATCH" -> PairingError.KIND_MISMATCH
            else -> PairingError.INVALID
        }

    private companion object { val CODE = Regex("^\\d{8}$") }
}
```

`core/network/NetworkModule.kt`:

```kotlin
package app.markiro.handheld.core.network

import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinxserialization.asConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Qualifier
import javax.inject.Singleton

@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class Bare

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides @Singleton fun json(): Json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    @Provides @Singleton fun revocationBus(): RevocationBus = RevocationBus()
    @Provides @Singleton fun reachability(): ReachabilityTracker = ReachabilityTracker()
    @Provides @Singleton fun serverUrl(config: DeviceConfigDao): ServerUrlProvider =
        ServerUrlProvider(config, BuildConfig.SAAS_SERVER_URL)

    /** Bare client for pairing: no key, no base-URL rewrite. Same 30 s deadline as the station. */
    @Provides @Singleton @Bare fun bareClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
        .build()

    @Provides @Singleton fun client(
        credential: CredentialStore,
        revocation: RevocationBus,
        reachability: ReachabilityTracker,
        serverUrl: ServerUrlProvider,
        json: Json,
    ): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(BaseUrlInterceptor(serverUrl))
        .addInterceptor(ApiKeyInterceptor(credential))
        .addInterceptor(CapabilitiesInterceptor())
        .addInterceptor(RevocationInterceptor(revocation, json))
        .addInterceptor(ReachabilityInterceptor(reachability))
        .build()

    @Provides @Singleton fun stationApi(client: OkHttpClient, json: Json): StationApi = Retrofit.Builder()
        .baseUrl("http://placeholder.invalid/")
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(StationApi::class.java)

    @Provides @Singleton fun pairingClient(@Bare client: OkHttpClient, json: Json): PairingClient = PairingClient(client, json)
}
```

- [ ] **Step 5: Run the network tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.network*'`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network
git commit -m "feat(handheld): station API client with pairing, revocation and reachability

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Scan input — sources, vendor profiles, normaliser and router

**Files:**
- Create: `core/scan/ScanEvent.kt`, `core/scan/ScanNormalizer.kt`, `core/scan/WedgeBuffer.kt`, `core/scan/VendorProfiles.kt`, `core/scan/IntentExtractor.kt`, `core/scan/Sources.kt`, `core/scan/ScanRouter.kt`, `core/scan/ScanPreferences.kt`, `core/scan/ScanModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/scan/ScanNormalizerTest.kt`, `WedgeBufferTest.kt`, `VendorProfilesTest.kt`

**Interfaces:**
- Produces: `data class ScanEvent(raw, symbology: String?, source: String, at: Long)`; `object ScanNormalizer { fun normalize(raw): String }`; `class WedgeBuffer(timeoutMs) { fun onChar(c, nowMs): String?; fun onEnter(nowMs): String? }`; `data class VendorProfile(id, label, action, dataExtra, symbologyExtra, setupHint, manufacturers)`; `object VendorProfiles { DATALOGIC; HONEYWELL; ZEBRA; ALL; fun defaultFor(manufacturer); fun byId(id) }`; `class IntentExtractor(profile) { fun extract(extras: Map<String, Any?>, nowMs): ScanEvent? }`; `enum ScanSourceKind { BUILTIN_INTENT, KEYBOARD_WEDGE, DEBUG }`; `interface ScanSource`; `KeyboardWedgeScanSource.onKeyEvent(event): Boolean`; `interface ScanEvents { val events: Flow<ScanEvent> }`, `class ScanRouterAdapter(events) : ScanEvents`; `class ScanRouter(context, preferences) : ScanEvents { val wedge; fun submit(event); fun configure() }`; `class ScanPreferences(context) { var sourceKind; var profileId }`.

- [ ] **Step 1: Write the failing tests**

`core/scan/ScanNormalizerTest.kt`:

```kotlin
package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Test

class ScanNormalizerTest {
    private val gs = "\u001d"

    @Test fun keepsARealGroupSeparator() {
        assertEquals("0104680089900383217XQ4K2A${gs}91EE10", ScanNormalizer.normalize("0104680089900383217XQ4K2A${gs}91EE10"))
    }

    @Test fun replacesTextualSubstitutesWithTheSeparator() {
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800<GS>91EE10"))
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800{GS}91EE10"))
        assertEquals("01046800${gs}91EE10", ScanNormalizer.normalize("01046800\\x1d91EE10"))
    }

    @Test fun stripsAnAimIdentifierPrefixAndLineEndings() {
        assertEquals("0104680089900383", ScanNormalizer.normalize("]d20104680089900383\r\n"))
        assertEquals("4680089900383", ScanNormalizer.normalize("]E04680089900383\n"))
    }
}
```

`core/scan/WedgeBufferTest.kt`:

```kotlin
package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WedgeBufferTest {
    @Test fun completesOnEnter() {
        val buffer = WedgeBuffer(timeoutMs = 150)
        var t = 1000L
        "010491".forEach { assertNull(buffer.onChar(it, t++)) }
        assertEquals("010491", buffer.onEnter(t))
        assertNull(buffer.onEnter(t + 1))
    }

    @Test fun dropsAStaleFragmentWhenTheInterKeyGapIsTooLong() {
        val buffer = WedgeBuffer(timeoutMs = 150)
        buffer.onChar('1', 1000)
        buffer.onChar('2', 1050)
        assertNull(buffer.onChar('3', 1400))
        assertEquals("3", buffer.onEnter(1401))
    }

    @Test fun ignoresEnterOnAnEmptyBuffer() {
        assertNull(WedgeBuffer(150).onEnter(0))
    }
}
```

`core/scan/VendorProfilesTest.kt`:

```kotlin
package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VendorProfilesTest {
    @Test fun picksAProfileByManufacturer() {
        assertEquals(VendorProfiles.DATALOGIC, VendorProfiles.defaultFor("Datalogic"))
        assertEquals(VendorProfiles.HONEYWELL, VendorProfiles.defaultFor("Honeywell"))
        assertEquals(VendorProfiles.ZEBRA, VendorProfiles.defaultFor("Zebra Technologies"))
        assertEquals(VendorProfiles.ZEBRA, VendorProfiles.defaultFor("Google"))
    }

    @Test fun extractsTheDataAndSymbologyExtrasOfAProfile() {
        val event = IntentExtractor(VendorProfiles.DATALOGIC).extract(
            mapOf(
                VendorProfiles.DATALOGIC.dataExtra to "]d2010468008990038391EE10",
                VendorProfiles.DATALOGIC.symbologyExtra to "DATAMATRIX",
            ),
            nowMs = 5,
        )
        assertEquals("010468008990038391EE10", event?.raw)
        assertEquals("DATAMATRIX", event?.symbology)
        assertEquals("intent:datalogic", event?.source)
        assertEquals(5L, event?.at)
        assertNull(IntentExtractor(VendorProfiles.DATALOGIC).extract(emptyMap(), 0))
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.scan*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement the pure parts**

`core/scan/ScanEvent.kt`:

```kotlin
package app.markiro.handheld.core.scan

/** `raw` keeps the GS1 group separator (U+001D); `source` names the producing source for diagnostics. */
data class ScanEvent(val raw: String, val symbology: String?, val source: String, val at: Long)
```

`core/scan/ScanNormalizer.kt`:

```kotlin
package app.markiro.handheld.core.scan

/** Vendor wedges often replace the unprintable separator with text; scans must carry the real byte. */
object ScanNormalizer {
    private const val GS = "\u001d"
    private val substitutes = listOf("<GS>", "{GS}", "\\x1d", "\\x1D", "\\u001d", "\\u001D")
    private val aimPrefix = Regex("^\\][A-Za-z][0-9A-Za-z]")

    fun normalize(raw: String): String {
        var value = raw.trimEnd('\r', '\n')
        value = aimPrefix.replace(value, "")
        for (token in substitutes) value = value.replace(token, GS)
        return value
    }
}
```

`core/scan/WedgeBuffer.kt`:

```kotlin
package app.markiro.handheld.core.scan

/** Collects keyboard-wedge characters into one scan; a long gap between keys starts a new one. */
class WedgeBuffer(private val timeoutMs: Long) {
    private val buffer = StringBuilder()
    private var lastAt = 0L

    fun onChar(c: Char, nowMs: Long): String? {
        if (buffer.isNotEmpty() && nowMs - lastAt > timeoutMs) buffer.setLength(0)
        buffer.append(c)
        lastAt = nowMs
        return null
    }

    fun onEnter(nowMs: Long): String? {
        if (buffer.isEmpty()) return null
        if (nowMs - lastAt > timeoutMs) {
            buffer.setLength(0)
            return null
        }
        val value = buffer.toString()
        buffer.setLength(0)
        return value
    }
}
```

`core/scan/VendorProfiles.kt`:

```kotlin
package app.markiro.handheld.core.scan

/**
 * Intent-output settings of the built-in scanner services. The action and extra names come from the
 * vendors' documentation (Datalogic "Intent Wedge", Honeywell "Data Intent", Zebra "DataWedge intent
 * output") and are NOT verified on hardware in this slice. Honeywell and Zebra send to the action the
 * operator configures on the device, so both default to the app's own action name.
 */
data class VendorProfile(
    val id: String,
    val label: String,
    val action: String,
    val dataExtra: String,
    val symbologyExtra: String,
    val setupHint: String,
    val manufacturers: List<String>,
)

object VendorProfiles {
    const val APP_ACTION = "app.markiro.handheld.SCAN"

    val DATALOGIC = VendorProfile(
        id = "datalogic",
        label = "Datalogic · Intent Wedge",
        action = "com.datalogic.decodewedge.decode_action",
        dataExtra = "com.datalogic.decode.intentwedge.barcode_string",
        symbologyExtra = "com.datalogic.decode.intentwedge.barcode_type",
        setupHint = "Настройки → Сканер → Wedge → Intent Wedge: включить, действие как выше, доставка Broadcast.",
        manufacturers = listOf("datalogic"),
    )
    val HONEYWELL = VendorProfile(
        id = "honeywell",
        label = "Honeywell · Data Intent",
        action = APP_ACTION,
        dataExtra = "data",
        symbologyExtra = "codeId",
        setupHint = "Настройки → Honeywell Settings → Scanning → Internal Scanner → Data Processing Settings → Data Intent: включить, Action = $APP_ACTION.",
        manufacturers = listOf("honeywell"),
    )
    val ZEBRA = VendorProfile(
        id = "zebra",
        label = "Zebra · DataWedge",
        action = APP_ACTION,
        dataExtra = "com.symbol.datawedge.data_string",
        symbologyExtra = "com.symbol.datawedge.label_type",
        setupHint = "DataWedge → профиль для app.markiro.handheld → Intent output: включить, Intent action = $APP_ACTION, delivery Broadcast.",
        manufacturers = listOf("zebra"),
    )
    val ALL = listOf(DATALOGIC, HONEYWELL, ZEBRA)

    fun defaultFor(manufacturer: String): VendorProfile {
        val needle = manufacturer.lowercase()
        return ALL.firstOrNull { profile -> profile.manufacturers.any { needle.contains(it) } } ?: ZEBRA
    }

    fun byId(id: String): VendorProfile = ALL.firstOrNull { it.id == id } ?: ZEBRA
}
```

`core/scan/IntentExtractor.kt`:

```kotlin
package app.markiro.handheld.core.scan

class IntentExtractor(private val profile: VendorProfile) {
    fun extract(extras: Map<String, Any?>, nowMs: Long): ScanEvent? {
        val data = extras[profile.dataExtra] as? String ?: return null
        val normalized = ScanNormalizer.normalize(data)
        if (normalized.isEmpty()) return null
        return ScanEvent(normalized, extras[profile.symbologyExtra] as? String, "intent:${profile.id}", nowMs)
    }
}
```

- [ ] **Step 4: Run the pure tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*core.scan*'`
Expected: 8 tests PASS.

- [ ] **Step 5: Implement the Android sources, router and preferences**

`core/scan/Sources.kt`:

```kotlin
package app.markiro.handheld.core.scan

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.view.KeyEvent
import androidx.core.content.ContextCompat

enum class ScanSourceKind { BUILTIN_INTENT, KEYBOARD_WEDGE, DEBUG }

interface ScanSource {
    val id: String
    fun start(onEvent: (ScanEvent) -> Unit)
    fun stop()
}

/** Receives the vendor service's broadcast. Exported: the scanner service is another app. */
class IntentScanSource(private val context: Context, private val profile: VendorProfile) : ScanSource {
    override val id = "intent:${profile.id}"
    private var receiver: BroadcastReceiver? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        val extractor = IntentExtractor(profile)
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val bundle = intent.extras ?: return
                val extras = bundle.keySet().associateWith { key -> @Suppress("DEPRECATION") bundle.get(key) }
                extractor.extract(extras, System.currentTimeMillis())?.let(onEvent)
            }
        }.also {
            ContextCompat.registerReceiver(context, it, IntentFilter(profile.action), ContextCompat.RECEIVER_EXPORTED)
        }
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }
}

/** Fed by the activity's dispatchKeyEvent; consumes wedge keystrokes so text fields never see them. */
class KeyboardWedgeScanSource(private val buffer: WedgeBuffer = WedgeBuffer(timeoutMs = 150)) : ScanSource {
    override val id = "wedge"
    private var sink: ((ScanEvent) -> Unit)? = null

    override fun start(onEvent: (ScanEvent) -> Unit) { sink = onEvent }
    override fun stop() { sink = null }

    /** Returns true when the event was consumed as part of a scan. */
    fun onKeyEvent(event: KeyEvent): Boolean {
        val sink = sink ?: return false
        val isEnter = event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
        if (event.action != KeyEvent.ACTION_DOWN) return isEnter
        val now = System.currentTimeMillis()
        if (isEnter) {
            buffer.onEnter(now)?.let { sink(ScanEvent(ScanNormalizer.normalize(it), null, id, now)) }
            return true
        }
        val ch = event.unicodeChar
        if (ch == 0) return false
        buffer.onChar(ch.toChar(), now)
        return true
    }
}

/** Debug builds only: `adb shell am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data "..."`. */
class DebugScanSource(private val context: Context) : ScanSource {
    override val id = "debug"
    private var receiver: BroadcastReceiver? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val data = intent.getStringExtra("data") ?: return
                onEvent(ScanEvent(ScanNormalizer.normalize(data), intent.getStringExtra("symbology"), id, System.currentTimeMillis()))
            }
        }.also {
            ContextCompat.registerReceiver(context, it, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED)
        }
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    companion object { const val ACTION = "app.markiro.handheld.DEBUG_SCAN" }
}
```

`core/scan/ScanRouter.kt`:

```kotlin
package app.markiro.handheld.core.scan

import android.content.Context
import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** What screens and view models depend on; `ScanRouter` is the production implementation. */
interface ScanEvents {
    val events: Flow<ScanEvent>
}

/** Test seam: a source of scans that is just a flow. */
class ScanRouterAdapter(override val events: Flow<ScanEvent>) : ScanEvents

/** Single entry for every scan; screens collect `events` while they are resumed. */
class ScanRouter(private val context: Context, private val preferences: ScanPreferences) : ScanEvents {
    private val flow = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 16)
    override val events: SharedFlow<ScanEvent> = flow
    val wedge = KeyboardWedgeScanSource()
    private var active: List<ScanSource> = emptyList()

    fun submit(event: ScanEvent) { flow.tryEmit(event) }

    /** Rebuilds the active sources from preferences; safe to call on every settings change. */
    fun configure() {
        active.forEach { it.stop() }
        val sources = mutableListOf<ScanSource>()
        when (preferences.sourceKind) {
            ScanSourceKind.BUILTIN_INTENT -> sources += IntentScanSource(context, VendorProfiles.byId(preferences.profileId))
            ScanSourceKind.KEYBOARD_WEDGE -> sources += wedge
            ScanSourceKind.DEBUG -> Unit
        }
        if (BuildConfig.DEBUG_SCAN_SOURCE) sources += DebugScanSource(context)
        sources.forEach { it.start(::submit) }
        active = sources
    }
}
```

`core/scan/ScanPreferences.kt`:

```kotlin
package app.markiro.handheld.core.scan

import android.content.Context
import android.os.Build

class ScanPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("scan", Context.MODE_PRIVATE)

    var sourceKind: ScanSourceKind
        get() = ScanSourceKind.valueOf(prefs.getString("source", ScanSourceKind.BUILTIN_INTENT.name)!!)
        set(value) { prefs.edit().putString("source", value.name).apply() }

    var profileId: String
        get() = prefs.getString("profile", VendorProfiles.defaultFor(Build.MANUFACTURER ?: "").id)!!
        set(value) { prefs.edit().putString("profile", value).apply() }
}
```

`core/scan/ScanModule.kt`:

```kotlin
package app.markiro.handheld.core.scan

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ScanModule {
    @Provides @Singleton fun preferences(@ApplicationContext context: Context): ScanPreferences = ScanPreferences(context)
    @Provides @Singleton fun router(@ApplicationContext context: Context, preferences: ScanPreferences): ScanRouter =
        ScanRouter(context, preferences).also { it.configure() }
    @Provides fun scanEvents(router: ScanRouter): ScanEvents = router
}
```

- [ ] **Step 6: Build and run all app tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest assembleDebug`
Expected: `BUILD SUCCESSFUL`, every test so far PASSES.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/scan apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/scan
git commit -m "feat(handheld): vendor-neutral scan input with intent, wedge and debug sources

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part C — Android app features and shell

### Task 13: Pairing feature — state machine, provisioning persistence, screens

**Files:**
- Create: `core/network/PairingGateway.kt`; Modify: `core/network/PairingClient.kt` (implements the gateway)
- Create: `feature/pairing/ProvisioningStore.kt`, `feature/pairing/PairingViewModel.kt`, `feature/pairing/PairingScreen.kt`
- Create: `app/src/test/kotlin/app/markiro/handheld/MainDispatcherRule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/pairing/PairingViewModelTest.kt`, `PairingScreenTest.kt`

**Interfaces:**
- Consumes: `PairingClient`, `PairingResult`, `PairingError`, `PairResponse`, `OperatorDto` (Task 11); `RosterStore`, `CredentialStore`, `DeviceConfigDao`, `DeviceConfigEntity` (Task 10); `ScanEvents`, `ScanEvent` (Task 12); `ServerUrlProvider` (Task 11); design composables (Task 8).
- Produces: `interface PairingGateway { suspend fun redeem(serverUrl, code): PairingResult }`; `interface ProvisioningStore { suspend fun persist(response: PairResponse, enteredServerUrl: String) }`, `class RoomProvisioningStore`; `sealed interface PairingUi { Enter(code, serverUrl, serverEditable); Binding; Failed(error); Success(organizationName, lineName) }`; `PairingViewModel { state; onDigit; onBackspace; onConfirm; onServerUrl; onScan; retry }`; `@Composable PairingScreen(state, callbacks…)`; `fun OperatorDto.toRecord(): OperatorRecord`.

- [ ] **Step 1: Add the test dispatcher rule and the gateway interface**

`app/src/test/kotlin/app/markiro/handheld/MainDispatcherRule.kt`:

```kotlin
package app.markiro.handheld

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(val dispatcher: TestDispatcher = StandardTestDispatcher()) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

`core/network/PairingGateway.kt`:

```kotlin
package app.markiro.handheld.core.network

interface PairingGateway {
    suspend fun redeem(serverUrl: String, code: String): PairingResult
}
```

In `core/network/PairingClient.kt` change the class header to `class PairingClient(private val client: OkHttpClient, private val json: Json) : PairingGateway {` and mark `redeem` with `override`. In `NetworkModule` add `@Provides fun pairingGateway(client: PairingClient): PairingGateway = client`.

- [ ] **Step 2: Write the failing view-model test**

`feature/pairing/PairingViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.PairingError
import app.markiro.handheld.core.network.PairingGateway
import app.markiro.handheld.core.network.PairingResult
import app.markiro.handheld.core.scan.ScanEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PairingViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val persisted = mutableListOf<Pair<PairResponse, String>>()
    private val store = ProvisioningStore { response, url -> persisted += response to url }
    private val response = PairResponse(
        DeviceDto("dev-1", "ТСД 1", "handheld", "t-1", "ООО «Родник»", LineDto("line-2", "Линия 2")),
        CredentialDto("mk_live_abc", "https://admin.markiro.app"),
        emptyList(),
    )

    private fun viewModel(gateway: PairingGateway) =
        PairingViewModel(gateway, store, scans, initialServerUrl = "https://admin.markiro.app", serverEditable = false)

    @Test fun collectsEightDigitsThenPairsAndPersists() = runTest {
        val calls = mutableListOf<String>()
        val vm = viewModel { _, code -> calls += code; PairingResult.Success(response) }
        "4812481" .forEach { vm.onDigit(it) }
        vm.onConfirm()
        assertTrue(vm.state.value is PairingUi.Enter)
        vm.onDigit('2')
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(listOf("48124812"), calls)
        assertEquals(PairingUi.Success("ООО «Родник»", "Линия 2"), vm.state.value)
        assertEquals(listOf(response to "https://admin.markiro.app"), persisted)
    }

    @Test fun aScannedEightDigitCodeIsRedeemedDirectly() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Success(response) }
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("12345678", null, "debug", 0))
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUi.Success)
    }

    @Test fun failuresAreShownAndRetryReturnsToAnEmptyEntry() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Failure(PairingError.KIND_MISMATCH) }
        "11111111".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(PairingUi.Failed(PairingError.KIND_MISMATCH), vm.state.value)
        vm.retry()
        assertEquals(PairingUi.Enter("", "https://admin.markiro.app", false), vm.state.value)
        assertTrue(persisted.isEmpty())
    }

    @Test fun backspaceEditsTheCodeAndAllowsAtMostEightDigits() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Failure(PairingError.INVALID) }
        "123456789".forEach { vm.onDigit(it) }
        vm.onBackspace()
        assertEquals("1234567", (vm.state.value as PairingUi.Enter).code)
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*PairingViewModelTest*'`
Expected: compilation FAILS.

- [ ] **Step 4: Implement the provisioning store and view model**

`feature/pairing/ProvisioningStore.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.RosterStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

fun interface ProvisioningStore {
    suspend fun persist(response: PairResponse, enteredServerUrl: String)
}

fun OperatorDto.toRecord() = OperatorRecord(operatorId, name, login, role, pinHash, badgeHash, active)

/**
 * Same order as the station's persistStationProvisioning: roster, then credential, then the
 * config row whose presence means "paired". A failure before the config write leaves the
 * device unpaired with nothing to clean up but a roster that the next pairing replaces.
 */
class RoomProvisioningStore(
    private val roster: RosterStore,
    private val credential: CredentialStore,
    private val config: DeviceConfigDao,
    private val now: () -> Long = System::currentTimeMillis,
) : ProvisioningStore {
    override suspend fun persist(response: PairResponse, enteredServerUrl: String) = withContext(Dispatchers.IO) {
        roster.replace(response.operators.map { it.toRecord() })
        credential.write(response.credential.apiKey)
        val device = response.device
        config.upsert(
            DeviceConfigEntity(
                deviceId = device.id,
                deviceName = device.name,
                tenantId = device.tenantId,
                organizationName = device.organizationName,
                lineId = device.line?.id,
                lineName = device.line?.name,
                kind = device.kind,
                serverUrl = response.credential.serverUrl.ifBlank { enteredServerUrl },
                pairedAt = now(),
                rosterFetchedAt = now(),
            ),
        )
    }
}
```

`feature/pairing/PairingViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.network.PairingError
import app.markiro.handheld.core.network.PairingGateway
import app.markiro.handheld.core.network.PairingResult
import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface PairingUi {
    data class Enter(val code: String, val serverUrl: String, val serverEditable: Boolean) : PairingUi
    data object Binding : PairingUi
    data class Failed(val error: PairingError) : PairingUi
    data class Success(val organizationName: String, val lineName: String?) : PairingUi
}

@HiltViewModel
class PairingViewModel(
    private val gateway: PairingGateway,
    private val store: ProvisioningStore,
    scans: Flow<ScanEvent>,
    initialServerUrl: String,
    private val serverEditable: Boolean,
    private val onServerUrlChanged: (String) -> Unit = {},
) : ViewModel() {
    @Inject constructor(
        gateway: PairingGateway,
        store: ProvisioningStore,
        scans: ScanEvents,
        serverUrl: ServerUrlProvider,
    ) : this(
        gateway,
        store,
        scans.events,
        serverUrl.current(),
        BuildConfig.SERVER_URL_EDITABLE,
        onServerUrlChanged = { serverUrl.debugOverride = it },
    )

    private val _state = MutableStateFlow<PairingUi>(PairingUi.Enter("", initialServerUrl, serverEditable))
    val state: StateFlow<PairingUi> = _state
    private var serverUrl = initialServerUrl

    init {
        viewModelScope.launch { scans.collect { onScan(it.raw) } }
    }

    fun onDigit(digit: Char) = _state.update { s ->
        if (s is PairingUi.Enter && s.code.length < 8 && digit.isDigit()) s.copy(code = s.code + digit) else s
    }

    fun onBackspace() = _state.update { s -> if (s is PairingUi.Enter) s.copy(code = s.code.dropLast(1)) else s }

    fun onServerUrl(url: String) {
        if (!serverEditable) return
        serverUrl = url.trim()
        onServerUrlChanged(serverUrl)
        _state.update { s -> if (s is PairingUi.Enter) s.copy(serverUrl = serverUrl) else s }
    }

    fun onConfirm() {
        val s = _state.value as? PairingUi.Enter ?: return
        if (s.code.length != 8) return
        redeem(s.code)
    }

    fun onScan(raw: String) {
        if (_state.value !is PairingUi.Enter) return
        if (Regex("^\\d{8}$").matches(raw)) redeem(raw)
    }

    fun retry() { _state.value = PairingUi.Enter("", serverUrl, serverEditable) }

    private fun redeem(code: String) {
        _state.value = PairingUi.Binding
        viewModelScope.launch {
            when (val result = gateway.redeem(serverUrl, code)) {
                is PairingResult.Failure -> _state.value = PairingUi.Failed(result.error)
                is PairingResult.Success -> {
                    store.persist(result.response, serverUrl)
                    _state.value = PairingUi.Success(result.response.device.organizationName, result.response.device.line?.name)
                }
            }
        }
    }
}
```

Hilt accepts the `@Inject` secondary constructor; the primary one stays for tests. Register the store in a small module `feature/pairing/PairingModule.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
object PairingModule {
    @Provides fun provisioningStore(roster: RosterStore, credential: CredentialStore, config: DeviceConfigDao): ProvisioningStore =
        RoomProvisioningStore(roster, credential, config)
}
```

- [ ] **Step 5: Run the view-model tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*PairingViewModelTest*'`
Expected: 4 tests PASS.

- [ ] **Step 6: Write the failing screen test**

`feature/pairing/PairingScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.network.PairingError
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun entryShowsTypedDigitsGroupedAndKeypad() {
        val digits = mutableListOf<Char>()
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Enter("4812", "https://admin.markiro.app", false), PairingCallbacks(onDigit = { digits += it })) }
        }
        compose.onNodeWithText("Привязать устройство").assertIsDisplayed()
        compose.onNodeWithText("4 8 1 2").assertIsDisplayed()
        compose.onNodeWithText("7").performClick()
        assertEquals(listOf('7'), digits)
    }

    @Test fun kindMismatchExplainsTheCabinetFix() {
        var retried = false
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Failed(PairingError.KIND_MISMATCH), PairingCallbacks(onRetry = { retried = true })) }
        }
        compose.onNodeWithText("Этот код выпущен для станции").assertIsDisplayed()
        compose.onNodeWithText("Ввести другой код").performClick()
        assertEquals(true, retried)
    }

    @Test fun successNamesTheLine() {
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Success("ООО «Родник»", "Линия 2"), PairingCallbacks()) }
        }
        compose.onNodeWithText("ТСД привязан").assertIsDisplayed()
        compose.onNodeWithText("ООО «Родник» · Линия 2").assertIsDisplayed()
    }
}
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*PairingScreenTest*'`
Expected: compilation FAILS (`PairingScreen`, `PairingCallbacks`).

- [ ] **Step 8: Implement the screen**

`feature/pairing/PairingScreen.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.PairingError

data class PairingCallbacks(
    val onDigit: (Char) -> Unit = {},
    val onBackspace: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onServerUrl: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onDone: () -> Unit = {},
)

@Composable
fun PairingScreen(state: PairingUi, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is PairingUi.Enter -> EnterCode(state, callbacks)
            PairingUi.Binding -> FullScreenState(Icons.Outlined.Sync, "Привязываем устройство…", "Загружаем настройки, операторов и товары. Обычно это занимает меньше минуты.", tone = Tone.Info)
            is PairingUi.Failed -> Failed(state.error, callbacks.onRetry)
            is PairingUi.Success -> FullScreenState(
                Icons.Outlined.CheckCircle, "ТСД привязан",
                listOfNotNull(state.organizationName, state.lineName).joinToString(" · "),
                primary = StateAction("Перейти ко входу", callbacks.onDone), tone = Tone.Ok,
            )
        }
    }
}

@Composable
private fun EnterCode(state: PairingUi.Enter, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
        Text("МАРКИРО", style = t.label, color = c.fg3)
        Text("Привязать устройство", style = t.title, color = c.fg1)
        Text("Введите код из кабинета или нажмите триггер и наведите на штрих-код рядом с кодом.", style = t.body.copy(fontSize = 15.sp), color = c.fg2)
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            val typed = state.code.toList().joinToString(" ")
            val rest = List(8 - state.code.length) { "_" }.joinToString(" ")
            Text(typed, style = t.key, color = c.fg1)
            if (rest.isNotEmpty()) Text((if (typed.isEmpty()) "" else " ") + rest, style = t.key, color = c.fgDisabled)
        }
        Keypad(callbacks.onDigit, callbacks.onBackspace, callbacks.onConfirm, confirmEnabled = state.code.length == 8)
        if (state.serverEditable) {
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = callbacks.onServerUrl,
                label = { Text("Адрес сервера") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun Failed(error: PairingError, onRetry: () -> Unit) {
    when (error) {
        PairingError.INVALID, PairingError.EXPIRED, PairingError.INVALID_RESPONSE -> FullScreenState(
            Icons.Outlined.Key, "Код не подошёл",
            "Код недействителен или истёк. Обновите код в кабинете и введите новый.",
            primary = StateAction("Ввести новый код", onRetry), tone = Tone.Err,
        )
        PairingError.LOCKED, PairingError.RATE_LIMITED -> FullScreenState(
            Icons.Outlined.Lock, "Слишком много попыток",
            "Устройство заблокировано на 15 минут. Подождите или сгенерируйте новый код в кабинете.",
            primary = StateAction("Понятно", onRetry), tone = Tone.Warn, primaryIsAccent = false,
        )
        PairingError.UNAVAILABLE -> FullScreenState(
            Icons.Outlined.WifiOff, "Сервер недоступен",
            "Проверьте Wi-Fi и адрес сервера. Код пока не использован.",
            primary = StateAction("Повторить", onRetry), tone = Tone.Err,
        )
        PairingError.KIND_MISMATCH -> FullScreenState(
            Icons.Outlined.Key, "Этот код выпущен для станции",
            "Добавьте в кабинете устройство типа «ТСД» и выпустите код для него. Этот код остаётся действующим для станции.",
            primary = StateAction("Ввести другой код", onRetry), tone = Tone.Warn,
        )
    }
}
```

Add `import androidx.compose.ui.unit.sp` to the imports.

- [ ] **Step 9: Run the pairing tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.pairing*'`
Expected: 7 tests PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pairing apps/handheld/app/src/test/kotlin/app/markiro/handheld/MainDispatcherRule.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/pairing
git commit -m "feat(handheld): pairing flow with code entry, scan redemption and provisioning

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Sign-in feature — badge or login + PIN, name search, lock

**Files:**
- Create: `feature/signin/Session.kt`, `feature/signin/SignInViewModel.kt`, `feature/signin/SignInScreen.kt`, `feature/signin/SignInModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/signin/SignInViewModelTest.kt`, `SignInScreenTest.kt`

**Interfaces:**
- Consumes: `OperatorAuth`, `OperatorRecord` (Task 9); `ScanEvents`, `ScanRouterAdapter` (Task 12); design composables (Task 8).
- Produces: `class SessionHolder { val state: StateFlow<SessionState>; fun signIn(op); fun lock(); fun unlock(); fun signOut() }`, `data class SessionState(operator: OperatorRecord?, locked: Boolean)`; `sealed interface SignInUi { Login(login, error); Pin(login, operatorName?, pin, error, lockMode); Search(query, results) }`, `enum SignInError { WRONG_PIN, NOT_FOUND, BADGE_UNKNOWN, ROSTER_EMPTY }`; `SignInViewModel { state; onDigit; onBackspace; onConfirm; onSearchQuery; onPickOperator; openSearch; back; switchOperator; onScan }`; `@Composable SignInScreen(state, callbacks)`.

- [ ] **Step 1: Write the failing view-model test**

`feature/signin/SignInViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.signin

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster
import app.markiro.handheld.core.scan.ScanEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SignInViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "PIN:1234", "BADGE:735519", true)
    private val roster = object : OperatorRoster { override suspend fun operators() = listOf(anna) }
    private val auth = OperatorAuth(roster) { secret, phc -> phc == "PIN:$secret" || phc == "BADGE:$secret" }
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder()

    private fun vm() = SignInViewModel(auth, session, scans)

    @Test fun loginThenPinSignsTheOperatorIn() = runTest {
        val vm = vm()
        "41".forEach { vm.onDigit(it) }
        vm.onConfirm()
        assertEquals(SignInUi.Pin(login = "041", operatorName = null, pin = "", error = null, lockMode = false), vm.state.value)
        vm.back()
        "4127".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals("Иванова Анна", (vm.state.value as SignInUi.Pin).operatorName)
        "1234".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
    }

    @Test fun wrongPinKeepsTheOperatorOnThePinStepWithAnError() = runTest {
        val vm = vm()
        "4127".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        "0000".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        val pin = vm.state.value as SignInUi.Pin
        assertEquals(SignInError.WRONG_PIN, pin.error)
        assertEquals("", pin.pin)
        assertNull(session.state.value.operator)
    }

    @Test fun badgeScanSignsInFromAnyStep() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("735519", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(anna, session.state.value.operator)
        session.signOut()
        val again = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("000000", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(SignInError.BADGE_UNKNOWN, (again.state.value as SignInUi.Login).error)
    }

    @Test fun searchOffersMatchesAndPrefillsTheLogin() = runTest {
        val vm = vm()
        vm.openSearch()
        vm.onSearchQuery("ив")
        advanceUntilIdle()
        assertEquals(listOf(anna), (vm.state.value as SignInUi.Search).results)
        vm.onPickOperator(anna)
        advanceUntilIdle()
        assertEquals("4127", (vm.state.value as SignInUi.Pin).login)
    }

    @Test fun lockModeStartsOnThePinOfTheCurrentOperator() = runTest {
        session.signIn(anna)
        session.lock()
        val vm = vm()
        advanceUntilIdle()
        val pin = vm.state.value as SignInUi.Pin
        assertTrue(pin.lockMode)
        assertEquals("4127", pin.login)
        "1234".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(SessionState(anna, locked = false), session.state.value)
        vm.switchOperator()
        assertNull(session.state.value.operator)
        assertTrue(vm.state.value is SignInUi.Login)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*SignInViewModelTest*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement the session and view model**

`feature/signin/Session.kt`:

```kotlin
package app.markiro.handheld.feature.signin

import app.markiro.handheld.core.auth.OperatorRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class SessionState(val operator: OperatorRecord? = null, val locked: Boolean = false)

/** In-memory operator session; the app shell locks it after idle time. */
class SessionHolder {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state

    fun signIn(operator: OperatorRecord) { _state.value = SessionState(operator, locked = false) }
    fun lock() = _state.update { if (it.operator != null) it.copy(locked = true) else it }
    fun unlock() = _state.update { it.copy(locked = false) }
    fun signOut() { _state.value = SessionState() }
}
```

`feature/signin/SignInViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanRouterAdapter
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class SignInError { WRONG_PIN, NOT_FOUND, BADGE_UNKNOWN, ROSTER_EMPTY }

sealed interface SignInUi {
    data class Login(val login: String = "", val error: SignInError? = null) : SignInUi
    data class Pin(
        val login: String,
        val operatorName: String?,
        val pin: String = "",
        val error: SignInError? = null,
        val lockMode: Boolean = false,
    ) : SignInUi
    data class Search(val query: String = "", val results: List<OperatorRecord> = emptyList()) : SignInUi
}

@HiltViewModel
class SignInViewModel @Inject constructor(
    private val auth: OperatorAuth,
    private val session: SessionHolder,
    scans: ScanEvents,
) : ViewModel() {
    /** Test seam: scans as a bare flow. */
    constructor(auth: OperatorAuth, session: SessionHolder, scans: Flow<ScanEvent>) : this(auth, session, ScanRouterAdapter(scans))

    private val _state = MutableStateFlow<SignInUi>(initial())
    val state: StateFlow<SignInUi> = _state

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
    }

    private fun initial(): SignInUi {
        val current = session.state.value
        return if (current.locked && current.operator != null) {
            SignInUi.Pin(current.operator.login, current.operator.name, lockMode = true)
        } else {
            SignInUi.Login()
        }
    }

    fun onDigit(digit: Char) = _state.update { s ->
        when (s) {
            is SignInUi.Login -> if (s.login.length < 12) s.copy(login = s.login + digit, error = null) else s
            is SignInUi.Pin -> if (s.pin.length < 6) s.copy(pin = s.pin + digit, error = null) else s
            is SignInUi.Search -> s
        }
    }

    fun onBackspace() = _state.update { s ->
        when (s) {
            is SignInUi.Login -> s.copy(login = s.login.dropLast(1))
            is SignInUi.Pin -> s.copy(pin = s.pin.dropLast(1))
            is SignInUi.Search -> s
        }
    }

    fun onConfirm() {
        when (val s = _state.value) {
            is SignInUi.Login -> {
                val login = OperatorAuth.padLogin(s.login) ?: return
                _state.value = SignInUi.Pin(login, operatorName = null)
                viewModelScope.launch {
                    val name = auth.byLoginOnly(login)?.name
                    _state.update { p -> if (p is SignInUi.Pin && p.login == login) p.copy(operatorName = name) else p }
                }
            }
            is SignInUi.Pin -> {
                if (s.pin.length < 4) return
                viewModelScope.launch {
                    val operator = auth.byLogin(s.login, s.pin)
                    if (operator == null) {
                        _state.update { p -> if (p is SignInUi.Pin) p.copy(pin = "", error = SignInError.WRONG_PIN) else p }
                    } else {
                        session.signIn(operator)
                    }
                }
            }
            is SignInUi.Search -> Unit
        }
    }

    fun openSearch() { _state.value = SignInUi.Search() }

    fun onSearchQuery(query: String) {
        _state.value = SignInUi.Search(query)
        viewModelScope.launch {
            val results = auth.search(query)
            _state.update { s -> if (s is SignInUi.Search && s.query == query) s.copy(results = results) else s }
        }
    }

    fun onPickOperator(operator: OperatorRecord) { _state.value = SignInUi.Pin(operator.login, operator.name) }

    fun back() { _state.value = SignInUi.Login() }

    fun switchOperator() {
        session.signOut()
        _state.value = SignInUi.Login()
    }

    fun onScan(raw: String) {
        viewModelScope.launch {
            val operator = auth.byBadge(raw)
            if (operator != null) {
                session.signIn(operator)
            } else {
                _state.update { s ->
                    when (s) {
                        is SignInUi.Login -> s.copy(error = SignInError.BADGE_UNKNOWN)
                        is SignInUi.Pin -> s.copy(error = SignInError.BADGE_UNKNOWN)
                        is SignInUi.Search -> s
                    }
                }
            }
        }
    }
}
```

`feature/signin/SignInModule.kt`:

```kotlin
package app.markiro.handheld.feature.signin

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SignInModule {
    @Provides @Singleton fun session(): SessionHolder = SessionHolder()
}
```

- [ ] **Step 4: Run the view-model tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*SignInViewModelTest*'`
Expected: 5 tests PASS.

- [ ] **Step 5: Write the failing screen test**

`feature/signin/SignInScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.signin

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
class SignInScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun loginStepShowsBadgeBlockLoginFieldAndSearchLink() {
        var searched = false
        compose.setContent { MarkiroTheme { SignInScreen(SignInUi.Login("41"), SignInCallbacks(onOpenSearch = { searched = true })) } }
        compose.onNodeWithText("Сканируйте бейдж").assertIsDisplayed()
        compose.onNodeWithText("41").assertIsDisplayed()
        compose.onNodeWithText("Найти по имени").performClick()
        assertEquals(true, searched)
    }

    @Test fun pinStepShowsTheOperatorAndAWrongPinError() {
        compose.setContent {
            MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Иванова Анна", "12", SignInError.WRONG_PIN), SignInCallbacks()) }
        }
        compose.onNodeWithText("Иванова Анна").assertIsDisplayed()
        compose.onNodeWithText("Неверный PIN").assertIsDisplayed()
    }

    @Test fun lockModeOffersSwitchingTheOperator() {
        var switched = false
        compose.setContent {
            MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Иванова Анна", lockMode = true), SignInCallbacks(onSwitchOperator = { switched = true })) }
        }
        compose.onNodeWithText("Сменить оператора").performClick()
        assertEquals(true, switched)
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*SignInScreenTest*'`
Expected: compilation FAILS.

- [ ] **Step 7: Implement the screens**

`feature/signin/SignInScreen.kt`:

```kotlin
package app.markiro.handheld.feature.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PinDots

data class SignInCallbacks(
    val onDigit: (Char) -> Unit = {},
    val onBackspace: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onOpenSearch: () -> Unit = {},
    val onSearchQuery: (String) -> Unit = {},
    val onPickOperator: (OperatorRecord) -> Unit = {},
    val onBack: () -> Unit = {},
    val onSwitchOperator: () -> Unit = {},
)

@Composable
fun SignInScreen(state: SignInUi, callbacks: SignInCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is SignInUi.Login -> LoginStep(state, callbacks)
            is SignInUi.Pin -> PinStep(state, callbacks)
            is SignInUi.Search -> SearchStep(state, callbacks)
        }
    }
}

@Composable
private fun LoginStep(state: SignInUi.Login, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(
            Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.lineStrong, RoundedCornerShape(MarkiroSizes.radius)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg1, modifier = Modifier.size(36.dp))
            Text("Сканируйте бейдж", style = t.strong, color = c.fg1)
            Text("нажмите триггер · или введите табельный номер ниже", style = t.caption, color = c.fg3, textAlign = TextAlign.Center)
            if (state.error == SignInError.BADGE_UNKNOWN) Text("Бейдж не найден", style = t.caption, color = c.errFg)
            if (state.error == SignInError.ROSTER_EMPTY) Text("Список операторов ещё не загружен", style = t.caption, color = c.warnFg)
        }
        Field(label = "Табельный №", value = state.login)
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.login.isNotEmpty())
        MarkiroTextButton("Найти по имени", cb.onOpenSearch)
    }
}

@Composable
private fun PinStep(state: SignInUi.Pin, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        Column(Modifier.fillMaxWidth().weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            val initials = (state.operatorName ?: "?").split(' ').take(2).mapNotNull { it.firstOrNull() }.joinToString("")
            Box(Modifier.size(44.dp).clip(CircleShape).background(c.surfacePanel), contentAlignment = Alignment.Center) {
                Text(initials, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
            }
            Text(state.operatorName ?: "Табельный ${state.login}", style = t.strong, color = c.fg1)
            Text(if (state.lockMode) "Введите PIN или сканируйте бейдж" else "табельный ${state.login}", style = t.caption, color = c.fg3)
            if (state.error == SignInError.WRONG_PIN) Text("Неверный PIN", style = t.caption, color = c.errFg)
            if (state.error == SignInError.BADGE_UNKNOWN) Text("Бейдж не найден", style = t.caption, color = c.errFg)
        }
        Row(
            Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("PIN", style = t.body.copy(fontSize = 15.sp), color = c.fg3)
            PinDots(total = maxOf(4, state.pin.length), filled = state.pin.length)
        }
        Keypad(cb.onDigit, cb.onBackspace, cb.onConfirm, confirmEnabled = state.pin.length >= 4)
        MarkiroTextButton(if (state.lockMode) "Сменить оператора" else "Не тот сотрудник", if (state.lockMode) cb.onSwitchOperator else cb.onBack)
    }
}

@Composable
private fun SearchStep(state: SignInUi.Search, cb: SignInCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize()) {
        AppBar("Найти по имени", onBack = cb.onBack)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            OutlinedTextField(value = state.query, onValueChange = cb.onSearchQuery, singleLine = true, modifier = Modifier.fillMaxWidth(), label = { Text("Фамилия или имя") })
            Text("Показаны первые 5 совпадений. Уточните запрос, если нужного нет.", style = t.caption, color = c.fg3)
            state.results.forEach { operator ->
                Row(
                    Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable { cb.onPickOperator(operator) },
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(operator.name, style = t.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = c.fg1)
                    Text("№ ${operator.login}", style = t.caption, color = c.fg3)
                }
            }
        }
    }
}

@Composable
private fun Field(label: String, value: String) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Row(
        Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
            .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.body.copy(fontSize = 15.sp), color = c.fg3)
        Text(value, style = t.code.copy(fontSize = 22.sp), color = c.fg1)
    }
}
```

- [ ] **Step 8: Run the sign-in tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.signin*'`
Expected: 8 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/signin
git commit -m "feat(handheld): operator sign-in by badge, login and PIN with search and lock

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Hub, status strip, roster refresh and settings

**Files:**
- Create: `feature/hub/HubViewModel.kt`, `feature/hub/HubScreen.kt`, `feature/hub/RosterRefresher.kt`
- Create: `feature/settings/AppPreferences.kt`, `feature/settings/SettingsViewModel.kt`, `feature/settings/SettingsScreens.kt`, `feature/settings/SettingsModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/hub/HubViewModelTest.kt`, `HubScreenTest.kt`

**Interfaces:**
- Consumes: `StationApi`, `ReachabilityTracker` (Task 11); `DeviceConfigDao`, `RosterStore` (Task 10); `SessionHolder` (Task 14); `ScanPreferences`, `ScanRouter`, `VendorProfiles`, `ScanEvents` (Task 12); design composables.
- Produces: `data class HubUi(organization, operatorName, lineName, shifts: Int?, inventories: Int?, countsAt: Long?, reachable: Boolean, scannerLabel: String)`; `HubViewModel { state; fun refresh(); fun signOut() }`; `@Composable HubScreen(state, onTile: (HubTile) -> Unit, onSignOut)`, `enum HubTile { SHIFT, INVENTORY, CHECK, SETTINGS }`; `class RosterRefresher { suspend fun refresh() }`; `class AppPreferences { var theme: ThemeMode; var language: String }`, `enum ThemeMode { DARK, LIGHT, SYSTEM }`; `SettingsViewModel`; `@Composable SettingsScreen`, `ScannerSettingsScreen`, `AboutScreen`, `ComingSoonScreen(title, onBack)`.

- [ ] **Step 1: Write the failing hub view-model test**

`feature/hub/HubViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.hub

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.IdentityResponse
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.InventoryTaskListResponse
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import java.io.IOException

class HubViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val configFlow = MutableStateFlow<DeviceConfigEntity?>(
        DeviceConfigEntity("dev-1", "ТСД 1", "t-1", "ООО «Родник»", "line-2", "Линия 2", "handheld", "https://x", 1L),
    )
    private val config = object : DeviceConfigDao {
        override fun observe(): Flow<DeviceConfigEntity?> = configFlow
        override suspend fun get() = configFlow.value
        override suspend fun count() = if (configFlow.value == null) 0 else 1
        override suspend fun upsert(config: DeviceConfigEntity) { configFlow.value = config }
        override suspend fun clear() { configFlow.value = null }
    }
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private var clock = 1_000_000L
    private val reachability = ReachabilityTracker { clock }

    private fun api(fail: Boolean = false) = object : StationApi {
        override suspend fun identity() = throw UnsupportedOperationException()
        override suspend fun operators() = RosterResponse(emptyList())
        override suspend fun shifts(status: String?): ShiftListResponse {
            if (fail) throw IOException("offline")
            return ShiftListResponse(listOf(ShiftDto("s1", "SEP26-001", "active"), ShiftDto("s2", "SEP26-002", "planned"), ShiftDto("s3", "SEP26-003", "closed")))
        }
        override suspend fun inventoryTasks(): InventoryTaskListResponse {
            if (fail) throw IOException("offline")
            return InventoryTaskListResponse(listOf(InventoryTaskDto("i1", "7", "Вода 0,5 л")))
        }
    }

    @Test fun refreshCountsOpenShiftsAndTasksAndStoresThem() = runTest {
        val vm = HubViewModel(api(), config, session, reachability, scannerLabel = { "встроенный" })
        vm.refresh()
        advanceUntilIdle()
        val ui = vm.state.value
        assertEquals(2, ui.shifts)
        assertEquals(1, ui.inventories)
        assertEquals("Иванова Анна", ui.operatorName)
        assertEquals("Линия 2", ui.lineName)
        assertEquals(2, configFlow.value?.shiftsCount)
    }

    @Test fun offlineKeepsCachedCountsAndReportsUnreachable() = runTest {
        configFlow.value = configFlow.value!!.copy(shiftsCount = 3, inventoryCount = 0, countsAt = 900_000L)
        val vm = HubViewModel(api(fail = true), config, session, reachability, scannerLabel = { "встроенный" })
        vm.refresh()
        advanceUntilIdle()
        val ui = vm.state.value
        assertEquals(3, ui.shifts)
        assertEquals(900_000L, ui.countsAt)
        assertEquals(false, ui.reachable)
    }

    @Test fun signOutClearsTheSession() = runTest {
        val vm = HubViewModel(api(), config, session, reachability, scannerLabel = { "встроенный" })
        vm.signOut()
        assertNull(session.state.value.operator)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*HubViewModelTest*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement the hub view model and roster refresher**

`feature/hub/HubViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.hub

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HubUi(
    val organization: String = "",
    val operatorName: String = "",
    val lineName: String? = null,
    val shifts: Int? = null,
    val inventories: Int? = null,
    val countsAt: Long? = null,
    val reachable: Boolean = false,
    val scannerLabel: String = "",
)

enum class HubTile { SHIFT, INVENTORY, CHECK, SETTINGS }

/** Reachable = an HTTP response within the last two minutes (the station's online threshold). */
private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private val OPEN_SHIFT_STATUSES = setOf("planned", "active")

@HiltViewModel
class HubViewModel(
    private val api: StationApi,
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    private val reachability: ReachabilityTracker,
    private val scannerLabel: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    @Inject constructor(
        api: StationApi,
        config: DeviceConfigDao,
        session: SessionHolder,
        reachability: ReachabilityTracker,
        scan: ScanPreferences,
    ) : this(api, config, session, reachability, scannerLabel = {
        when (scan.sourceKind) {
            ScanSourceKind.BUILTIN_INTENT -> VendorProfiles.byId(scan.profileId).label.substringBefore(" ·")
            ScanSourceKind.KEYBOARD_WEDGE -> "клавиатурный"
            ScanSourceKind.DEBUG -> "отладка"
        }
    })

    val state: StateFlow<HubUi> = combine(config.observe(), session.state, reachability.lastSuccessAt) { cfg, ses, lastOk ->
        HubUi(
            organization = cfg?.organizationName.orEmpty(),
            operatorName = ses.operator?.name.orEmpty(),
            lineName = cfg?.lineName,
            shifts = cfg?.shiftsCount,
            inventories = cfg?.inventoryCount,
            countsAt = cfg?.countsAt,
            reachable = lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS,
            scannerLabel = scannerLabel(),
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HubUi())

    /** Fetches live counts; on any failure the cached counts and their timestamp stay untouched. */
    fun refresh() {
        viewModelScope.launch {
            val current = config.get() ?: return@launch
            val counts = runCatching {
                val shifts = api.shifts().items.count { it.status in OPEN_SHIFT_STATUSES }
                val tasks = api.inventoryTasks().items.size
                shifts to tasks
            }.getOrNull() ?: return@launch
            config.upsert(current.copy(shiftsCount = counts.first, inventoryCount = counts.second, countsAt = now()))
        }
    }

    fun signOut() = session.signOut()
}
```

`feature/hub/RosterRefresher.kt`:

```kotlin
package app.markiro.handheld.feature.hub

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.feature.pairing.toRecord
import javax.inject.Inject

/** Refreshes the operator mirror when online; a failure keeps the previous roster. */
class RosterRefresher @Inject constructor(
    private val api: StationApi,
    private val roster: RosterStore,
    private val config: DeviceConfigDao,
) {
    suspend fun refresh(now: Long = System.currentTimeMillis()) {
        val items = runCatching { api.operators().items }.getOrNull() ?: return
        roster.replace(items.map { it.toRecord() })
        config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) }
    }
}
```

- [ ] **Step 4: Run the hub view-model tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*HubViewModelTest*'`
Expected: 3 tests PASS.

- [ ] **Step 5: Write the failing hub screen test**

`feature/hub/HubScreenTest.kt`:

```kotlin
package app.markiro.handheld.feature.hub

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
class HubScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun showsHeaderTilesAndCounts() {
        var opened: HubTile? = null
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi("ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 3, inventories = 1, countsAt = null, reachable = true, scannerLabel = "Datalogic"),
                    onTile = { opened = it },
                    onSignOut = {},
                )
            }
        }
        compose.onNodeWithText("Иванова Анна · Линия 2").assertIsDisplayed()
        compose.onNodeWithText("3 доступны").assertIsDisplayed()
        compose.onNodeWithText("1 задание").assertIsDisplayed()
        compose.onNodeWithText("Инвентаризация").performClick()
        assertEquals(HubTile.INVENTORY, opened)
    }

    @Test fun offlineShowsTheCacheTimeAndBanner() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(HubUi("ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false, scannerLabel = "Datalogic"), onTile = {}, onSignOut = {})
            }
        }
        compose.onNodeWithText("Работаем офлайн").assertIsDisplayed()
        compose.onNodeWithText("заданий нет").assertIsDisplayed()
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*HubScreenTest*'`
Expected: compilation FAILS.

- [ ] **Step 7: Implement the hub screen**

`feature/hub/HubScreen.kt`:

```kotlin
package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tile
import app.markiro.handheld.core.design.Tone
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HubScreen(state: HubUi, onTile: (HubTile) -> Unit, onSignOut: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) StatusItem(Icons.Outlined.Wifi, "Сеть") else StatusItem(Icons.Outlined.WifiOff, "Офлайн", Tone.Warn),
                StatusItem(Icons.Outlined.Sync, "Очередь 0"),
                StatusItem(Icons.Outlined.Print, "Принтер"),
                StatusItem(Icons.Outlined.QrCodeScanner, state.scannerLabel.ifEmpty { "Сканер" }),
            ),
        )
        if (!state.reachable) Banner("Работаем офлайн", Tone.Warn, Icons.Outlined.WifiOff)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Row(Modifier.fillMaxWidth().height(44.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(state.organization, style = t.caption, color = c.fg3)
                    Text(listOfNotNull(state.operatorName.ifEmpty { null }, state.lineName).joinToString(" · "), style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
                }
                IconAction(Icons.AutoMirrored.Outlined.Logout, "Выйти", onSignOut)
            }
            val stamp = state.countsAt?.takeIf { !state.reachable }?.let { " · данные на " + SimpleDateFormat("HH:mm", Locale("ru")).format(Date(it)) }.orEmpty()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(Icons.Outlined.Factory, "Смена", shiftsLabel(state.shifts) + stamp, { onTile(HubTile.SHIFT) }, Modifier.weight(1f))
                Tile(Icons.Outlined.Inventory2, "Инвентаризация", inventoriesLabel(state.inventories), { onTile(HubTile.INVENTORY) }, Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(Icons.Outlined.QrCodeScanner, "Проверка кода", "нажмите триггер", { onTile(HubTile.CHECK) }, Modifier.weight(1f))
                Tile(Icons.Outlined.Settings, "Настройки", "принтер не настроен", { onTile(HubTile.SETTINGS) }, Modifier.weight(1f), statusTone = Tone.Warn)
            }
        }
    }
}

internal fun shiftsLabel(count: Int?): String = when (count) {
    null -> "нет данных"
    0 -> "смен нет"
    1 -> "1 доступна"
    else -> "$count доступны"
}

internal fun inventoriesLabel(count: Int?): String = when (count) {
    null -> "нет данных"
    0 -> "заданий нет"
    1 -> "1 задание"
    2, 3, 4 -> "$count задания"
    else -> "$count заданий"
}
```

Add `import androidx.compose.ui.unit.sp`.

- [ ] **Step 8: Run the hub tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*feature.hub*'`
Expected: 5 tests PASS.

- [ ] **Step 9: Implement preferences and the settings screens**

`feature/settings/AppPreferences.kt`:

```kotlin
package app.markiro.handheld.feature.settings

import android.content.Context

enum class ThemeMode { DARK, LIGHT, SYSTEM }

class AppPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("app", Context.MODE_PRIVATE)

    var theme: ThemeMode
        get() = ThemeMode.valueOf(prefs.getString("theme", ThemeMode.DARK.name)!!)
        set(value) { prefs.edit().putString("theme", value.name).apply() }

    /** BCP-47 tag applied through AppCompatDelegate; `ru` is the default. */
    var language: String
        get() = prefs.getString("language", "ru")!!
        set(value) { prefs.edit().putString("language", value).apply() }
}
```

`feature/settings/SettingsViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.settings

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUi(
    val sourceKind: ScanSourceKind,
    val profileId: String,
    val theme: ThemeMode,
    val language: String,
    val lastScan: ScanEvent? = null,
    val debugScanEnabled: Boolean = BuildConfig.DEBUG_SCAN_SOURCE,
    val version: String = BuildConfig.VERSION_NAME,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val scan: ScanPreferences,
    private val router: ScanRouter,
    scans: ScanEvents,
    private val app: AppPreferences,
    config: DeviceConfigDao,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUi(scan.sourceKind, scan.profileId, app.theme, app.language))
    val state: StateFlow<SettingsUi> = _state
    val config: StateFlow<DeviceConfigEntity?> = config.observe().stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        viewModelScope.launch { scans.events.collect { event -> _state.value = _state.value.copy(lastScan = event) } }
    }

    fun setSource(kind: ScanSourceKind) {
        scan.sourceKind = kind
        router.configure()
        _state.value = _state.value.copy(sourceKind = kind)
    }

    fun setProfile(id: String) {
        scan.profileId = id
        router.configure()
        _state.value = _state.value.copy(profileId = id)
    }

    fun setTheme(mode: ThemeMode) {
        app.theme = mode
        _state.value = _state.value.copy(theme = mode)
    }

    fun setLanguage(tag: String) {
        app.language = tag
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
        _state.value = _state.value.copy(language = tag)
    }

    /** Hidden text field on the test-scan screen (debug builds): behaves like a scan. */
    fun submitDebugScan(text: String) {
        if (BuildConfig.DEBUG_SCAN_SOURCE) router.submit(ScanEvent(text, null, "debug-field", System.currentTimeMillis()))
    }

    fun profileLabel(id: String): String = VendorProfiles.byId(id).label
}
```

`feature/settings/SettingsScreens.kt`:

```kotlin
package app.markiro.handheld.feature.settings

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
import androidx.compose.material.icons.outlined.Construction
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigEntity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SettingsScreen(state: SettingsUi, config: DeviceConfigEntity?, onBack: () -> Unit, onScanner: () -> Unit, onTheme: (ThemeMode) -> Unit, onLanguage: (String) -> Unit) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar("Настройки", onBack)
        Column(Modifier.padding(horizontal = MarkiroSizes.sp4)) {
            SettingRow("Сканер", sourceLabel(state), onScanner)
            SettingRow("Язык", if (state.language == "en") "English" else "Русский") { onLanguage(if (state.language == "en") "ru" else "en") }
            SettingRow("Тема", when (state.theme) { ThemeMode.DARK -> "Тёмная"; ThemeMode.LIGHT -> "Светлая"; ThemeMode.SYSTEM -> "Как в системе" }) {
                onTheme(ThemeMode.entries[(state.theme.ordinal + 1) % ThemeMode.entries.size])
            }
            Text("ОБ УСТРОЙСТВЕ", style = MarkiroTheme.type.label, color = c.fg3, modifier = Modifier.padding(top = MarkiroSizes.sp4, bottom = MarkiroSizes.sp2))
            InfoRow("Имя", listOfNotNull(config?.deviceName, config?.lineName).joinToString(" · "))
            InfoRow("Сервер", config?.serverUrl.orEmpty().removePrefix("https://"))
            InfoRow("Версия", state.version)
            InfoRow("Операторы", config?.rosterFetchedAt?.let { "обновлены " + SimpleDateFormat("dd.MM HH:mm", Locale("ru")).format(Date(it)) } ?: "не загружены")
            Text("Отвязать устройство можно только из кабинета.", style = MarkiroTheme.type.caption, color = c.fg3, modifier = Modifier.padding(top = MarkiroSizes.sp3))
        }
    }
}

private fun sourceLabel(state: SettingsUi): String = when (state.sourceKind) {
    ScanSourceKind.BUILTIN_INTENT -> "встроенный · " + VendorProfiles.byId(state.profileId).label.substringBefore(" ·")
    ScanSourceKind.KEYBOARD_WEDGE -> "клавиатурный wedge"
    ScanSourceKind.DEBUG -> "отладка"
}

@Composable
fun ScannerSettingsScreen(state: SettingsUi, onBack: () -> Unit, onSource: (ScanSourceKind) -> Unit, onProfile: (String) -> Unit, onDebugScan: (String) -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar("Сканер", onBack)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            Text("ИСТОЧНИК СКАНОВ", style = t.label, color = c.fg3)
            OptionRow("Встроенный сканер", VendorProfiles.byId(state.profileId).setupHint, state.sourceKind == ScanSourceKind.BUILTIN_INTENT) { onSource(ScanSourceKind.BUILTIN_INTENT) }
            OptionRow("Клавиатурный wedge", "универсальный запасной путь: сканер печатает код как клавиатура", state.sourceKind == ScanSourceKind.KEYBOARD_WEDGE) { onSource(ScanSourceKind.KEYBOARD_WEDGE) }
            if (state.sourceKind == ScanSourceKind.BUILTIN_INTENT) {
                Text("ПРОФИЛЬ ВЕНДОРА", style = t.label, color = c.fg3)
                VendorProfiles.ALL.forEach { profile -> OptionRow(profile.label, "действие ${profile.action}", state.profileId == profile.id) { onProfile(profile.id) } }
            }
            Text("ТЕСТОВЫЙ СКАН", style = t.label, color = c.fg3)
            TestScan(state.lastScan)
            if (state.debugScanEnabled) {
                var text by remember { mutableStateOf("") }
                OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("Отладочный скан (только debug)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                PrimaryButton("Отправить как скан", { onDebugScan(text); text = "" }, enabled = text.isNotEmpty())
            }
        }
    }
}

@Composable
private fun TestScan(event: ScanEvent?) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard).border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(MarkiroSizes.sp3),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
    ) {
        if (event == null) {
            Text("Нажмите триггер — здесь появится сырая строка с разделителями GS.", style = t.caption, color = c.fg3)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1), verticalAlignment = Alignment.CenterVertically) {
                event.raw.split('\u001d').forEachIndexed { index, part ->
                    if (index > 0) MarkiroChip("GS", Tone.Info)
                    Text(part, style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                }
            }
            Text("${event.symbology ?: "символика неизвестна"} · источник ${event.source} · ${event.raw.length} симв.", style = t.caption, color = c.okFg)
        }
    }
}

@Composable
fun ComingSoonScreen(title: String, onBack: () -> Unit) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(title, onBack)
        FullScreenState(Icons.Outlined.Construction, "В следующем срезе", "Этот раздел появится после того, как ТСД научится работать в смене.", primary = StateAction("Назад", onBack), primaryIsAccent = false)
    }
}

@Composable
private fun SettingRow(label: String, value: String, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    Row(
        Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.caption.copy(fontSize = 15.sp), color = c.fg2)
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth().height(40.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.caption.copy(fontSize = 15.sp), color = c.fg1)
    }
}

@Composable
private fun OptionRow(label: String, sub: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard).border(1.dp, if (selected) c.accent else c.line, shape).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape), contentAlignment = Alignment.Center) {
            if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent))
        }
        Column {
            Text(label, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
            Text(sub, style = t.caption, color = c.fg3)
        }
    }
}
```

`feature/settings/SettingsModule.kt`:

```kotlin
package app.markiro.handheld.feature.settings

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SettingsModule {
    @Provides @Singleton fun appPreferences(@ApplicationContext context: Context): AppPreferences = AppPreferences(context)
}
```

- [ ] **Step 10: Build and run all tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest assembleDebug`
Expected: `BUILD SUCCESSFUL`, all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/hub
git commit -m "feat(handheld): hub with live counts, status strip and scanner settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: App shell — navigation, idle lock, revocation, docs, final gate

**Files:**
- Create: `app/src/main/kotlin/app/markiro/handheld/AppShellViewModel.kt`, `AppNavigation.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/MainActivity.kt`
- Create: `apps/handheld/README.md`
- Modify: `AGENTS.md` (repository map), `docs/architecture.md` (product surfaces)
- Test: `app/src/test/kotlin/app/markiro/handheld/AppShellViewModelTest.kt`

**Interfaces:**
- Consumes: everything above.
- Produces: `AppShellViewModel { val start: StateFlow<StartDestination?>; val events: SharedFlow<ShellEvent>; fun onUserInteraction(); fun onPaired(); }`, `enum StartDestination { PAIRING, SIGN_IN, HUB }`, `sealed interface ShellEvent { Revoked; Locked }`; routes `pairing`, `signin`, `hub`, `settings`, `settings/scanner`, `soon/{title}`.

- [ ] **Step 1: Write the failing shell test**

`AppShellViewModelTest.kt`:

```kotlin
package app.markiro.handheld

import app.cash.turbine.test
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.DeviceWipe
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.OperatorDao
import app.markiro.handheld.core.storage.OperatorEntity
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AppShellViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val configFlow = MutableStateFlow<DeviceConfigEntity?>(null)
    private val config = object : DeviceConfigDao {
        override fun observe(): Flow<DeviceConfigEntity?> = configFlow
        override suspend fun get() = configFlow.value
        override suspend fun count() = if (configFlow.value == null) 0 else 1
        override suspend fun upsert(config: DeviceConfigEntity) { configFlow.value = config }
        override suspend fun clear() { configFlow.value = null }
    }
    private val operators = object : OperatorDao {
        val rows = mutableListOf<OperatorEntity>()
        override suspend fun all() = rows.toList()
        override suspend fun insertAll(rows: List<OperatorEntity>) { this.rows += rows }
        override suspend fun clear() = rows.clear()
    }
    private val credential = InMemoryCredentialStore()
    private val session = SessionHolder()
    private val revocation = RevocationBus()
    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)

    private fun vm() = AppShellViewModel(config, session, revocation, DeviceWipe(config, operators, credential), idleMs = 5 * 60 * 1000L)

    @Test fun startsOnPairingWithoutConfigAndOnSignInWithIt() = runTest {
        val a = vm()
        advanceUntilIdle()
        assertEquals(StartDestination.PAIRING, a.start.value)
        configFlow.value = DeviceConfigEntity("dev-1", "ТСД 1", "t-1", "ООО", null, null, "handheld", "https://x", 1L)
        val b = vm()
        advanceUntilIdle()
        assertEquals(StartDestination.SIGN_IN, b.start.value)
    }

    @Test fun revocationWipesEverythingAndEmitsAnEvent() = runTest {
        configFlow.value = DeviceConfigEntity("dev-1", "ТСД 1", "t-1", "ООО", null, null, "handheld", "https://x", 1L)
        credential.write("mk_live_abc")
        session.signIn(anna)
        val shell = vm()
        shell.events.test {
            revocation.raise()
            assertEquals(ShellEvent.Revoked, awaitItem())
        }
        assertNull(configFlow.value)
        assertNull(credential.read())
        assertNull(session.state.value.operator)
    }

    @Test fun idleTimeLocksASignedInSession() = runTest {
        session.signIn(anna)
        val shell = vm()
        shell.events.test {
            shell.onUserInteraction()
            advanceTimeBy(4 * 60 * 1000L)
            shell.onUserInteraction()
            advanceTimeBy(4 * 60 * 1000L)
            expectNoEvents()
            advanceTimeBy(2 * 60 * 1000L)
            assertEquals(ShellEvent.Locked, awaitItem())
        }
        assertTrue(session.state.value.locked)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*AppShellViewModelTest*'`
Expected: compilation FAILS.

- [ ] **Step 3: Implement the shell view model**

`AppShellViewModel.kt`:

```kotlin
package app.markiro.handheld

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceWipe
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class StartDestination { PAIRING, SIGN_IN, HUB }

sealed interface ShellEvent {
    data object Revoked : ShellEvent
    data object Locked : ShellEvent
}

@HiltViewModel
class AppShellViewModel(
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    revocation: RevocationBus,
    private val wipe: DeviceWipe,
    private val idleMs: Long,
) : ViewModel() {
    @Inject constructor(config: DeviceConfigDao, session: SessionHolder, revocation: RevocationBus, wipe: DeviceWipe) :
        this(config, session, revocation, wipe, idleMs = IDLE_LOCK_MS)

    private val _start = MutableStateFlow<StartDestination?>(null)
    val start: StateFlow<StartDestination?> = _start
    private val _events = MutableSharedFlow<ShellEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ShellEvent> = _events
    private var idleJob: Job? = null

    init {
        viewModelScope.launch {
            val paired = config.observe().first() != null
            _start.value = when {
                !paired -> StartDestination.PAIRING
                session.state.value.operator != null && !session.state.value.locked -> StartDestination.HUB
                else -> StartDestination.SIGN_IN
            }
        }
        viewModelScope.launch {
            revocation.events.collect {
                wipe.wipeAll()
                session.signOut()
                _events.emit(ShellEvent.Revoked)
            }
        }
    }

    /** Called by the activity on every touch or key; five idle minutes lock a signed-in session. */
    fun onUserInteraction() {
        idleJob?.cancel()
        if (session.state.value.operator == null || session.state.value.locked) return
        idleJob = viewModelScope.launch {
            delay(idleMs)
            session.lock()
            _events.emit(ShellEvent.Locked)
        }
    }

    companion object { const val IDLE_LOCK_MS = 5 * 60 * 1000L }
}
```

- [ ] **Step 4: Run the shell tests**

Run: `cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*AppShellViewModelTest*'`
Expected: 3 tests PASS.

- [ ] **Step 5: Wire navigation and the activity**

`AppNavigation.kt`:

```kotlin
package app.markiro.handheld

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubTile
import app.markiro.handheld.feature.hub.HubViewModel
import app.markiro.handheld.feature.hub.RosterRefresher
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingViewModel
import app.markiro.handheld.feature.settings.AppPreferences
import app.markiro.handheld.feature.settings.ComingSoonScreen
import app.markiro.handheld.feature.settings.ScannerSettingsScreen
import app.markiro.handheld.feature.settings.SettingsScreen
import app.markiro.handheld.feature.settings.SettingsViewModel
import app.markiro.handheld.feature.settings.ThemeMode
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInViewModel
import app.markiro.handheld.feature.signin.SessionHolder

object Routes {
    const val PAIRING = "pairing"
    const val SIGN_IN = "signin"
    const val HUB = "hub"
    const val SETTINGS = "settings"
    const val SCANNER = "settings/scanner"
    const val SOON = "soon/{title}"
    fun soon(title: String) = "soon/$title"
}

@Composable
fun MarkiroApp(shell: AppShellViewModel, session: SessionHolder, refresher: RosterRefresher, preferences: AppPreferences) {
    val start by shell.start.collectAsStateWithLifecycle()
    val dark = when (preferences.theme) {
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
    }
    MarkiroTheme(dark = dark) {
        val first = start ?: return@MarkiroTheme
        val nav = rememberNavController()
        val sessionState by session.state.collectAsStateWithLifecycle()

        LaunchedEffect(Unit) {
            shell.events.collect { event ->
                when (event) {
                    ShellEvent.Revoked -> nav.navigate(Routes.PAIRING) { popUpTo(0) }
                    ShellEvent.Locked -> nav.navigate(Routes.SIGN_IN) { popUpTo(0) }
                }
            }
        }
        LaunchedEffect(sessionState.operator, sessionState.locked) {
            if (sessionState.operator != null && !sessionState.locked && nav.currentDestination?.route == Routes.SIGN_IN) {
                nav.navigate(Routes.HUB) { popUpTo(0) }
            }
            if (sessionState.operator == null && nav.currentDestination?.route !in setOf(Routes.SIGN_IN, Routes.PAIRING)) {
                nav.navigate(Routes.SIGN_IN) { popUpTo(0) }
            }
        }

        NavHost(nav, startDestination = when (first) { StartDestination.PAIRING -> Routes.PAIRING; StartDestination.SIGN_IN -> Routes.SIGN_IN; StartDestination.HUB -> Routes.HUB }) {
            composable(Routes.PAIRING) {
                val vm: PairingViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                PairingScreen(state, PairingCallbacks(vm::onDigit, vm::onBackspace, vm::onConfirm, vm::onServerUrl, vm::retry, onDone = { nav.navigate(Routes.SIGN_IN) { popUpTo(0) } }))
            }
            composable(Routes.SIGN_IN) {
                val vm: SignInViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                SignInScreen(state, SignInCallbacks(vm::onDigit, vm::onBackspace, vm::onConfirm, vm::openSearch, vm::onSearchQuery, vm::onPickOperator, vm::back, vm::switchOperator))
            }
            composable(Routes.HUB) {
                val vm: HubViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { refresher.refresh(); vm.refresh() }
                HubScreen(state, onTile = { tile ->
                    when (tile) {
                        HubTile.SHIFT -> nav.navigate(Routes.soon("Смена"))
                        HubTile.INVENTORY -> nav.navigate(Routes.soon("Инвентаризация"))
                        HubTile.CHECK -> nav.navigate(Routes.soon("Проверка кода"))
                        HubTile.SETTINGS -> nav.navigate(Routes.SETTINGS)
                    }
                }, onSignOut = vm::signOut)
            }
            composable(Routes.SETTINGS) {
                val vm: SettingsViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                val config by vm.config.collectAsStateWithLifecycle()
                SettingsScreen(state, config, onBack = { nav.popBackStack() }, onScanner = { nav.navigate(Routes.SCANNER) }, onTheme = vm::setTheme, onLanguage = vm::setLanguage)
            }
            composable(Routes.SCANNER) {
                val vm: SettingsViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                ScannerSettingsScreen(state, onBack = { nav.popBackStack() }, onSource = vm::setSource, onProfile = vm::setProfile, onDebugScan = vm::submitDebugScan)
            }
            composable(Routes.SOON) { entry ->
                ComingSoonScreen(entry.arguments?.getString("title") ?: "", onBack = { nav.popBackStack() })
            }
        }
    }
}
```

`MainActivity.kt` (replace the Task 7 version):

```kotlin
package app.markiro.handheld

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.feature.hub.RosterRefresher
import app.markiro.handheld.feature.settings.AppPreferences
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    @Inject lateinit var scanRouter: ScanRouter
    @Inject lateinit var session: SessionHolder
    @Inject lateinit var refresher: RosterRefresher
    @Inject lateinit var preferences: AppPreferences
    private val shell: AppShellViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(preferences.language))
        setContent { MarkiroApp(shell, session, refresher, preferences) }
        shell.onUserInteraction()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        shell.onUserInteraction()
    }

    /** Keyboard-wedge scanners type into whatever is focused; intercept them before Compose does. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        scanRouter.wedge.onKeyEvent(event) || super.dispatchKeyEvent(event)
}
```

- [ ] **Step 6: Build, lint and run everything**

Run:
```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```
Expected: `BUILD SUCCESSFUL`; all unit and Robolectric tests PASS; lint reports no errors (warnings about unused resources are acceptable and listed in the report).

- [ ] **Step 7: Document the app and the repository map**

`apps/handheld/README.md`:

```markdown
# Markiro Handheld (ТСД)

Native Android app for industrial handheld terminals. Design: `docs/design-briefs/10-tsd-handheld.md`;
this slice: `docs/superpowers/specs/2026-09-10-handheld-foundation-design.md`.

## Build and test

    ./gradlew testDebugUnitTest lintDebug assembleDebug
    adb install -r app/build/outputs/apk/debug/app-debug.apk

Requires JDK 17 and the Android SDK (platform 35). Fonts are bundled (see FONT-LICENSES.md).

## Debug aids (debug build only)

- The pairing screen has an editable server address; point it at the local API
  (`http://10.0.2.2:3000` from the emulator).
- Any flow accepts a broadcast scan:

      adb shell am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data "48124812"

  Settings → Сканер also has a text field that submits a scan.

## Scanner sources

Built-in vendor intent (Datalogic Intent Wedge, Honeywell Data Intent, Zebra DataWedge; the
device-side setup hint is shown in Settings → Сканер), keyboard wedge as the fallback. Vendor
intent names are taken from documentation and are not yet verified on hardware.
```

In `AGENTS.md`, add to the repository map after the `apps/signer` entry:

```markdown
- `apps/handheld`: native Android (Kotlin, Compose) app for industrial handheld
  terminals (ТСД). Pairs and authenticates as a station device (`kind =
  handheld`), keeps an offline operator roster, and receives scans from the
  vendor scanner service or a keyboard wedge. Gradle project outside the pnpm
  workspace; CI job `handheld-android`.
```

In `docs/architecture.md`, add one line to the product-surfaces list (next to the station entry) describing the handheld as a station-kind device that reuses the station credential and endpoints.

- [ ] **Step 8: Manual verification on the emulator (report separately)**

1. Start the dev stack: `docker compose -f docker-compose.dev.yml up -d`, `pnpm --filter @markiro/api dev`, `pnpm --filter @markiro/admin dev`.
2. In the cabinet add a device of type «ТСД» on a line; issue a pairing code.
3. Create an API-34 emulator in Android Studio, `adb install -r` the debug APK, open it, set the server address to `http://10.0.2.2:3000`, enter the code. Expect «ТСД привязан · <org> · <line>».
4. Sign in with a seeded operator by login + PIN; then sign out and sign in with `adb shell am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data "<badge code>"`.
5. Check the hub counts against the cabinet; stop the API and confirm the offline banner and «данные на HH:MM».
6. Leave the app idle for five minutes: expect the lock screen; unlock by PIN.
7. Revoke the device in the cabinet, trigger any request (open Settings → back to Hub): expect a return to the pairing screen with an empty state.
8. Record the result in the PR description as manual evidence; list Datalogic/Honeywell hardware and vendor intents as not exercised.

- [ ] **Step 9: Commit and open the pull request**

```bash
git add apps/handheld AGENTS.md docs/architecture.md
git commit -m "feat(handheld): app shell with navigation, idle lock and revocation handling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin worktree-tsd-handheld
gh pr create --base main --title "feat: handheld (TSD) foundation — device kind and Android app" --body-file - <<'PR'
## Summary
- `station_devices.kind` (`station` | `handheld`), unified `/devices` type, cabinet «ТСД» option, pairing kind check (`PAIR_KIND_MISMATCH`)
- `apps/handheld`: Kotlin/Compose app — pairing, offline operator sign-in (PHC-compatible), hub with live counts, scanner settings, idle lock, revocation wipe
- CI job `handheld-android` behind the selective classifier

## Automated checks
- db migration tests, API e2e (devices, station-devices, station-pairing), admin tests
- `./gradlew testDebugUnitTest lintDebug assembleDebug`

## Manual verification
- Emulator API 34 against the local stack: pairing, sign-in by PIN and debug badge, hub counts, offline banner, idle lock, revocation
- Not exercised: Datalogic/Honeywell hardware, vendor intent profiles, hardware trigger

Spec: docs/superpowers/specs/2026-09-10-handheld-foundation-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PR
```

---

## Self-review notes

- Spec coverage: database (Task 1), API kind and list (Tasks 2–3), pairing check (Task 4), cabinet (Task 5), CI and ignores (Task 6), project and build types (Task 7), design system (Task 8), offline auth (Task 9), storage and credential (Task 10), network with revocation and reachability (Task 11), scan sources and profiles (Task 12), pairing screens and provisioning order (Task 13), sign-in tiers and lock (Task 14), hub counts, roster refresh, status strip, settings (Task 15), navigation, idle lock, revocation, docs, manual verification (Task 16).
- Deliberately narrowed from the spec: the theme/language settings use a tap-to-cycle row instead of a picker sheet, and the lock timeout is a constant, as the spec allows.
- Type consistency checked across tasks: `ScanEvents` and `ScanRouterAdapter` are defined in Task 12 and consumed by the pairing (13), sign-in (14) and settings (15) view models; `OperatorAuth.byLoginOnly` is defined in Task 9 and used in Task 14; `HubViewModel`'s injected constructor derives the scanner label from `ScanPreferences` defined in Task 12.
