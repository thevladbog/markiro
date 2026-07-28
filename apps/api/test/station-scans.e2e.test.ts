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
import { listenOnLoopback } from "./support/listen-loopback";

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
    await listenOnLoopback(app);
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

  // Reads `code_registry`'s actual current owner directly, tenant-scoped —
  // the only way to prove ownership itself (not just the JSON response,
  // which is computed in application code and can silently diverge from
  // what the database holds; see Finding 1 / Finding 2 in the review that
  // added this helper).
  async function registryOwner(
    tenantId: string,
    codeHash: string,
  ): Promise<{ terminalId: string | null; scannedAt: Date } | undefined> {
    const rows = await db
      .select({
        terminalId: schema.codeRegistry.terminalId,
        scannedAt: schema.codeRegistry.scannedAt,
      })
      .from(schema.codeRegistry)
      .where(
        and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, codeHash)),
      );
    return rows[0];
  }

  async function conflictCount(tenantId: string, codeHash: string): Promise<number> {
    const rows = await db
      .select({ id: schema.codeConflicts.id })
      .from(schema.codeConflicts)
      .where(
        and(
          eq(schema.codeConflicts.tenantId, tenantId),
          eq(schema.codeConflicts.codeHash, codeHash),
        ),
      );
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

  // A computed offset from "now", not a fixed historical date: Finding 2
  // introduced an ABSOLUTE timestamp window anchored to "now" (see
  // WINDOW_PAST_MS, station-scans.service.ts), so a fixed date far enough in
  // the past to exercise this test would eventually rotate outside that
  // window as real time passes -- unlike before that fix, when nothing here
  // depended on "now" at all. 3 months back stays safely inside the 3-year
  // window while still being well outside the scheduled job's proactively
  // maintained {current, next} month pair, so `ensurePartitions` still has
  // to create this month's partition on demand. Distinct from
  // packages/db/test/partitions.test.ts's 2001-01 fixture, which that suite
  // drops and recreates on every run.
  function monthsAgoUTC(monthsAgo: number, day = 15): Date {
    const d = new Date(0);
    const now = new Date();
    d.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day);
    return d;
  }
  const FAR_PAST_SCANNED_AT = monthsAgoUTC(3).toISOString();

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
  // numeric year of 0-99 used to get silently mapped to 1900-1999
  // (Date.UTC(50, 0, 1) => 1950-01-01, not year 0050), so a scannedAt in that
  // range would previously ensure the partition for the wrong century while
  // the row inserts with the real year, and Postgres would reject it with
  // SQLSTATE 23514 -- a 500 that wedges the station's drain loop forever.
  //
  // Finding 2's absolute timestamp window now rejects a value this far from
  // "now" before the month-start computation ever runs, so the Date.UTC bug
  // can no longer be reached via this endpoint at all -- the underlying
  // setUTCFullYear fix (station-scans.service.ts) is pure defense-in-depth.
  // This test is repurposed accordingly: it now proves the window rejects
  // this value cleanly (400, no partition, nothing stored) rather than
  // reaching the two-digit-year computation (previously a 500) or, before
  // the window existed, succeeding outright.
  //
  // Year 0000 itself (as opposed to any other year 0-99) is not usable here:
  // Postgres's calendar has no year zero -- `SELECT '0000-01-01'::date`
  // fails with 22008 "date/time field value out of range" independent of
  // partitioning -- so this fixture uses year 0050, which both zod's
  // `.datetime()` and Postgres accept, and which still falls in the
  // remapped range.
  const TWO_DIGIT_YEAR_SCANNED_AT = "0050-06-15T10:00:00.000Z";

  it("rejects a scan whose scannedAt falls in the Date.UTC two-digit-year range, via the timestamp window, creating no partition", async () => {
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
      .expect(400);

    expect(res.body.message).toMatch(/scannedAt outside the acceptable window/);
    expect(await scanEventsCount(tenantId, shiftId)).toBe(0);
    expect(await codesCount(tenantId, shiftId)).toBe(0);

    // Deliberately no partition-existence assertion here: this exact
    // fixture (year 0050, month 06) is also exercised by this file's OWN
    // history from before Finding 2 existed, when it was still an
    // "accepts and stores" test -- so a long-lived local dev database can
    // legitimately already have this one month's partition sitting around
    // from a much earlier run, independent of whether today's rejection
    // logic works. The dedicated "outside the acceptable timestamp window"
    // test below covers the "no partition gets created" guarantee with a
    // date this suite has never used for anything else.
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

      // Thirty distinct months -- comfortably past
      // MAX_DISTINCT_MONTHS_PER_BATCH (24, see station-scans.service.ts).
      // 30 CONSECUTIVE months ending 5 months ago (via monthsAgoUTC's
      // month-rollover, same as Date.UTC's), so every one of them stays
      // safely inside the absolute timestamp window (3 years / 36 months) --
      // this test must be rejected by the MONTH CAP, not the window check,
      // and a fixed historical year (like the old 2010 fixture, or
      // partitions.test.ts's 2001-01) can no longer be used for that: the
      // window is anchored to "now", so a fixed date would eventually rotate
      // outside it as real time passes. Ending 5 months back (not 0) keeps
      // every target month away from the scheduled job's proactively
      // maintained {current, next} pair, so none of them could already have
      // a partition from unrelated activity.
      const MONTH_COUNT = 30;
      const items = Array.from({ length: MONTH_COUNT }, (_, i) =>
        item(shiftId, i + 1, {
          scannedAt: monthsAgoUTC(34 - i).toISOString(),
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
      for (let i = 0; i < MONTH_COUNT; i++) {
        const name = partitionName("scan_events", monthsAgoUTC(34 - i, 1));
        const exists = await db.execute(
          sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = ${name} AND n.nspname = current_schema()`,
        );
        expect(exists.rows).toHaveLength(0);
      }
    },
  );

  it("rejects a batch referencing an unknown shift, creating no partition for its month (Finding 2)", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    // 2 months back: inside the absolute timestamp window and away from
    // the 5-34-months-back range the month-cap test above uses, and away
    // from the scheduled job's current/next-month maintenance -- so this
    // test isolates the shift-ownership guard rejection specifically.
    const scannedAt = monthsAgoUTC(2).toISOString();

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "machine-1:960",
        items: [item(randomUUID(), 1, { scannedAt })],
      })
      .expect(400);

    expect(res.body.message).toBe("Unknown shift in batch");

    const name = partitionName("scan_events", monthsAgoUTC(2, 1));
    const exists = await db.execute(
      sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ${name} AND n.nspname = current_schema()`,
    );
    expect(exists.rows).toHaveLength(0);
  });

  it(
    "rejects a batch with a scannedAt outside the acceptable timestamp window, creating no " +
      "partition for its month, even for an otherwise-valid, owned shift (Finding 2)",
    async () => {
      const agent = request.agent(app!.getHttpServer());
      const tenantId = await signUpAndActivate(agent);
      const apiKey = await deviceKey(agent);
      // A real, owned shift -- proves the window check rejects purely on the
      // timestamp, before the (otherwise-valid) shift is ever looked at.
      const shiftId = await openShift(agent);

      // 7 years back: comfortably outside WINDOW_PAST_MS (3 years,
      // station-scans.service.ts), but an ordinary-looking date rather than
      // the historical-curiosity two-digit-year fixture above -- and
      // deliberately far from every other offset this file uses (2, 3, and
      // 5-34 months back) so it cannot collide with their partitions.
      const scannedAt = new Date(
        Date.UTC(new Date().getUTCFullYear() - 7, new Date().getUTCMonth(), 15),
      );

      const res = await request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send({
          batchId: "machine-1:970",
          items: [item(shiftId, 1, { scannedAt: scannedAt.toISOString() })],
        })
        .expect(400);

      expect(res.body.message).toMatch(/scannedAt outside the acceptable window/);
      expect(await scanEventsCount(tenantId, shiftId)).toBe(0);
      expect(await codesCount(tenantId, shiftId)).toBe(0);

      const name = partitionName(
        "scan_events",
        new Date(Date.UTC(scannedAt.getUTCFullYear(), scannedAt.getUTCMonth(), 1)),
      );
      const exists = await db.execute(
        sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ${name} AND n.nspname = current_schema()`,
      );
      expect(exists.rows).toHaveLength(0);
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

  it("gives an unowned code to the batch that sent it, with no conflict", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:10", items: [item(shiftId, 1)] })
      .expect(201);

    expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);
  });

  it("reports a later scan of an already-owned code back to the sender", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = item(shiftId, 1);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:20", items: [{ ...first, terminalId: "t1" }] })
      .expect(201);

    const later = {
      ...first,
      terminalId: "t2",
      scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
    };
    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:21", items: [later] })
      .expect(201);

    const conflicts = (res.body as { conflicts: { codeHash: string; winningTerminalId: string }[] })
      .conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.winningTerminalId).toBe("t1");
  });

  it("lets an earlier scan displace the incumbent, and does not report that to the sender", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const late = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:30", items: [late] })
      .expect(201);

    const earlier = {
      ...late,
      terminalId: "t2",
      scannedAt: new Date(Date.parse(late.scannedAt) - 5000).toISOString(),
    };
    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:31", items: [earlier] })
      .expect(201);

    // The sender won, so nothing comes back to it — but a conflict exists.
    expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);

    // The claim above is JSON computed by the server's application code and
    // could pass even if ownership itself were never actually flipped (see
    // Finding 2 in the review that added this block) — so assert the
    // registry's actual post-state directly: the owner must now be the
    // EARLIER terminal (t2), not the one that arrived first (t1).
    const owner = await registryOwner(tenantId, earlier.code!.codeHash);
    expect(owner?.terminalId).toBe("t2");
    expect(owner?.scannedAt.toISOString()).toBe(earlier.scannedAt);

    // The displaced scan (t1's) is deliberately never reported to any
    // sender — the cabinet (`code_conflicts`) must be the only record of it.
    expect(await conflictCount(tenantId, earlier.code!.codeHash)).toBe(1);
  });

  it("is idempotent: replaying a batch changes neither ownership nor conflict count", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:40", items: [first] })
      .expect(201);

    const body = {
      batchId: "m1:41",
      items: [
        {
          ...first,
          terminalId: "t2",
          scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
        },
      ],
    };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);
    const replay = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);

    expect((replay.body as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect((replay.body as { conflicts: unknown[] }).conflicts).toEqual([]);
  });
});
