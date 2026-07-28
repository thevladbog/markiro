import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { partitionName, schema, type Db } from "@markiro/db";
import type { ScanItemDto } from "../src/modules/station-scans/dto";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station-scans e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  async function deviceKey(agent: ReturnType<typeof request.agent>): Promise<string> {
    const device = await agent.post("/station-devices").send({ name: "Line 1" }).expect(201);
    return (device.body as { apiKey: string }).apiKey;
  }

  // A genuinely valid GTIN-14 (same fixture as products.e2e.test.ts's
  // GTIN14_CANONICAL_PADDED): POST /products validates the GS1 check digit
  // via normalizeToGtin14, and the field is `gtin`, not `gtin14`.
  const VALID_GTIN14 = "04006381333931";

  // productGroup + both capacities are required for the product to come
  // back "active" (see ProductsService.computeStatus); a "draft" product is
  // rejected outright by POST /shifts regardless of shift mode.
  async function createActiveProduct(agent: ReturnType<typeof request.agent>): Promise<string> {
    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    return (product.body as { id: string }).id;
  }

  // `productId`, if given, lets a caller open two shifts against the same
  // product (GTIN is unique per tenant, so a second `createActiveProduct`
  // call for the same tenant would 409).
  async function openShift(
    agent: ReturnType<typeof request.agent>,
    productId?: string,
  ): Promise<string> {
    const pid = productId ?? (await createActiveProduct(agent));
    const shift = await agent
      .post("/shifts")
      .send({ productId: pid, mode: "validation" })
      .expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  function item(shiftId: string, n: number, overrides: Partial<ScanItemDto> = {}): ScanItemDto {
    return {
      shiftId,
      terminalId: "t1",
      raw: `RAW${n}`,
      verdict: "ok",
      scannedAt: `2026-07-28T10:00:0${n}.000Z`,
      code: { codeHash: `h${n}`.padEnd(64, "0"), gtin14: VALID_GTIN14, serial: `S${n}` },
      ...overrides,
    };
  }

  // Tenant-scoped row counters so a parallel test's data (or a previous run's
  // leftovers in a shared partition) cannot satisfy these assertions.
  async function scanEventsCount(tenantId: string, shiftId: string): Promise<number> {
    const rows = await db
      .select({ scannedAt: schema.scanEvents.scannedAt })
      .from(schema.scanEvents)
      .where(and(eq(schema.scanEvents.tenantId, tenantId), eq(schema.scanEvents.shiftId, shiftId)));
    return rows.length;
  }

  async function codesCount(tenantId: string, shiftId: string): Promise<number> {
    const rows = await db
      .select({ codeHash: schema.codes.codeHash })
      .from(schema.codes)
      .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.shiftId, shiftId)));
    return rows.length;
  }

  it("accepts a batch from a station api-key and stores codes and events", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:200", items: [item(shiftId, 1), item(shiftId, 2)] })
      .expect(201);

    expect(res.body).toMatchObject({ applied: 2, alreadyApplied: false });
    expect(await scanEventsCount(tenantId, shiftId)).toBe(2);
    expect(await codesCount(tenantId, shiftId)).toBe(2);
  });

  it("is idempotent: the same batchId applied twice stores one set of rows", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    const body = { batchId: "machine-1:200", items: [item(shiftId, 1)] };

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);
    const second = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);

    expect(second.body).toMatchObject({ applied: 0, alreadyApplied: true });
    expect(await scanEventsCount(tenantId, shiftId)).toBe(1);
    expect(await codesCount(tenantId, shiftId)).toBe(1);
  });

  it("accepts late data for a closed shift and stamps it", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    // closeShiftSchema requires `reason` (min 3 chars, see shifts/dto.ts),
    // matching the field name shifts.e2e.test.ts uses for this same route.
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:300", items: [item(shiftId, 1)] })
      .expect(201);

    const shift = await agent.get(`/shifts/${shiftId}`).expect(200);
    expect((shift.body as { lateDataAt: string | null }).lateDataAt).not.toBeNull();
  });

  it("leaves lateDataAt null for a batch delivered to an open (not closed) shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:310", items: [item(shiftId, 1)] })
      .expect(201);

    const shift = await agent.get(`/shifts/${shiftId}`).expect(200);
    expect((shift.body as { lateDataAt: string | null }).lateDataAt).toBeNull();
  });

  it("does not move lateDataAt when a second late batch arrives for an already-stamped shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:320", items: [item(shiftId, 1)] })
      .expect(201);
    const first = await agent.get(`/shifts/${shiftId}`).expect(200);
    const firstLateDataAt = (first.body as { lateDataAt: string | null }).lateDataAt;
    expect(firstLateDataAt).not.toBeNull();

    // Different batchId — otherwise this second call is a no-op idempotent
    // retry of the first and proves nothing about the "set once" guarantee.
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:321", items: [item(shiftId, 2)] })
      .expect(201);
    const second = await agent.get(`/shifts/${shiftId}`).expect(200);
    expect((second.body as { lateDataAt: string | null }).lateDataAt).toBe(firstLateDataAt);
  });

  // Fixed historical month, not a computed offset from "now" — so the test
  // does not drift. Distinct from packages/db/test/partitions.test.ts's
  // 2001-01 fixture, which that suite drops and recreates on every run.
  const FAR_PAST_SCANNED_AT = "2019-03-15T10:00:00.000Z";

  it("accepts and stores a scan whose scannedAt falls outside the currently-maintained partition window", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "machine-1:600",
        items: [item(shiftId, 1, { scannedAt: FAR_PAST_SCANNED_AT })],
      })
      .expect(201);

    expect(res.body).toMatchObject({ applied: 1, alreadyApplied: false });
    expect(await scanEventsCount(tenantId, shiftId)).toBe(1);
    expect(await codesCount(tenantId, shiftId)).toBe(1);
  });

  // Regression for the Date.UTC(year, month, 1) two-digit-year remap: a raw
  // numeric year of 0-99 gets silently mapped to 1900-1999 (Date.UTC(50, 0, 1)
  // => 1950-01-01, not year 0050), so a scannedAt in that range would
  // previously ensure the partition for the wrong century while the row
  // inserts with the real year, and Postgres rejects it with SQLSTATE 23514
  // -- a 500 that wedges the station's drain loop forever, same failure mode
  // the partition-window fix above exists to prevent.
  //
  // Year 0000 itself (as opposed to any other year 0-99) is not usable here:
  // Postgres's calendar has no year zero -- `SELECT '0000-01-01'::date`
  // fails with 22008 "date/time field value out of range" independent of
  // partitioning -- so this fixture uses year 0050, which both zod's
  // `.datetime()` and Postgres accept, and which still falls in the
  // remapped range.
  const TWO_DIGIT_YEAR_SCANNED_AT = "0050-06-15T10:00:00.000Z";

  it("accepts and stores a scan whose scannedAt falls in the Date.UTC two-digit-year range", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "machine-1:650",
        items: [item(shiftId, 1, { scannedAt: TWO_DIGIT_YEAR_SCANNED_AT })],
      })
      .expect(201);

    expect(res.body).toMatchObject({ applied: 1, alreadyApplied: false });
    expect(await scanEventsCount(tenantId, shiftId)).toBe(1);
    expect(await codesCount(tenantId, shiftId)).toBe(1);
  });

  it("stores a scan_events row with no codes row when the item's code is null", async () => {
    // Real traffic: the station writes a NULL code for every scan it judged
    // a duplicate (see the outbox/journal writer), so this is not
    // hypothetical.
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:700", items: [item(shiftId, 1, { code: null })] })
      .expect(201);

    expect(await scanEventsCount(tenantId, shiftId)).toBe(1);
    expect(await codesCount(tenantId, shiftId)).toBe(0);
  });

  it("applies a batch spanning two shifts", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const productId = await createActiveProduct(agent);
    const shiftA = await openShift(agent, productId);
    const shiftB = await openShift(agent, productId);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:800", items: [item(shiftA, 1), item(shiftB, 2)] })
      .expect(201);

    expect(res.body).toMatchObject({ applied: 2, alreadyApplied: false });
    expect(await scanEventsCount(tenantId, shiftA)).toBe(1);
    expect(await scanEventsCount(tenantId, shiftB)).toBe(1);
  });

  it("rejects a shift id belonging to another tenant", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const foreignShift = await openShift(other);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:400", items: [item(foreignShift, 1)] })
      .expect(400);

    expect(res.body.message).toBe("Unknown shift in batch");
  });

  it("rejects a well-formed shift id that exists in no tenant, with the same signal as a foreign one", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:450", items: [item(randomUUID(), 1)] })
      .expect(400);

    expect(res.body.message).toBe("Unknown shift in batch");
  });

  it(
    "rejects a batch spanning more distinct months than the cap, creating no partitions " +
      "and storing nothing (Finding 2)",
    async () => {
      const agent = request.agent(app!.getHttpServer());
      const tenantId = await signUpAndActivate(agent);
      const apiKey = await deviceKey(agent);
      const shiftId = await openShift(agent);

      // Nine distinct months -- comfortably past
      // MAX_DISTINCT_MONTHS_PER_BATCH (6, see station-scans.service.ts). A
      // fixed historical year, like partitions.test.ts's 2001-01 fixture, so
      // this can never collide with a partition real traffic (or another
      // test file) already created.
      const items = Array.from({ length: 9 }, (_, i) =>
        item(shiftId, i + 1, {
          scannedAt: `2010-${String(i + 1).padStart(2, "0")}-15T00:00:00.000Z`,
        }),
      );

      const res = await request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send({ batchId: "machine-1:950", items })
        .expect(400);

      expect(res.body.message).toMatch(/distinct months/);
      expect(await scanEventsCount(tenantId, shiftId)).toBe(0);
      expect(await codesCount(tenantId, shiftId)).toBe(0);

      // The stronger proof of "no lock storm": not one of these months' scan
      // partitions was created, even though ensuring THIS rejection didn't
      // just accidentally still create a couple before the count check.
      for (let i = 0; i < 9; i++) {
        const name = partitionName("scan_events", new Date(Date.UTC(2010, i, 1)));
        const exists = await db.execute(
          sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = ${name} AND n.nspname = current_schema()`,
        );
        expect(exists.rows).toHaveLength(0);
      }
    },
  );

  // Device-key surface regression guard: see docs/device-key-surface.md.
  // If a future hardening pass makes this session-only, every station stops
  // being able to deliver its scans at all.
  it("stays reachable by a station api-key", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:900", items: [] })
      .expect(201);
  });

  it("rejects an unauthenticated caller", async () => {
    await request(app!.getHttpServer())
      .post("/station/scans")
      .send({ batchId: "machine-1:500", items: [] })
      .expect(401);
  });
});
