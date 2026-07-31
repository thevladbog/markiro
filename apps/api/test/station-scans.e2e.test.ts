import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import { Logger, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { buildSscc } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { partitionName, schema, type Db } from "@markiro/db";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station-scans e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  const deviceIdsByKey = new Map<string, string>();

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
    const body = device.body as { apiKey: string; deviceId: string };
    deviceIdsByKey.set(body.apiKey, body.deviceId);
    return body.apiKey;
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
      boxId: null,
      operatorId: null,
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

  // Returns the actual persisted CONTENT of every code_conflicts row for
  // this code, not just how many there are: `rows.length` alone cannot catch
  // a transposed losing/winning pair (e.g. `losingTerminalId:
  // c.winning.terminalId`), which would leave every count-only assertion
  // green while silently inverting who lost -- see the review that added
  // this shape.
  async function conflictRows(
    tenantId: string,
    codeHash: string,
  ): Promise<
    { losingTerminalId: string | null; winningTerminalId: string | null; losingScannedAt: Date }[]
  > {
    return db
      .select({
        losingTerminalId: schema.codeConflicts.losingTerminalId,
        winningTerminalId: schema.codeConflicts.winningTerminalId,
        losingScannedAt: schema.codeConflicts.losingScannedAt,
      })
      .from(schema.codeConflicts)
      .where(
        and(
          eq(schema.codeConflicts.tenantId, tenantId),
          eq(schema.codeConflicts.codeHash, codeHash),
        ),
      );
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
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    const scan = item(shiftId, 1);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:10", items: [scan] })
      .expect(201);

    expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);
    // The response alone is application-computed JSON and could stay green
    // even if a bug wrote a row anyway (e.g. the uppercase-shiftId self-
    // conflict this guards against — see the next test): assert the
    // database directly holds none for this code either.
    expect(await conflictRows(tenantId, scan.code!.codeHash)).toEqual([]);
  });

  it("does not self-conflict a fresh code whose shiftId arrives uppercased", async () => {
    // Regression: `claim.shiftId` is whatever case the client sends, but a
    // prior incumbent read back from Postgres's `uuid` column always comes
    // back lowercased. Before the dto-level normalisation, an uppercase
    // shiftId passed z.string().uuid() and the tenant-scoped shift guard
    // (both semantic uuid comparisons) but then failed `sameScan`'s plain
    // string equality against itself — via `freshHashes` folding into
    // `wonHashes` for a code this same batch just inserted — fabricating a
    // code_conflicts row whose losing and winning sides were the same scan.
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = (await openShift(agent)).toUpperCase();
    const scan = item(shiftId, 1);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:11", items: [scan] })
      .expect(201);

    expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);
    expect(await conflictRows(tenantId, scan.code!.codeHash)).toEqual([]);
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

    const conflicts = (
      res.body as {
        conflicts: { codeHash: string; winningTerminalId: string; winningScannedAt: string }[];
      }
    ).conflicts;
    expect(conflicts).toHaveLength(1);
    // `codeHash` and `winningScannedAt` were previously never asserted here
    // -- only `winningTerminalId` -- so a bug scrambling either field could
    // pass unnoticed.
    expect(conflicts[0]!.codeHash).toBe(first.code!.codeHash);
    expect(conflicts[0]!.winningTerminalId).toBe("t1");
    expect(conflicts[0]!.winningScannedAt).toBe(first.scannedAt);
  });

  it("keeps the incumbent when a later batch ties its scannedAt exactly", async () => {
    // Regression for setWhere's strict "<" (station-scans.service.ts): a
    // tied scannedAt must NOT beat the incumbent. If that comparison were
    // ever loosened to "<=", the second (later-arriving) batch would take
    // over ownership purely by matching the timestamp, and "the same two
    // scans, replayed in either arrival order, converge on one stable
    // owner" would no longer hold.
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:60", items: [first] })
      .expect(201);

    // Exact same scannedAt, a different terminal -- a genuine tie, not a
    // duplicate resend of the same scan (terminalId differs).
    const tied = { ...first, terminalId: "t2" };
    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:61", items: [tied] })
      .expect(201);

    const owner = await registryOwner(tenantId, first.code!.codeHash);
    expect(owner?.terminalId).toBe("t1");
    expect(owner?.scannedAt.toISOString()).toBe(first.scannedAt);

    // The tied claim lost, so its own sender is told.
    const conflicts = (res.body as { conflicts: { winningTerminalId: string }[] }).conflicts;
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
    // Asserting the row's actual CONTENT, not just its count: a transposed
    // losing/winning pair in the service's mapping (e.g. `losingTerminalId:
    // c.winning.terminalId`) would invert who lost while a count-only
    // assertion stayed green.
    const rows = await conflictRows(tenantId, earlier.code!.codeHash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.losingTerminalId).toBe("t1");
    expect(rows[0]!.winningTerminalId).toBe("t2");
    expect(rows[0]!.losingScannedAt.toISOString()).toBe(late.scannedAt);
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

  /**
   * Task 10: boxes get created from their first item, box items get marked
   * displaced (both directions -- this batch's own, and the retroactive
   * one on an incumbent it displaces), and box closures both fill in the
   * box's sscc/closedAt and advance the covering sscc_blocks row's
   * consumedThroughSerial (SsccService.recordConsumedSerial's wiring).
   *
   * A fresh tenant/device/shift per test (not shared with the describe
   * above): several of these tests post the SAME deviceBoxId ("b1"/"b2")
   * from more than one terminal, and reusing state across tests would let
   * an earlier test's boxes collide with (or be silently reused by) a
   * later one.
   */
  describe("box membership (Task 10)", () => {
    let agent: ReturnType<typeof request.agent>;
    let tenantId: string;
    let apiKey: string;
    let deviceId: string;
    let shiftId: string;
    let OPERATOR_ID: string;
    let OTHER_OPERATOR_ID: string;

    // Arbitrary but well-formed shape: the DTO only requires exactly 18
    // characters (z.string().length(18)) -- it need not be a real,
    // check-digit-valid SSCC for the tests that merely assert it round-trips
    // into `boxes.sscc` unchanged.
    const SSCC = "123456789012345675";
    const ISO = "2026-07-29T09:00:00.000Z";

    beforeEach(async () => {
      agent = request.agent(app!.getHttpServer());
      tenantId = await signUpAndActivate(agent);
      apiKey = await deviceKey(agent);
      deviceId = deviceIdsByKey.get(apiKey)!;
      shiftId = await openShift(agent);

      // Real employees rows: boxes.operator_id and scan_events.operator_id
      // both carry a composite tenant FK to employees, so a non-null
      // operatorId that doesn't resolve to one would 23503 the whole batch.
      const op1 = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
      OPERATOR_ID = (op1.body as { id: string }).id;
      const op2 = await agent.post("/employees").send({ fullName: "Operator Two" }).expect(201);
      OTHER_OPERATOR_ID = (op2.body as { id: string }).id;
    });

    interface ClosureFixture {
      boxId: string;
      shiftId: string;
      terminalId: string | null;
      sscc: string;
      closedAt: string;
      operatorId: string | null;
      // Optional (Task 13 review, Finding 6): the DTO defaults an absent
      // field to null, exactly like an older station build that has not
      // learned to send these two fields yet -- so every closure fixture
      // that predates this finding is still a valid payload unchanged.
      printVerifiedAt?: string | null;
      printSkippedAt?: string | null;
    }

    function batchBody(items: ScanItemDto[], boxes: ClosureFixture[] = []) {
      return { batchId: `box-batch-${randomUUID()}`, items, boxes };
    }

    async function postRaw(body: Record<string, unknown>) {
      return request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send(body)
        .expect(201);
    }

    async function postBatchAs(terminalId: string, items: ScanItemDto[]) {
      return postRaw(batchBody(items.map((i) => ({ ...i, terminalId }))));
    }

    async function postBatch(items: ScanItemDto[]) {
      return postBatchAs("t1", items);
    }

    async function postBatchWithBoxes(items: ScanItemDto[], boxes: ClosureFixture[]) {
      return postRaw(batchBody(items, boxes));
    }

    /**
     * Builds a scan for a short, human-readable code label (e.g. "aa"),
     * expanded to the full 64-char codeHash the same way every other file
     * in this suite does (`item()`'s `` `h${n}`.padEnd(64, "0")` `` above).
     * `scannedAt` is a bare time-of-day ("10:00:05"); every scan in this
     * describe block shares the same calendar day, so tests can compare
     * "earlier" vs "later" scans without spelling out a full timestamp each
     * time.
     *
     * `terminalId` defaults to "t1" only when the caller OMITS it
     * (`undefined`) -- an explicit `null` (a device with no notion of
     * "terminal", Finding 1) must pass through unchanged, so this cannot use
     * `??`, which would treat that explicit `null` as absent too.
     */
    function scan(
      codeLabel: string,
      overrides: {
        boxId?: string | null;
        operatorId?: string | null;
        terminalId?: string | null;
        scannedAt?: string;
      } = {},
    ): ScanItemDto {
      return {
        shiftId,
        terminalId: overrides.terminalId === undefined ? "t1" : overrides.terminalId,
        raw: `RAW-${codeLabel}`,
        verdict: "ok",
        scannedAt: `2026-07-29T${overrides.scannedAt ?? "10:00:00"}.000Z`,
        code: {
          codeHash: codeLabel.padEnd(64, "0"),
          gtin14: VALID_GTIN14,
          serial: `S-${codeLabel}`,
        },
        boxId: overrides.boxId ?? null,
        operatorId: overrides.operatorId ?? null,
      };
    }

    async function boxIdFor(deviceBoxId: string): Promise<string> {
      const [row] = await db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.deviceBoxId, deviceBoxId)));
      if (!row) throw new Error(`no box row for deviceBoxId ${deviceBoxId}`);
      return row.id;
    }

    async function boxItemRows(
      forTenantId: string,
      codeLabel: string,
    ): Promise<{ boxId: string; displacedAt: Date | null }[]> {
      return db
        .select({ boxId: schema.boxItems.boxId, displacedAt: schema.boxItems.displacedAt })
        .from(schema.boxItems)
        .where(
          and(
            eq(schema.boxItems.tenantId, forTenantId),
            eq(schema.boxItems.codeHash, codeLabel.padEnd(64, "0")),
          ),
        );
    }

    async function liveItemCount(deviceBoxId: string): Promise<number> {
      const boxId = await boxIdFor(deviceBoxId);
      const rows = await db
        .select({ codeHash: schema.boxItems.codeHash })
        .from(schema.boxItems)
        .where(
          and(
            eq(schema.boxItems.tenantId, tenantId),
            eq(schema.boxItems.boxId, boxId),
            isNull(schema.boxItems.displacedAt),
          ),
        );
      return rows.length;
    }

    async function boxCount(forTenantId: string): Promise<number> {
      const rows = await db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(eq(schema.boxes.tenantId, forTenantId));
      return rows.length;
    }

    it("creates the box row from its first item, before any closure arrives", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      const rows = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sscc).toBeNull();
      expect(rows[0]!.closedAt).toBeNull();
    });

    it("fills in the serial, closedAt, and operator when the closure arrives", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      await postBatchWithBoxes(
        [],
        [
          {
            boxId: "b1",
            shiftId,
            terminalId: "t1",
            sscc: SSCC,
            closedAt: ISO,
            operatorId: OPERATOR_ID,
          },
        ],
      );
      const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(box!.sscc).toBe(SSCC);
      // Compared against the exact value sent, not just non-null: `new
      // Date()` in place of the closure's own closedAt would previously have
      // passed this assertion (cheap gap named in the review).
      expect(box!.closedAt?.toISOString()).toBe(ISO);
      // boxes.operator_id is written by the closure but was previously
      // asserted by nothing in this suite -- every closure test sent
      // `operatorId: null` (another cheap gap named in the review).
      expect(box!.operatorId).toBe(OPERATOR_ID);
    });

    // Task 13 review, Finding 6: the closure DTO now carries the device's own
    // print-verification outcome (`boxes_mirror.print_verified_at`) through
    // to the server's `boxes` row, in the SAME UPDATE that already sets
    // sscc/closedAt/operatorId.
    it("persists a non-null printVerifiedAt from the closure onto the server's boxes row", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      await postBatchWithBoxes(
        [],
        [
          {
            boxId: "b1",
            shiftId,
            terminalId: "t1",
            sscc: SSCC,
            closedAt: ISO,
            operatorId: OPERATOR_ID,
            printVerifiedAt: ISO,
          },
        ],
      );
      const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(box!.printVerifiedAt?.toISOString()).toBe(ISO);
      expect(box!.printSkippedAt).toBeNull();
    });

    // The counterpart: a closure whose printVerifiedAt/printSkippedAt are
    // both absent (the ordinary case -- the operator has usually not yet
    // resolved the prompt by the time the closure is acked) must not
    // manufacture either timestamp out of nothing.
    it("leaves printVerifiedAt/printSkippedAt null when the closure carries neither", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      await postBatchWithBoxes(
        [],
        [{ boxId: "b1", shiftId, terminalId: "t1", sscc: SSCC, closedAt: ISO, operatorId: null }],
      );
      const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(box!.printVerifiedAt).toBeNull();
      expect(box!.printSkippedAt).toBeNull();
    });

    // A later delivery of the SAME closure, now carrying a resolved outcome
    // that was still unresolved the first time -- e.g. the device acked the
    // closure before the operator answered the print-verification prompt.
    // The primary sscc/closedAt/operatorId write deliberately refuses to
    // touch an already-closed row, but the print-outcome fields must still
    // be allowed to land (see the service's own comment on why this is
    // scoped safely by sscc equality).
    it("accepts a late-arriving printVerifiedAt for a box the closure already closed earlier", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      await postBatchWithBoxes(
        [],
        [{ boxId: "b1", shiftId, terminalId: "t1", sscc: SSCC, closedAt: ISO, operatorId: null }],
      );
      let [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(box!.printVerifiedAt).toBeNull();

      // Resent under a fresh batchId (a real device would not resend the
      // very same batchId once it has moved on) with the SAME sscc, now
      // carrying the resolved outcome.
      await postBatchWithBoxes(
        [],
        [
          {
            boxId: "b1",
            shiftId,
            terminalId: "t1",
            sscc: SSCC,
            closedAt: ISO,
            operatorId: null,
            printVerifiedAt: ISO,
          },
        ],
      );
      [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
      expect(box!.printVerifiedAt?.toISOString()).toBe(ISO);
      // The original closure fields are untouched by this second delivery.
      expect(box!.closedAt?.toISOString()).toBe(ISO);
      expect(box!.sscc).toBe(SSCC);
    });

    it("records the operator on the scan event", async () => {
      // Two items, two different operators: a single-item batch would pass
      // even if the production code wrote the BATCH's first operatorId onto
      // every scan event instead of each item's own (see dto.ts's comment
      // on why this must be per scan, not per batch).
      await postBatch([
        scan("aa", { boxId: "b1", operatorId: OPERATOR_ID }),
        scan("bb", { boxId: "b1", operatorId: OTHER_OPERATOR_ID }),
      ]);
      const evs = await db
        .select({ raw: schema.scanEvents.raw, operatorId: schema.scanEvents.operatorId })
        .from(schema.scanEvents)
        .where(eq(schema.scanEvents.tenantId, tenantId));
      const byRaw = new Map(evs.map((e) => [e.raw, e.operatorId]));
      expect(byRaw.get("RAW-aa")).toBe(OPERATOR_ID);
      expect(byRaw.get("RAW-bb")).toBe(OTHER_OPERATOR_ID);
    });

    it("marks the later terminal's box item displaced when an earlier scan wins", async () => {
      await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
      await postBatchAs("t1", [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
      const items = await boxItemRows(tenantId, "aa");
      const displaced = items.filter((i) => i.displacedAt !== null);
      expect(displaced).toHaveLength(1);
      expect(displaced[0]!.boxId).toBe(await boxIdFor("b2"));
    });

    it("marks nothing when a batch is clean", async () => {
      await postBatch([scan("aa", { boxId: "b1" })]);
      const items = await boxItemRows(tenantId, "aa");
      expect(items.every((i) => i.displacedAt === null)).toBe(true);
    });

    it("counts a box's contents excluding displaced items", async () => {
      await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
      await postBatchAs("t1", [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
      expect(await liveItemCount("b2")).toBe(0);
      expect(await liveItemCount("b1")).toBe(1);
    });

    it("is idempotent: replaying a batch changes neither boxes nor items", async () => {
      const body = batchBody([scan("aa", { boxId: "b1" })]);
      await postRaw(body);
      await postRaw(body);
      expect(await boxCount(tenantId)).toBe(1);
      expect((await boxItemRows(tenantId, "aa")).length).toBe(1);
    });

    // Beyond the brief's own cases: the batch that WINS ownership can also
    // be the one whose OWN box item must be marked -- when its scan loses
    // ownership to an EARLIER one already recorded by a previous batch.
    // None of the cases above reach this branch (the earlier-scan winner is
    // always this same batch's own claim there); this one arrives second
    // with the LATER scannedAt, so its own newly-inserted box item is the
    // one that must come back displaced.
    it("marks its own box item displaced when its scan loses to an already-recorded earlier one", async () => {
      await postBatchAs("t1", [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
      await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
      const items = await boxItemRows(tenantId, "aa");
      const displaced = items.filter((i) => i.displacedAt !== null);
      expect(displaced).toHaveLength(1);
      expect(displaced[0]!.boxId).toBe(await boxIdFor("b2"));
    });

    // Beyond the brief's own idempotency case (which replays the identical
    // batchId and so never re-executes the transaction body at all): a
    // device that lost its own record of what it already sent can resend
    // the SAME item under a FRESH batchId (the exact scenario `codes`' own
    // ON CONFLICT DO NOTHING already guards against -- see
    // station-scans.service.ts). Without box_items' ON CONFLICT DO NOTHING,
    // this second, differently-keyed batch would 500 on a duplicate-key
    // violation instead of being a clean no-op.
    it("keeps one box_items row when the same scan is redelivered under a fresh batchId", async () => {
      const item = scan("aa", { boxId: "b1" });
      await postRaw(batchBody([item]));
      await postRaw(batchBody([item]));
      expect(await boxCount(tenantId)).toBe(1);
      expect((await boxItemRows(tenantId, "aa")).length).toBe(1);
    });

    // Beyond the brief's own cases: proves SsccService.recordConsumedSerial
    // is actually wired into the closure path end-to-end, not merely
    // present and unreachable -- the concern the parent task calls out
    // explicitly ("Call it for every closure this batch applies").
    it("advances the covering sscc_blocks row's consumedThroughSerial when a closure names a real serial", async () => {
      const device = await agent.post("/station-devices").send({ name: "Box device" }).expect(201);
      const deviceId = (device.body as { deviceId: string }).deviceId;

      const prefix = "800000001";
      const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 20);
      const sscc = buildSscc(0, prefix, block.fromSerial + 3);

      await postBatch([scan("aa", { boxId: "b1" })]);
      await postBatchWithBoxes(
        [],
        [{ boxId: "b1", shiftId, terminalId: "t1", sscc, closedAt: ISO, operatorId: null }],
      );

      const [row] = await db
        .select({ consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial })
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      expect(row!.consumedThroughSerial).toBe(block.fromSerial + 3);
    });

    // Finding 1: `boxes_device_box_uq` is a plain UNIQUE over a NULLABLE
    // terminal_id -- Postgres treats every NULL as distinct from every
    // other in a plain unique index, so `ON CONFLICT` would never fire for
    // a null-terminal device, and each batch would insert a NEW box row
    // instead of resolving to the one already open. Two batches (not the
    // three in the review's failure narrative) are enough to prove it: the
    // second batch's insert either collides (fixed) or silently creates a
    // second row (the bug).
    it(
      "resolves a null-terminal box drained across two batches to one row, and closes it " +
        "without error (Finding 1)",
      async () => {
        await postRaw(batchBody([scan("aa", { boxId: "b1", terminalId: null })]));
        await postRaw(batchBody([scan("bb", { boxId: "b1", terminalId: null })]));

        expect(await boxCount(tenantId)).toBe(1);
        const aaRows = await boxItemRows(tenantId, "aa");
        const bbRows = await boxItemRows(tenantId, "bb");
        expect(aaRows).toHaveLength(1);
        expect(bbRows).toHaveLength(1);
        // Both items landed in the SAME box row, not two different ones.
        expect(aaRows[0]!.boxId).toBe(bbRows[0]!.boxId);

        // Closes cleanly: before the fix, the closure UPDATE (matched only
        // on tenant_id/device_box_id at the time, or even on all four
        // columns post-Finding-3) would have found more than one row for
        // deviceBoxId "b1" and either written the same sscc to both --
        // raising boxes_tenant_sscc_uq's 23505 -- or, post-Finding-3,
        // failed the "matched exactly 1 row" assertion outright.
        await postBatchWithBoxes(
          [],
          [{ boxId: "b1", shiftId, terminalId: null, sscc: SSCC, closedAt: ISO, operatorId: null }],
        );
        const [box] = await db
          .select()
          .from(schema.boxes)
          .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.deviceBoxId, "b1")));
        expect(box!.sscc).toBe(SSCC);
      },
    );

    // Finding 2: the retroactive displacement UPDATE used to sit inside
    // `if (boxed.length > 0)`, but the DTO explicitly blesses `boxId: null`
    // as an ordinary unboxed scan (e.g. one taken at a verification
    // station). t2 boxes an item as the (later, losing) incumbent; t1 then
    // WINS ownership with an earlier, UNBOXED scan of the same code. Before
    // the fix, `boxed.length === 0` for t1's batch skipped the retroactive
    // block entirely, leaving b2's item live even though b2's own scan no
    // longer owns the code.
    it(
      "retroactively displaces an incumbent's box item when the winning claim is itself " +
        "unboxed (Finding 2)",
      async () => {
        await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:05" })]);
        await postBatchAs("t1", [scan("aa", { boxId: null, scannedAt: "10:00:00" })]);

        // t1's earlier, unboxed scan now owns "aa" -- b2 (t2's box) must no
        // longer count it.
        expect(await liveItemCount("b2")).toBe(0);
        const items = await boxItemRows(tenantId, "aa");
        const b2Id = await boxIdFor("b2");
        const b2Item = items.find((i) => i.boxId === b2Id);
        // Assert the row EXISTS before asserting anything about its
        // `displacedAt`: optional chaining on a missing row yields
        // `undefined`, which `.not.toBeNull()` is satisfied by just as
        // vacuously as a real timestamp -- so without this, a bug that made
        // the retroactive UPDATE match zero rows (or a bug that deleted the
        // row outright) would pass this assertion right alongside a genuine
        // fix (cheap gap named in the review).
        expect(b2Item).toBeDefined();
        expect(b2Item!.displacedAt).not.toBeNull();
      },
    );

    // Finding 3: `boxes_device_box_uq` scopes a device box id to (shift,
    // terminal) precisely because the bare string is not unique on its own.
    // Two terminals in the SAME shift both call their (different) box "b1"
    // -- closing one must not touch the other, which is exactly what a
    // closure matched on `(tenant_id, device_box_id)` alone could not tell
    // apart.
    it("closes each terminal's own box when two terminals share a shift and deviceBoxId (Finding 3)", async () => {
      await postBatchAs("t1", [scan("aa", { boxId: "b1" })]);
      await postBatchAs("t2", [scan("bb", { boxId: "b1" })]);
      expect(await boxCount(tenantId)).toBe(2);

      const ssccT1 = SSCC;
      const ssccT2 = "223456789012345670";
      await postBatchWithBoxes(
        [],
        [{ boxId: "b1", shiftId, terminalId: "t1", sscc: ssccT1, closedAt: ISO, operatorId: null }],
      );
      await postBatchWithBoxes(
        [],
        [{ boxId: "b1", shiftId, terminalId: "t2", sscc: ssccT2, closedAt: ISO, operatorId: null }],
      );

      const rows = await db
        .select({ terminalId: schema.boxes.terminalId, sscc: schema.boxes.sscc })
        .from(schema.boxes)
        .where(eq(schema.boxes.tenantId, tenantId));
      expect(rows).toHaveLength(2);
      const byTerminal = new Map(rows.map((r) => [r.terminalId, r.sscc]));
      expect(byTerminal.get("t1")).toBe(ssccT1);
      expect(byTerminal.get("t2")).toBe(ssccT2);
    });

    // Regression for the defect this task fixes: the closure UPDATE used to
    // also scope to `closedAt IS NULL` and throw a bare `Error` (-> 500) on
    // any other row count. A batch that errors is retried under the SAME
    // batchId forever (sync.ts's own doc comment on the device side), so a
    // closure redelivered under a FRESH batchId -- the device having lost
    // its own record that this one already landed, exactly the scenario
    // `codes`/`box_items`'s own ON CONFLICT DO NOTHING already guard
    // against -- used to match zero rows (the box already closed) and throw,
    // wedging the device's queue permanently over its own documented threat
    // model. Must now be a clean no-op, leaving the box closed with the
    // SAME serial.
    it(
      "leaves a box closed with the same serial when its closure is redelivered under a " +
        "fresh batchId, without erroring",
      async () => {
        await postBatch([scan("aa", { boxId: "b1" })]);
        const closure: ClosureFixture = {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: SSCC,
          closedAt: ISO,
          operatorId: OPERATOR_ID,
        };
        await postBatchWithBoxes([], [closure]);
        // Same closure fields, a FRESH batchId -- postBatchWithBoxes ->
        // postRaw asserts 201, so a regression back to the bare `throw new
        // Error` (-> 500) fails this test outright.
        await postBatchWithBoxes([], [closure]);

        const rows = await db
          .select()
          .from(schema.boxes)
          .where(eq(schema.boxes.tenantId, tenantId));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.sscc).toBe(SSCC);
        expect(rows[0]!.closedAt?.toISOString()).toBe(ISO);
        expect(await boxCount(tenantId)).toBe(1);
      },
    );

    // Regression: a box with zero items has no row at all (a box row is
    // created from its FIRST item, never the closure -- see the box-upsert
    // in station-scans.service.ts), so its closure's four-column match finds
    // nothing to update. That used to be indistinguishable from any other
    // row-count mismatch and threw; it must now be a no-op, not a 500.
    it("does not error when a closure arrives for a box that has no items", async () => {
      // The warn log is the operator's ONLY signal that a real closure was
      // dropped on the floor -- a 201 response alone (asserted below via
      // postBatchWithBoxes) would stay green even if this logging silently
      // stopped firing, so assert it directly.
      const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      try {
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "empty-box",
              shiftId,
              terminalId: "t1",
              sscc: SSCC,
              closedAt: ISO,
              operatorId: null,
            },
          ],
        );
        expect(await boxCount(tenantId)).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty-box"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    // shiftId's presence in the closure match was previously undiscriminated
    // by this suite: every other test here uses exactly one shift, so a
    // closure match missing `eq(boxes.shiftId, closure.shiftId)` would still
    // leave every existing test green. Two shifts reusing the same terminal
    // AND deviceBoxId ("b1") close independently here -- proving shiftId is
    // actually load-bearing in the match, the same way Finding 3's test
    // proves terminalId is.
    it(
      "closes only its own shift's box when two shifts reuse the same terminal and " +
        "deviceBoxId",
      async () => {
        // A second, independent product -- `openShift(agent)` with no
        // `productId` would call `createActiveProduct`, which always sends
        // the SAME `VALID_GTIN14`, and gtin14 is unique per tenant (see
        // products.e2e.test.ts), so a bare second `openShift(agent)` call in
        // an already-provisioned tenant 409s. `GTIN14_WIDGET_A` is the same
        // valid, distinct fixture products.e2e.test.ts uses for exactly
        // this reason.
        const productB = await agent
          .post("/products")
          .send({
            name: "Cola B",
            gtin: "04006382000009",
            productGroup: "Beverages",
            boxCapacity: 10,
            palletCapacity: 5,
          })
          .expect(201);
        const shiftB = await openShift(agent, (productB.body as { id: string }).id);

        await postBatch([scan("aa", { boxId: "b1" })]);
        await postRaw(batchBody([{ ...scan("bb", { boxId: "b1" }), shiftId: shiftB }]));
        expect(await boxCount(tenantId)).toBe(2);

        const ssccA = SSCC;
        const ssccB = "223456789012345670";
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: "t1",
              sscc: ssccA,
              closedAt: ISO,
              operatorId: null,
            },
          ],
        );
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId: shiftB,
              terminalId: "t1",
              sscc: ssccB,
              closedAt: ISO,
              operatorId: null,
            },
          ],
        );

        const rows = await db
          .select({ shiftId: schema.boxes.shiftId, sscc: schema.boxes.sscc })
          .from(schema.boxes)
          .where(eq(schema.boxes.tenantId, tenantId));
        expect(rows).toHaveLength(2);
        const byShift = new Map(rows.map((r) => [r.shiftId, r.sscc]));
        expect(byShift.get(shiftId)).toBe(ssccA);
        expect(byShift.get(shiftB)).toBe(ssccB);
      },
    );

    // Nothing in this suite previously sent a batch carrying TWO closures,
    // so recordConsumedSerial's call being hoisted outside the closures loop
    // (applying only the LAST closure's sscc) went uncaught. Two DIFFERENT
    // devices' blocks, each closed in the SAME batch, makes that visible: if
    // only the last-processed closure (sorted by boxId -- "b1" then "b2")
    // took effect, deviceA's block would stay unconsumed while deviceB's
    // correctly advanced.
    it(
      "advances both sscc_blocks rows' consumedThroughSerial when one batch carries two " +
        "closures",
      async () => {
        const deviceA = await agent
          .post("/station-devices")
          .send({ name: "Box device A" })
          .expect(201);
        const deviceAId = (deviceA.body as { deviceId: string }).deviceId;
        const deviceB = await agent
          .post("/station-devices")
          .send({ name: "Box device B" })
          .expect(201);
        const deviceBId = (deviceB.body as { deviceId: string }).deviceId;

        const prefixA = "800000001";
        const prefixB = "800000002";
        const blockA = await app!.get(SsccService).allocate(tenantId, prefixA, 0, deviceAId, 20);
        const blockB = await app!.get(SsccService).allocate(tenantId, prefixB, 0, deviceBId, 20);
        const ssccA = buildSscc(0, prefixA, blockA.fromSerial + 3);
        const ssccB = buildSscc(0, prefixB, blockB.fromSerial + 7);

        await postBatch([scan("aa", { boxId: "b1" }), scan("bb", { boxId: "b2" })]);
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: "t1",
              sscc: ssccA,
              closedAt: ISO,
              operatorId: null,
            },
            {
              boxId: "b2",
              shiftId,
              terminalId: "t1",
              sscc: ssccB,
              closedAt: ISO,
              operatorId: null,
            },
          ],
        );

        const rows = await db
          .select({
            deviceId: schema.ssccBlocks.deviceId,
            consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial,
          })
          .from(schema.ssccBlocks)
          .where(eq(schema.ssccBlocks.tenantId, tenantId));
        const byDevice = new Map(rows.map((r) => [r.deviceId, r.consumedThroughSerial]));
        expect(byDevice.get(deviceAId)).toBe(blockA.fromSerial + 3);
        expect(byDevice.get(deviceBId)).toBe(blockB.fromSerial + 7);
      },
    );

    // Finding 17: `recordConsumedSerial` must run for EVERY closure this
    // batch carries, matched to a box row or not -- a box closed with zero
    // items is still a case where a PHYSICAL box was closed and a label
    // carrying this serial was printed and applied; only the server's own
    // bookkeeping (the box row) failed to find a match. Before the fix, the
    // `continue` on the zero-row path skipped `recordConsumedSerial`
    // entirely for this input, silently forgetting the consumption and
    // reopening the reprint hazard that method exists to close.
    it(
      "advances the covering sscc_blocks row's consumedThroughSerial for a closure whose box " +
        "row does not exist (Finding 17)",
      async () => {
        const device = await agent
          .post("/station-devices")
          .send({ name: "Ghost box device" })
          .expect(201);
        const deviceId = (device.body as { deviceId: string }).deviceId;

        const prefix = "800000003";
        const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 20);
        const sscc = buildSscc(0, prefix, block.fromSerial + 5);

        // No items posted for "empty-box" at all -- its box row is never
        // created (a box row is created from its FIRST item, never the
        // closure -- see the box-upsert in station-scans.service.ts).
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "empty-box",
              shiftId,
              terminalId: "t1",
              sscc,
              closedAt: ISO,
              operatorId: null,
            },
          ],
        );
        expect(await boxCount(tenantId)).toBe(0);

        const [row] = await db
          .select({ consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial })
          .from(schema.ssccBlocks)
          .where(
            and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
          );
        expect(row!.consumedThroughSerial).toBe(block.fromSerial + 5);
      },
    );

    // Finding 18: `closedAt IS NULL` is back in the closure match. Without
    // it, a second closure sharing the same box IDENTITY (tenant, shift,
    // terminal, deviceBoxId) but carrying a DIFFERENT sscc would match the
    // already-closed row and silently overwrite its serial -- an in-place
    // UPDATE that `boxes_tenant_sscc_uq` cannot catch, since there is no
    // second row to collide with. The reachable path: a device that lost its
    // local database restarts its box counter at "b1" inside the SAME
    // still-open shift and terminal; its box upsert earlier in the
    // transaction no-ops onto this same old, already-closed row.
    it(
      "leaves the original serial intact when a second closure for the same box carries a " +
        "different serial (Finding 18)",
      async () => {
        await postBatch([scan("aa", { boxId: "b1" })]);
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: "t1",
              sscc: SSCC,
              closedAt: ISO,
              operatorId: OPERATOR_ID,
            },
          ],
        );

        // Same box identity, a DIFFERENT serial and a later closedAt/operator
        // -- must be a no-op against the already-closed row, not a rewrite.
        const differentSscc = "223456789012345670";
        const laterIso = "2026-07-29T09:30:00.000Z";
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: "t1",
              sscc: differentSscc,
              closedAt: laterIso,
              operatorId: OTHER_OPERATOR_ID,
            },
          ],
        );

        const rows = await db
          .select()
          .from(schema.boxes)
          .where(eq(schema.boxes.tenantId, tenantId));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.sscc).toBe(SSCC);
        expect(rows[0]!.closedAt?.toISOString()).toBe(ISO);
        expect(rows[0]!.operatorId).toBe(OPERATOR_ID);
      },
    );

    // No test previously rolled a closure back, so dropping
    // `recordConsumedSerial`'s `tx` argument (falling back to `this.db`,
    // which would commit outside the ingest transaction) would leave this
    // suite green. Forces a genuine mid-transaction failure AFTER a closure
    // has already advanced a block's cursor, via a SECOND closure in the
    // SAME batch that collides on `boxes_tenant_sscc_uq` (same tenant, same
    // sscc, a DIFFERENT box row) -- and proves the cursor advance rolled
    // back along with everything else.
    it(
      "rolls back a closure's consumedThroughSerial advance when a later statement in the " +
        "same batch fails (transaction wiring)",
      async () => {
        const device = await agent
          .post("/station-devices")
          .send({ name: "Rollback device" })
          .expect(201);
        const deviceId = (device.body as { deviceId: string }).deviceId;
        const prefix = "800000004";
        const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 20);
        const sscc = buildSscc(0, prefix, block.fromSerial + 2);

        await postBatch([scan("aa", { boxId: "b1" }), scan("bb", { boxId: "b2" })]);

        // Sorted by boxId ("b1" then "b2"): b1's closure applies first
        // within the transaction and advances the block's cursor; b2's
        // closure then tries to write the SAME sscc to a DIFFERENT box row,
        // which `boxes_tenant_sscc_uq` forbids -- raising a 23505 that must
        // roll back the whole transaction, including b1's cursor advance.
        await request(app!.getHttpServer())
          .post("/station/scans")
          .set("x-api-key", apiKey)
          .send(
            batchBody(
              [],
              [
                { boxId: "b1", shiftId, terminalId: "t1", sscc, closedAt: ISO, operatorId: null },
                { boxId: "b2", shiftId, terminalId: "t1", sscc, closedAt: ISO, operatorId: null },
              ],
            ),
          )
          .expect(500);

        // b1 must still be OPEN -- if the transaction had committed anything
        // at all, b1's closedAt would be set.
        const [boxRow] = await db
          .select({ closedAt: schema.boxes.closedAt })
          .from(schema.boxes)
          .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.deviceBoxId, "b1")));
        expect(boxRow!.closedAt).toBeNull();

        // The assertion that actually distinguishes `tx` from `this.db`: if
        // `recordConsumedSerial` had used `this.db`, b1's advance would have
        // committed immediately and survived b2's later rollback.
        const [blockRow] = await db
          .select({ consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial })
          .from(schema.ssccBlocks)
          .where(
            and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
          );
        expect(blockRow!.consumedThroughSerial).toBeNull();
      },
    );

    // Task 4: applying "undo" exceptions inside the same sync-batch
    // transaction. Nested here (rather than a fresh top-level describe) so
    // it inherits this describe's own beforeEach (agent/tenantId/apiKey/
    // shiftId) and its scan/postBatch/postBatchAs/postRaw/boxIdFor/
    // registryOwner helpers, instead of re-deriving a fresh fixture shape.
    describe("exceptions", () => {
      it("undo releases the code from the registry and marks the box item removed", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" })]);
        const boxId = await boxIdFor("b1");
        const codeHash = "aa".padEnd(64, "0");

        const undoRes = await postRaw({
          batchId: `undo-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "undo",
              // The real device-local box id, exactly as the station's own
              // sync protocol sends it (see ScanItemDto.boxId and the
              // box-closures loop's own `boxId` a few hundred lines above in
              // station-scans.service.ts) -- deliberately NOT the resolved
              // server `boxes.id` UUID `boxIdFor` returns below. Proves the
              // resolution step inside `applyExceptions` actually resolves a
              // raw device string, rather than merely accepting an
              // already-resolved UUID by luck (the bug this fix closes: a
              // real device sending "b1" here used to raise Postgres 22P02,
              // "invalid input syntax for type uuid").
              boxId: "b1",
              codeHash,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: null,
              occurredAt: new Date().toISOString(),
            },
          ],
        });
        expect(undoRes.body.applied).toBe(0);

        const [registryRow] = await db
          .select()
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              eq(schema.codeRegistry.codeHash, codeHash),
            ),
          );
        expect(registryRow).toBeUndefined();

        const [itemRow] = await db
          .select()
          .from(schema.boxItems)
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxItems.boxId, boxId),
              eq(schema.boxItems.codeHash, codeHash),
            ),
          );
        expect(itemRow?.removedAt).not.toBeNull();

        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRow?.kind).toBe("undo");
        expect(auditRow?.terminalId).toBe(deviceId);
        // The audit row's boxId is the RESOLVED server UUID, not the raw
        // "b1" the request carried -- proving the resolution step's output
        // actually flows into the box_exceptions write (and not just into
        // the box_items update above).
        expect(auditRow?.boxId).toBe(boxId);
      });

      it("reactivates box membership when the released code is scanned again later", async () => {
        const codeHash = "aa".padEnd(64, "0");
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1", scannedAt: "10:00:00" })]);
        await postRaw({
          batchId: `undo-rescan-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "undo",
              boxId: "b1",
              codeHash,
              shiftId,
              terminalId: "spoofed-terminal",
              operatorId: null,
              reason: null,
              occurredAt: "2026-07-29T10:00:01.000Z",
            },
          ],
        });
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1", scannedAt: "10:00:02" })]);

        expect((await registryOwner(tenantId, codeHash))?.terminalId).toBe(deviceId);
        const [membership] = await db
          .select({ removedAt: schema.boxItems.removedAt, addedAt: schema.boxItems.addedAt })
          .from(schema.boxItems)
          .where(
            and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.codeHash, codeHash)),
          );
        expect(membership?.removedAt).toBeNull();
        expect(membership?.addedAt.toISOString()).toBe("2026-07-29T10:00:02.000Z");
      });

      // t1 claims "aa" first (a LATER scannedAt); t2's own later-arriving but
      // EARLIER-scannedAt claim then wins ownership (06b: earlier scannedAt
      // wins) and retroactively marks t1's own box item displaced -- the
      // exact scenario "marks its own box item displaced..." above already
      // exercises. code_registry now belongs to t2, not the original t1.
      it("undo on a code already displaced to another terminal is a harmless no-op", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1", scannedAt: "10:00:05" })]);
        await postBatchAs("t2", [scan("aa", { boxId: "b2", scannedAt: "10:00:00" })]);

        const codeHash = "aa".padEnd(64, "0");
        const before = await registryOwner(tenantId, codeHash);
        expect(before?.terminalId).toBe("t2");

        await postRaw({
          batchId: `undo-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "undo",
              // Raw device-local id (see the previous test's comment) --
              // "b1" resolves to t1's own box, which is exactly the box this
              // no-op case must resolve successfully; the no-op comes from
              // `releaseCode`'s own WHERE (terminal no longer owns the
              // code), not from a resolution failure.
              boxId: "b1",
              codeHash,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: null,
              occurredAt: new Date().toISOString(),
            },
          ],
        });

        const after = await registryOwner(tenantId, codeHash);
        expect(after?.terminalId).toBe("t2");
        expect(after?.scannedAt).toEqual(before?.scannedAt);
      });

      it("redelivering the same undo exception twice is idempotent", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" })]);
        const codeHash = "aa".padEnd(64, "0");

        const body = {
          batchId: `undo-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "undo",
              // Raw device-local id -- see the first test's comment.
              boxId: "b1",
              codeHash,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: null,
              occurredAt: new Date().toISOString(),
            },
          ],
        };

        const first = await postRaw(body);
        expect(first.body.alreadyApplied).toBe(false);
        const second = await postRaw(body);
        expect(second.body.alreadyApplied).toBe(true);

        const auditRows = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRows).toHaveLength(1);
      });

      // Critical-finding regression: a device's boxId is device-local and can
      // fail to resolve to any server `boxes` row at all -- a genuinely
      // stale/unknown id, or a race with the box's own first item. This must
      // be a logged no-op, never a throw: throwing here 500s the whole batch,
      // and per this file's own established retry semantics (see the
      // box-closures loop's "Zero rows is..." comment in
      // station-scans.service.ts) the device resends a failing batch under
      // the SAME batchId forever, wedging that device's queue permanently --
      // exactly the failure this fix exists to prevent. No `box_exceptions`
      // audit row either: `box_exceptions.box_id` carries a NOT NULL foreign
      // key onto `boxes(tenant_id, id)` (packages/db/src/schema/platform.ts),
      // so a row naming an unresolved box could never be written even if the
      // code tried.
      it(
        "logs and no-ops an exception whose boxId never resolves to a box row, without " +
          "erroring or writing an audit row",
        async () => {
          const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
          try {
            const res = await postRaw({
              batchId: `undo-test-${randomUUID()}`,
              items: [],
              boxes: [],
              exceptions: [
                {
                  kind: "undo",
                  boxId: "ghost-box",
                  codeHash: "aa".padEnd(64, "0"),
                  shiftId,
                  terminalId: "t1",
                  operatorId: null,
                  reason: null,
                  occurredAt: new Date().toISOString(),
                },
              ],
            });
            expect(res.body.applied).toBe(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ghost-box"));

            const auditRows = await db
              .select()
              .from(schema.boxExceptions)
              .where(eq(schema.boxExceptions.tenantId, tenantId));
            expect(auditRows).toHaveLength(0);
          } finally {
            warnSpy.mockRestore();
          }
        },
      );

      // Task 5: "clear" empties a still-open box (every active item's code
      // released and the item itself marked removed) WITHOUT closing it --
      // that's the difference from "disassemble" (Task 6), which does the
      // same emptying but only to an already-closed box.
      it("clear removes every active item from a still-open box, closes none of it", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" }), scan("bb", { boxId: "b1" })]);
        const boxId = await boxIdFor("b1");
        const codeHash1 = "aa".padEnd(64, "0");
        const codeHash2 = "bb".padEnd(64, "0");

        const res = await postRaw({
          batchId: `clear-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "clear",
              // Raw device-local id (see the "undo" tests' own comment
              // above) -- proves this branch also consumes the resolution
              // step's `resolvedBoxId`, not `ex.boxId` directly.
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: null,
              occurredAt: new Date().toISOString(),
            },
          ],
        });
        expect(res.body.applied).toBe(0);

        const items = await db
          .select()
          .from(schema.boxItems)
          .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
        expect(items).toHaveLength(2);
        expect(items.every((i) => i.removedAt !== null)).toBe(true);

        const registryRows = await db
          .select()
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              inArray(schema.codeRegistry.codeHash, [codeHash1, codeHash2]),
            ),
          );
        expect(registryRows).toHaveLength(0);

        const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        expect(box?.closedAt).toBeNull();
        expect(box?.disassembledAt).toBeNull();

        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRow?.kind).toBe("clear");
        // Same proof as the "undo" test above: the audit row's boxId is the
        // RESOLVED server UUID, not the raw "b1" the request carried.
        expect(auditRow?.boxId).toBe(boxId);
      });

      it("clear on an already-closed box is a no-op (guarded by closedAt IS NULL)", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" })]);
        const codeHash = "aa".padEnd(64, "0");
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: deviceId,
              sscc: SSCC,
              closedAt: ISO,
              operatorId: OPERATOR_ID,
            },
          ],
        );
        const boxId = await boxIdFor("b1");

        await postRaw({
          batchId: `clear-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "clear",
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: null,
              occurredAt: new Date().toISOString(),
            },
          ],
        });

        // Item untouched -- the box was already closed, so the guard
        // (`closedAt IS NULL`) must have refused to act at all.
        const [itemRow] = await db
          .select()
          .from(schema.boxItems)
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxItems.boxId, boxId),
              eq(schema.boxItems.codeHash, codeHash),
            ),
          );
        expect(itemRow?.removedAt).toBeNull();

        const registryRow = await registryOwner(tenantId, codeHash);
        expect(registryRow).toBeDefined();

        const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        expect(box?.closedAt?.toISOString()).toBe(ISO);
        expect(box?.disassembledAt).toBeNull();

        // Still a recorded attempt (same pattern as every other kind/no-op
        // combination in this describe block) even though nothing else
        // changed.
        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRow?.kind).toBe("clear");
      });

      // Task 6: "disassemble" retires an ALREADY-CLOSED box (every active
      // item's code released and the item itself marked removed, exactly
      // like "clear" above) -- but unlike "clear", it acts only on a box
      // that IS closed, and it additionally marks the box itself
      // `disassembledAt` so it drops out of any "active" listing. The
      // `sscc` string is deliberately left untouched: it stays on the row
      // as a historical record of what was printed and applied to the
      // physical box; only `disassembledAt` marks the box retired (the
      // guarantee that the sscc itself is never reissued lives entirely in
      // `SsccService.allocate`'s counter, which always moves forward and
      // never reads `boxes` -- see sscc.e2e.test.ts's own lock-down test).
      it("disassemble retires a closed box: items released, box excluded from active listing", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" }), scan("bb", { boxId: "b1" })]);
        const codeHash1 = "aa".padEnd(64, "0");
        const codeHash2 = "bb".padEnd(64, "0");
        await postBatchWithBoxes(
          [],
          [
            {
              boxId: "b1",
              shiftId,
              terminalId: deviceId,
              sscc: SSCC,
              closedAt: ISO,
              operatorId: OPERATOR_ID,
            },
          ],
        );
        const boxId = await boxIdFor("b1");

        const res = await postRaw({
          batchId: `disassemble-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "disassemble",
              // Raw device-local id (same proof as "undo"/"clear" above) --
              // proves this branch also consumes the resolution step's
              // `resolvedBoxId`, not `ex.boxId` directly.
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: "packed for wrong customer",
              occurredAt: new Date().toISOString(),
            },
          ],
        });
        expect(res.body.applied).toBe(0);

        const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        expect(box?.disassembledAt).not.toBeNull();
        // The sscc string itself is kept -- historical record; only
        // disassembledAt marks retirement.
        expect(box?.sscc).toBe(SSCC);

        const items = await db
          .select()
          .from(schema.boxItems)
          .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
        expect(items).toHaveLength(2);
        expect(items.every((i) => i.removedAt !== null)).toBe(true);

        const registryRows = await db
          .select()
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              inArray(schema.codeRegistry.codeHash, [codeHash1, codeHash2]),
            ),
          );
        expect(registryRows).toHaveLength(0);

        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRow?.kind).toBe("disassemble");
        // Same proof as the "undo"/"clear" tests above: the audit row's
        // boxId is the RESOLVED server UUID, not the raw "b1" the request
        // carried.
        expect(auditRow?.boxId).toBe(boxId);
      });

      it("disassemble on a still-open box is a no-op (guarded by closedAt IS NOT NULL)", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" })]);
        const codeHash = "aa".padEnd(64, "0");
        const boxId = await boxIdFor("b1");

        await postRaw({
          batchId: `disassemble-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "disassemble",
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: "packed for wrong customer",
              occurredAt: new Date().toISOString(),
            },
          ],
        });

        // Untouched -- the box was never closed, so the guard (`closedAt
        // IS NOT NULL`) must have refused to act at all: reaching into a
        // still-open box is "clear"'s job, not "disassemble"'s.
        const [itemRow] = await db
          .select()
          .from(schema.boxItems)
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxItems.boxId, boxId),
              eq(schema.boxItems.codeHash, codeHash),
            ),
          );
        expect(itemRow?.removedAt).toBeNull();

        const registryRow = await registryOwner(tenantId, codeHash);
        expect(registryRow).toBeDefined();

        const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        expect(box?.closedAt).toBeNull();
        expect(box?.disassembledAt).toBeNull();

        // Still a recorded attempt (same pattern as every other kind/no-op
        // combination in this describe block) even though nothing else
        // changed.
        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(eq(schema.boxExceptions.tenantId, tenantId));
        expect(auditRow?.kind).toBe("disassemble");
      });

      it(
        "disassemble twice on the same box is a no-op the second time (guarded by " +
          "disassembledAt IS NULL)",
        async () => {
          await postBatchAs(deviceId, [scan("aa", { boxId: "b1" })]);
          await postBatchWithBoxes(
            [],
            [
              {
                boxId: "b1",
                shiftId,
                terminalId: deviceId,
                sscc: SSCC,
                closedAt: ISO,
                operatorId: OPERATOR_ID,
              },
            ],
          );
          const boxId = await boxIdFor("b1");

          const disassembleException = {
            kind: "disassemble",
            boxId: "b1",
            codeHash: null,
            shiftId,
            terminalId: "t1",
            operatorId: null,
            reason: "packed for wrong customer",
            occurredAt: new Date().toISOString(),
          };

          await postRaw({
            batchId: `disassemble-test-${randomUUID()}`,
            items: [],
            boxes: [],
            exceptions: [disassembleException],
          });
          const [firstPass] = await db
            .select({ disassembledAt: schema.boxes.disassembledAt })
            .from(schema.boxes)
            .where(eq(schema.boxes.id, boxId));
          const firstTimestamp = firstPass!.disassembledAt;
          expect(firstTimestamp).not.toBeNull();

          // A SECOND, independent disassemble exception (a distinct batchId,
          // not a redelivery of the same one) -- proves the guard is
          // `disassembledAt IS NULL`, not merely the batch-level
          // already-applied short-circuit.
          await postRaw({
            batchId: `disassemble-test-${randomUUID()}`,
            items: [],
            boxes: [],
            exceptions: [{ ...disassembleException, occurredAt: new Date().toISOString() }],
          });

          const [secondPass] = await db
            .select({ disassembledAt: schema.boxes.disassembledAt })
            .from(schema.boxes)
            .where(eq(schema.boxes.id, boxId));
          // The FIRST disassembly's own timestamp survives untouched -- a
          // missing guard would re-stamp `now()` a second time here.
          expect(secondPass!.disassembledAt?.getTime()).toBe(firstTimestamp!.getTime());

          const auditRows = await db
            .select()
            .from(schema.boxExceptions)
            .where(eq(schema.boxExceptions.tenantId, tenantId));
          // Both attempts are still recorded (same pattern as every other
          // no-op case in this describe block) even though the second did
          // nothing else.
          expect(auditRows.filter((r) => r.kind === "disassemble")).toHaveLength(2);
        },
      );

      // Task 7: "reprint" is a pure audit fact -- unlike every other kind in
      // this describe block, no branch in `applyExceptions` matches it, so
      // it falls straight through the if/else-if chain to the unconditional
      // box_exceptions insert at the end of the loop and touches nothing
      // else: no box_items update, no registry release, no box retirement.
      it("reprint writes only an audit row -- no box or item state changes", async () => {
        await postBatchAs(deviceId, [scan("aa", { boxId: "b1" }), scan("bb", { boxId: "b1" })]);
        const boxId = await boxIdFor("b1");
        const [before] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        const itemsBefore = await db
          .select()
          .from(schema.boxItems)
          .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));

        const res = await postRaw({
          batchId: `reprint-test-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "reprint",
              // Raw device-local id (same proof as every other kind in this
              // describe block above) -- proves this kind also goes through
              // the resolution step, not just an already-resolved UUID.
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: "t1",
              operatorId: null,
              reason: "label jammed",
              occurredAt: new Date().toISOString(),
            },
          ],
        });
        expect(res.body.applied).toBe(0);

        const [after] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
        expect(after).toEqual(before);

        const itemsAfter = await db
          .select()
          .from(schema.boxItems)
          .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
        expect(itemsAfter).toEqual(itemsBefore);

        const codeHash1 = "aa".padEnd(64, "0");
        const codeHash2 = "bb".padEnd(64, "0");
        const registryRows = await db
          .select()
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              inArray(schema.codeRegistry.codeHash, [codeHash1, codeHash2]),
            ),
          );
        // Both codes still owned -- "reprint" releases nothing.
        expect(registryRows).toHaveLength(2);

        const [auditRow] = await db
          .select()
          .from(schema.boxExceptions)
          .where(
            and(
              eq(schema.boxExceptions.tenantId, tenantId),
              eq(schema.boxExceptions.kind, "reprint"),
            ),
          );
        expect(auditRow?.reason).toBe("label jammed");
        // Same proof as every other kind above: the audit row's boxId is the
        // RESOLVED server UUID, not the raw "b1" the request carried.
        expect(auditRow?.boxId).toBe(boxId);
      });
    });
  });
});
