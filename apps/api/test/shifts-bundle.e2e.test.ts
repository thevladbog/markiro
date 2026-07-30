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

  // CodeRabbit PR33 review, Finding 3: the box template column, schema, and
  // admin picker were all fully wired, but `getBundle` only ever resolved
  // `labelTemplate` off `shift.labelTemplateId` -- the ITEM template -- and
  // never touched `shift.boxLabelTemplateId` at all. The station therefore
  // had no way to print anything but the item template on a box label. This
  // pins the fix at the bundle level: a shift with its own distinct box
  // template returns that template's spec under a NEW `boxLabelTemplate`
  // field, clearly distinct from `labelTemplate`.
  it("GET /shifts/:id/bundle resolves boxLabelTemplateId into its own boxLabelTemplate field, distinct from labelTemplate (Finding 3)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const itemTemplateId = await seedLabelTemplate(orgId, "Item Template");
    const boxTemplateId = await seedLabelTemplate(orgId, "Box Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultLabelTemplateId: itemTemplateId,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", boxLabelTemplateId: boxTemplateId })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.boxLabelTemplateId).toBe(boxTemplateId);

    const bundle = await agent.get(`/shifts/${id}/bundle`).expect(200);
    expect(bundle.body.labelTemplate).toMatchObject({ id: itemTemplateId, name: "Item Template" });
    expect(bundle.body.boxLabelTemplate).toMatchObject({ id: boxTemplateId, name: "Box Template" });
    expect(bundle.body.boxLabelTemplate.spec).toMatchObject({ language: "zpl" });
    expect(bundle.body.boxLabelTemplate.id).not.toBe(bundle.body.labelTemplate.id);
  });

  // The absence case: no boxLabelTemplateId at all must resolve to null, not
  // a fallback to the item template or any other guess.
  it("GET /shifts/:id/bundle returns boxLabelTemplate: null when the shift has no box template set (Finding 3)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);
    const itemTemplateId = await seedLabelTemplate(orgId, "Item Only Template");
    const productId = await seedProduct(orgId, {
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
      defaultLabelTemplateId: itemTemplateId,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    const id = created.body.id as string;

    const bundle = await agent.get(`/shifts/${id}/bundle`).expect(200);
    expect(bundle.body.labelTemplate).toMatchObject({ id: itemTemplateId });
    expect(bundle.body.boxLabelTemplate).toBeNull();
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

    let agent: ReturnType<typeof request.agent>;
    let orgId: string;
    let stationKey: string;
    let shiftId: string;
    let issuerShiftId: string;
    let validationShiftId: string;

    beforeAll(async () => {
      agent = request.agent(app!.getHttpServer());
      orgId = await signUpAndActivate(agent);

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

    /** Snapshot of this tenant/issuer/extension-digit's sscc_blocks rows, for delta assertions. */
    async function blocksForOrgGln(): Promise<(typeof schema.ssccBlocks.$inferSelect)[]> {
      return db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, orgId),
            eq(schema.ssccBlocks.issuerPrefix, orgGln.slice(0, 9)),
            eq(schema.ssccBlocks.extensionDigit, 0),
          ),
        );
    }

    it("a second bundle fetch by the same device returns the held block and cuts no new one (Task 7 finding 3)", async () => {
      const first = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", stationKey)
        .expect(200);
      const rowsBefore = await blocksForOrgGln();

      const second = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", stationKey)
        .expect(200);
      const rowsAfter = await blocksForOrgGln();

      // No new sscc_blocks row for this device -- the bundle is not a
      // top-up channel (see SsccService.allocateForBundle's comment).
      expect(rowsAfter).toHaveLength(rowsBefore.length);
      // The device gets back the SAME range, not null: it may have lost its
      // local database and be re-provisioning, and the range it already
      // holds is the useful thing to hand it, not nothing.
      expect(second.body.sscc).toEqual(first.body.sscc);
    });

    it("a fetch by a different device for the same shift cuts its own block (Task 7 finding 3)", async () => {
      const otherDevice = await agent
        .post("/station-devices")
        .send({ name: "Second box-block terminal" })
        .expect(201);
      const otherKey = (otherDevice.body as { apiKey: string }).apiKey;
      const rowsBefore = await blocksForOrgGln();

      const res = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", otherKey)
        .expect(200);
      const rowsAfter = await blocksForOrgGln();

      expect(rowsAfter).toHaveLength(rowsBefore.length + 1);
      expect(res.body.sscc).not.toBeNull();
    });
  });

  describe("bundle degrades gracefully when numbers are unavailable (Task 7 finding 1)", () => {
    it("still returns product/template/roster with sscc: null when the tenant has no org GLN", async () => {
      const agent = request.agent(app!.getHttpServer());
      const orgId = await signUpAndActivate(agent);
      // Deliberately no PUT /org/profile -- this tenant never filled in a
      // GLN (the field is nullable, and a tenant may have no profile row at
      // all), which is exactly the fixture the review flagged: an
      // aggregation shift whose issuer prefix can never be resolved.
      const templateId = await seedLabelTemplate(orgId, "No-GLN Template");
      const productId = await seedProduct(orgId, {
        status: "active",
        productGroup: "Beverages",
        boxCapacity: 12,
        palletCapacity: 48,
        defaultLabelTemplateId: templateId,
      });
      const employee = await agent
        .post("/employees")
        .send({ fullName: "Оператор Без GLN" })
        .expect(201);
      await agent
        .put(`/operators/${employee.body.id}`)
        .send({ login: "3301", pin: "1234" })
        .expect(200);
      const shift = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation" })
        .expect(201);
      const shiftId = (shift.body as { id: string }).id;

      const device = await agent
        .post("/station-devices")
        .send({ name: "No-GLN terminal" })
        .expect(201);
      const apiKey = (device.body as { apiKey: string }).apiKey;

      const res = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", apiKey)
        .expect(200);

      expect(res.body.product).toMatchObject({ id: productId });
      expect(res.body.labelTemplate).toMatchObject({ id: templateId });
      expect(res.body.operators).toHaveLength(1);
      expect(res.body.sscc).toBeNull();
    });
  });

  describe("cross-tenant device lookup (Task 7 finding 2)", () => {
    it("a device row mistakenly tagged with another tenant is not resolved by that tenant's own api-key", async () => {
      // "Victim" tenant: exists only so its id can be written onto another
      // tenant's station_devices row below, simulating a data-integrity
      // slip. Nothing in the schema stops this: station_devices.api_key_id
      // carries no unique constraint of its own (see
      // sscc_blocks_tenant_device_fk's comment in platform.ts), so a
      // tenant-scoped WHERE clause is the ONLY thing standing between "a
      // row exists with this api-key id" and "MY tenant owns the row with
      // this api-key id".
      const victimAgent = request.agent(app!.getHttpServer());
      const victimOrgId = await signUpAndActivate(victimAgent);

      const callerAgent = request.agent(app!.getHttpServer());
      const callerOrgId = await signUpAndActivate(callerAgent);
      await callerAgent.put("/org/profile").send({ gln: "4601112222005" }).expect(200);
      const productId = await seedProduct(callerOrgId, {
        status: "active",
        productGroup: "Beverages",
        boxCapacity: 12,
        palletCapacity: 48,
      });
      const shift = await callerAgent
        .post("/shifts")
        .send({ productId, mode: "aggregation" })
        .expect(201);
      const shiftId = (shift.body as { id: string }).id;

      const device = await callerAgent
        .post("/station-devices")
        .send({ name: "Caller terminal" })
        .expect(201);
      const deviceId = (device.body as { deviceId: string }).deviceId;
      const apiKey = (device.body as { apiKey: string }).apiKey;

      // The row keeps the caller's real api-key id but now claims the
      // victim's tenantId -- TenantGuard must still resolve req.tenantId
      // from the api-key's own referenceId (Better Auth's record, untouched
      // by this update) and must refuse to hand back a device row that
      // doesn't ALSO belong to that tenant.
      await db
        .update(schema.stationDevices)
        .set({ tenantId: victimOrgId })
        .where(eq(schema.stationDevices.id, deviceId));

      const res = await request(app!.getHttpServer())
        .get(`/shifts/${shiftId}/bundle`)
        .set("x-api-key", apiKey)
        .expect(200);

      // No device resolves for the caller any more (the only row with this
      // api-key now belongs to the victim), so the bundle must degrade to
      // sscc: null rather than allocate against the victim-tagged row.
      expect(res.body.sscc).toBeNull();

      const blocks = await db
        .select()
        .from(schema.ssccBlocks)
        .where(eq(schema.ssccBlocks.deviceId, deviceId));
      expect(blocks).toHaveLength(0);
    });
  });
});
