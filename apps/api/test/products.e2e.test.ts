import { randomUUID } from "node:crypto";
import express from "express";
import sharp from "sharp";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";

/**
 * GTIN test vectors. Computed with node + @markiro/domain's gs1CheckDigit
 * (see packages/domain/src/gs1/check-digit.ts) via:
 *   node -e "const {gs1CheckDigit}=require('./packages/domain/dist/index.js');
 *            console.log(body12 + gs1CheckDigit(body12))"
 * `normalizeToGtin14` just zero-pads to 14 chars -- leading zeros don't
 * change the weighted mod-10 sum, so an EAN-13 and its already-padded
 * GTIN-14 form share the same check digit and collide as duplicates.
 *
 * gtinMatchesPrefix(gtin14, prefix) tests whether `gtin14.slice(1)` (the
 * 13-digit body+check-digit, once the GTIN-14 indicator/pad digit is
 * stripped) starts with `prefix` -- so for an EAN-13 input (normalized by
 * prepending a single "0"), the prefix must match the leading digits of
 * the original 13-digit code itself.
 *
 * Vectors:
 * - "4006381333931" (brief's canonical EAN-13) -> gtin14 "04006381333931"
 * - "4006381333930" -- same body, corrupted check digit -> GTIN_INVALID
 * - "1234567890"    -- 10 digits, not a valid GTIN length -> GTIN_INVALID
 * - "4006382000009" / "4006383000008" -- two more valid EAN-13s (body
 *   "400638200000"/"400638300000" + computed check digit) for search/filter
 *   tests needing two distinct products in one tenant.
 * - Owner-detection prefixes, each with body = prefix + "00001" (12 digits)
 *   + computed check digit:
 *     - own prefix "4600000"      -> EAN-13 "4600000000015"
 *     - counterparty prefix "4600001" -> EAN-13 "4600001000014"
 *     - unmatched prefix "9999999"     -> EAN-13 "9999999000010"
 */
const EAN13_CANONICAL = "4006381333931";
const GTIN14_CANONICAL_PADDED = "04006381333931"; // same value as EAN13_CANONICAL, pre-padded
const GTIN14_CANONICAL = "04006381333931";
const EAN13_BAD_CHECK_DIGIT = "4006381333930";
const GTIN_WRONG_LENGTH = "1234567890";
const EAN13_WIDGET_A = "4006382000009";
const GTIN14_WIDGET_A = "04006382000009";
const EAN13_WIDGET_B = "4006383000008";

const OWN_PREFIX = "4600000";
const EAN13_OWN = "4600000000015";
const GTIN14_OWN = "04600000000015";
const COUNTERPARTY_PREFIX = "4600001";
const EAN13_COUNTERPARTY = "4600001000014";
const GTIN14_COUNTERPARTY = "04600001000014";
const UNKNOWN_PREFIX_GTIN = "9999999000010";
const GTIN14_UNKNOWN = "09999999000010";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/** Direct-DB label template seed (bypasses domain spec validation -- not under test here). */
async function seedLabelTemplate(
  db: Db,
  tenantId: string,
  name = "Seed Template",
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.labelTemplates).values({
    id,
    tenantId,
    name,
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  });
  return id;
}

