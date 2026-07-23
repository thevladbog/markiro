import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { schema, type Db } from "@markiro/db";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("shifts open + bundle e2e", () => {
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
      .send({ email, password: "Passw0rd!123", name: "T" })
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

  /** Direct-DB product seed (bypasses GTIN/status validation -- not under test here). */
  async function seedProduct(
    tenantId: string,
    overrides: Partial<typeof schema.products.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.products).values({
      id,
      tenantId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Seed Product",
      status: "draft",
      ...overrides,
    });
    return id;
  }

  /** Direct-DB counterparty seed (bypasses GLN validation -- not under test here). */
  async function seedCounterparty(tenantId: string, name = "Seed Counterparty"): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.counterparties).values({
      id,
      tenantId,
      name,
      gln: "6291041500213",
    });
    return id;
  }

  /** Direct-DB label template seed (bypasses domain spec validation -- not under test here). */
  async function seedLabelTemplate(tenantId: string, name = "Seed Template"): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id,
      tenantId,
      name,
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    return id;
  }

  it("POST /shifts/:id/open flips planned->active and sets openedAt; 409 if not planned", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = created.body.id as string;

    const opened = await agent.post(`/shifts/${id}/open`).expect(200);
    expect(opened.body).toMatchObject({ id, status: "active" });
    expect(opened.body.openedAt).toBeDefined();

    // Re-open once active -> 409.
    await agent.post(`/shifts/${id}/open`).expect(409);
  });

  it("GET /shifts/:id/bundle returns shift+product+labelTemplate+counterpartyGln and operators=[]", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const counterpartyId = await seedCounterparty(orgId, "Buyer");
    const templateId = await seedLabelTemplate(orgId, "Bundle Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultCounterpartyId: counterpartyId,
      defaultLabelTemplateId: templateId,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    const id = created.body.id as string;

    const bundle = await agent.get(`/shifts/${id}/bundle`).expect(200);
    expect(bundle.body.shift).toMatchObject({ id, productId });
    expect(bundle.body.product).toMatchObject({ id: productId, gtin14: expect.any(String) });
    expect(bundle.body.labelTemplate).toMatchObject({ id: templateId, name: "Bundle Template" });
    expect(bundle.body.labelTemplate.spec).toMatchObject({ language: "zpl" });
    expect(bundle.body.counterpartyGln).toBe("6291041500213");
    expect(bundle.body.operators).toEqual([]);
  });

  it("GET /shifts/:id/bundle is 404 for another tenant's shift", async () => {
    const a1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(a1);
    const productId = await seedProduct(org1, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const created = await a1.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const a2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(a2);
    await a2.get(`/shifts/${created.body.id}/bundle`).expect(404);
  });
});
