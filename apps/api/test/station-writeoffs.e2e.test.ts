import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { createTestStationDevice } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

/**
 * Check digits are VALID (see packages/domain/src/gs1/check-digit.ts). An
 * invalid one fails classification as `not_km` before product resolution and
 * would make every assertion below meaningless.
 *   - GTIN            catalogued product for the tenant.
 *   - GTIN_UNLISTED   real product for the tenant, on no kiosk's allowlist —
 *                     the handheld must still accept it.
 *   - GTIN_UNKNOWN    no product row at all -> unknown_product.
 */
const GTIN = "04600682000013";
const GTIN_UNLISTED = "04600682000020";
const GTIN_UNKNOWN = "04600682000037";
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station writeoffs e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let apiKey: string;
  let deviceId: string;
  let operatorId: string;
  let deniedOperatorId: string;
  let reasonId: string;
  let archivedReasonId: string;
  let foreignTenantId: string;
  let foreignOperatorId: string;
  let foreignReasonId: string;

  let seq = 0;
  const nextSeq = (): number => ++seq;
  const km = (gtin: string, prefix: string): string => {
    const serial = `${prefix}${randomUUID().replace(/-/g, "")}`.slice(0, 18).toUpperCase();
    return `01${gtin}21${serial}${GS}93Abcd`;
  };

  async function seedOperator(tenant: string, canWriteoff: boolean): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.employees).values({ id, tenantId: tenant, fullName: "Оператор О." });
    await db.insert(schema.employeePickupPolicies).values({
      tenantId: tenant,
      employeeId: id,
      limitMode: "limited",
      dayLimit: 2,
      canWriteoff,
    });
    return id;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
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
    const orgId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  const post = (body: Record<string, unknown>, key = apiKey) =>
    request(app!.getHttpServer()).post("/station/writeoffs").set("x-api-key", key).send(body);

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

    const agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    await db
      .insert(schema.pickupTenantPolicies)
      .values({ tenantId, limitsEnabled: true })
      .onConflictDoNothing();

    const device = await createTestStationDevice(app, agent, "ТСД-1", { kind: "handheld" });
    apiKey = device.apiKey;
    deviceId = device.deviceId;

    operatorId = await seedOperator(tenantId, true);
    deniedOperatorId = await seedOperator(tenantId, false);

    await db.insert(schema.products).values([
      { id: randomUUID(), tenantId, gtin14: GTIN, name: "Вода 0,5 л", unitPrice: "99.90" },
      { id: randomUUID(), tenantId, gtin14: GTIN_UNLISTED, name: "Вода 1,5 л" },
    ]);

    reasonId = randomUUID();
    archivedReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values([
      { id: reasonId, tenantId, name: "Бой", sortOrder: 0, archived: false },
      { id: archivedReasonId, tenantId, name: "Старая", sortOrder: 1, archived: true },
    ]);

    const foreignAgent = request.agent(app.getHttpServer());
    foreignTenantId = await signUpAndActivate(foreignAgent);
    await db
      .insert(schema.pickupTenantPolicies)
      .values({ tenantId: foreignTenantId, limitsEnabled: true })
      .onConflictDoNothing();
    foreignOperatorId = await seedOperator(foreignTenantId, true);
    foreignReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: foreignReasonId,
      tenantId: foreignTenantId,
      name: "Чужая",
      sortOrder: 0,
      archived: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("files a write-off as a handheld-owned document with no price", async () => {
    const deviceSeq = nextSeq();
    const res = await post({
      deviceSeq,
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN, "WO") }],
      createdAt: new Date().toISOString(),
    }).expect(201);

    expect(res.body.itemCount).toBe(1);
    expect(res.body.conflicts).toEqual([]);

    const [row] = await db
      .select()
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.orderNo, res.body.orderNo as string),
        ),
      );
    expect(row?.sourceKind).toBe("handheld");
    expect(row?.stationDeviceId).toBe(deviceId);
    expect(row?.kioskId).toBeNull();
    expect(row?.reason).toBe("writeoff");
    expect(row?.totalPrice).toBeNull();
  });

  it("is idempotent on a replayed device sequence", async () => {
    const body = {
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN, "ID") }],
      createdAt: new Date().toISOString(),
    };
    const first = await post(body).expect(201);
    const replay = await post(body).expect(201);
    expect(replay.body.orderNo).toBe(first.body.orderNo);
  });

  it("accepts a catalogue product that no kiosk lists", async () => {
    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN_UNLISTED, "UL") }],
      createdAt: new Date().toISOString(),
    }).expect(201);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.itemCount).toBe(1);
  });

  it("still refuses a code with no product row for this tenant", async () => {
    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN_UNKNOWN, "UK") }],
      createdAt: new Date().toISOString(),
    });
    expect(res.status).toBe(422);
  });

  it("does not spend the operator's daily allowance", async () => {
    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN, "L1") }, { rawKm: km(GTIN, "L2") }, { rawKm: km(GTIN, "L3") }],
      createdAt: new Date().toISOString(),
    }).expect(201);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.itemCount).toBe(3);
  });

  it("refuses an operator without can_writeoff, even though the device asserted them", async () => {
    await post({
      deviceSeq: nextSeq(),
      operatorId: deniedOperatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN, "DN") }],
      createdAt: new Date().toISOString(),
    }).expect(403);
  });

  it("refuses an operator belonging to another tenant", async () => {
    await post({
      deviceSeq: nextSeq(),
      operatorId: foreignOperatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: km(GTIN, "FT") }],
      createdAt: new Date().toISOString(),
    }).expect(403);
  });

  it("refuses a reason belonging to another tenant", async () => {
    // 400, not 422: the kiosk already answers a bad writeoffReasonId that way
    // (`resolveWriteoffReasonId`), and the handheld inherits the contract.
    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: foreignReasonId,
      items: [{ rawKm: km(GTIN, "FR") }],
      createdAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an archived reason", async () => {
    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: archivedReasonId,
      items: [{ rawKm: km(GTIN, "AR") }],
      createdAt: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("reports partial acceptance instead of failing the request", async () => {
    const shared = km(GTIN, "PA");
    await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: shared }],
      createdAt: new Date().toISOString(),
    }).expect(201);

    const res = await post({
      deviceSeq: nextSeq(),
      operatorId,
      writeoffReasonId: reasonId,
      items: [{ rawKm: shared }, { rawKm: km(GTIN, "PB") }],
      createdAt: new Date().toISOString(),
    }).expect(201);
    expect(res.body.itemCount).toBe(1);
    expect(res.body.conflicts).toEqual([{ rawKm: shared, reason: "duplicate" }]);
  });

  it("rejects an unauthenticated request", async () => {
    await request(app!.getHttpServer())
      .post("/station/writeoffs")
      .send({
        deviceSeq: nextSeq(),
        operatorId,
        writeoffReasonId: reasonId,
        items: [{ rawKm: km(GTIN, "NA") }],
        createdAt: new Date().toISOString(),
      })
      .expect(401);
  });

  it("serves a bootstrap scoped to this tenant", async () => {
    const res = await request(app!.getHttpServer())
      .get("/station/writeoff-bootstrap")
      .set("x-api-key", apiKey)
      .expect(200);

    expect(typeof res.body.generatedAt).toBe("string");
    const reasonIds = res.body.reasons.map((r: { id: string }) => r.id);
    expect(reasonIds).toContain(reasonId);
    expect(reasonIds).not.toContain(archivedReasonId);
    expect(reasonIds).not.toContain(foreignReasonId);

    const gtins = res.body.products.map((p: { gtin14: string }) => p.gtin14);
    // The box registry names a product by id, not by GTIN, so the handheld's
    // mirror needs both to name a scanned box.
    for (const p of res.body.products as { id?: unknown }[]) expect(typeof p.id).toBe("string");
    expect(gtins).toEqual(expect.arrayContaining([GTIN, GTIN_UNLISTED]));

    expect(res.body.operators).toContainEqual({ employeeId: operatorId, canWriteoff: true });
    expect(res.body.operators).toContainEqual({
      employeeId: deniedOperatorId,
      canWriteoff: false,
    });
    expect(res.body.operators.map((o: { employeeId: string }) => o.employeeId)).not.toContain(
      foreignOperatorId,
    );
  });

  it("serves the box registry with the kiosk's page shape", async () => {
    const res = await request(app!.getHttpServer())
      .get("/station/box-registry")
      .set("x-api-key", apiKey)
      .expect(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
