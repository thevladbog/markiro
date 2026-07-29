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
import { listenOnLoopback } from "./support/listen-loopback";

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

  it("GET /shifts/:id/bundle returns shift+product+labelTemplate+counterpartyGln and the operator roster", async () => {
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
    const employee = await agent
      .post("/employees")
      .send({ fullName: "Оператор Бандла" })
      .expect(201);
    await agent
      .put(`/operators/${employee.body.id}`)
      .send({ login: "3300", pin: "1234" })
      .expect(200);
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
    expect(bundle.body.operators).toHaveLength(1);
    expect(bundle.body.operators[0]).toMatchObject({
      operatorId: employee.body.id,
      name: "Оператор Бандла",
      login: "3300",
      role: "operator",
      badgeHash: null,
      active: true,
    });
    expect(bundle.body.operators[0].pinHash).toMatch(/^pbkdf2\$sha256\$100000\$/);
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

  // Regression guard (Task 9): open + bundle are two of the station's four
  // routes (list, create, open, bundle -- verified against
  // apps/station/src/lib/shift-bundle.ts and pages/ShiftSelection.tsx) and
  // must stay reachable by a station api-key even after SessionOnlyGuard was
  // added elsewhere on this controller. Routes carry no global prefix, so
  // these are `/station-devices` and `/shifts`, matching employees.e2e.test.ts.
  it("a station api-key can open a shift and fetch its bundle", async () => {
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

    const device = await agent
      .post("/station-devices")
      .send({ name: "Line 1 terminal" })
      .expect(201);
    const apiKey = (device.body as { apiKey: string }).apiKey;
    const server = app!.getHttpServer();

    const opened = await request(server)
      .post(`/shifts/${id}/open`)
      .set("x-api-key", apiKey)
      .expect(200);
    expect(opened.body).toMatchObject({ id, status: "active" });

    const bundle = await request(server)
      .get(`/shifts/${id}/bundle`)
      .set("x-api-key", apiKey)
      .expect(200);
    expect(bundle.body.shift).toMatchObject({ id, productId });
  });

  describe("box serial block on the bundle (Task 7)", () => {
    // Two distinct, check-digit-shaped GLNs so a bug that swapped the
    // organisation's own issuer for the shift's explicit one (or vice versa)
    // shows up as the WRONG prefix rather than an accidental match.
    const orgGln = "4601112222005";
    const counterpartyGln = "4609876543008";

    let stationKey: string;
    let shiftId: string;
    let issuerShiftId: string;
    let validationShiftId: string;

    beforeAll(async () => {
      const agent = request.agent(app!.getHttpServer());
      const orgId = await signUpAndActivate(agent);

      await agent.put("/org/profile").send({ gln: orgGln }).expect(200);

      const counterparty = await agent
        .post("/counterparties")
        .send({ name: "Issuer Co", gln: counterpartyGln })
        .expect(201);
      const counterpartyId = (counterparty.body as { id: string }).id;

      const productId = await seedProduct(orgId, {
        status: "active",
        productGroup: "Beverages",
        boxCapacity: 12,
        palletCapacity: 48,
      });

      // sscc_blocks.device_id carries a real FK to station_devices -- the
      // block must be attributed to an actual enrolled device, not an
      // invented uuid (see sscc.e2e.test.ts's registerDevice).
      const device = await agent
        .post("/station-devices")
        .send({ name: "Box-block terminal" })
        .expect(201);
      stationKey = (device.body as { apiKey: string }).apiKey;

      const plain = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation" })
        .expect(201);
      shiftId = (plain.body as { id: string }).id;

      const issuer = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation", ssccIssuerCounterpartyId: counterpartyId })
        .expect(201);
      issuerShiftId = (issuer.body as { id: string }).id;

      const validation = await agent
        .post("/shifts")
        .send({ productId, mode: "validation" })
        .expect(201);
      validationShiftId = (validation.body as { id: string }).id;
    });

    it("carries a box serial block for the shift's issuer", async () => {
      const res = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", stationKey)
        .expect(200);
      expect(res.body.sscc.issuerPrefix).toBe(orgGln.slice(0, 9));
      expect(res.body.sscc.extensionDigit).toBe(0);
      expect(res.body.sscc.toSerial).toBeGreaterThan(res.body.sscc.fromSerial);
    });

    it("carries the counterparty's numbers when the shift names an issuer", async () => {
      const res = await request(app!.getHttpServer())
        .get(`/shifts/${issuerShiftId}/bundle`)
        .set("x-api-key", stationKey)
        .expect(200);
      expect(res.body.sscc.issuerPrefix).toBe(counterpartyGln.slice(0, 9));
    });

    it("does not allocate for a validation-mode shift", async () => {
      const res = await request(app!.getHttpServer())
        .get(`/shifts/${validationShiftId}/bundle`)
        .set("x-api-key", stationKey)
        .expect(200);
      expect(res.body.sscc).toBeNull();
    });
  });
});
