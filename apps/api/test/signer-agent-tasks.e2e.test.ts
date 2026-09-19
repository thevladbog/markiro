import { randomUUID } from "node:crypto";
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

  // `chz_signer_tasks_open_uq` allows at most one open (pending/claimed) task
  // per tenant+type, so every `it` below must terminalize (complete/fail/
  // expire) the task it creates before the next `insertTask()` call --
  // otherwise the insert races the partial unique index and fails.
  async function insertTask(tokenFormat?: "jwt" | "uuid"): Promise<string> {
    // Task provenance must match the configured channel at completion.
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } })
      .onConflictDoUpdate({
        target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
        set: { settings: { environment: "sandbox" } },
      });
    const [row] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: {
          trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
          ...(tokenFormat ? { tokenFormat } : {}),
        },
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
    const taskId = await insertTask("uuid");
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
    const token = `long-true-api-jwt.${"x".repeat(16_384)}`;
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/complete`)
      .set("x-signer-token", secret)
      .send({ token, expiresAt, certThumbprint: "AB12" })
      .expect(204);

    const [stored] = await db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    expect(stored).toBeTruthy();
    expect(stored!.encryptedToken.toString("utf8")).not.toContain("long-true-api-jwt");
    expect(stored!.agentId).toBe(agentId);
    expect(stored!.tokenType).toBe("uuid");

    const overview = await agent.get("/signer-agents").expect(200);
    expect(overview.body.token.status).toBe("active");
    expect(overview.body.token.tokenType).toBe("uuid");
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

    // The previous assertion left `taskId` still `claimed` by a1 -- close it
    // out before the next `it` seeds its own task (see the ordering-
    // constraint comment on `insertTask`).
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/complete`)
      .set("x-signer-token", a1.secret)
      .send({
        token: "x",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        certThumbprint: "CD",
      })
      .expect(204);
  });

  it("does not let an agent paired to another tenant complete or fail a task", async () => {
    const taskId = await insertTask();

    const otherSession = request.agent(app!.getHttpServer());
    await signUpAndActivate(otherSession);
    const { body: issuedOther } = await otherSession
      .post("/signer-agents/pairing-code")
      .expect(201);
    const pairOther = await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issuedOther.code, hostname: "PC-OTHER-TENANT", appVersion: "0.1.0" })
      .expect(201);
    const otherSecret = pairOther.body.agentSecret as string;

    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/complete`)
      .set("x-signer-token", otherSecret)
      .send({
        token: "x",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        certThumbprint: "CD",
      })
      .expect(404);

    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${taskId}/fail`)
      .set("x-signer-token", otherSecret)
      .send({ errorCode: "CRYPTO_PIN_REQUIRED", message: "not this agent's task" })
      .expect(404);

    // The task belongs to tenant A and was never claimed by tenant B's
    // agent, so it is still `pending` here -- terminalize it so it doesn't
    // linger as an open task for the next `it`.
    const [row] = await db
      .select({ status: schema.chzSignerTasks.status })
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, taskId));
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
    await db
      .update(schema.chzSignerTasks)
      .set({ status: "expired" })
      .where(eq(schema.chzSignerTasks.id, taskId));
  });

  it("rejects a malformed task id with 400 rather than a database error", async () => {
    const { secret } = await pairAgent();
    await request(app!.getHttpServer())
      .post("/signer-agent/tasks/not-a-uuid/complete")
      .set("x-signer-token", secret)
      .send({
        token: "example-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        certThumbprint: "AB12",
      })
      .expect(400);
  });

  async function setOmsSettings(): Promise<void> {
    await db
      .insert(schema.integrationChannels)
      .values({
        tenantId,
        type: "chestny_znak",
        settings: {
          environment: "sandbox",
          omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
          omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        },
      })
      .onConflictDoUpdate({
        target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
        set: {
          settings: {
            environment: "sandbox",
            omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
            omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
          },
        },
      });
  }

  it("completes an oms_auth task into chz_oms_tokens", async () => {
    const { agentId, secret } = await pairAgent();
    await setOmsSettings();
    const [row] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "oms_auth",
        payload: {
          trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
          omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        },
      })
      .returning({ id: schema.chzSignerTasks.id });
    const next = await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    expect(next.body.task).toMatchObject({ id: row!.id, type: "oms_auth" });
    const expiresAt = new Date(Date.now() + 10 * 3600_000).toISOString();
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${row!.id}/complete`)
      .set("x-signer-token", secret)
      .send({ token: "2f2222c2-cbc2-22ff-bc2c-2222222fbef2", expiresAt, certThumbprint: "AB12" })
      .expect(204);
    const [token] = await db
      .select()
      .from(schema.chzOmsTokens)
      .where(eq(schema.chzOmsTokens.tenantId, tenantId));
    expect(token).toMatchObject({
      agentId,
      sourceOmsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
    });
    expect(Buffer.from(token!.encryptedToken).toString("utf8")).not.toContain("2f2222c2");
  });

  it("completes a sign_detached task by storing the signature on the task", async () => {
    const { secret } = await pairAgent();
    const [row] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "sign_detached",
        payload: { purpose: "oms_order", orderId: randomUUID(), dataBase64: "eyJhIjoxfQ==" },
      })
      .returning({ id: schema.chzSignerTasks.id });
    await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${row!.id}/complete`)
      .set("x-signer-token", secret)
      .send({ signatureBase64: "MIIE5QYJKoZIhvcNAQcCoIIE1g==", certThumbprint: "AB12" })
      .expect(204);
    const [task] = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, row!.id));
    expect(task).toMatchObject({
      status: "completed",
      resultSummary: { signatureBase64: "MIIE5QYJKoZIhvcNAQcCoIIE1g==", certThumbprint: "AB12" },
    });
  });

  it("refuses a token body for a sign_detached task", async () => {
    const { secret } = await pairAgent();
    const [row] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "sign_detached",
        payload: { purpose: "oms_order", orderId: randomUUID(), dataBase64: "eyJhIjoxfQ==" },
      })
      .returning({ id: schema.chzSignerTasks.id });
    await request(app!.getHttpServer())
      .get("/signer-agent/tasks/next?wait=0")
      .set("x-signer-token", secret)
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${row!.id}/complete`)
      .set("x-signer-token", secret)
      .send({ token: "x", expiresAt: new Date().toISOString(), certThumbprint: "AB12" })
      .expect(400);
    await request(app!.getHttpServer())
      .post(`/signer-agent/tasks/${row!.id}/fail`)
      .set("x-signer-token", secret)
      .send({ errorCode: "NETWORK", message: "cleanup" })
      .expect(204);
  });
});
