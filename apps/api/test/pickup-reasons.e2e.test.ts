import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("pickup-reasons e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

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

  it("GET /pickup-reasons is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/pickup-reasons").expect(401);
  });

  it("creates reasons, lists them ordered by sortOrder/name, and archiving removes one from the list", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const marketing = await agent
      .post("/pickup-reasons")
      .send({ name: "Маркетинг", sortOrder: 2 })
      .expect(201);
    expect(marketing.body).toMatchObject({ name: "Маркетинг", sortOrder: 2 });
    expect(marketing.body.id).toBeDefined();
    expect(marketing.body.archived).toBeUndefined();

    const damage = await agent
      .post("/pickup-reasons")
      .send({ name: "Бой", sortOrder: 1 })
      .expect(201);
    const gift = await agent
      .post("/pickup-reasons")
      .send({ name: "Подарок", sortOrder: 1 })
      .expect(201);

    const listed = await agent.get("/pickup-reasons").expect(200);
    expect(listed.body.items).toHaveLength(3);
    // sortOrder asc, then name asc: (1, "Бой"), (1, "Подарок"), (2, "Маркетинг")
    expect(listed.body.items.map((r: { id: string }) => r.id)).toEqual([
      damage.body.id,
      gift.body.id,
      marketing.body.id,
    ]);

    await agent.delete(`/pickup-reasons/${damage.body.id}`).expect(204);

    const afterArchive = await agent.get("/pickup-reasons").expect(200);
    expect(afterArchive.body.items).toHaveLength(2);
    expect(afterArchive.body.items.map((r: { id: string }) => r.id)).toEqual([
      gift.body.id,
      marketing.body.id,
    ]);
  });

  it("POST /pickup-reasons defaults sortOrder to 0 and trims the name", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent.post("/pickup-reasons").send({ name: "  Другое  " }).expect(201);
    expect(created.body).toMatchObject({ name: "Другое", sortOrder: 0 });
  });

  it("PATCH /pickup-reasons/:id updates name and sortOrder", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent.post("/pickup-reasons").send({ name: "Original" }).expect(201);
    const id = created.body.id as string;

    const patched = await agent
      .patch(`/pickup-reasons/${id}`)
      .send({ name: "Renamed", sortOrder: 5 })
      .expect(200);
    expect(patched.body).toMatchObject({ id, name: "Renamed", sortOrder: 5 });
  });

  it("returns the reason unchanged on an empty PATCH body, and 404 for a missing id", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/pickup-reasons")
      .send({ name: "Empty Patch Тест" })
      .expect(201);
    const id = created.body.id as string;

    const patched = await agent.patch(`/pickup-reasons/${id}`).send({}).expect(200);
    expect(patched.body).toMatchObject({
      id,
      name: created.body.name,
      sortOrder: created.body.sortOrder,
    });

    await agent.patch(`/pickup-reasons/${randomUUID()}`).send({}).expect(404);
  });

  it("isolates reasons across tenants", async () => {
    const a = request.agent(app!.getHttpServer());
    await signUpAndActivate(a);
    const b = request.agent(app!.getHttpServer());
    await signUpAndActivate(b);

    const created = await a.post("/pickup-reasons").send({ name: "Org A Reason" }).expect(201);

    await b.patch(`/pickup-reasons/${created.body.id}`).send({ name: "hax" }).expect(404);
    await b.delete(`/pickup-reasons/${created.body.id}`).expect(404);

    const bList = await b.get("/pickup-reasons").expect(200);
    expect(bList.body.items).toHaveLength(0);
  });
});
