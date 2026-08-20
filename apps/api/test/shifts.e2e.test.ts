import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { shiftMonthKey } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, setOnlyOrganizationMemberRole } from "./support/auth";
import { createShiftSchema, updateShiftSchema } from "../src/modules/shifts/dto";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe("shift DTO compatibility boundary", () => {
  it("strips the retired labelTemplateId from create and update payloads", () => {
    const productId = randomUUID();
    const legacyTemplateId = randomUUID();

    expect(
      createShiftSchema.parse({
        productId,
        mode: "validation",
        labelTemplateId: legacyTemplateId,
      }),
    ).toEqual({ productId, mode: "validation" });
    expect(updateShiftSchema.parse({ plannedQty: 10, labelTemplateId: legacyTemplateId })).toEqual({
      plannedQty: 10,
    });
  });
});

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

  async function setDefaultBoxLabelTemplate(
    agent: ReturnType<typeof request.agent>,
    tenantId: string,
    name = "Default Box Template",
  ): Promise<string> {
    const id = await seedLabelTemplate(tenantId, name);
    await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: id }).expect(200);
    return id;
  }

  async function shiftRows(tenantId: string) {
    return db
      .select({ id: schema.shifts.id })
      .from(schema.shifts)
      .where(eq(schema.shifts.tenantId, tenantId));
  }

  it("lets a manager read only the box-template default needed for shift planning", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const defaultBoxLabelTemplateId = await setDefaultBoxLabelTemplate(agent, orgId);
    await setOnlyOrganizationMemberRole(db, orgId, "manager");

    // The full settings profile remains protected from managers.
    await agent.get("/org/profile").expect(403);

    const response = await agent.get("/shifts/planning-config").expect(200);
    expect(response.body).toEqual({ defaultBoxLabelTemplateId });
    expect(Object.keys(response.body)).toEqual(["defaultBoxLabelTemplateId"]);
  });

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
      numberMonthKey: "AUG25",
      numberSeq: 1,
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
    await setDefaultBoxLabelTemplate(agent, orgId);

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

  it("POST /shifts does not copy a seeded product item-label binding", async () => {
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
    const id = res.body.id as string;

    expect(res.body).not.toHaveProperty("labelTemplateId");
    expect(res.body).not.toHaveProperty("labelTemplateName");
    const [stored] = await db
      .select({ labelTemplateId: schema.shifts.labelTemplateId })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, orgId), eq(schema.shifts.id, id)));
    expect(stored?.labelTemplateId).toBeNull();
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
    await setDefaultBoxLabelTemplate(agent, orgId);

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
    await setDefaultBoxLabelTemplate(agent, orgId);

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

  it("GET/list/PATCH omit a seeded legacy item binding and PATCH leaves its column untouched", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const templateId = await seedLabelTemplate(orgId, "Legacy Item Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = created.body.id as string;
    await db
      .update(schema.shifts)
      .set({ labelTemplateId: templateId })
      .where(and(eq(schema.shifts.tenantId, orgId), eq(schema.shifts.id, id)));

    const getRes = await agent.get(`/shifts/${id}`).expect(200);
    const listRes = await agent.get("/shifts").expect(200);
    const patchRes = await agent
      .patch(`/shifts/${id}`)
      .send({ plannedQty: 25, labelTemplateId: null })
      .expect(200);

    for (const response of [getRes.body, patchRes.body]) {
      expect(response).not.toHaveProperty("labelTemplateId");
      expect(response).not.toHaveProperty("labelTemplateName");
    }
    const listed = listRes.body.items.find((item: { id: string }) => item.id === id);
    expect(listed).not.toHaveProperty("labelTemplateId");
    expect(listed).not.toHaveProperty("labelTemplateName");

    const [stored] = await db
      .select({ labelTemplateId: schema.shifts.labelTemplateId })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, orgId), eq(schema.shifts.id, id)));
    expect(stored?.labelTemplateId).toBe(templateId);
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

  it("stores an explicit boxLabelTemplateId without exposing an item-label binding", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

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
        boxLabelTemplateId: boxTemplateId,
      })
      .expect(201);

    expect(res.body).not.toHaveProperty("labelTemplateId");
    expect(res.body).not.toHaveProperty("labelTemplateName");
    expect(res.body.boxLabelTemplateId).toBe(boxTemplateId);
  });

  it("POST /shifts snapshots the organisation default box template when omitted", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const defaultTemplateId = await setDefaultBoxLabelTemplate(agent, orgId, "Original Default");
    const replacementTemplateId = await seedLabelTemplate(orgId, "Replacement Default");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    expect(created.body.boxLabelTemplateId).toBe(defaultTemplateId);

    await agent
      .put("/org/profile")
      .send({ defaultBoxLabelTemplateId: replacementTemplateId })
      .expect(200);
    const fetched = await agent.get(`/shifts/${created.body.id}`).expect(200);
    expect(fetched.body.boxLabelTemplateId).toBe(defaultTemplateId);
    const opened = await agent.post(`/shifts/${created.body.id}/open`).expect(200);
    expect(opened.body.boxLabelTemplateId).toBe(defaultTemplateId);
  });

  it("POST /shifts lets an explicit box template override the organisation default", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    await setDefaultBoxLabelTemplate(agent, orgId, "Ignored Default");
    const overrideTemplateId = await seedLabelTemplate(orgId, "Explicit Override");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", boxLabelTemplateId: overrideTemplateId })
      .expect(201);

    expect(created.body.boxLabelTemplateId).toBe(overrideTemplateId);
  });

  it.each([
    ["explicit null", { boxLabelTemplateId: null }],
    ["an absent organisation default", {}],
  ])(
    "POST /shifts rejects aggregation with %s using a stable scalar code and inserts no shift",
    async (_case, boxTemplateInput) => {
      const agent = request.agent(app!.getHttpServer());
      const orgId = await signUpAndActivate(agent);
      const productId = await seedProduct(orgId, {
        status: "active",
        productGroup: "Beverages",
        boxCapacity: 12,
        palletCapacity: 48,
      });
      const before = await shiftRows(orgId);

      const response = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation", ...boxTemplateInput })
        .expect(422);

      expect(response.body).toMatchObject({
        code: "BOX_LABEL_TEMPLATE_REQUIRED",
        message: "Aggregation shifts require a box label template",
      });
      expect(response.body.code).toBeTypeOf("string");
      expect(JSON.stringify(response.body)).not.toContain(productId);
      expect(await shiftRows(orgId)).toEqual(before);
    },
  );

  it("POST /shifts accepts an explicit null box template for validation", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    await setDefaultBoxLabelTemplate(agent, orgId);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", boxLabelTemplateId: null })
      .expect(201);

    expect(created.body.boxLabelTemplateId).toBeNull();
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
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(org1);
    expect(serialized).not.toContain(org2);
    expect(serialized).not.toContain(templateId);
    expect(serialized).not.toContain("shifts_tenant_box_label_template_fk");
  });

  it("PATCH /shifts/:id updates the sscc issuer and box label template independently", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const buyerId = await seedCounterparty(orgId, "Buyer");
    const brandOwnerId = await seedCounterparty(orgId, "Brand Owner");
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
        boxLabelTemplateId: boxTemplateId,
      })
      .expect(200);

    // counterpartyId is untouched by the PATCH -- a mutation that routed the
    // issuer update into the counterparty column instead would flip this.
    expect(patchRes.body.counterpartyId).toBe(buyerId);
    expect(patchRes.body.ssccIssuerCounterpartyId).toBe(brandOwnerId);
    expect(patchRes.body).not.toHaveProperty("labelTemplateId");
    expect(patchRes.body).not.toHaveProperty("labelTemplateName");
    expect(patchRes.body.boxLabelTemplateId).toBe(boxTemplateId);
  });

  it("PATCH validation -> aggregation uses the shift snapshot without re-resolving the organisation default", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const snapshottedTemplateId = await setDefaultBoxLabelTemplate(agent, orgId, "Snapshot");
    const currentDefaultId = await seedLabelTemplate(orgId, "Current Default");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    expect(created.body.boxLabelTemplateId).toBe(snapshottedTemplateId);

    await agent
      .put("/org/profile")
      .send({ defaultBoxLabelTemplateId: currentDefaultId })
      .expect(200);
    const updated = await agent
      .patch(`/shifts/${created.body.id}`)
      .send({ mode: "aggregation" })
      .expect(200);

    expect(updated.body.mode).toBe("aggregation");
    expect(updated.body.boxLabelTemplateId).toBe(snapshottedTemplateId);
  });

  it("PATCH validation -> aggregation rejects a null merged snapshot with the stable 422 code", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", boxLabelTemplateId: null })
      .expect(201);

    const response = await agent
      .patch(`/shifts/${created.body.id}`)
      .send({ mode: "aggregation" })
      .expect(422);
    expect(response.body).toMatchObject({
      code: "BOX_LABEL_TEMPLATE_REQUIRED",
      message: "Aggregation shifts require a box label template",
    });
    const unchanged = await agent.get(`/shifts/${created.body.id}`).expect(200);
    expect(unchanged.body).toMatchObject({ mode: "validation", boxLabelTemplateId: null });
  });

  it("PATCH validation -> aggregation accepts an explicit box template override", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const boxTemplateId = await seedLabelTemplate(orgId, "Adopted Box Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", boxLabelTemplateId: null })
      .expect(201);

    const updated = await agent
      .patch(`/shifts/${created.body.id}`)
      .send({ mode: "aggregation", boxLabelTemplateId: boxTemplateId })
      .expect(200);

    expect(updated.body).toMatchObject({
      mode: "aggregation",
      boxLabelTemplateId: boxTemplateId,
    });
  });

  it("PATCH /shifts/:id updates safe metadata on an active shift and rejects operational changes", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const line = await agent.post("/lines").send({ name: "Corrected line" }).expect(201);
    await setDefaultBoxLabelTemplate(agent, orgId, "Initial active template");
    const boxTemplateId = await seedLabelTemplate(orgId, "Active box template");
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    await agent.post(`/shifts/${created.body.id as string}/open`).expect(200);

    const updated = await agent
      .patch(`/shifts/${created.body.id as string}`)
      .send({
        lineId: line.body.id,
        plannedDate: "2026-08-14",
        plannedQty: 750,
        boxLabelTemplateId: boxTemplateId,
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      status: "active",
      lineId: line.body.id,
      plannedDate: "2026-08-14",
      plannedQty: 750,
      boxLabelTemplateId: boxTemplateId,
      mode: "aggregation",
    });
    const rejected = await agent
      .patch(`/shifts/${created.body.id as string}`)
      .send({ mode: "validation" })
      .expect(409);
    expect(rejected.body.message).toContain("mode");
  });

  // ---------------------------------------------------------------------
  // Shifts: operational PATCH and DELETE remain gated by planned status
  // ---------------------------------------------------------------------

  it("operational PATCH and DELETE /shifts/:id are rejected once the shift is active", async () => {
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

    const patchRes = await agent.patch(`/shifts/${id}`).send({ mode: "aggregation" }).expect(409);
    expect(patchRes.body.message).toEqual(expect.stringContaining("mode"));

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

  it("GET /shifts joins current names and supports status/date/line filters", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const counterpartyId = await seedCounterparty(orgId, "Joined Counterparty");
    const productId = await seedProduct(orgId, {
      name: "Joined Product",
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultCounterpartyId: counterpartyId,
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
    });
    expect(joined).not.toHaveProperty("labelTemplateId");
    expect(joined).not.toHaveProperty("labelTemplateName");

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

  it("defaults a station shift list to its assigned line plus unassigned shifts without restricting explicit tenant filters", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const lineRes = await agent.post("/lines").send({ name: "Station line" }).expect(201);
    const stationLineId = lineRes.body.id as string;
    const otherLineRes = await agent.post("/lines").send({ name: "Other line" }).expect(201);
    const otherLineId = otherLineRes.body.id as string;

    const [assigned, unassigned, otherLine] = await Promise.all([
      agent
        .post("/shifts")
        .send({ productId, mode: "validation", lineId: stationLineId })
        .expect(201),
      agent.post("/shifts").send({ productId, mode: "validation" }).expect(201),
      agent
        .post("/shifts")
        .send({ productId, mode: "validation", lineId: otherLineId })
        .expect(201),
    ]);
    const station = await createTestStationDevice(app!, agent, "Shift-list terminal");
    await db
      .update(schema.stationDevices)
      .set({ lineId: stationLineId })
      .where(
        and(
          eq(schema.stationDevices.tenantId, orgId),
          eq(schema.stationDevices.id, station.deviceId),
        ),
      );

    const server = app!.getHttpServer();
    const stationDefault = await request(server)
      .get("/shifts")
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(stationDefault.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [assigned.body.id, unassigned.body.id].sort(),
    );

    // A supplied line remains a tenant-scoped filter, not a station authorization boundary.
    const stationExplicit = await request(server)
      .get("/shifts")
      .query({ lineId: otherLineId })
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(stationExplicit.body.items.map((item: { id: string }) => item.id)).toEqual([
      otherLine.body.id,
    ]);

    const cabinet = await agent.get("/shifts").expect(200);
    expect(cabinet.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [assigned.body.id, unassigned.body.id, otherLine.body.id].sort(),
    );
  });

  it("keeps a station with no assigned line on the existing tenant-wide shift list", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const lineRes = await agent.post("/lines").send({ name: "First line" }).expect(201);
    const firstLineId = lineRes.body.id as string;
    const otherLineRes = await agent.post("/lines").send({ name: "Second line" }).expect(201);
    const secondLineId = otherLineRes.body.id as string;
    const [firstLineShift, unassignedShift, secondLineShift] = await Promise.all([
      agent
        .post("/shifts")
        .send({ productId, mode: "validation", lineId: firstLineId })
        .expect(201),
      agent.post("/shifts").send({ productId, mode: "validation" }).expect(201),
      agent
        .post("/shifts")
        .send({ productId, mode: "validation", lineId: secondLineId })
        .expect(201),
    ]);
    // The fixture deliberately leaves station_devices.line_id as NULL.
    const station = await createTestStationDevice(app!, agent, "Unassigned shift-list terminal");

    const result = await request(app!.getHttpServer())
      .get("/shifts")
      .set("x-api-key", station.apiKey)
      .expect(200);

    expect(result.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [firstLineShift.body.id, unassignedShift.body.id, secondLineShift.body.id].sort(),
    );
  });

  // ---------------------------------------------------------------------
  // Device-key surface (Task 9): lines are cabinet-only; shifts is a mix --
  // the station's own five routes (list, create, open, bundle, reference bundle -- covered by
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

    const assignedLine = await agent.post("/lines").send({ name: "Assigned line" }).expect(201);
    const spoofedLine = await agent.post("/lines").send({ name: "Spoofed line" }).expect(201);
    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    await db
      .update(schema.stationDevices)
      .set({ lineId: assignedLine.body.id as string })
      .where(
        and(
          eq(schema.stationDevices.tenantId, orgId),
          eq(schema.stationDevices.id, device.deviceId),
        ),
      );
    const apiKey = device.apiKey;
    const server = app!.getHttpServer();

    // Session-only: not part of the station's five routes.
    await request(server).get(`/shifts/${id}`).set("x-api-key", apiKey).expect(403);
    await request(server).get("/shifts/planning-config").set("x-api-key", apiKey).expect(403);
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
      .send({ productId, mode: "validation", lineId: spoofedLine.body.id })
      .expect(201);
    expect(stationCreated.body).toMatchObject({
      productId,
      lineId: assignedLine.body.id,
      createdFrom: "station",
      plannedDate: null,
    });
  });

  // ---------------------------------------------------------------------
  // Shift numbers (Task 3): immutable AUG26-003-style numbers, per-tenant
  // per-month sequences, /S suffix for station-created shifts.
  // ---------------------------------------------------------------------

  describe("shift numbers", () => {
    let agent: ReturnType<typeof request.agent>;
    let productId: string;
    let apiKey: string;

    // Fresh organization for this whole describe block so its per-month
    // counters start at 001 deterministically, unaffected by shifts created
    // in the tests above.
    beforeAll(async () => {
      agent = request.agent(app!.getHttpServer());
      const orgId = await signUpAndActivate(agent);
      productId = await seedProduct(orgId, { status: "active" });
      const device = await createTestStationDevice(app!, agent, "Numbers terminal");
      apiKey = device.apiKey;
    });

    function stationPost(body: Record<string, unknown>) {
      return request(app!.getHttpServer()).post("/shifts").set("x-api-key", apiKey).send(body);
    }

    it("assigns sequential per-month numbers and restarts across months", async () => {
      const a = await agent
        .post("/shifts")
        .send({ productId, mode: "validation", plannedDate: "2031-08-05" })
        .expect(201);
      const b = await agent
        .post("/shifts")
        .send({ productId, mode: "validation", plannedDate: "2031-08-20" })
        .expect(201);
      const c = await agent
        .post("/shifts")
        .send({ productId, mode: "validation", plannedDate: "2031-09-01" })
        .expect(201);

      expect(a.body.number).toBe("AUG31-001");
      expect(b.body.number).toBe("AUG31-002");
      expect(c.body.number).toBe("SEP31-001");
    });

    it("suffixes /S for station-created shifts and shares the month sequence", async () => {
      const first = await agent
        .post("/shifts")
        .send({ productId, mode: "validation", plannedDate: "2031-10-01" })
        .expect(201);
      const second = await stationPost({
        productId,
        mode: "validation",
        plannedDate: "2031-10-02",
      }).expect(201);

      expect(first.body.number).toBe("OCT31-001");
      expect(second.body.number).toBe("OCT31-002/S");
    });

    it("keeps the number when plannedDate moves to another month", async () => {
      const created = await agent
        .post("/shifts")
        .send({ productId, mode: "validation", plannedDate: "2031-11-05" })
        .expect(201);
      expect(created.body.number).toBe("NOV31-001");

      const updated = await agent
        .patch(`/shifts/${created.body.id}`)
        .send({ plannedDate: "2031-12-05" })
        .expect(200);
      expect(updated.body.number).toBe("NOV31-001");
    });

    it("falls back to the creation month when plannedDate is omitted", async () => {
      const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
      const todayKey = shiftMonthKey(new Date().toISOString().slice(0, 10));
      expect((created.body.number as string).startsWith(`${todayKey}-`)).toBe(true);
    });

    it("lists shifts by real date, newest first", async () => {
      // Fresh org/agent so only these three shifts exist for the list.
      const listAgent = request.agent(app!.getHttpServer());
      const listOrgId = await signUpAndActivate(listAgent);
      const listProductId = await seedProduct(listOrgId, { status: "active" });

      const early = await listAgent
        .post("/shifts")
        .send({ productId: listProductId, mode: "validation", plannedDate: "2020-01-01" })
        .expect(201);
      const late = await listAgent
        .post("/shifts")
        .send({ productId: listProductId, mode: "validation", plannedDate: "2020-03-01" })
        .expect(201);
      const dateless = await listAgent
        .post("/shifts")
        .send({ productId: listProductId, mode: "validation" })
        .expect(201); // real date = today

      const list = await listAgent.get("/shifts").expect(200);
      const ids = list.body.items.map((item: { id: string }) => item.id as string);
      expect(ids).toEqual([dateless.body.id, late.body.id, early.body.id]);
    });
  });
});
