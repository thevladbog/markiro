import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const VALID_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "Hello", fontSizePt: 12 }],
};

describe.skipIf(!ready)("subscription expiry and offline recovery", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(PLATFORM_TEST_ENV)) vi.stubEnv(key, value);
    const env = loadEnv({
      ...process.env,
      ...PLATFORM_TEST_ENV,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
    });
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  async function attachPlan(
    tenantId: string,
    input: {
      labelEditorEnabled?: boolean;
      publicApiEnabled?: boolean;
      palletsEnabled?: boolean;
      startsAt?: Date;
      endsAt?: Date;
    },
  ) {
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
      labelEditorEnabled: input.labelEditorEnabled ?? true,
      publicApiEnabled: input.publicApiEnabled ?? true,
      palletsEnabled: input.palletsEnabled ?? true,
    });
    return createManagedSubscription(db, {
      tenantId,
      planVersionId,
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
      ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
    });
  }

  it("keeps reads and profile maintenance while denying disabled editor and public API mutations", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await attachPlan(tenantId, { labelEditorEnabled: false, publicApiEnabled: false });

    await agent.get("/label-templates").expect(200, { items: [] });
    const labelDenied = await agent
      .post("/label-templates")
      .send({ name: "Blocked", spec: VALID_SPEC })
      .expect(403);
    expect(labelDenied.body).toEqual({
      code: "subscription_feature_disabled",
      entitlement: "labelEditor",
    });

    await agent.get("/integrations/public_api/keys").expect(200, { keys: [] });
    const keyDenied = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Blocked" })
      .expect(403);
    expect(keyDenied.body).toEqual({
      code: "subscription_feature_disabled",
      entitlement: "publicApi",
    });

    await agent
      .patch("/profile")
      .send({ firstName: "Иван", lastName: "Петров", middleName: null })
      .expect(200);
  });

  it("denies pallet creation when the plan does not include pallets", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04607004360024",
      name: "No-pallet product",
      status: "active",
      boxCapacity: 10,
      palletCapacity: 5,
    });
    await attachPlan(tenantId, { palletsEnabled: false });

    const denied = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "aggregation",
        boxCapacity: 10,
        palletCapacity: 5,
        palletsEnabled: true,
      })
      .expect(403);

    expect(denied.body).toEqual({
      code: "subscription_feature_disabled",
      entitlement: "pallets",
    });
  });

  it("uses endsAt immediately, blocks new work, and exposes redacted device bootstrap state", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Expiry station");
    const kioskId = randomUUID();
    const kioskToken = `kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Expiry kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    const stationPairingCode = await agent
      .post(`/station-devices/${station.deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const kioskPairingCode = await agent
      .post(`/kiosks/${kioskId}/pairing-code`)
      .send({})
      .expect(201);
    const startsAt = new Date(Date.now() - 86_400_000);
    const endsAt = new Date(Date.now() - 60_000);
    await attachPlan(tenantId, { startsAt, endsAt });

    const denied = await agent
      .post("/shifts")
      .send({ productId: randomUUID(), mode: "validation" })
      .expect(403);
    expect(denied.body).toEqual({ code: "subscription_read_only" });

    const stationBootstrap = await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(stationBootstrap.body.subscription).toEqual({
      access: "read_only",
      status: "expired",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    expect(stationBootstrap.text).not.toMatch(/price|payment|platform/i);

    const kioskBootstrap = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", kioskToken)
      .expect(200);
    expect(kioskBootstrap.body.subscription).toEqual({
      access: "read_only",
      status: "expired",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    expect(kioskBootstrap.text).not.toMatch(/payment|platform/i);

    for (const deniedRequest of [
      agent.post(`/station-devices/${station.deviceId}/pairing-code`).send({}),
      agent.post(`/kiosks/${kioskId}/pairing-code`).send({}),
      agent.post(`/kiosks/${kioskId}/enroll`).send({}),
    ]) {
      const response = await deniedRequest.expect(403);
      expect(response.body).toEqual({ code: "subscription_read_only" });
    }
    const deniedStationPair = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: stationPairingCode.body.code })
      .expect(403);
    expect(deniedStationPair.body).toEqual({ code: "subscription_read_only" });
    const deniedKioskPair = await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: kioskPairingCode.body.code })
      .expect(403);
    expect(deniedKioskPair.body).toEqual({ code: "subscription_read_only" });

    await agent.get("/pickup-orders").expect(200, { items: [] });
    await agent
      .post("/pickup-orders/export")
      .send({ orderIds: [randomUUID()] })
      .expect(200, "");
  });

  it("accepts station recovery only for a same-tenant shift opened before expiry", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Recovery station");
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04006381333931",
      name: "Recovery product",
      status: "active",
      boxCapacity: 10,
      palletCapacity: 5,
    });
    const endsAt = new Date(Date.now() - 60_000);
    const eligibleShiftId = randomUUID();
    const lateShiftId = randomUUID();
    await db.insert(schema.shifts).values([
      {
        id: eligibleShiftId,
        tenantId,
        productId,
        mode: "validation",
        status: "active",
        openedAt: new Date(endsAt.getTime() - 60_000),
      },
      {
        id: lateShiftId,
        tenantId,
        productId,
        mode: "validation",
        status: "active",
        openedAt: new Date(endsAt.getTime() + 1_000),
      },
    ]);
    await attachPlan(tenantId, { startsAt: new Date(endsAt.getTime() - 86_400_000), endsAt });

    const item = (shiftId: string) => ({
      shiftId,
      terminalId: "untrusted-terminal",
      raw: "invalid-code",
      verdict: "invalid",
      scannedAt: new Date().toISOString(),
      code: null,
      boxId: null,
      operatorId: null,
    });
    const postBatch = (batchId: string, shiftId: string) =>
      request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", station.apiKey)
        .send({ batchId, items: [item(shiftId)], boxes: [], exceptions: [] });

    const eligibleBatchId = `eligible-${randomUUID()}`;
    await postBatch(eligibleBatchId, eligibleShiftId).expect(201);
    await db
      .update(schema.shifts)
      .set({ openedAt: new Date(endsAt.getTime() + 1_000) })
      .where(eq(schema.shifts.id, eligibleShiftId));
    const replay = await postBatch(eligibleBatchId, eligibleShiftId).expect(201);
    expect(replay.body).toMatchObject({ applied: 0, alreadyApplied: true });
    const late = await postBatch(`late-${randomUUID()}`, lateShiftId).expect(403);
    expect(late.body).toEqual({ code: "subscription_read_only" });

    const otherAgent = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);
    const otherProductId = randomUUID();
    const otherShiftId = randomUUID();
    await db.insert(schema.products).values({
      id: otherProductId,
      tenantId: otherTenantId,
      gtin14: "04607004360017",
      name: "Other product",
      status: "active",
      boxCapacity: 10,
      palletCapacity: 5,
    });
    await db.insert(schema.shifts).values({
      id: otherShiftId,
      tenantId: otherTenantId,
      productId: otherProductId,
      mode: "validation",
      status: "active",
      openedAt: new Date(endsAt.getTime() - 60_000),
    });
    const foreign = await postBatch(`foreign-${randomUUID()}`, otherShiftId).expect(403);
    expect(foreign.body).toEqual({ code: "subscription_read_only" });
  });

  it("continues kiosk queue recovery record-by-record and keeps duplicate retry idempotent", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = randomUUID();
    const badgeCode = `badge-${randomUUID()}`;
    const kioskId = randomUUID();
    const kioskToken = `kiosk-${randomUUID()}`;
    await db.insert(schema.employees).values({
      id: employeeId,
      tenantId,
      fullName: "Recovery employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode });
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Recovery kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    const endsAt = new Date(Date.now() - 60_000);
    await attachPlan(tenantId, { startsAt: new Date(endsAt.getTime() - 86_400_000), endsAt });

    const post = (deviceSeq: number, createdAt: string) =>
      request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", kioskToken)
        .send({ deviceSeq, badgeCode, reason: "buy", items: [], createdAt });

    const queuedAt = new Date(endsAt.getTime() - 1_000).toISOString();
    const accepted = await post(1, queuedAt).expect(201);
    expect(accepted.body).toMatchObject({ status: "pending", itemCount: 0 });
    const replay = await post(1, new Date().toISOString()).expect(201);
    expect(replay.body.orderNo).toBe(accepted.body.orderNo);

    const denied = await post(2, new Date().toISOString()).expect(403);
    expect(denied.body).toEqual({ code: "subscription_read_only" });

    const laterEligible = await post(3, queuedAt).expect(201);
    expect(laterEligible.body.orderNo).not.toBe(accepted.body.orderNo);

    const secondKioskId = randomUUID();
    const secondKioskToken = `kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: secondKioskId,
      tenantId,
      name: "Second recovery kiosk",
      deviceTokenHash: hashDeviceToken(secondKioskToken),
    });
    const independentDeviceSequence = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", secondKioskToken)
      .send({ deviceSeq: 1, badgeCode, reason: "buy", items: [], createdAt: queuedAt })
      .expect(201);
    expect(independentDeviceSequence.body.orderNo).not.toBe(accepted.body.orderNo);

    const otherAgent = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);
    const otherEmployeeId = randomUUID();
    const otherBadgeCode = `badge-${randomUUID()}`;
    await db.insert(schema.employees).values({
      id: otherEmployeeId,
      tenantId: otherTenantId,
      fullName: "Other tenant employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({
      tenantId: otherTenantId,
      employeeId: otherEmployeeId,
      badgeCode: otherBadgeCode,
    });
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .send({
        deviceSeq: 5,
        badgeCode: otherBadgeCode,
        reason: "buy",
        items: [],
        createdAt: queuedAt,
      })
      .expect(422);

    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .send({ deviceSeq: 4, badgeCode, reason: "buy", items: [], createdAt: "not-a-date" })
      .expect(400);
  });
});
