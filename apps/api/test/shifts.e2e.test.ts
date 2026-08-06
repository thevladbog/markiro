import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("lines + shifts e2e", () => {
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

  // ---------------------------------------------------------------------
  // Lines CRUD
  // ---------------------------------------------------------------------

  it("GET /lines is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/lines").expect(401);
  });

  it("lines CRUD happy path: POST, GET list, PATCH, DELETE", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent.post("/lines").send({ name: "Line 1" }).expect(201);
    const id = createRes.body.id as string;
    expect(createRes.body).toMatchObject({ name: "Line 1" });
    expect(createRes.body.createdAt).toBeDefined();

    const listRes = await agent.get("/lines").expect(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0]).toMatchObject({ id, name: "Line 1" });

    const patchRes = await agent.patch(`/lines/${id}`).send({ name: "Line 1 Renamed" }).expect(200);
    expect(patchRes.body).toMatchObject({ id, name: "Line 1 Renamed" });

    await agent.delete(`/lines/${id}`).expect(204);
    await agent
      .get("/lines")
      .expect(200)
      .expect((res) => {
        expect(res.body.items).toHaveLength(0);
      });
  });

  it("cross-tenant isolation: org B cannot PATCH/DELETE org A's line", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);
    const createRes = await agent1.post("/lines").send({ name: "Org A Line" }).expect(201);
    const id = createRes.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.patch(`/lines/${id}`).send({ name: "Hijacked" }).expect(404);
    await agent2.delete(`/lines/${id}`).expect(404);
  });

  it("DELETE /lines/:id returns 409 if referenced by a shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const lineRes = await agent.post("/lines").send({ name: "Referenced Line" }).expect(201);
    const lineId = lineRes.body.id as string;

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 10,
      palletCapacity: 5,
    });

    await db.insert(schema.shifts).values({
      id: randomUUID(),
      tenantId: orgId,
      productId,
      lineId,
      mode: "validation",
    });

    const deleteRes = await agent.delete(`/lines/${lineId}`).expect(409);
    expect(deleteRes.body).toMatchObject({ message: expect.stringContaining("referenced") });
  });

  // ---------------------------------------------------------------------
  // Shifts: create + prefill/validation rules
  // ---------------------------------------------------------------------

  it("GET /shifts is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/shifts").expect(401);
  });

  it("POST /shifts prefills boxCapacity/palletCapacity/counterpartyId from an active product", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const counterpartyId = await seedCounterparty(orgId, "Default Buyer");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultCounterpartyId: counterpartyId,
    });

    const res = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);

    expect(res.body).toMatchObject({
      productId,
      mode: "aggregation",
      status: "planned",
      boxCapacity: 12,
      palletCapacity: 48,
      counterpartyId,
      palletsEnabled: false,
      createdFrom: "admin",
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
  });

  it("POST /shifts: explicit counterpartyId null overrides the product default", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const counterpartyId = await seedCounterparty(orgId, "Default Buyer");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultCounterpartyId: counterpartyId,
    });

    const res = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", counterpartyId: null })
      .expect(201);

    expect(res.body).toMatchObject({
      productId,
      counterpartyId: null,
      boxCapacity: 12,
      palletCapacity: 48,
    });
  });

  it("POST /shifts prefills labelTemplateId from the product's defaultLabelTemplateId", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const templateId = await seedLabelTemplate(orgId, "Product Default Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultLabelTemplateId: templateId,
    });

    const res = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);

    expect(res.body).toMatchObject({ productId, labelTemplateId: templateId });
  });

  it("POST /shifts: explicit labelTemplateId null overrides the product default (no effective template)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const templateId = await seedLabelTemplate(orgId, "Product Default Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultLabelTemplateId: templateId,
    });

    // aggregation mode is deliberately used here to pin the plan's rule that
    // a shift WITHOUT an effective label template is still allowed to be
    // created -- the printing station decides the fallback later.
    const res = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", labelTemplateId: null })
      .expect(201);

    expect(res.body).toMatchObject({ productId, labelTemplateId: null });
  });

  it("POST /shifts: an explicit labelTemplateId overrides the product default with its own", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const defaultTemplateId = await seedLabelTemplate(orgId, "Product Default Template");
    const ownTemplateId = await seedLabelTemplate(orgId, "Shift Own Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultLabelTemplateId: defaultTemplateId,
    });

    const res = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", labelTemplateId: ownTemplateId })
      .expect(201);

    expect(res.body).toMatchObject({ productId, labelTemplateId: ownTemplateId });
  });

  it("POST /shifts: no product default and no override -> labelTemplateId is null (allowed)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);

    expect(res.body).toMatchObject({ productId, labelTemplateId: null });
  });

  it("POST /shifts rejects a draft product with 422", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, { status: "draft" });

    const res = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(422);

    expect(res.body.message).toEqual(expect.stringContaining("Product card is incomplete"));
  });

  it("POST /shifts: aggregation mode without an effective boxCapacity is rejected with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    // Explicit null overrides the product's boxCapacity prefill -> effective boxCapacity is null.
    const res = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", boxCapacity: null })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("box capacity"));
  });

  it("POST /shifts: palletsEnabled without an effective palletCapacity is rejected with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "aggregation",
        palletsEnabled: true,
        palletCapacity: null,
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("pallet capacity"));
  });

  it("POST /shifts rejects a nonexistent productId with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/shifts")
      .send({ productId: randomUUID(), mode: "validation" })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown product"));
  });

  it("POST /shifts rejects a cross-tenant productId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const productId = await seedProduct(org1, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    const res = await agent2.post("/shifts").send({ productId, mode: "validation" }).expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown product"));
  });

  it("POST /shifts rejects a cross-tenant lineId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);
    const lineRes = await agent1.post("/lines").send({ name: "Org1 Line" }).expect(201);
    const lineId = lineRes.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpAndActivate(agent2);
    const productId = await seedProduct(org2, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent2
      .post("/shifts")
      .send({ productId, mode: "validation", lineId })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown line"));
  });

  it("POST /shifts rejects a cross-tenant counterpartyId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const counterpartyId = await seedCounterparty(org1, "Org1 Counterparty");

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpAndActivate(agent2);
    const productId = await seedProduct(org2, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent2
      .post("/shifts")
      .send({ productId, mode: "validation", counterpartyId })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown counterparty"));
  });

  it("POST /shifts rejects a cross-tenant labelTemplateId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const templateId = await seedLabelTemplate(org1, "Org1 Template");

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpAndActivate(agent2);
    const productId = await seedProduct(org2, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent2
      .post("/shifts")
      .send({ productId, mode: "validation", labelTemplateId: templateId })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown label template"));
  });

  // ---------------------------------------------------------------------
  // Shifts: explicit sscc issuer + box label template (Task 6) -- the issuer
  // is deliberately never inferred from counterpartyId (see the doc comment
  // on shifts.ssccIssuerCounterpartyId in platform.ts): a plant may pack for
  // a client (counterpartyId) while still stamping boxes with its own SSCCs,
  // or vice versa, so the two fields must be settable independently.
  // ---------------------------------------------------------------------

  it("stores an explicit sscc issuer distinct from the counterparty", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const buyerId = await seedCounterparty(orgId, "Buyer");
    const brandOwnerId = await seedCounterparty(orgId, "Brand Owner");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        counterpartyId: buyerId,
        ssccIssuerCounterpartyId: brandOwnerId,
      })
      .expect(201);

    expect(res.body.counterpartyId).toBe(buyerId);
    expect(res.body.ssccIssuerCounterpartyId).toBe(brandOwnerId);
  });

  it("defaults the sscc issuer to the tenant's own organisation", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);

    expect(res.body.ssccIssuerCounterpartyId).toBeNull();
  });

  it("rejects an sscc issuer from another tenant", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const otherTenantCounterpartyId = await seedCounterparty(org1, "Org1 Counterparty");

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpAndActivate(agent2);
    const productId = await seedProduct(org2, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent2
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        ssccIssuerCounterpartyId: otherTenantCounterpartyId,
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("sscc issuer"));
  });

  it("stores a boxLabelTemplateId distinct from the shift's own labelTemplateId", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const itemTemplateId = await seedLabelTemplate(orgId, "Item Template");
    const boxTemplateId = await seedLabelTemplate(orgId, "Box Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        labelTemplateId: itemTemplateId,
        boxLabelTemplateId: boxTemplateId,
      })
      .expect(201);

    expect(res.body.labelTemplateId).toBe(itemTemplateId);
    expect(res.body.boxLabelTemplateId).toBe(boxTemplateId);
  });

  it("rejects a cross-tenant boxLabelTemplateId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const templateId = await seedLabelTemplate(org1, "Org1 Box Template");

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpAndActivate(agent2);
    const productId = await seedProduct(org2, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const res = await agent2
      .post("/shifts")
      .send({ productId, mode: "validation", boxLabelTemplateId: templateId })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown box label template"));
  });

  it("PATCH /shifts/:id updates the sscc issuer and box label template independently of the counterparty and item template", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const buyerId = await seedCounterparty(orgId, "Buyer");
    const brandOwnerId = await seedCounterparty(orgId, "Brand Owner");
    const itemTemplateId = await seedLabelTemplate(orgId, "Item Template");
    const boxTemplateId = await seedLabelTemplate(orgId, "Box Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const createRes = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", counterpartyId: buyerId })
      .expect(201);
    const id = createRes.body.id as string;
    expect(createRes.body.ssccIssuerCounterpartyId).toBeNull();

    const patchRes = await agent
      .patch(`/shifts/${id}`)
      .send({
        ssccIssuerCounterpartyId: brandOwnerId,
        labelTemplateId: itemTemplateId,
        boxLabelTemplateId: boxTemplateId,
      })
      .expect(200);

    // counterpartyId is untouched by the PATCH -- a mutation that routed the
    // issuer update into the counterparty column instead would flip this.
    expect(patchRes.body.counterpartyId).toBe(buyerId);
    expect(patchRes.body.ssccIssuerCounterpartyId).toBe(brandOwnerId);
    expect(patchRes.body.labelTemplateId).toBe(itemTemplateId);
    expect(patchRes.body.boxLabelTemplateId).toBe(boxTemplateId);
  });

  // ---------------------------------------------------------------------
  // Shifts: PATCH/DELETE gated by planned status
  // ---------------------------------------------------------------------

  it("PATCH and DELETE /shifts/:id are rejected with 409 once the shift is no longer planned", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const createRes = await agent
      .post("/shifts")
      .send({ productId, mode: "validation" })
      .expect(201);
    const id = createRes.body.id as string;

    // Sanity: PATCH/DELETE work while still planned.
    await agent.patch(`/shifts/${id}`).send({ plannedQty: 100 }).expect(200);

    // Flip status via direct DB update (station activation is out of scope here).
    await db.update(schema.shifts).set({ status: "active" }).where(eq(schema.shifts.id, id));

    const patchRes = await agent.patch(`/shifts/${id}`).send({ plannedQty: 200 }).expect(409);
    expect(patchRes.body.message).toEqual(expect.stringContaining("planned"));

    const deleteRes = await agent.delete(`/shifts/${id}`).expect(409);
    expect(deleteRes.body.message).toEqual(expect.stringContaining("planned"));
  });

  it("cross-tenant isolation: org B cannot GET/PATCH/DELETE org A's shift", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const productId = await seedProduct(org1, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const createRes = await agent1
      .post("/shifts")
      .send({ productId, mode: "validation" })
      .expect(201);
    const id = createRes.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.get(`/shifts/${id}`).expect(404);
    await agent2.patch(`/shifts/${id}`).send({ plannedQty: 5 }).expect(404);
    await agent2.delete(`/shifts/${id}`).expect(404);
  });

  // ---------------------------------------------------------------------
  // Shifts: close
  // ---------------------------------------------------------------------

  it("POST /shifts/:id/close: 409 while planned, 200 from active with reason, 409 once closed", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const createRes = await agent
      .post("/shifts")
      .send({ productId, mode: "validation" })
      .expect(201);
    const id = createRes.body.id as string;

    // Still planned -> 409.
    await agent.post(`/shifts/${id}/close`).send({ reason: "test close" }).expect(409);

    // Missing/short reason -> 400 (validation gate applies regardless of current status).
    await db.update(schema.shifts).set({ status: "active" }).where(eq(schema.shifts.id, id));
    await agent.post(`/shifts/${id}/close`).send({ reason: "ab" }).expect(400);

    const closeRes = await agent
      .post(`/shifts/${id}/close`)
      .send({ reason: "Stuck at station, closing manually" })
      .expect(200);
    expect(closeRes.body).toMatchObject({ id, status: "closed" });
    expect(closeRes.body.closedAt).toBeDefined();
    expect(closeRes.body.closeReason).toBe("Stuck at station, closing manually");

    // Verify closeReason persists on subsequent GET.
    const getRes = await agent.get(`/shifts/${id}`).expect(200);
    expect(getRes.body.closeReason).toBe("Stuck at station, closing manually");

    // Already closed -> 409.
    await agent.post(`/shifts/${id}/close`).send({ reason: "test close again" }).expect(409);
  });

  // ---------------------------------------------------------------------
  // Shifts: list joins + filters
  // ---------------------------------------------------------------------

  it("GET /shifts joins productName/lineName/counterpartyName/labelTemplateName and supports status/date/line filters", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const counterpartyId = await seedCounterparty(orgId, "Joined Counterparty");
    const templateId = await seedLabelTemplate(orgId, "Joined Template");
    const productId = await seedProduct(orgId, {
      name: "Joined Product",
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultCounterpartyId: counterpartyId,
      defaultLabelTemplateId: templateId,
    });
    const lineRes = await agent.post("/lines").send({ name: "Joined Line" }).expect(201);
    const lineId = lineRes.body.id as string;
    const otherLineRes = await agent.post("/lines").send({ name: "Other Line" }).expect(201);
    const otherLineId = otherLineRes.body.id as string;

    const shift1 = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", lineId, plannedDate: "2026-01-10" })
      .expect(201);
    const shift2 = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", lineId, plannedDate: "2026-01-15" })
      .expect(201);
    const shift3 = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", lineId: otherLineId, plannedDate: "2026-01-20" })
      .expect(201);

    // Flip shift2 to active for the status filter assertion.
    await db
      .update(schema.shifts)
      .set({ status: "active" })
      .where(eq(schema.shifts.id, shift2.body.id));

    const allRes = await agent.get("/shifts").expect(200);
    expect(allRes.body.items.length).toBeGreaterThanOrEqual(3);
    const joined = allRes.body.items.find((item: { id: string }) => item.id === shift1.body.id);
    expect(joined).toMatchObject({
      productName: "Joined Product",
      lineName: "Joined Line",
      counterpartyName: "Joined Counterparty",
      labelTemplateId: templateId,
      labelTemplateName: "Joined Template",
    });

    const byStatus = await agent.get("/shifts").query({ status: "active" }).expect(200);
    expect(byStatus.body.items.map((i: { id: string }) => i.id)).toEqual([shift2.body.id]);

    const byLine = await agent.get("/shifts").query({ lineId }).expect(200);
    expect(byLine.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [shift1.body.id, shift2.body.id].sort(),
    );

    const byRange = await agent
      .get("/shifts")
      .query({ from: "2026-01-10", to: "2026-01-15" })
      .expect(200);
    expect(byRange.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [shift1.body.id, shift2.body.id].sort(),
    );

    expect(byRange.body.items.some((i: { id: string }) => i.id === shift3.body.id)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Device-key surface (Task 9): lines are cabinet-only; shifts is a mix --
  // the station's own four routes (list, create, open, bundle -- covered by
  // station-auth.e2e.test.ts, shifts-bundle.e2e.test.ts) stay reachable, but
  // get-by-id/patch/delete/close are cabinet-only since the station never
  // calls them (verified against apps/station/src). Routes carry no global
  // prefix -- only Better Auth's own `/api/auth/*` mount does -- so these are
  // `/station-devices`, `/lines`, `/shifts`, matching employees.e2e.test.ts.
  // ---------------------------------------------------------------------

  it("rejects a station api-key: lines are cabinet-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    const apiKey = device.apiKey;

    await request(app!.getHttpServer()).get("/lines").set("x-api-key", apiKey).expect(403);
  });

  it("still serves lines to a signed-in cabinet user", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    await agent.get("/lines").expect(200);
  });

  it("rejects a station api-key on shifts routes the station does not use, while keeping GET/POST /shifts reachable", async () => {
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

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    const apiKey = device.apiKey;
    const server = app!.getHttpServer();

    // Session-only: not part of the station's four routes.
    await request(server).get(`/shifts/${id}`).set("x-api-key", apiKey).expect(403);
    await request(server)
      .patch(`/shifts/${id}`)
      .set("x-api-key", apiKey)
      .send({ plannedQty: 5 })
      .expect(403);
    await request(server)
      .post(`/shifts/${id}/close`)
      .set("x-api-key", apiKey)
      .send({ reason: "station attempt" })
      .expect(403);
    await request(server).delete(`/shifts/${id}`).set("x-api-key", apiKey).expect(403);

    // Regression guard: the station's own routes stay reachable by the same key.
    await request(server).get("/shifts").set("x-api-key", apiKey).expect(200);
    const stationCreated = await request(server)
      .post("/shifts")
      .set("x-api-key", apiKey)
      .send({ productId, mode: "validation" })
      .expect(201);
    expect(stationCreated.body.productId).toBe(productId);
  });
});