describe.skipIf(!ready)("products e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  const storedObjects = new Map<string, Buffer>();
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(async (key: string, body: Buffer) => {
      storedObjects.set(key, body);
    }),
    delete: vi.fn(async (key: string) => {
      storedObjects.delete(key);
    }),
    presignRead: vi.fn(async (key: string) => `https://signed.invalid/${encodeURIComponent(key)}`),
  };

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();

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

  beforeEach(() => {
    storedObjects.clear();
    vi.clearAllMocks();
    storage.ensureBucket.mockResolvedValue(undefined);
    storage.put.mockImplementation(async (key: string, body: Buffer) => {
      storedObjects.set(key, body);
    });
    storage.delete.mockImplementation(async (key: string) => {
      storedObjects.delete(key);
    });
    storage.presignRead.mockImplementation(
      async (key: string) => `https://signed.invalid/${encodeURIComponent(key)}`,
    );
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

  async function actorForTenant(tenantId: string): Promise<string> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected tenant owner fixture");
    return member.userId;
  }

  async function productImageFixture(background = "#2463eb"): Promise<Buffer> {
    return sharp({ create: { width: 640, height: 320, channels: 3, background } })
      .jpeg()
      .toBuffer();
  }

  it("GET /products is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/products").expect(401);
  });

  it("POST /products normalizes an EAN-13 gtin to gtin14 and defaults to draft", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Minimal Widget" })
      .expect(201);

    expect(res.body).toMatchObject({
      gtin14: GTIN14_CANONICAL,
      name: "Minimal Widget",
      productGroup: null,
      boxCapacity: null,
      palletCapacity: null,
      status: "draft",
      defaultCounterpartyId: null,
      defaultLabelTemplateId: null,
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
  });

  it("POST /products rejects an invalid GTIN (bad check digit) with 400 GTIN_INVALID", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/products")
      .send({ gtin: EAN13_BAD_CHECK_DIGIT, name: "Bad Widget" })
      .expect(400);

    expect(res.body.code).toEqual("GTIN_INVALID");
  });

  it("POST /products rejects a wrong-length GTIN with 400 GTIN_INVALID", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/products")
      .send({ gtin: GTIN_WRONG_LENGTH, name: "Wrong Length Widget" })
      .expect(400);

    expect(res.body.code).toEqual("GTIN_INVALID");
  });

  it("POST /products rejects a duplicate (tenant, gtin14) with 409, across formats", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    await agent.post("/products").send({ gtin: EAN13_CANONICAL, name: "First Widget" }).expect(201);

    // Same gtin14, submitted as an already-padded GTIN-14 this time.
    const res = await agent
      .post("/products")
      .send({ gtin: GTIN14_CANONICAL_PADDED, name: "Duplicate Widget" })
      .expect(409);

    expect(res.body.message).toEqual(expect.stringContaining("already exists"));
  });

  it("status flips draft -> active -> draft as capacities/group are patched/cleared", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Flip Widget" })
      .expect(201);
    const id = createRes.body.id as string;
    expect(createRes.body.status).toEqual("draft");

    const activateRes = await agent
      .patch(`/products/${id}`)
      .send({ productGroup: "Beverages", boxCapacity: 12, palletCapacity: 48 })
      .expect(200);
    expect(activateRes.body).toMatchObject({
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });

    const downgradeRes = await agent
      .patch(`/products/${id}`)
      .send({ palletCapacity: null })
      .expect(200);
    expect(downgradeRes.body).toMatchObject({
      status: "draft",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: null,
    });
  });

  it("gtin-check: own prefix (org profile) -> owner=own", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    await agent
      .put("/org/profile")
      .send({ gs1Prefixes: [OWN_PREFIX] })
      .expect(200);

    const res = await agent.post("/products/gtin-check").send({ gtin: EAN13_OWN }).expect(200);
    expect(res.body).toEqual({ gtin14: GTIN14_OWN, owner: "own" });
  });

  it("gtin-check: counterparty prefix -> owner=counterparty with id/name", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    await agent
      .put("/org/profile")
      .send({ gs1Prefixes: [OWN_PREFIX] })
      .expect(200);
    const cpRes = await agent
      .post("/counterparties")
      .send({
        name: "GS1 Partner Co",
        gln: "6291041500213",
        gs1Prefixes: [COUNTERPARTY_PREFIX],
      })
      .expect(201);

    const res = await agent
      .post("/products/gtin-check")
      .send({ gtin: EAN13_COUNTERPARTY })
      .expect(200);
    expect(res.body).toEqual({
      gtin14: GTIN14_COUNTERPARTY,
      owner: "counterparty",
      counterpartyId: cpRes.body.id,
      counterpartyName: "GS1 Partner Co",
    });
  });

  it("gtin-check: no matching prefix -> owner=unknown", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    await agent
      .put("/org/profile")
      .send({ gs1Prefixes: [OWN_PREFIX] })
      .expect(200);
    await agent
      .post("/counterparties")
      .send({
        name: "GS1 Partner Co",
        gln: "6291041500213",
        gs1Prefixes: [COUNTERPARTY_PREFIX],
      })
      .expect(201);

    const res = await agent
      .post("/products/gtin-check")
      .send({ gtin: UNKNOWN_PREFIX_GTIN })
      .expect(200);
    expect(res.body).toEqual({ gtin14: GTIN14_UNKNOWN, owner: "unknown" });
  });

  it("cross-tenant isolation: org B cannot GET/PATCH/DELETE org A's product", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);

    const createRes = await agent1
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Org A Widget" })
      .expect(201);
    const id = createRes.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.get(`/products/${id}`).expect(404);
    await agent2.patch(`/products/${id}`).send({ name: "Hijacked" }).expect(404);
    await agent2.delete(`/products/${id}`).expect(404);
  });

  it("GET /products supports search (name substring, gtin14 prefix) and status filters", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const widgetRes = await agent
      .post("/products")
      .send({ gtin: EAN13_WIDGET_A, name: "Alpha Widget" })
      .expect(201);
    await agent.post("/products").send({ gtin: EAN13_WIDGET_B, name: "Beta Gadget" }).expect(201);

    await agent
      .patch(`/products/${widgetRes.body.id}`)
      .send({ productGroup: "Snacks", boxCapacity: 10, palletCapacity: 20 })
      .expect(200);

    const byName = await agent.get("/products").query({ search: "Widget" }).expect(200);
    expect(byName.body.items).toHaveLength(1);
    expect(byName.body.items[0]).toMatchObject({ name: "Alpha Widget" });

    const byGtinPrefix = await agent
      .get("/products")
      .query({ search: GTIN14_WIDGET_A.slice(0, 9) })
      .expect(200);
    expect(byGtinPrefix.body.items).toHaveLength(1);
    expect(byGtinPrefix.body.items[0]).toMatchObject({ gtin14: GTIN14_WIDGET_A });

    const activeOnly = await agent.get("/products").query({ status: "active" }).expect(200);
    expect(activeOnly.body.items).toHaveLength(1);
    expect(activeOnly.body.items[0]).toMatchObject({ name: "Alpha Widget" });

    const draftOnly = await agent.get("/products").query({ status: "draft" }).expect(200);
    expect(draftOnly.body.items).toHaveLength(1);
    expect(draftOnly.body.items[0]).toMatchObject({ name: "Beta Gadget" });
  });

  it("DELETE /products/:id returns 409 if referenced by a shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Referenced Widget" })
      .expect(201);
    const productId = createRes.body.id as string;

    // Seed a shift that references the product (direct DB insert).
    await db.insert(schema.shifts).values({
      id: randomUUID(),
      tenantId: orgId,
      productId,
      mode: "validation",
    });

    const deleteRes = await agent.delete(`/products/${productId}`).expect(409);
    expect(deleteRes.body).toMatchObject({
      message: expect.stringContaining("referenced"),
    });
  });

  it("DELETE /products/:id succeeds when unreferenced", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Deletable Widget" })
      .expect(201);
    const id = createRes.body.id as string;

    await agent.delete(`/products/${id}`).expect(204);
    await agent.get(`/products/${id}`).expect(404);
  });

  it("POST /products rejects a nonexistent defaultCounterpartyId with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Bad Counterparty",
        defaultCounterpartyId: randomUUID(),
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown counterparty"));
  });

  it("POST /products rejects a cross-tenant defaultCounterpartyId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);

    // Create a counterparty in org 1
    const cpRes = await agent1
      .post("/counterparties")
      .send({
        name: "Org1 Counterparty",
        gln: "6291041500213",
        gs1Prefixes: [],
      })
      .expect(201);
    const counterpartyId = cpRes.body.id as string;

    // Create agent2 (different org) and try to use org1's counterparty
    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    const res = await agent2
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Cross-Tenant Counterparty",
        defaultCounterpartyId: counterpartyId,
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown counterparty"));
  });

  it("POST /products accepts a defaultLabelTemplateId and PATCH can clear it back to null", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const templateId = await seedLabelTemplate(db, orgId, "Bottle Template");

    const createRes = await agent
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Template",
        defaultLabelTemplateId: templateId,
      })
      .expect(201);
    expect(createRes.body.defaultLabelTemplateId).toEqual(templateId);
    const id = createRes.body.id as string;

    const clearRes = await agent
      .patch(`/products/${id}`)
      .send({ defaultLabelTemplateId: null })
      .expect(200);
    expect(clearRes.body.defaultLabelTemplateId).toBeNull();
  });

  it("PATCH /products/:id omitting defaultLabelTemplateId leaves it unchanged", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const templateId = await seedLabelTemplate(db, orgId, "Kept Template");
    const createRes = await agent
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Kept Template",
        defaultLabelTemplateId: templateId,
      })
      .expect(201);
    const id = createRes.body.id as string;

    const patchRes = await agent.patch(`/products/${id}`).send({ name: "Renamed" }).expect(200);
    expect(patchRes.body).toMatchObject({ name: "Renamed", defaultLabelTemplateId: templateId });
  });

  it("POST /products rejects a nonexistent defaultLabelTemplateId with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Bad Template",
        defaultLabelTemplateId: randomUUID(),
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown label template"));
  });

  it("POST /products rejects a cross-tenant defaultLabelTemplateId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const templateId = await seedLabelTemplate(db, org1, "Org1 Template");

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    const res = await agent2
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Widget with Cross-Tenant Template",
        defaultLabelTemplateId: templateId,
      })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown label template"));
  });

  it("PATCH /products/:id rejects a cross-tenant defaultLabelTemplateId with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const templateId = await seedLabelTemplate(db, org1, "Org1 Template");

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);
    const createRes = await agent2
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Org2 Widget" })
      .expect(201);
    const id = createRes.body.id as string;

    const res = await agent2
      .patch(`/products/${id}`)
      .send({ defaultLabelTemplateId: templateId })
      .expect(400);

    expect(res.body.message).toEqual(expect.stringContaining("Unknown label template"));
  });

  it("POST /products accepts unitPrice, egaisCode, externalRef and GET returns them; PATCH unitPrice: null clears it", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({
        gtin: EAN13_CANONICAL,
        name: "Product with Price",
        unitPrice: "52.00",
        egaisCode: "0123456789",
        externalRef: "ext-ref-001",
      })
      .expect(201);

    expect(createRes.body).toMatchObject({
      gtin14: GTIN14_CANONICAL,
      name: "Product with Price",
      unitPrice: "52.00",
      egaisCode: "0123456789",
      externalRef: "ext-ref-001",
    });

    const id = createRes.body.id as string;

    // GET /products returns the fields
    const getRes = await agent.get(`/products/${id}`).expect(200);
    expect(getRes.body).toMatchObject({
      unitPrice: "52.00",
      egaisCode: "0123456789",
      externalRef: "ext-ref-001",
    });

    // PATCH unitPrice to null clears it
    const patchRes = await agent.patch(`/products/${id}`).send({ unitPrice: null }).expect(200);
    expect(patchRes.body).toMatchObject({
      unitPrice: null,
      egaisCode: "0123456789", // should remain unchanged
      externalRef: "ext-ref-001", // should remain unchanged
    });

    // Verify the clear persists
    const verifyRes = await agent.get(`/products/${id}`).expect(200);
    expect(verifyRes.body).toMatchObject({
      unitPrice: null,
      egaisCode: "0123456789",
      externalRef: "ext-ref-001",
    });
  });

  it("uploads, enriches, replaces, reads, and idempotently deletes a private product image", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const actorUserId = await actorForTenant(tenantId);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Image Widget" })
      .expect(201);
    const productId = created.body.id as string;
    expect(created.body.image).toBeNull();

    const first = await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture("#2463eb"), {
        filename: "source-one.jpg",
        contentType: "image/jpeg",
      })
      .expect(201);
    expect(first.body.image).toMatchObject({
      contentType: "image/webp",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteSize: expect.any(Number),
      width: 640,
      height: 320,
    });
    expect(first.body).not.toHaveProperty("assetId");
    expect(first.body).not.toHaveProperty("objectKey");
    expect(first.body.image).not.toHaveProperty("assetId");
    expect(first.body.image).not.toHaveProperty("objectKey");

    const [firstAsset] = await db
      .select({
        id: schema.mediaAssets.id,
        ownerTenantId: schema.mediaAssets.ownerTenantId,
        ownerUserId: schema.mediaAssets.ownerUserId,
        objectKey: schema.mediaAssets.objectKey,
        contentType: schema.mediaAssets.contentType,
        byteSize: schema.mediaAssets.byteSize,
        checksum: schema.mediaAssets.checksum,
        width: schema.mediaAssets.width,
        height: schema.mediaAssets.height,
        status: schema.mediaAssets.status,
      })
      .from(schema.productImages)
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
      .where(
        and(
          eq(schema.productImages.tenantId, tenantId),
          eq(schema.productImages.productId, productId),
        ),
      );
    expect(firstAsset).toMatchObject({
      ownerTenantId: tenantId,
      ownerUserId: null,
      objectKey: expect.stringMatching(
        new RegExp(`^tenants/${tenantId}/products/${productId}/[a-f0-9-]+\\.webp$`),
      ),
      contentType: "image/webp",
      byteSize: first.body.image.byteSize,
      checksum: first.body.image.checksum,
      width: 640,
      height: 320,
      status: "active",
    });
    expect(storedObjects.get(firstAsset!.objectKey)).toBeDefined();

    const detail = await agent.get(`/products/${productId}`).expect(200);
    expect(detail.body.image).toEqual(first.body.image);
    const list = await agent.get("/products").expect(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: productId, image: first.body.image }),
    ]);
    const updated = await agent
      .patch(`/products/${productId}`)
      .send({ name: "Image Widget Updated" })
      .expect(200);
    expect(updated.body.image).toEqual(first.body.image);

    const read = await agent
      .get(`/products/${productId}/image/${first.body.image.checksum}`)
      .redirects(0)
      .expect(302);
    expect(read.headers.location).toBe(
      `https://signed.invalid/${encodeURIComponent(firstAsset!.objectKey)}`,
    );
    expect(storage.presignRead).toHaveBeenCalledWith(firstAsset!.objectKey, 300);

    const second = await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture("#dc2626"), {
        filename: "source-two.png",
        contentType: "image/png",
      })
      .expect(201);
    expect(second.body.image.checksum).not.toBe(first.body.image.checksum);
    await agent.get(`/products/${productId}/image/${first.body.image.checksum}`).expect(404);
    expect(storedObjects.has(firstAsset!.objectKey)).toBe(false);
    expect(
      await db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, firstAsset!.id)),
    ).toHaveLength(0);

    const audits = await db
      .select({
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        before: schema.tenantAuditEvents.before,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, productId),
        ),
      )
      .orderBy(schema.tenantAuditEvents.createdAt);
    expect(audits).toEqual([
      {
        actorUserId,
        action: "product.image.uploaded",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: { image: null },
        after: { image: first.body.image },
      },
      {
        actorUserId,
        action: "product.image.replaced",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: { image: first.body.image },
        after: { image: second.body.image },
      },
    ]);

    await agent.delete(`/products/${productId}/image`).expect(204);
    await agent.delete(`/products/${productId}/image`).expect(204);
    expect((await agent.get(`/products/${productId}`).expect(200)).body.image).toBeNull();
    const finalAudits = await db
      .select({
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, productId),
        ),
      )
      .orderBy(schema.tenantAuditEvents.createdAt);
    expect(finalAudits).toEqual([
      { action: "product.image.uploaded", outcome: "success" },
      { action: "product.image.replaced", outcome: "success" },
      { action: "product.image.deleted", outcome: "success" },
    ]);
  });

  it("rejects invalid and oversized image sources without storing an object", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Bounded Widget" })
      .expect(201);
    const productId = created.body.id as string;

    await agent
      .post(`/products/${productId}/image`)
      .attach("image", Buffer.from("<svg><script>alert(1)</script></svg>"), {
        filename: "not-an-image.svg",
        contentType: "image/svg+xml",
      })
      .expect(400);
    await agent
      .post(`/products/${productId}/image`)
      .attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: "too-large.png",
        contentType: "image/png",
      })
      .expect(413);

    expect(storage.put).not.toHaveBeenCalled();
    expect((await agent.get(`/products/${productId}`).expect(200)).body.image).toBeNull();
  });

  it("masks unknown and foreign product image operations as 404 before storage", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    const created = await owner
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Tenant A Image" })
      .expect(201);
    const productId = created.body.id as string;
    const outsider = request.agent(app!.getHttpServer());
    await signUpAndActivate(outsider);

    await outsider
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture(), "foreign.jpg")
      .expect(404);
    await outsider.delete(`/products/${productId}/image`).expect(404);
    await outsider.get(`/products/${productId}/image/${"a".repeat(64)}`).expect(404);
    await outsider
      .post(`/products/${randomUUID()}/image`)
      .attach("image", await productImageFixture(), "unknown.jpg")
      .expect(404);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("keeps the current image when object storage fails and records safe failure metadata", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const actorUserId = await actorForTenant(tenantId);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Storage Failure Widget" })
      .expect(201);
    const productId = created.body.id as string;
    storage.put.mockRejectedValueOnce(new Error("private storage detail"));

    await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture(), "failure.jpg")
      .expect(503, {
        message: "Product image storage is unavailable",
        error: "Service Unavailable",
        statusCode: 503,
      });

    expect((await agent.get(`/products/${productId}`).expect(200)).body.image).toBeNull();
    const [staging] = await db
      .select({
        id: schema.mediaAssets.id,
        checksum: schema.mediaAssets.checksum,
        status: schema.mediaAssets.status,
      })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.ownerTenantId, tenantId))
      .orderBy(schema.mediaAssets.createdAt);
    expect(staging).toMatchObject({
      status: "staging",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const [audit] = await db
      .select({
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, productId),
        ),
      );
    expect(audit).toEqual({
      actorUserId,
      action: "product.image.uploaded",
      outcome: "failure",
      targetType: "product",
      targetId: productId,
      after: {
        attemptedImage: expect.objectContaining({
          checksum: staging!.checksum,
          contentType: "image/webp",
        }),
        reason: "storage_unavailable",
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/objectKey|assetId|private storage detail/);
  });

  it("serializes concurrent replacements and retains exactly one active current image", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Concurrent Widget" })
      .expect(201);
    const productId = created.body.id as string;
    await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture("#111827"), "initial.jpg")
      .expect(201);

    let releaseUploads!: () => void;
    const uploadsReady = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    let pendingUploads = 0;
    storage.put.mockImplementation(async (key: string, body: Buffer) => {
      pendingUploads += 1;
      if (pendingUploads === 2) releaseUploads();
      await uploadsReady;
      storedObjects.set(key, body);
    });
    const [red, green] = await Promise.all([
      agent
        .post(`/products/${productId}/image`)
        .attach("image", await productImageFixture("#dc2626"), "red.jpg"),
      agent
        .post(`/products/${productId}/image`)
        .attach("image", await productImageFixture("#16a34a"), "green.jpg"),
    ]);
    expect(red.status).toBe(201);
    expect(green.status).toBe(201);

    const current = await agent.get(`/products/${productId}`).expect(200);
    expect([red.body.image.checksum, green.body.image.checksum]).toContain(
      current.body.image.checksum,
    );
    const active = await db
      .select({ id: schema.mediaAssets.id })
      .from(schema.productImages)
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .where(
        and(
          eq(schema.productImages.tenantId, tenantId),
          eq(schema.productImages.productId, productId),
        ),
      );
    expect(active).toHaveLength(1);
    expect(storedObjects.size).toBe(1);
  });

  it("preserves the old image when the transactional switch fails", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Switch Failure Widget" })
      .expect(201);
    const productId = created.body.id as string;
    const initial = await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture("#111827"), "initial.jpg")
      .expect(201);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `fail_product_image_switch_${suffix}`;
    const triggerName = `fail_product_image_switch_${suffix}`;
    await setup.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'forced product image switch failure'; end $$`,
    );
    await setup.pool.query(
      `create trigger ${triggerName} before update on product_images for each row execute function ${functionName}()`,
    );
    try {
      await agent
        .post(`/products/${productId}/image`)
        .attach("image", await productImageFixture("#f59e0b"), "replacement.jpg")
        .expect(503);
    } finally {
      await setup.pool.query(`drop trigger ${triggerName} on product_images`);
      await setup.pool.query(`drop function ${functionName}()`);
    }

    expect((await agent.get(`/products/${productId}`).expect(200)).body.image).toEqual(
      initial.body.image,
    );
    const assets = await db
      .select({ status: schema.mediaAssets.status })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.ownerTenantId, tenantId));
    expect(assets.map(({ status }: { status: string }) => status).sort()).toEqual([
      "active",
      "staging",
    ]);
  });

  it("marks product media deleting before product cascade and leaves retryable cleanup", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Delete Cleanup Widget" })
      .expect(201);
    const productId = created.body.id as string;
    await agent
      .post(`/products/${productId}/image`)
      .attach("image", await productImageFixture(), "delete.jpg")
      .expect(201);
    storage.delete.mockRejectedValueOnce(new Error("S3 unavailable"));

    await agent.delete(`/products/${productId}`).expect(204);
    const references = await db
      .select({ productId: schema.productImages.productId })
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId));
    const [asset] = await db
      .select({ status: schema.mediaAssets.status })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.ownerTenantId, tenantId));
    expect(references).toHaveLength(0);
    expect(asset).toEqual({ status: "deleting" });
  });

  // ---------------------------------------------------------------------
  // Device-key surface (Task 9): the station only ever calls GET /products
  // (search) and POST /products/gtin-check (see
  // apps/station/src/pages/NewShift.tsx) -- get-by-id and every mutation are
  // cabinet-only. Routes carry no global prefix -- only Better Auth's own
  // `/api/auth/*` mount does -- so these are `/station-devices` and
  // `/products`, matching employees.e2e.test.ts.
  // ---------------------------------------------------------------------

  it("rejects a station api-key on product routes the station does not use, while keeping GET/gtin-check reachable", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Device Surface Widget" })
      .expect(201);
    const id = createRes.body.id as string;

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    const apiKey = device.apiKey;
    const server = app!.getHttpServer();

    // Session-only: not part of the station's two routes.
    await request(server).get(`/products/${id}`).set("x-api-key", apiKey).expect(403);
    await request(server)
      .post("/products")
      .set("x-api-key", apiKey)
      .send({ gtin: EAN13_WIDGET_A, name: "Should Not Create" })
      .expect(403);
    await request(server)
      .patch(`/products/${id}`)
      .set("x-api-key", apiKey)
      .send({ name: "Hijacked" })
      .expect(403);
    await request(server).delete(`/products/${id}`).set("x-api-key", apiKey).expect(403);

    // Regression guard: the station's own routes stay reachable by the same
    // key. The station never calls a bare `GET /products` -- `NewShift.tsx`
    // always searches by the scanned gtin14 (`/products?search=<gtin14>`) --
    // so assert the actual call shape, not just an unfiltered list.
    const search = await request(server)
      .get("/products")
      .query({ search: GTIN14_CANONICAL })
      .set("x-api-key", apiKey)
      .expect(200);
    expect(search.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, gtin14: GTIN14_CANONICAL })]),
    );
    const gtinCheck = await request(server)
      .post("/products/gtin-check")
      .set("x-api-key", apiKey)
      .send({ gtin: EAN13_CANONICAL })
      .expect(200);
    expect(gtinCheck.body).toMatchObject({ gtin14: GTIN14_CANONICAL });
  });

  it("still serves the full products CRUD to a signed-in cabinet user", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/products")
      .send({ gtin: EAN13_CANONICAL, name: "Cabinet Widget" })
      .expect(201);
    const id = createRes.body.id as string;
    await agent.get(`/products/${id}`).expect(200);
    await agent.patch(`/products/${id}`).send({ name: "Cabinet Widget 2" }).expect(200);
    await agent.delete(`/products/${id}`).expect(204);
  });
});
