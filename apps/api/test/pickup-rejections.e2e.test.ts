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

/** Check-digit VALID GTINs. GTIN is allowlisted on the kiosk; GTIN_NOT_ALLOWED is not. */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";
/** GS (ASCII 0x1D) — the KM segment separator. */
const GS = String.fromCharCode(0x1d);

const REFUSED_KM = `01${GTIN_NOT_ALLOWED}21REJ1${GS}93Abcd`;
const REFUSED_KM_2 = `01${GTIN_NOT_ALLOWED}21REJ2${GS}93Abcd`;
const GOOD_KM = `01${GTIN}21REJ3${GS}93Abcd`;

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
});
