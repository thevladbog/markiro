import { randomUUID } from "node:crypto";
import express from "express";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { verifySecret } from "../src/lib/pin-hash";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("operators e2e", () => {
  let app: INestApplication | undefined;
  let moduleRef: TestingModule;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    moduleRef = ref;
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
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
    const orgId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  async function createEmployee(
    agent: ReturnType<typeof request.agent>,
    fullName: string,
  ): Promise<string> {
    const res = await agent.post("/employees").send({ fullName }).expect(201);
    return res.body.id as string;
  }

  async function issueBadge(
    agent: ReturnType<typeof request.agent>,
    employeeId: string,
    badgeCode: string,
  ): Promise<void> {
    await agent.post(`/employees/${employeeId}/badges`).send({ badgeCode }).expect(201);
  }

  it("grants station access, lists it, and never leaks the PIN", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const employeeId = await createEmployee(agent, "Смирнов Алексей");

    const granted = await agent
      .put(`/operators/${employeeId}`)
      .send({ login: "1042", pin: "4821" })
      .expect(200);
    expect(granted.body.login).toBe("1042");
    expect(granted.body.active).toBe(true);
    expect(JSON.stringify(granted.body)).not.toContain("4821");
    expect(JSON.stringify(granted.body)).not.toContain("pbkdf2");

    const list = await agent.get("/operators").expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      employeeId,
      fullName: "Смирнов Алексей",
      login: "1042",
      active: true,
      hasBadge: false,
    });
    expect(JSON.stringify(list.body)).not.toContain("pbkdf2");
  });

  it("rejects a duplicate login in the same tenant with 409", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const first = await createEmployee(agent, "Первый");
    const second = await createEmployee(agent, "Второй");

    await agent.put(`/operators/${first}`).send({ login: "700", pin: "1234" }).expect(200);
    await agent.put(`/operators/${second}`).send({ login: "700", pin: "5678" }).expect(409);
  });

  it("deactivates and revokes access", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const employeeId = await createEmployee(agent, "Ким Е.");
    await agent.put(`/operators/${employeeId}`).send({ login: "88", pin: "1234" }).expect(400);
    await agent.put(`/operators/${employeeId}`).send({ login: "880", pin: "1234" }).expect(200);

    const patched = await agent
      .patch(`/operators/${employeeId}`)
      .send({ active: false })
      .expect(200);
    expect(patched.body.active).toBe(false);

    await agent.delete(`/operators/${employeeId}`).expect(204);
    const list = await agent.get("/operators").expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it("is tenant-isolated: another tenant cannot see or revoke access", async () => {
    const alice = request.agent(app!.getHttpServer());
    await signUpAndActivate(alice);
    const employeeId = await createEmployee(alice, "Алиса");
    await alice.put(`/operators/${employeeId}`).send({ login: "9001", pin: "1234" }).expect(200);

    const bob = request.agent(app!.getHttpServer());
    await signUpAndActivate(bob);
    const bobList = await bob.get("/operators").expect(200);
    expect(bobList.body.items).toHaveLength(0);
    await bob.delete(`/operators/${employeeId}`).expect(404);
  });

  it("buildRoster is deterministic on multi-badge employees and scoped to operators only", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);

    // Employee WITH station access and two active badges — the roster's
    // badgeHash must correspond to the most recently issued one.
    const operatorId = await createEmployee(agent, "Двубейджевый Оператор");
    await agent.put(`/operators/${operatorId}`).send({ login: "5150", pin: "9911" }).expect(200);
    const oldCode = `OLD-${randomUUID()}`;
    const newCode = `NEW-${randomUUID()}`;
    await issueBadge(agent, operatorId, oldCode);
    await issueBadge(agent, operatorId, newCode);

    // Employee WITHOUT station access — must not appear in the roster at all,
    // even though it has an active badge (proves the helper is scoped to
    // operators, not every badge in the tenant).
    const bystanderId = await createEmployee(agent, "Без доступа");
    await issueBadge(agent, bystanderId, `BYSTANDER-${randomUUID()}`);

    const operatorsService = moduleRef.get(OperatorsService);
    const roster = await operatorsService.buildRoster(tenantId);

    expect(roster.some((r) => r.operatorId === bystanderId)).toBe(false);

    const entry = roster.find((r) => r.operatorId === operatorId);
    expect(entry).toBeDefined();
    expect(entry!.badgeHash).toBeTruthy();
    await expect(verifySecret(newCode, entry!.badgeHash!)).resolves.toBe(true);
    await expect(verifySecret(oldCode, entry!.badgeHash!)).resolves.toBe(false);
  });
});
