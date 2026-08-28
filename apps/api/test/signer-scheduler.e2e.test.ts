import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { DB } from "../src/auth/auth.module";
import { JournalService } from "../src/modules/integrations/journal.service";
import { SignerSchedulerService } from "../src/modules/signer-agents/signer-scheduler.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL &&
    process.env.BETTER_AUTH_SECRET &&
    process.env.BETTER_AUTH_URL &&
    process.env.CHZ_TOKEN_ENCRYPTION_KEY,
);

describe.skipIf(!ready)("signer token refresh scheduler", () => {
  let app: INestApplication | undefined;
  let agent: request.Agent;
  let db: Db;
  let svc: SignerSchedulerService;

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
    svc = new SignerSchedulerService(db, new JournalService(db));

    agent = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
  });

  async function freshTenant(): Promise<string> {
    return signUpAndActivate(request.agent(app!.getHttpServer()));
  }

  async function insertAgent(tenantId: string): Promise<void> {
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "PC",
      status: "active",
      secretHash: randomUUID(),
    });
  }

  async function setToken(tenantId: string, expiresAt: Date): Promise<void> {
    await db
      .insert(schema.chzApiTokens)
      .values({
        tenantId,
        encryptedToken: Buffer.from("token"),
        tokenNonce: Buffer.from("nonce12345678"),
        tokenTag: Buffer.from("tag123456789012"),
        obtainedAt: new Date(),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.chzApiTokens.tenantId,
        set: { expiresAt, obtainedAt: new Date() },
      });
  }

  async function pendingTasks(tenantId: string) {
    return db
      .select()
      .from(schema.chzSignerTasks)
      .where(
        and(
          eq(schema.chzSignerTasks.tenantId, tenantId),
          inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
        ),
      );
  }

  it("does nothing for tenants without active agents", async () => {
    const tenantId = await freshTenant();
    await svc.run(new Date());
    expect(await pendingTasks(tenantId)).toHaveLength(0);
  });

  it("enqueues a refresh task when there is no token", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await svc.run(new Date());
    const tasks = await pendingTasks(tenantId);
    expect(tasks).toHaveLength(1);
    expect((tasks[0]!.payload as { trueApiBaseUrl: string }).trueApiBaseUrl).toBe(
      "https://markirovka.crpt.ru/api/v3/true-api",
    );
  });

  it("does not enqueue a duplicate while a task is open", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await svc.run(new Date());
    await svc.run(new Date());
    expect(await pendingTasks(tenantId)).toHaveLength(1);
  });

  it("skips tenants with a fresh token and fires when it nears expiry", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await setToken(tenantId, new Date(Date.now() + 5 * 3600_000)); // 5h left
    await svc.run(new Date());
    expect(await pendingTasks(tenantId)).toHaveLength(0);
    await setToken(tenantId, new Date(Date.now() + 60 * 60_000)); // 60min < 90min lead
    await svc.run(new Date());
    expect(await pendingTasks(tenantId)).toHaveLength(1);
  });

  it("uses sandbox URL and inn from channel settings", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await db
      .insert(schema.integrationChannels)
      .values({
        tenantId,
        type: "chestny_znak",
        settings: { environment: "sandbox", mchdInn: "7712345678" },
      })
      .onConflictDoUpdate({
        target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
        set: { settings: { environment: "sandbox", mchdInn: "7712345678" } },
      });
    await svc.run(new Date());
    const [task] = await pendingTasks(tenantId);
    expect((task!.payload as { trueApiBaseUrl: string }).trueApiBaseUrl).toBe(
      "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
    );
    expect((task!.payload as { inn: string }).inn).toBe("7712345678");
  });

  it("expires stale pending and claimed tasks", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    const [t] = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: {},
        createdAt: new Date(Date.now() - 31 * 60_000),
      })
      .returning();
    await svc.run(new Date());
    const [row] = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, t!.id));
    expect(row!.status).toBe("expired");
  });
});
