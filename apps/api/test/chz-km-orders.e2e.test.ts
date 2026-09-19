import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.CHZ_TOKEN_ENCRYPTION_KEY,
);

const FIXTURE_GTIN = "04607034690014";
const OMS_ID = "cdf12109-10d3-11e6-8b6f-0050569977a1";
const OMS_CONNECTION = "b7f0c8b0-10d3-11e6-8b6f-0050569977a1";
// `chz_product_groups` (migration 0099) seeds code 15 as alias "beer", and
// `CHZ_UNIT_TEMPLATE_ID_BY_GROUP.beer` (packages/domain/src/chz/km-orders.ts)
// is 18 -- both asserted against directly below.
const BEER_GROUP_CODE = 15;
const BEER_TEMPLATE_ID = 18;

type Agent = ReturnType<typeof request.agent>;

describe.skipIf(!ready)("chz-km-orders cabinet e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let crypto: ChzCryptoService;
  const seededTenantIds: string[] = [];

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    db = ref.get(DB);
    crypto = new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY);
  });

  afterAll(async () => {
    if (seededTenantIds.length > 0) {
      await db
        .delete(schema.chzKmOrders)
        .where(inArray(schema.chzKmOrders.tenantId, seededTenantIds));
    }
    await app?.close();
  });

  async function seedProduct(
    tenantId: string,
    overrides: Partial<typeof schema.products.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.products).values({
      id,
      tenantId,
      gtin14: FIXTURE_GTIN,
      name: "KM order fixture product",
      status: "active",
      ...overrides,
    });
    return id;
  }

  /** Satisfies every pre-flight condition: settings, a paired agent, a usable token, and a supported product. */
  async function readyTenant(): Promise<{ agent: Agent; tenantId: string; productId: string }> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    seededTenantIds.push(tenantId);

    await db.insert(schema.integrationChannels).values({
      tenantId,
      type: "chestny_znak",
      settings: { environment: "sandbox", omsId: OMS_ID, omsConnection: OMS_CONNECTION },
    });

    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "KM-ORDER-PC", appVersion: "0.1.0" })
      .expect(201);

    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const productId = await seedProduct(tenantId, { chzProductGroupCode: BEER_GROUP_CODE });
    return { agent, tenantId, productId };
  }

  it("refuses an order until СУЗ settings, an agent and a token exist", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    seededTenantIds.push(tenantId);
    const productId = await seedProduct(tenantId, { chzProductGroupCode: BEER_GROUP_CODE });

    const res = await agent.post("/chz-km-orders").send({ productId, quantity: 10 }).expect(422);
    expect(res.body).toMatchObject({
      code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
      blockedBy: expect.arrayContaining([
        "OMS_SETTINGS_MISSING",
        "AGENT_NOT_PAIRED",
        "OMS_TOKEN_UNAVAILABLE",
      ]),
    });
  });

  it("creates an order in state created with the exact request body and lists it", async () => {
    const { agent, productId } = await readyTenant();
    const created = await agent
      .post("/chz-km-orders")
      .send({ productId, quantity: 10, contactPerson: "Ковалёва М. А." })
      .expect(201);
    expect(created.body).toMatchObject({
      state: "created",
      quantity: 10,
      gtin14: FIXTURE_GTIN,
      templateId: BEER_TEMPLATE_ID,
      fetchedCount: 0,
      issuedCount: 0,
    });

    const [row] = await db
      .select()
      .from(schema.chzKmOrders)
      .where(eq(schema.chzKmOrders.id, created.body.id));
    expect(JSON.parse(row!.requestBody)).toMatchObject({
      productGroup: "beer",
      products: [
        {
          gtin: FIXTURE_GTIN,
          quantity: 10,
          templateId: BEER_TEMPLATE_ID,
          cisType: "UNIT",
          serialNumberType: "OPERATOR",
        },
      ],
      attributes: {
        releaseMethodType: "PRODUCTION",
        contactPerson: "Ковалёва М. А.",
        productionOrderId: created.body.id,
      },
    });

    const list = await agent.get("/chz-km-orders").expect(200);
    expect(list.body.orders.map((o: { id: string }) => o.id)).toContain(created.body.id);
  });

  it("denies another tenant's order", async () => {
    const { agent, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);

    const other = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(other);
    seededTenantIds.push(otherTenantId);

    await other.get(`/chz-km-orders/${created.body.id}`).expect(404);
    await other.post(`/chz-km-orders/${created.body.id}/retry`).expect(404);
  });

  it("refuses retry unless the order failed", async () => {
    const { agent, productId } = await readyTenant();
    const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);

    await agent.post(`/chz-km-orders/${created.body.id}/retry`).expect(409);
  });
});
