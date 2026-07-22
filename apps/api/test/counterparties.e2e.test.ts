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

describe.skipIf(!ready)("counterparties e2e", () => {
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

  it("GET /counterparties is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/counterparties").expect(401);
  });

  it("CRUD happy path: POST, GET list, PATCH, DELETE", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // POST: Create a counterparty
    const createRes = await agent
      .post("/counterparties")
      .send({
        name: "Supplier Inc",
        gln: "6291041500213",
        inn: "7701234567",
        gs1Prefixes: ["4600000", "4600001"],
        notes: "Primary supplier",
      })
      .expect(201);

    const id = createRes.body.id as string;
    expect(createRes.body).toMatchObject({
      name: "Supplier Inc",
      gln: "6291041500213",
      inn: "7701234567",
      gs1Prefixes: ["4600000", "4600001"],
      notes: "Primary supplier",
    });
    expect(createRes.body.createdAt).toBeDefined();

    // GET list: should contain the created counterparty
    const listRes = await agent.get("/counterparties").expect(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0]).toMatchObject({
      id,
      name: "Supplier Inc",
      gln: "6291041500213",
    });

    // PATCH: Update the counterparty
    const patchRes = await agent
      .patch(`/counterparties/${id}`)
      .send({
        name: "Updated Supplier",
        inn: "7709876543",
      })
      .expect(200);

    expect(patchRes.body).toMatchObject({
      id,
      name: "Updated Supplier",
      gln: "6291041500213", // Should be unchanged
      inn: "7709876543",
      gs1Prefixes: ["4600000", "4600001"], // Should be unchanged
    });

    // GET: Verify the update
    const getRes = await agent.get(`/counterparties/${id}`).expect(200);
    expect(getRes.body).toMatchObject({
      id,
      name: "Updated Supplier",
      gln: "6291041500213",
      inn: "7709876543",
    });

    // DELETE: Remove the counterparty
    await agent.delete(`/counterparties/${id}`).expect(204);

    // Verify it's deleted
    await agent.get(`/counterparties/${id}`).expect(404);
  });

  it("cross-tenant isolation: org B cannot GET/PATCH/DELETE org A's counterparty", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpWithInactiveOrg(agent1);
    await agent1
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org1 })
      .expect(200);

    const createRes = await agent1
      .post("/counterparties")
      .send({
        name: "Org A Supplier",
        gln: "6291041500213",
      })
      .expect(201);
    const id = createRes.body.id as string;

    // Org B tries to access org A's counterparty
    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpWithInactiveOrg(agent2);
    await agent2
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org2 })
      .expect(200);

    // GET should 404
    await agent2.get(`/counterparties/${id}`).expect(404);

    // PATCH should 404
    await agent2.patch(`/counterparties/${id}`).send({ name: "Hijacked" }).expect(404);

    // DELETE should 404
    await agent2.delete(`/counterparties/${id}`).expect(404);
  });

  it("POST /counterparties rejects invalid GLN format with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const res = await agent
      .post("/counterparties")
      .send({
        name: "Bad Supplier",
        gln: "not-a-gln",
      })
      .expect(400);

    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "gln",
          message: expect.stringContaining("gln must be exactly 13 digits"),
        }),
      ]),
    );
  });

  it("POST /counterparties rejects GLN with invalid check digit with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const res = await agent
      .post("/counterparties")
      .send({
        name: "Bad Supplier",
        gln: "6291041500214", // Invalid check digit
      })
      .expect(400);

    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "gln",
          message: expect.stringContaining("check digit"),
        }),
      ]),
    );
  });

  it("DELETE /counterparties/:id returns 409 if referenced by product", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // Create a counterparty
    const createRes = await agent
      .post("/counterparties")
      .send({
        name: "Referenced Supplier",
        gln: "6291041500213",
      })
      .expect(201);
    const counterppartyId = createRes.body.id as string;

    // Seed a product that references the counterparty (direct DB insert)
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: orgId,
      gtin14: "12345678901234",
      name: "Test Product",
      defaultCounterpartyId: counterppartyId,
    });

    // DELETE should return 409
    const deleteRes = await agent.delete(`/counterparties/${counterppartyId}`).expect(409);

    expect(deleteRes.body).toMatchObject({
      message: expect.stringContaining("referenced"),
    });
  });

  it("DELETE /counterparties/:id returns 409 if referenced by shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // Create a counterparty
    const createRes = await agent
      .post("/counterparties")
      .send({
        name: "Referenced Supplier",
        gln: "6291041500213",
      })
      .expect(201);
    const counterppartyId = createRes.body.id as string;

    // Seed a product
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: orgId,
      gtin14: "12345678901234",
      name: "Test Product",
    });

    // Seed a shift that references the counterparty
    await db.insert(schema.shifts).values({
      id: randomUUID(),
      tenantId: orgId,
      productId,
      counterpartyId: counterppartyId,
      mode: "validation",
    });

    // DELETE should return 409
    const deleteRes = await agent.delete(`/counterparties/${counterppartyId}`).expect(409);

    expect(deleteRes.body).toMatchObject({
      message: expect.stringContaining("referenced"),
    });
  });

  it("validation: name must be 1-200 characters", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // Empty name
    await agent
      .post("/counterparties")
      .send({
        name: "",
        gln: "6291041500213",
      })
      .expect(400);

    // Name too long (201 chars)
    const longName = "a".repeat(201);
    await agent
      .post("/counterparties")
      .send({
        name: longName,
        gln: "6291041500213",
      })
      .expect(400);
  });

  it("validation: gs1Prefixes entries must be 4-12 digits", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // Prefix too short (3 digits)
    await agent
      .post("/counterparties")
      .send({
        name: "Supplier",
        gln: "6291041500213",
        gs1Prefixes: ["123"],
      })
      .expect(400);

    // Prefix too long (13 digits)
    await agent
      .post("/counterparties")
      .send({
        name: "Supplier",
        gln: "6291041500213",
        gs1Prefixes: ["1234567890123"],
      })
      .expect(400);
  });

  it("PATCH preserves untouched fields", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // Create with all fields
    const createRes = await agent
      .post("/counterparties")
      .send({
        name: "Supplier A",
        gln: "6291041500213",
        inn: "7701234567",
        gs1Prefixes: ["4600000"],
        notes: "Notes",
      })
      .expect(201);
    const id = createRes.body.id as string;

    // PATCH only name and inn
    const patchRes = await agent
      .patch(`/counterparties/${id}`)
      .send({
        name: "Supplier B",
        inn: "7709876543",
      })
      .expect(200);

    // gln and gs1Prefixes should be unchanged
    expect(patchRes.body).toMatchObject({
      id,
      name: "Supplier B",
      gln: "6291041500213",
      inn: "7709876543",
      gs1Prefixes: ["4600000"],
      notes: "Notes",
    });
  });
});
