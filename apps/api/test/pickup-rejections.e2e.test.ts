import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";

/** Check-digit VALID GTINs. GTIN is allowlisted on the kiosk; GTIN_NOT_ALLOWED is not. */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";
/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const REFUSED_KM = `01${GTIN_NOT_ALLOWED}21REJ1${GS}93Abcd`;
const REFUSED_KM_2 = `01${GTIN_NOT_ALLOWED}21REJ2${GS}93Abcd`;
const GOOD_KM = `01${GTIN}21REJ3${GS}93Abcd`;
const WRITEOFF_KM = `01${GTIN}21REJ16${GS}93Abcd`;

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup scan rejections e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let employeeId: string;
  let productId: string;
  let kioskId: string;
  let agent: ReturnType<typeof request.agent>;
  const TOKEN = `kiosk-token-${randomUUID()}`;
  const BADGE = `badge-${randomUUID()}`;

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

    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId, fullName: "Иван Иванов", role: "оператор" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });
    await db
      .insert(schema.products)
      .values({ id: randomUUID(), tenantId, gtin14: GTIN_NOT_ALLOWED, name: "Другой товар" });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск-1", dayLimitPerEmployee: 20 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(a: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await a
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);
    const org = await a
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    const orgId = org.body.id as string;
    await a.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
    return orgId;
  }

  function postScan(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body);
  }

  function rejectionsFor(deviceSeq: number) {
    return db
      .select()
      .from(schema.pickupScanRejections)
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          eq(schema.pickupScanRejections.kioskId, kioskId),
          eq(schema.pickupScanRejections.deviceSeq, deviceSeq),
        ),
      );
  }

  it("records a scan whose codes were all refused, with no order", async () => {
    const res = await postScan({
      deviceSeq: 10,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }, { rawKm: REFUSED_KM_2 }],
    }).expect(201);

    expect(res.body.orderNo).toBe("");
    expect(res.body.conflicts).toHaveLength(2);

    const rows = await rejectionsFor(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.employeeId).toBe(employeeId);
    expect(rows[0]!.badgeCode).toBeNull();
    expect(rows[0]!.codes.map((c) => c.rawKm).sort()).toEqual([REFUSED_KM, REFUSED_KM_2].sort());
  });

  it("records a replayed all-refused sync exactly once", async () => {
    await postScan({
      deviceSeq: 11,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }],
    }).expect(201);
    await postScan({
      deviceSeq: 11,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: REFUSED_KM }],
    }).expect(201);

    expect(await rejectionsFor(11)).toHaveLength(1);
  });

  it("records a sync whose badge is no longer recognised, and still 401s", async () => {
    await postScan({
      deviceSeq: 12,
      badgeCode: "badge-that-never-existed",
      reason: "buy",
      items: [{ rawKm: GOOD_KM }],
    }).expect(401);

    const rows = await rejectionsFor(12);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBeNull();
    expect(rows[0]!.badgeCode).toBe("badge-that-never-existed");
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.codes).toEqual([{ rawKm: GOOD_KM, reason: "unknown_badge" }]);
  });

  // A badge heartbeat carries no codes, so nothing was lost -- a row here
  // would be noise in a surface whose whole point is that it stays worth
  // reading.
  it("records nothing when an unrecognised-badge sync carried no codes", async () => {
    await postScan({
      deviceSeq: 13,
      badgeCode: "badge-that-never-existed",
      reason: "buy",
      items: [],
    }).expect(401);

    expect(await rejectionsFor(13)).toHaveLength(0);
  });

  // The unified log has to be a superset: an admin asking "what got refused
  // today?" must not have to check two places. `sync_conflicts` keeps being
  // written so the order card and `conflictCount` are untouched.
  it("records a partial refusal linked to its order, without disturbing sync_conflicts", async () => {
    const res = await postScan({
      deviceSeq: 14,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: GOOD_KM }, { rawKm: REFUSED_KM }],
    }).expect(201);

    expect(res.body.itemCount).toBe(1);

    const rows = await rejectionsFor(14);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).not.toBeNull();
    expect(rows[0]!.employeeId).toBe(employeeId);
    expect(rows[0]!.codes).toEqual([
      { rawKm: REFUSED_KM, reason: expect.stringMatching(/unknown_product|not_allowed/) },
    ]);

    const [order] = await db
      .select({ syncConflicts: schema.pickupOrders.syncConflicts })
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.id, rows[0]!.orderId!),
        ),
      );
    expect(order!.syncConflicts).toHaveLength(1);
  });

  it("records nothing for a clean order", async () => {
    const good = `01${GTIN}21REJ9${GS}93Abcd`;
    await postScan({
      deviceSeq: 15,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: good }],
    }).expect(201);

    expect(await rejectionsFor(15)).toHaveLength(0);
  });

  // Step 3 (writeoffReasonId validation) fires before any item is examined --
  // same offline-drift shape as the unrecognised badge, but for a reason the
  // kiosk cached at bootstrap and the admin archived hours later.
  it("records a writeoff sync whose reason is archived, and still 400s", async () => {
    const archivedReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: archivedReasonId,
      tenantId,
      name: "Списание (архивная)",
      archived: true,
    });

    await postScan({
      deviceSeq: 16,
      badgeCode: BADGE,
      reason: "writeoff",
      writeoffReasonId: archivedReasonId,
      items: [{ rawKm: WRITEOFF_KM }],
    }).expect(400);

    const rows = await rejectionsFor(16);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBe(employeeId);
    expect(rows[0]!.badgeCode).toBeNull();
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.codes).toEqual([{ rawKm: WRITEOFF_KM, reason: "unknown_reason" }]);
  });

  // A heartbeat-shaped writeoff sync (no codes) lost no product and must not
  // add noise, mirroring the unrecognised-badge item-less guard.
  it("records nothing when a bad-reason writeoff sync carried no codes", async () => {
    await postScan({
      deviceSeq: 17,
      badgeCode: BADGE,
      reason: "writeoff",
      writeoffReasonId: randomUUID(),
      items: [],
    }).expect(400);

    expect(await rejectionsFor(17)).toHaveLength(0);
  });

  // `resolveWriteoffReasonId`'s OTHER throw site: a kiosk build that forgot to
  // send `writeoffReasonId` at all (as opposed to the archived-reason case
  // above, which sends a stale one). Same offline-drift durability applies.
  it("records a writeoff sync missing writeoffReasonId entirely, and still 400s", async () => {
    await postScan({
      deviceSeq: 18,
      badgeCode: BADGE,
      reason: "writeoff",
      items: [{ rawKm: WRITEOFF_KM }],
    }).expect(400);

    const rows = await rejectionsFor(18);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBe(employeeId);
    expect(rows[0]!.badgeCode).toBeNull();
    expect(rows[0]!.orderId).toBeNull();
    expect(rows[0]!.codes).toEqual([{ rawKm: WRITEOFF_KM, reason: "unknown_reason" }]);
  });

  // A rejection consumes a device_seq without creating an order. If the
  // re-pair counter only looked at orders it would hand that number back,
  // and the replacement device's first rejection would collide with the old
  // one and vanish.
  it("continues device_seq past a number consumed only by a rejection", async () => {
    const pairKioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: pairKioskId, tenantId, name: "Киоск-2", dayLimitPerEmployee: 20 });
    await db.insert(schema.pickupScanRejections).values({
      tenantId,
      kioskId: pairKioskId,
      employeeId,
      deviceSeq: 77,
      codes: [{ rawKm: REFUSED_KM, reason: "not_allowed" }],
      scannedAt: new Date(),
    });

    // Route, `.send({})` and status match apps/api/test/kiosk-pairing.e2e.test.ts,
    // which is the reference for this flow.
    const issued = await agent.post(`/kiosks/${pairKioskId}/pairing-code`).send({}).expect(201);
    const paired = await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(201);

    expect(paired.body.nextDeviceSeq).toBe(78);
  });

  it("lists rejections for the tenant with an open count", async () => {
    const res = await agent.get("/pickup-rejections").expect(200);

    expect(res.body.openCount).toBeGreaterThan(0);
    const row = res.body.items.find(
      (r: { deviceSeq: number; kioskId: string }) => r.deviceSeq === 10 && r.kioskId === kioskId,
    );
    expect(row.kind).toBe("items_refused");
    expect(row.kioskName).toBe("Киоск-1");
    expect(row.employeeName).toBe("Иван Иванов");
    expect(row.orderNo).toBeNull();
    expect(row.codes).toHaveLength(2);
    expect(row.acknowledgedAt).toBeNull();
  });

  it("reports an unrecognised badge as its own kind", async () => {
    const res = await agent.get("/pickup-rejections").expect(200);
    const row = res.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 12);

    expect(row.kind).toBe("unknown_badge");
    expect(row.employeeName).toBeNull();
    expect(row.badgeCode).toBe("badge-that-never-existed");
  });

  it("links a partial refusal to its order number", async () => {
    const res = await agent.get("/pickup-rejections").expect(200);
    const row = res.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 14);

    expect(row.orderId).not.toBeNull();
    expect(row.orderNo).toMatch(/^ORD-/);
  });

  it("acknowledges a rejection and drops it from the open count", async () => {
    const before = await agent.get("/pickup-rejections?state=open").expect(200);
    const target = before.body.items.find((r: { deviceSeq: number }) => r.deviceSeq === 10);
    expect(target).toBeDefined();

    const acked = await agent.post(`/pickup-rejections/${target.id}/acknowledge`).expect(200);
    expect(acked.body.acknowledgedAt).not.toBeNull();

    const after = await agent.get("/pickup-rejections?state=open").expect(200);
    expect(after.body.openCount).toBe(before.body.openCount - 1);
    expect(after.body.items.some((r: { id: string }) => r.id === target.id)).toBe(false);

    const ackedOnly = await agent.get("/pickup-rejections?state=acknowledged").expect(200);
    expect(ackedOnly.body.items.some((r: { id: string }) => r.id === target.id)).toBe(true);
  });

  it("filters by kiosk", async () => {
    const res = await agent.get(`/pickup-rejections?kioskId=${kioskId}`).expect(200);
    expect(res.body.items.every((r: { kioskId: string }) => r.kioskId === kioskId)).toBe(true);
  });

  it("400s acknowledging a malformed id instead of reaching Postgres", async () => {
    await agent.post("/pickup-rejections/not-a-uuid/acknowledge").expect(400);
  });

  it("404s acknowledging a rejection of another tenant", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const mine = await agent.get("/pickup-rejections").expect(200);

    await other.post(`/pickup-rejections/${mine.body.items[0].id}/acknowledge`).expect(404);
    const theirs = await other.get("/pickup-rejections").expect(200);
    expect(theirs.body.items).toHaveLength(0);
  });

  // Cabinet-only surface: a device key must never reach it (docs/device-key-surface.md).
  // `x-kiosk-token` isn't a credential TenantGuard recognises at all, so this
  // only proves TenantGuard's own 401 -- it can't tell us SessionOnlyGuard is
  // wired up. See the next test for that.
  it("refuses a kiosk device token on both routes", async () => {
    await request(app!.getHttpServer())
      .get("/pickup-rejections")
      .set("x-kiosk-token", TOKEN)
      .expect(401);
    await request(app!.getHttpServer())
      .post(`/pickup-rejections/${randomUUID()}/acknowledge`)
      .set("x-kiosk-token", TOKEN)
      .expect(401);
  });

  // A station api-key DOES pass TenantGuard, so this is the credential
  // SessionOnlyGuard exists to refuse -- with 403, not 401.
  it("refuses a station api-key on both routes", async () => {
    const enroll = await agent.post("/station-devices").send({ name: "Terminal" }).expect(201);
    const stationKey = enroll.body.apiKey as string;

    await request(app!.getHttpServer())
      .get("/pickup-rejections")
      .set("x-api-key", stationKey)
      .expect(403);
    await request(app!.getHttpServer())
      .post(`/pickup-rejections/${randomUUID()}/acknowledge`)
      .set("x-api-key", stationKey)
      .expect(403);
  });
});
