import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { DB } from "../src/auth/auth.module";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.CHZ_TOKEN_ENCRYPTION_KEY,
);

describe.skipIf(!ready)("signer agent task queue", () => {
  let app: INestApplication | undefined;
  let agent: request.Agent;
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    db = ref.get(DB);

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function pairAgent(): Promise<{ agentId: string; secret: string }> {
    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    const pair = await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "PC", appVersion: "0.1.0" })
      .expect(201);
    return { agentId: pair.body.agentId, secret: pair.body.agentSecret };
  }

  async function insertTask(): Promise<string> {
    const [row] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: { trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api" },
      })
      .returning({ id: schema.chzSignerTasks.id });
    return row!.id;
  }

  it("rejects a bad agent token", async () => {
    await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", "nope")
      .expect(401);
  });

  it("claims, returns and completes a task, storing the encrypted token", async () => {
    const { agentId, secret } = await pairAgent();
    const taskId = await insertTask();
    const next = await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    expect(next.body.task).toMatchObject({ id: taskId, type: "true_api_auth" });
    // повторный опрос — задач нет (уже claimed этим агентом)
    const empty = await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    expect(empty.body.task).toBeNull();

    const expiresAt = new Date(Date.now() + 10 * 3600_000).toISOString();
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/complete`)
      .set("x-signer-token", secret)
      .send({ token: "jwt-abc", expiresAt, certThumbprint: "AB12" })
      .expect(204);

    const [stored] = await db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    expect(stored).toBeTruthy();
    expect(stored!.encryptedToken.toString("utf8")).not.toContain("jwt-abc"); // токен не в открытом виде
    expect(stored!.agentId).toBe(agentId);

    const overview = await agent.get("/signer-agents").expect(200);
    expect(overview.body.token.status).toBe("active");
    const agentRow = overview.body.agents.find((a: { id: string }) => a.id === agentId);
    expect(agentRow.certThumbprint).toBe("AB12");
  });

  it("records a failed task with its error code", async () => {
    const { secret } = await pairAgent();
    const taskId = await insertTask();
    await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/fail`)
      .set("x-signer-token", secret)
      .send({ errorCode: "CRYPTO_PIN_REQUIRED", message: "PIN prompt pending" })
      .expect(204);
    const [row] = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, taskId));
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("CRYPTO_PIN_REQUIRED");
  });

  it("does not let an agent complete a task claimed by another agent", async () => {
    const a1 = await pairAgent();
    const a2 = await pairAgent();
    const taskId = await insertTask();
    await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", a1.secret)
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/complete`)
      .set("x-signer-token", a2.secret)
      .send({
        token: "x",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        certThumbprint: "CD",
      })
      .expect(404);
  });
});
