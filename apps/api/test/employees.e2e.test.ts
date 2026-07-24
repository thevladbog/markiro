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

describe.skipIf(!ready)("employees e2e", () => {
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

  it("creates an employee, issues and revokes a badge", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/employees")
      .send({ fullName: "Смирнов Алексей", role: "оператор" })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe("active");

    const withBadge = await agent
      .post(`/employees/${id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412", label: "…4412" })
      .expect(201);
    const badgeId = withBadge.body.badges[0].id as string;
    expect(withBadge.body.badges).toHaveLength(1);

    // Same active code again on another employee → 409.
    const other = await agent.post("/employees").send({ fullName: "Ким Е." }).expect(201);
    await agent
      .post(`/employees/${other.body.id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412" })
      .expect(409);

    await agent.delete(`/employees/${id}/badges/${badgeId}`).expect(204);
    // After revoke the code can be reissued.
    await agent
      .post(`/employees/${other.body.id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412" })
      .expect(201);
  });

  it("isolates employees across tenants", async () => {
    const a = request.agent(app!.getHttpServer());
    await signUpAndActivate(a);
    const b = request.agent(app!.getHttpServer());
    await signUpAndActivate(b);
    const created = await a.post("/employees").send({ fullName: "A" }).expect(201);
    await b.patch(`/employees/${created.body.id}`).send({ fullName: "hax" }).expect(404);
  });

  it("returns the employee unchanged on an empty PATCH body, and 404 for a missing id", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/employees")
      .send({ fullName: "Empty Patch Тест" })
      .expect(201);
    const id = created.body.id as string;

    const patched = await agent.patch(`/employees/${id}`).send({}).expect(200);
    expect(patched.body.fullName).toBe(created.body.fullName);
    expect(patched.body.status).toBe(created.body.status);

    await agent.patch(`/employees/${randomUUID()}`).send({}).expect(404);
  });
});
