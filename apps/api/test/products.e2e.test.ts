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

describe.skipIf(!ready)("products e2e", () => {
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
});
