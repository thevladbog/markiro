import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import { Logger, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { createTestEmployee, createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { preTask8KioskWillQuarantine } from "./support/pre-task8-kiosk-client";

const KIOSK_RECOVERY_CAPABILITY = "subscription-recovery-v1";
const KIOSK_RECOVERY_GTIN = "04600682000013";
const GS = "\u001d";

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
      .set("x-station-capabilities", "subscription-state-v1")
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
    const postBatch = (batchId: string, shiftId: string, batchItem = item(shiftId)) =>
      request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", station.apiKey)
        .send({ batchId, items: [batchItem], boxes: [], exceptions: [] });

    const eligibleBatchId = `eligible-${randomUUID()}`;
    const eligibleItem = item(eligibleShiftId);
    await postBatch(eligibleBatchId, eligibleShiftId, eligibleItem).expect(201);
    await db
      .update(schema.shifts)
      .set({ openedAt: new Date(endsAt.getTime() + 1_000) })
      .where(eq(schema.shifts.id, eligibleShiftId));
    const replay = await postBatch(eligibleBatchId, eligibleShiftId, eligibleItem).expect(201);
    expect(replay.body).toMatchObject({ applied: 0, alreadyApplied: true });
    const late = await postBatch(`late-${randomUUID()}`, lateShiftId).expect(201);
    expect(late.body).toEqual({ applied: 0, alreadyApplied: false, conflicts: [] });

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
    const foreign = await postBatch(`foreign-${randomUUID()}`, otherShiftId).expect(201);
    expect(foreign.body).toEqual({ applied: 0, alreadyApplied: false, conflicts: [] });
  });

  it("applies an eligible mixed station subset and durably quarantines late, missing, and foreign records", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Mixed recovery station");
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04006381333931",
      name: "Mixed recovery product",
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

    const otherAgent = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);
    const otherProductId = randomUUID();
    const foreignShiftId = randomUUID();
    await db.insert(schema.products).values({
      id: otherProductId,
      tenantId: otherTenantId,
      gtin14: "04607004360017",
      name: "Foreign recovery product",
      status: "active",
      boxCapacity: 10,
      palletCapacity: 5,
    });
    await db.insert(schema.shifts).values({
      id: foreignShiftId,
      tenantId: otherTenantId,
      productId: otherProductId,
      mode: "validation",
      status: "active",
      openedAt: new Date(endsAt.getTime() - 60_000),
    });
    await attachPlan(tenantId, {
      startsAt: new Date(endsAt.getTime() - 86_400_000),
      endsAt,
    });

    const missingShiftId = randomUUID();
    const batchId = `mixed-expiry-${randomUUID()}`;
    const eligibleRaw = "eligible-invalid-code";
    const lateRaw = "010400638133393121LATE-RAW-GS1";
    const body = {
      batchId,
      items: [
        {
          shiftId: eligibleShiftId,
          terminalId: "spoofed",
          raw: eligibleRaw,
          verdict: "invalid",
          scannedAt: new Date().toISOString(),
          code: null,
          boxId: null,
          operatorId: null,
        },
        {
          shiftId: lateShiftId,
          terminalId: "spoofed",
          raw: lateRaw,
          verdict: "invalid",
          scannedAt: new Date().toISOString(),
          code: null,
          boxId: null,
          operatorId: null,
        },
      ],
      boxes: [
        {
          boxId: "missing-box",
          shiftId: missingShiftId,
          terminalId: "spoofed",
          sscc: "080000000400000022",
          closedAt: new Date().toISOString(),
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
      exceptions: [
        {
          kind: "clear",
          boxId: "foreign-box",
          codeHash: null,
          targetScannedAt: null,
          shiftId: foreignShiftId,
          terminalId: "spoofed",
          operatorId: null,
          reason: null,
          occurredAt: new Date().toISOString(),
        },
      ],
    };

    const first = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", station.apiKey)
      .set("x-station-capabilities", "station-recovery-v1")
      .send(body)
      .expect(201);

    const expectedDenied = [
      {
        recordKind: "item",
        recordIndex: 1,
        shiftId: lateShiftId,
        code: "subscription_read_only",
      },
      {
        recordKind: "box",
        recordIndex: 0,
        shiftId: missingShiftId,
        code: "subscription_read_only",
      },
      {
        recordKind: "exception",
        recordIndex: 0,
        shiftId: foreignShiftId,
        code: "subscription_read_only",
      },
    ];
    expect(first.body).toEqual({
      applied: 1,
      alreadyApplied: false,
      conflicts: [],
      denied: expectedDenied,
    });

    const eligibleEvents = await db
      .select({ raw: schema.scanEvents.raw })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.tenantId, tenantId),
          eq(schema.scanEvents.shiftId, eligibleShiftId),
        ),
      );
    const lateEvents = await db
      .select({ raw: schema.scanEvents.raw })
      .from(schema.scanEvents)
      .where(
        and(eq(schema.scanEvents.tenantId, tenantId), eq(schema.scanEvents.shiftId, lateShiftId)),
      );
    expect(eligibleEvents).toContainEqual({ raw: eligibleRaw });
    expect(lateEvents).not.toContainEqual({ raw: lateRaw });

    const quarantined = await db.execute<{
      record_kind: string;
      record_index: number;
      reason: string;
      payload: { raw?: string };
    }>(sql`
      select record_kind, record_index, reason, payload
      from station_sync_quarantine
      where tenant_id = ${tenantId} and batch_id = ${batchId}
      order by record_kind, record_index
    `);
    expect(quarantined.rows).toHaveLength(3);
    expect(quarantined.rows).toContainEqual({
      record_kind: "item",
      record_index: 1,
      reason: "subscription_read_only",
      payload: expect.objectContaining({ raw: lateRaw }),
    });

    const replay = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", station.apiKey)
      .set("x-station-capabilities", "station-recovery-v1")
      .send(body)
      .expect(201);
    expect(replay.body).toEqual({
      applied: 0,
      alreadyApplied: true,
      conflicts: [],
      denied: expectedDenied,
    });
    const replayedQuarantine = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from station_sync_quarantine
      where tenant_id = ${tenantId} and batch_id = ${batchId}
    `);
    expect(replayedQuarantine.rows).toEqual([{ count: "3" }]);
  });

  it("continues kiosk queue recovery record-by-record and keeps duplicate retry idempotent", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = randomUUID();
    const badgeCode = `badge-${randomUUID()}`;
    const kioskId = randomUUID();
    const kioskToken = `kiosk-${randomUUID()}`;
    await createTestEmployee(db, {
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
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: KIOSK_RECOVERY_GTIN,
      name: "Recovery product",
    });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    const initialEndsAt = new Date(Date.now() + 86_400_000);
    const subscription = await attachPlan(tenantId, {
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: initialEndsAt,
    });

    const recoveryKm = (prefix: string) =>
      `01${KIOSK_RECOVERY_GTIN}21${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}${GS}93Abcd`;
    const firstKm = recoveryKm("FIRST");
    const laterKm = recoveryKm("LATER");
    const secondKioskKm = recoveryKm("SECOND");
    const reserve = (token: string, deviceSeq: number, rawKm: string) =>
      request(app!.getHttpServer())
        .post("/kiosk/order-admissions")
        .set("x-kiosk-token", token)
        .send({ deviceSeq, badgeCode, reason: "buy", items: [{ rawKm }] })
        .expect(201);
    const firstAdmission = await reserve(kioskToken, 1, firstKm);
    const laterAdmission = await reserve(kioskToken, 3, laterKm);

    const post = (deviceSeq: number, rawKm: string, createdAt: string, admissionProof?: string) =>
      request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", kioskToken)
        .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
        .send({
          deviceSeq,
          badgeCode,
          reason: "buy",
          items: [{ rawKm }],
          createdAt,
          ...(admissionProof ? { admissionProof } : {}),
        });

    const secondKioskId = randomUUID();
    const secondKioskToken = `kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: secondKioskId,
      tenantId,
      name: "Second recovery kiosk",
      deviceTokenHash: hashDeviceToken(secondKioskToken),
    });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId: secondKioskId, productId });
    const secondAdmission = await reserve(secondKioskToken, 1, secondKioskKm);
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: new Date() })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));

    const accepted = await post(
      1,
      firstKm,
      firstAdmission.body.claimedAt,
      firstAdmission.body.admissionProof,
    ).expect(201);
    expect(accepted.body).toMatchObject({ status: "pending", itemCount: 1 });
    const replay = await post(1, firstKm, new Date().toISOString()).expect(201);
    expect(replay.body.orderNo).toBe(accepted.body.orderNo);

    const denied = await post(2, recoveryKm("DENIED"), new Date().toISOString()).expect(403);
    expect(denied.body).toEqual({ code: "subscription_read_only" });

    const laterEligible = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
      .send({
        deviceSeq: 3,
        badgeCode,
        reason: "buy",
        items: [{ rawKm: laterKm }],
        createdAt: laterAdmission.body.claimedAt,
        admissionProof: laterAdmission.body.admissionProof,
      })
      .expect(201);
    expect(laterEligible.body.orderNo).not.toBe(accepted.body.orderNo);

    const independentDeviceSequence = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", secondKioskToken)
      .send({
        deviceSeq: 1,
        badgeCode,
        reason: "buy",
        items: [{ rawKm: secondKioskKm }],
        createdAt: secondAdmission.body.claimedAt,
        admissionProof: secondAdmission.body.admissionProof,
      })
      .expect(201);
    expect(independentDeviceSequence.body.orderNo).not.toBe(accepted.body.orderNo);

    const consumedAdmissions = await db
      .select({ id: schema.kioskOrderAdmissions.id })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(consumedAdmissions).toEqual([]);

    const otherAgent = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);
    const otherEmployeeId = randomUUID();
    const otherBadgeCode = `badge-${randomUUID()}`;
    await createTestEmployee(db, {
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
      .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
      .send({
        deviceSeq: 5,
        badgeCode: otherBadgeCode,
        reason: "buy",
        items: [{ rawKm: "not-a-km" }],
        createdAt: firstAdmission.body.claimedAt,
      })
      .expect(403, { code: "subscription_read_only" });

    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .send({
        deviceSeq: 4,
        badgeCode,
        reason: "buy",
        items: [{ rawKm: "not-a-km" }],
        createdAt: "not-a-date",
      })
      .expect(400);
  });

  it("never auto-applies proofless or generic pre-issued backdated orders after expiry", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = randomUUID();
    const badgeCode = `badge-${randomUUID()}`;
    const kioskId = randomUUID();
    const kioskToken = `kiosk-${randomUUID()}`;
    await createTestEmployee(db, {
      id: employeeId,
      tenantId,
      fullName: "Untrusted recovery employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode });
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Untrusted recovery kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    const startsAt = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    const endsAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await attachPlan(tenantId, { startsAt, endsAt });
    const createdAt = new Date(startsAt.getTime() + 60 * 60_000);
    const genericProof = "legacy-pre-issued-generic-proof";
    const post = (body: Record<string, unknown>, capability = KIOSK_RECOVERY_CAPABILITY) =>
      request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", kioskToken)
        .set("x-kiosk-capabilities", capability)
        .send({
          badgeCode,
          reason: "buy",
          items: [{ rawKm: "not-a-km" }],
          createdAt: createdAt.toISOString(),
          ...body,
        });

    const audit = vi.spyOn(Logger.prototype, "warn");
    try {
      const legacy = await post({ deviceSeq: 9 }, "").expect(422, {
        code: "subscription_read_only",
      });
      expect(preTask8KioskWillQuarantine(legacy.status)).toBe(true);
      await post({ deviceSeq: 10, admissionProof: genericProof }).expect(403, {
        code: "subscription_read_only",
      });
      expect(
        audit.mock.calls.some(([value]) =>
          String(value).includes('"action":"kiosk.legacy_proofless_recovery"'),
        ),
      ).toBe(false);
    } finally {
      audit.mockRestore();
    }
    const rows = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.tenantId, tenantId));
    expect(rows).toEqual([]);
  });

  it("accepts only a server-time reservation bound to exact order content after expiry", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = randomUUID();
    const badgeCode = `badge-${randomUUID()}`;
    const kioskId = randomUUID();
    const kioskToken = `proof-bootstrap-${randomUUID()}`;
    await createTestEmployee(db, {
      id: employeeId,
      tenantId,
      fullName: "Attested employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode });
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Admission proof kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    const startsAt = new Date(Date.now() - 60_000);
    const endsAt = new Date(Date.now() + 86_400_000);
    const subscription = await attachPlan(tenantId, { startsAt, endsAt });
    const content = { badgeCode, reason: "buy", items: [{ rawKm: "not-a-km" }] };
    const reserve = async (deviceSeq: number) =>
      request(app!.getHttpServer())
        .post("/kiosk/order-admissions")
        .set("x-kiosk-token", kioskToken)
        .send({ deviceSeq, ...content })
        .expect(201);
    const exact = await reserve(0);
    const wrongTime = await reserve(1);
    const wrongContent = await reserve(2);

    const persistedAdmissions = await db
      .select({
        tokenHash: schema.kioskOrderAdmissions.tokenHash,
        payloadDigest: schema.kioskOrderAdmissions.payloadDigest,
      })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(persistedAdmissions).toHaveLength(3);
    expect(JSON.stringify(persistedAdmissions)).not.toContain(exact.body.admissionProof);
    expect(JSON.stringify(persistedAdmissions)).not.toContain(badgeCode);
    const durableAudit = await db
      .select({
        before: schema.tenantAuditEvents.before,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(JSON.stringify(durableAudit)).not.toContain(exact.body.admissionProof);

    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(exact.body.claimedAt as string) })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));

    // A renewal may already exist but not have started. The reservation is
    // bound to the subscription that was authoritative when the server issued
    // it, not whichever read-only row the resolver happens to rank today.
    const pendingPlanVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    await createManagedSubscription(db, {
      tenantId,
      planVersionId: pendingPlanVersionId,
      status: "pending_activation",
      startsAt: null,
      endsAt: null,
    });

    const post = (body: Record<string, unknown>, token = kioskToken) =>
      request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", token)
        .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
        .send({ ...content, ...body });
    const retriedAdmission = await request(app!.getHttpServer())
      .post("/kiosk/order-admissions")
      .set("x-kiosk-token", kioskToken)
      .send({
        ...content,
        deviceSeq: 0,
        admissionNonce: exact.body.admissionProof,
      })
      .expect(201);
    expect(retriedAdmission.body).toEqual(exact.body);
    await request(app!.getHttpServer())
      .post("/kiosk/order-admissions")
      .set("x-kiosk-token", kioskToken)
      .send({
        ...content,
        deviceSeq: 99,
        admissionNonce: "n".repeat(32),
      })
      .expect(403);
    await post({
      deviceSeq: 0,
      createdAt: exact.body.claimedAt,
      admissionProof: exact.body.admissionProof,
    }).expect(201);
    await post({
      deviceSeq: 1,
      createdAt: new Date(Date.parse(wrongTime.body.claimedAt as string) - 60_000).toISOString(),
      admissionProof: wrongTime.body.admissionProof,
    }).expect(403, { code: "subscription_read_only" });
    await post({
      deviceSeq: 2,
      createdAt: wrongContent.body.claimedAt,
      admissionProof: wrongContent.body.admissionProof,
      reason: "writeoff",
    }).expect(403, { code: "subscription_read_only" });
    await post({
      deviceSeq: 3,
      createdAt: exact.body.claimedAt,
      admissionProof: "forged-admission-token",
    }).expect(403, { code: "subscription_read_only" });
    await post({
      deviceSeq: 4,
      createdAt: exact.body.claimedAt,
      admissionProof: exact.body.admissionProof,
    }).expect(403, { code: "subscription_read_only" });

    const otherKioskId = randomUUID();
    const otherKioskToken = `proof-other-kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: otherKioskId,
      tenantId,
      name: "Other admission proof kiosk",
      deviceTokenHash: hashDeviceToken(otherKioskToken),
    });
    await post(
      {
        deviceSeq: 10,
        createdAt: exact.body.claimedAt,
        admissionProof: exact.body.admissionProof,
      },
      otherKioskToken,
    ).expect(403, { code: "subscription_read_only" });

    const otherAgent = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherAgent);
    const otherEmployeeId = randomUUID();
    const otherTenantKioskToken = `proof-other-tenant-${randomUUID()}`;
    await createTestEmployee(db, {
      id: otherEmployeeId,
      tenantId: otherTenantId,
      fullName: "Other attestation tenant employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({
      tenantId: otherTenantId,
      employeeId: otherEmployeeId,
      badgeCode,
    });
    await db.insert(schema.kiosks).values({
      id: randomUUID(),
      tenantId: otherTenantId,
      name: "Other tenant admission proof kiosk",
      deviceTokenHash: hashDeviceToken(otherTenantKioskToken),
    });
    await attachPlan(otherTenantId, {
      startsAt: new Date(Date.now() - 2 * 86_400_000),
      endsAt: new Date(Date.now() - 86_400_000),
    });
    await post(
      {
        deviceSeq: 10,
        createdAt: exact.body.claimedAt,
        admissionProof: exact.body.admissionProof,
      },
      otherTenantKioskToken,
    ).expect(403, { code: "subscription_read_only" });
  });

  it("has no fixed bootstrap proof window and admits sequence 128 after 129 queued records", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const volumeEmployeeId = randomUUID();
    const volumeBadge = `volume-badge-${randomUUID()}`;
    await createTestEmployee(db, {
      id: volumeEmployeeId,
      tenantId,
      fullName: "Admission volume employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({
      tenantId,
      employeeId: volumeEmployeeId,
      badgeCode: volumeBadge,
    });
    const kioskId = randomUUID();
    const kioskToken = `proof-volume-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Admission volume kiosk",
      dayLimitPerEmployee: 1000,
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    await attachPlan(tenantId, {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });

    const bootstrap = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", kioskToken)
      .set("x-kiosk-next-device-seq", "0")
      .expect(200);
    expect(bootstrap.body).not.toHaveProperty("admissionProofs");

    const admissions: Array<{ deviceSeq: number; admissionProof: string; claimedAt: string }> = [];
    for (let deviceSeq = 0; deviceSeq < 128; deviceSeq += 1) {
      const response = await request(app!.getHttpServer())
        .post("/kiosk/order-admissions")
        .set("x-kiosk-token", kioskToken)
        .send({ deviceSeq, badgeCode: volumeBadge, reason: "buy", items: [{ rawKm: "not-a-km" }] });
      expect(response.status).toBe(201);
      admissions.push({
        deviceSeq,
        admissionProof: response.body.admissionProof,
        claimedAt: response.body.claimedAt,
      });
    }
    await request(app!.getHttpServer())
      .post("/kiosk/order-admissions")
      .set("x-kiosk-token", kioskToken)
      .send({
        deviceSeq: 128,
        badgeCode: volumeBadge,
        reason: "buy",
        items: [{ rawKm: "not-a-km" }],
      })
      .expect(409);
    const outstanding = await db
      .select({ deviceSeq: schema.kioskOrderAdmissions.deviceSeq })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(outstanding.map(({ deviceSeq }) => deviceSeq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 128 }, (_, deviceSeq) => deviceSeq),
    );

    // Consume the outstanding rows, then verify honest serialized delivery can
    // continue beyond the cap without requiring dense sequence values.
    for (const admission of admissions) {
      const submitted = await request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", kioskToken)
        .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
        .send({
          deviceSeq: admission.deviceSeq,
          badgeCode: volumeBadge,
          reason: "buy",
          items: [{ rawKm: "not-a-km" }],
          createdAt: admission.claimedAt,
          admissionProof: admission.admissionProof,
        });
      expect(submitted.status).toBe(201);
    }
    const afterConsume = await db
      .select({ id: schema.kioskOrderAdmissions.id })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(afterConsume).toEqual([]);

    // Serialized just-in-time delivery remains valid beyond the outstanding cap.
    for (let deviceSeq = 128; deviceSeq <= 256; deviceSeq += 1) {
      const admission = await request(app!.getHttpServer())
        .post("/kiosk/order-admissions")
        .set("x-kiosk-token", kioskToken)
        .send({ deviceSeq, badgeCode: volumeBadge, reason: "buy", items: [{ rawKm: "not-a-km" }] })
        .expect(201);
      await request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", kioskToken)
        .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
        .send({
          deviceSeq,
          badgeCode: volumeBadge,
          reason: "buy",
          items: [{ rawKm: "not-a-km" }],
          createdAt: admission.body.claimedAt,
          admissionProof: admission.body.admissionProof,
        })
        .expect(201);
    }
    const afterJitConsume = await db
      .select({ id: schema.kioskOrderAdmissions.id })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(afterJitConsume).toEqual([]);
  }, 60_000);

  it("consumes an exact admission after a durable terminal order rejection", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const kioskId = randomUUID();
    const kioskToken = `proof-rejection-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Admission rejection kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    await attachPlan(tenantId, {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const content = {
      deviceSeq: 1,
      badgeCode: `unknown-${randomUUID()}`,
      reason: "buy" as const,
      items: [{ rawKm: "010460704360021721rejected" }],
    };
    const admission = await request(app!.getHttpServer())
      .post("/kiosk/order-admissions")
      .set("x-kiosk-token", kioskToken)
      .send(content)
      .expect(201);

    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
      .send({
        ...content,
        createdAt: admission.body.claimedAt,
        admissionProof: admission.body.admissionProof,
      })
      .expect(422);

    const outstanding = await db
      .select({ id: schema.kioskOrderAdmissions.id })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(outstanding).toEqual([]);
  });

  it("consumes a later admission when replaying an already durable order", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = randomUUID();
    const badgeCode = `badge-${randomUUID()}`;
    const kioskId = randomUUID();
    const kioskToken = `proof-idempotent-${randomUUID()}`;
    await createTestEmployee(db, {
      id: employeeId,
      tenantId,
      fullName: "Idempotent admission employee",
      status: "active",
    });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode });
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Idempotent admission kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    await attachPlan(tenantId, {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const content = {
      deviceSeq: 1,
      badgeCode,
      reason: "buy" as const,
      items: [{ rawKm: "not-a-km" }],
    };
    const created = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
      .send(content)
      .expect(201);

    await request(app!.getHttpServer())
      .post("/kiosk/order-admissions")
      .set("x-kiosk-token", kioskToken)
      .send(content)
      .expect(201);
    const replay = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .set("x-kiosk-capabilities", KIOSK_RECOVERY_CAPABILITY)
      .send(content)
      .expect(201);
    expect(replay.body.orderNo).toBe(created.body.orderNo);

    const outstanding = await db
      .select({ id: schema.kioskOrderAdmissions.id })
      .from(schema.kioskOrderAdmissions)
      .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId));
    expect(outstanding).toEqual([]);
  });

  it("derives the bootstrap snapshot from one recovery resolution instead of a racy second read", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const kioskId = randomUUID();
    const kioskToken = `single-snapshot-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Single snapshot kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    await attachPlan(tenantId, {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const entitlements = app!.get(EntitlementsService);
    const splitRead = vi
      .spyOn(entitlements, "accessSnapshot")
      .mockRejectedValueOnce(new Error("split subscription snapshot read"));
    const recoveryRead = vi.spyOn(entitlements, "resolveRecovery");
    recoveryRead.mockClear();
    try {
      const response = await request(app!.getHttpServer())
        .get("/kiosk/bootstrap")
        .set("x-kiosk-token", kioskToken)
        .expect(200);
      expect(response.body.subscription).toMatchObject({ access: "managed", status: "active" });
      expect(splitRead).not.toHaveBeenCalled();
      expect(recoveryRead).toHaveBeenCalledTimes(1);
    } finally {
      splitRead.mockRestore();
      recoveryRead.mockRestore();
    }
  });
});
