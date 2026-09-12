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
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/** A minimal, valid label-template spec with at least one element. */
function specWithElements() {
  return {
    widthMm: 100,
    heightMm: 150,
    dpi: 203,
    language: "zpl" as const,
    elements: [{ kind: "text" as const, id: "t1", xMm: 2, yMm: 2, text: "Pallet", fontSizePt: 12 }],
  };
}

interface ShiftLike {
  id: string;
  palletBoxCapacity: number | null;
  palletLabelTemplateId: string | null;
}

interface ShiftBundleLike {
  palletLabelTemplate: { id: string; name: string; spec: { elements: unknown[] } } | null;
}

describe.skipIf(!ready)("shift pallet configuration (task 8)", () => {
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

  /** Direct-DB product seed (bypasses GTIN/status validation -- not under test here). */
  async function seedProductRow(
    tenantId: string,
    overrides: Partial<typeof schema.products.$inferInsert> = {},
  ): Promise<{ id: string }> {
    const id = randomUUID();
    await db.insert(schema.products).values({
      id,
      tenantId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Pallet fixture product",
      status: "active",
      chzProductGroupCode: 8,
      boxCapacity: 20,
      palletBoxCapacity: 12,
      ...overrides,
    });
    return { id };
  }

  /** Direct-DB box-purpose label template seed. */
  async function seedLabelTemplate(tenantId: string, name = "Box Template"): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id,
      tenantId,
      name,
      purpose: "box",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    return id;
  }

  /** Direct-DB pallet-purpose label template seed, with a non-empty spec. */
  async function seedPalletLabelTemplate(
    tenantId: string,
    name = "Pallet Template",
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id,
      tenantId,
      name,
      purpose: "pallet",
      spec: specWithElements(),
    });
    return id;
  }

  async function setDefaultBoxLabelTemplate(
    agent: ReturnType<typeof request.agent>,
    tenantId: string,
  ): Promise<string> {
    const id = await seedLabelTemplate(tenantId, "Default Box Template");
    await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: id }).expect(200);
    return id;
  }

  async function setOrgDefaultPalletTemplate(tenantId: string, templateId: string): Promise<void> {
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, defaultPalletLabelTemplateId: templateId })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { defaultPalletLabelTemplateId: templateId },
      });
  }

  async function setCategoryPalletDefault(
    tenantId: string,
    chzProductGroupCode: number,
    templateId: string,
  ): Promise<void> {
    await db
      .insert(schema.orgPalletLabelTemplateDefaults)
      .values({ tenantId, chzProductGroupCode, templateId })
      .onConflictDoUpdate({
        target: [
          schema.orgPalletLabelTemplateDefaults.tenantId,
          schema.orgPalletLabelTemplateDefaults.chzProductGroupCode,
        ],
        set: { templateId },
      });
  }

  /**
   * A fresh tenant with a default box template and a default product, ready
   * to create shifts against. Every test gets its own tenant so mutating one
   * test's org/category defaults can never bleed into another test.
   */
  async function setupOrg(): Promise<{
    agent: ReturnType<typeof request.agent>;
    tenantId: string;
    boxTemplateId: string;
    productId: string;
  }> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const boxTemplateId = await setDefaultBoxLabelTemplate(agent, tenantId);
    const { id: productId } = await seedProductRow(tenantId);
    return { agent, tenantId, boxTemplateId, productId };
  }

  /** POSTs /shifts and throws the supertest Response (status included) on failure. */
  async function postShift(
    agent: ReturnType<typeof request.agent>,
    defaultProductId: string,
    overrides: Record<string, unknown>,
  ): Promise<ShiftLike> {
    const res = await agent.post("/shifts").send({ productId: defaultProductId, ...overrides });
    if (res.status >= 400) throw res;
    return res.body as ShiftLike;
  }

  async function getBundle(shiftId: string, apiKey: string): Promise<ShiftBundleLike> {
    const res = await request(app!.getHttpServer())
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", apiKey)
      .expect(200);
    return res.body as ShiftBundleLike;
  }

  it("refuses pallets without a box count", async () => {
    const { agent, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);

    await expect(
      createShift({
        mode: "aggregation",
        palletsEnabled: true,
        boxCapacity: 20,
        palletBoxCapacity: null,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses pallets without a box capacity", async () => {
    const { agent, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);

    await expect(
      createShift({
        mode: "aggregation",
        palletsEnabled: true,
        boxCapacity: null,
        palletBoxCapacity: 12,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("still refuses pallets to a tenant without the entitlement", async () => {
    const { agent, tenantId, productId } = await setupOrg();
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
      labelEditorEnabled: true,
      publicApiEnabled: true,
      palletsEnabled: false,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);

    await expect(
      createShift({
        mode: "aggregation",
        palletsEnabled: true,
        boxCapacity: 20,
        palletBoxCapacity: 12,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("prefills the box count from the product", async () => {
    const { agent, tenantId, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);
    const createProduct = (overrides: Partial<typeof schema.products.$inferInsert>) =>
      seedProductRow(tenantId, overrides);

    const product = await createProduct({ boxCapacity: 20, palletBoxCapacity: 12 });
    const shift = await createShift({
      productId: product.id,
      mode: "aggregation",
      palletsEnabled: true,
    });
    expect(shift.palletBoxCapacity).toBe(12);
  });

  it("resolves the pallet template by category, then organisation, then none", async () => {
    const { agent, tenantId, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);

    const orgTemplate = { id: await seedPalletLabelTemplate(tenantId, "Org Pallet Default") };
    const categoryTemplate = {
      id: await seedPalletLabelTemplate(tenantId, "Category 8 Pallet Default"),
    };
    const productInGroup8 = await seedProductRow(tenantId, { chzProductGroupCode: 8 });
    const productInGroup3 = await seedProductRow(tenantId, { chzProductGroupCode: 3 });

    await setOrgDefaultPalletTemplate(tenantId, orgTemplate.id);
    await setCategoryPalletDefault(tenantId, 8, categoryTemplate.id);

    const inCategory = await createShift({
      productId: productInGroup8.id,
      mode: "aggregation",
      palletsEnabled: true,
    });
    expect(inCategory.palletLabelTemplateId).toBe(categoryTemplate.id);

    const otherCategory = await createShift({
      productId: productInGroup3.id,
      mode: "aggregation",
      palletsEnabled: true,
    });
    expect(otherCategory.palletLabelTemplateId).toBe(orgTemplate.id);
  });

  it("refuses a pallet template whose purpose is not pallet", async () => {
    const { agent, boxTemplateId, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);
    const boxTemplate = { id: boxTemplateId };

    await expect(
      createShift({
        mode: "aggregation",
        palletsEnabled: true,
        boxCapacity: 20,
        palletBoxCapacity: 12,
        palletLabelTemplateId: boxTemplate.id,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  /**
   * The converse of the case above, and the half that 06d's widened
   * `purposeSchema` puts at risk: now that a tenant can mint pallet
   * templates of its own, a pallet template is a value an operator can
   * actually pick in the BOX slot by mistake. It must still be refused.
   */
  it("refuses a pallet template in the box-label slot", async () => {
    const { agent, tenantId, productId } = await setupOrg();
    const palletTemplateId = await seedPalletLabelTemplate(tenantId, "Pallet In Box Slot");

    await expect(
      postShift(agent, productId, {
        mode: "aggregation",
        boxCapacity: 20,
        boxLabelTemplateId: palletTemplateId,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not enable pallets on a validation shift", async () => {
    const { agent, productId } = await setupOrg();
    const createShift = (overrides: Record<string, unknown>) =>
      postShift(agent, productId, overrides);

    await expect(
      createShift({ mode: "validation", palletsEnabled: true, palletBoxCapacity: 12 }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("ships the pallet template spec, not just its id", async () => {
    const { agent, tenantId, productId } = await setupOrg();
    const palletTemplateId = await seedPalletLabelTemplate(tenantId);
    await setOrgDefaultPalletTemplate(tenantId, palletTemplateId);
    const device = await createTestStationDevice(app!, agent, "Pallet spec terminal");

    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", palletsEnabled: true })
      .expect(201);
    const shiftWithPallets = { id: created.body.id as string };
    await agent.post(`/shifts/${shiftWithPallets.id}/open`).expect(200);

    const bundle = await getBundle(shiftWithPallets.id, device.apiKey);
    expect(bundle.palletLabelTemplate?.spec.elements.length).toBeGreaterThan(0);
  });

  it("ships no pallet template for a shift without pallets", async () => {
    const { agent, productId } = await setupOrg();
    const device = await createTestStationDevice(app!, agent, "No-pallet terminal");

    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", palletsEnabled: false })
      .expect(201);
    const shiftWithoutPallets = { id: created.body.id as string };
    await agent.post(`/shifts/${shiftWithoutPallets.id}/open`).expect(200);

    expect((await getBundle(shiftWithoutPallets.id, device.apiKey)).palletLabelTemplate).toBeNull();
  });

  it("refuses opening a planned shift whose pallets are enabled with no boxes-per-pallet count", async () => {
    // A shift planned before this slice (or with capacities cleared by a
    // later PATCH) can hold palletsEnabled with a null capacity; opening it
    // must fail loudly rather than hand a terminal an unfulfillable
    // configuration -- see assertPalletConfiguration's call in openShift.
    const { agent, tenantId, productId } = await setupOrg();
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation", palletsEnabled: true, palletBoxCapacity: 12 })
      .expect(201);
    const shiftId = created.body.id as string;

    // Bypass the DTO validation to reach the state a pre-existing planned
    // shift could have been left in.
    await db
      .update(schema.shifts)
      .set({ palletBoxCapacity: null })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));

    const res = await agent.post(`/shifts/${shiftId}/open`).send();
    expect(res.status).toBe(422);
  });
});
