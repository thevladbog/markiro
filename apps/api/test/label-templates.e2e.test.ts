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

/**
 * A minimal, valid `LabelTemplateSpec` (see packages/domain/src/labels/model.ts)
 * used as the CRUD happy-path fixture. Kept intentionally small -- exact
 * spec round-tripping is what's under test, not domain coverage (that's
 * packages/domain/test/labels-model.test.ts's job).
 */
const VALID_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "Hello", fontSizePt: 12 }],
};

const VALID_SPEC_V2 = {
  widthMm: 100,
  heightMm: 150,
  dpi: 300,
  language: "tspl",
  elements: [{ kind: "field", id: "f1", xMm: 5, yMm: 5, field: "product.name", fontSizePt: 10 }],
};

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("label-templates e2e", () => {
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

  it("GET /label-templates is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/label-templates").expect(401);
  });

  it("CRUD happy path: create, list summary, get full, patch, delete", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/label-templates")
      .send({ name: "Bottle Label", spec: VALID_SPEC })
      .expect(201);

    expect(createRes.body.name).toEqual("Bottle Label");
    expect(createRes.body.spec).toEqual(VALID_SPEC);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.createdAt).toBeDefined();
    expect(createRes.body.updatedAt).toBeDefined();
    const id = createRes.body.id as string;

    const listRes = await agent.get("/label-templates").expect(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0]).toMatchObject({
      id,
      name: "Bottle Label",
      widthMm: VALID_SPEC.widthMm,
      heightMm: VALID_SPEC.heightMm,
      dpi: VALID_SPEC.dpi,
      language: VALID_SPEC.language,
    });
    expect(listRes.body.items[0].updatedAt).toBeDefined();
    expect(listRes.body.items[0].spec).toBeUndefined();

    const getRes = await agent.get(`/label-templates/${id}`).expect(200);
    expect(getRes.body).toMatchObject({ id, name: "Bottle Label" });
    expect(getRes.body.spec).toEqual(VALID_SPEC);

    // Small delay so the DB's now()-driven updatedAt (see
    // LabelTemplatesService.updateLabelTemplate -- deliberately DB-clock-sourced,
    // not app-clock `new Date()`, to avoid app/DB clock-skew flakiness) is
    // guaranteed to differ from createdAt at the assertion's resolution.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const patchRes = await agent
      .patch(`/label-templates/${id}`)
      .send({ name: "Bottle Label V2", spec: VALID_SPEC_V2 })
      .expect(200);
    expect(patchRes.body.name).toEqual("Bottle Label V2");
    expect(patchRes.body.spec).toEqual(VALID_SPEC_V2);
    expect(new Date(patchRes.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(createRes.body.updatedAt).getTime(),
    );

    await agent.delete(`/label-templates/${id}`).expect(204);
    await agent.get(`/label-templates/${id}`).expect(404);
  });

  it("GET /label-templates orders items by updatedAt desc (most recently updated first)", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createA = await agent
      .post("/label-templates")
      .send({ name: "Template A", spec: VALID_SPEC })
      .expect(201);
    const idA = createA.body.id as string;

    // Small delay (same pattern as the CRUD happy-path test above) so the
    // DB-clock-sourced `updatedAt` values are guaranteed to differ.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const createB = await agent
      .post("/label-templates")
      .send({ name: "Template B", spec: VALID_SPEC })
      .expect(201);
    const idB = createB.body.id as string;

    const listAfterCreate = await agent.get("/label-templates").expect(200);
    expect(listAfterCreate.body.items.map((item: { id: string }) => item.id)).toEqual([idB, idA]);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Touch A only (name-only patch) -- A is now the most recently updated,
    // even though it was created FIRST, so this only passes with an
    // explicit `ORDER BY updatedAt DESC` (never by accidental insertion
    // order, which would still show B before A here).
    await agent.patch(`/label-templates/${idA}`).send({ name: "Template A (touched)" }).expect(200);

    const listAfterPatch = await agent.get("/label-templates").expect(200);
    expect(listAfterPatch.body.items.map((item: { id: string }) => item.id)).toEqual([idA, idB]);
  });

  it("PATCH /label-templates/:id supports a name-only partial update (spec untouched)", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/label-templates")
      .send({ name: "Original Name", spec: VALID_SPEC })
      .expect(201);
    const id = createRes.body.id as string;

    const patchRes = await agent
      .patch(`/label-templates/${id}`)
      .send({ name: "Renamed" })
      .expect(200);
    expect(patchRes.body.name).toEqual("Renamed");
    expect(patchRes.body.spec).toEqual(VALID_SPEC);
  });

  it("POST /label-templates rejects a name shorter than 1 char with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/label-templates")
      .send({ name: "", spec: VALID_SPEC })
      .expect(400);

    // ZodValidationPipe's issues array lands under `message` -- see
    // `HttpException.createBody`: an array `objectOrError` is wrapped as
    // `{ message: array, error: "Bad Request", statusCode }`, not returned bare.
    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "name" })]),
    );
  });

  it("POST /label-templates rejects a name longer than 200 chars with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/label-templates")
      .send({ name: "x".repeat(201), spec: VALID_SPEC })
      .expect(400);

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "name" })]),
    );
  });

  it("POST /label-templates rejects an invalid spec (bad dpi) with 400 and a spec.dpi issue", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/label-templates")
      .send({ name: "Bad Template", spec: { ...VALID_SPEC, dpi: 150 } })
      .expect(400);

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "spec.dpi" })]),
    );
  });

  it("POST /label-templates rejects a doubly-invalid spec with 400 carrying BOTH issues", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent
      .post("/label-templates")
      .send({
        name: "Doubly Bad Template",
        spec: { ...VALID_SPEC, dpi: 150, heightMm: 500 },
      })
      .expect(400);

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message.length).toBeGreaterThanOrEqual(2);
    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "spec.dpi" }),
        expect.objectContaining({ path: "spec.heightMm" }),
      ]),
    );
  });

  it("PATCH /label-templates/:id rejects an invalid spec with 400 and a spec-path issue", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const createRes = await agent
      .post("/label-templates")
      .send({ name: "Valid For Now", spec: VALID_SPEC })
      .expect(201);
    const id = createRes.body.id as string;

    const res = await agent
      .patch(`/label-templates/${id}`)
      .send({ spec: { ...VALID_SPEC, elements: "not-an-array" } })
      .expect(400);

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "spec.elements" })]),
    );
  });

  it("cross-tenant isolation: org B cannot GET/PATCH/DELETE org A's label template", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);

    const createRes = await agent1
      .post("/label-templates")
      .send({ name: "Org A Template", spec: VALID_SPEC })
      .expect(201);
    const id = createRes.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.get(`/label-templates/${id}`).expect(404);
    await agent2.patch(`/label-templates/${id}`).send({ name: "Hijacked" }).expect(404);
    await agent2.delete(`/label-templates/${id}`).expect(404);

    // Org A's template is untouched and still listed only for org A.
    const listA = await agent1.get("/label-templates").expect(200);
    expect(listA.body.items).toHaveLength(1);
    const listB = await agent2.get("/label-templates").expect(200);
    expect(listB.body.items).toHaveLength(0);
  });

  it("DELETE /label-templates/:id returns 409 if referenced by a product's defaultLabelTemplateId", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const createRes = await agent
      .post("/label-templates")
      .send({ name: "Referenced Template", spec: VALID_SPEC })
      .expect(201);
    const id = createRes.body.id as string;

    // Seed a product that references the template (direct DB insert).
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: orgId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Seed Product",
      status: "draft",
      defaultLabelTemplateId: id,
    });

    const deleteRes = await agent.delete(`/label-templates/${id}`).expect(409);
    expect(deleteRes.body).toMatchObject({
      message: expect.stringContaining("referenced"),
    });
  });

  it("DELETE /label-templates/:id returns 409 if referenced by a shift's labelTemplateId, then 204 once unreferenced", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpAndActivate(agent);

    const createRes = await agent
      .post("/label-templates")
      .send({ name: "Shift Referenced Template", spec: VALID_SPEC })
      .expect(201);
    const id = createRes.body.id as string;

    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: orgId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Seed Product",
      status: "active",
      productGroup: "Beverages",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    const shiftId = randomUUID();
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId: orgId,
      productId,
      mode: "validation",
      labelTemplateId: id,
    });

    const deleteRes = await agent.delete(`/label-templates/${id}`).expect(409);
    expect(deleteRes.body).toMatchObject({
      message: expect.stringContaining("referenced"),
    });

    // Unreference (clear the shift's labelTemplateId) -> delete now succeeds.
    await db
      .update(schema.shifts)
      .set({ labelTemplateId: null })
      .where(eq(schema.shifts.id, shiftId));

    await agent.delete(`/label-templates/${id}`).expect(204);
    await agent.get(`/label-templates/${id}`).expect(404);
  });
});
