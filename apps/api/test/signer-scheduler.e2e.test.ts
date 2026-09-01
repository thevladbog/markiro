import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { chzTrueApiAuthPayloadSchema } from "@markiro/platform-contracts";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { DB } from "../src/auth/auth.module";
import { JournalService } from "../src/modules/integrations/journal.service";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
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
    svc = new SignerSchedulerService(
      db,
      new JournalService(db),
      new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Guards the `beforeAll`-populated app instance instead of `app!`. */
  function requireApp(): INestApplication {
    if (!app) throw new Error("app was not initialized");
    return app;
  }

  /** Asserts an array has exactly one element and returns it, sidestepping
   * `noUncheckedIndexedAccess` without a non-null assertion. */
  function firstRow<T>(rows: T[], message: string): T {
    const [row] = rows;
    if (!row) throw new Error(message);
    return row;
  }

  async function freshTenant(): Promise<string> {
    return signUpAndActivate(request.agent(requireApp().getHttpServer()));
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

  /** Asserts exactly one pending/claimed task exists for the tenant and returns it. */
  async function singlePendingTask(tenantId: string) {
    const tasks = await pendingTasks(tenantId);
    expect(tasks).toHaveLength(1);
    return firstRow(tasks, `expected exactly one pending task for tenant ${tenantId}`);
  }

  /** Fetches a task row by id, asserting it still exists (row was not pruned/missing). */
  async function taskRow(id: string) {
    const rows = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, id));
    return firstRow(rows, `expected task ${id} to exist`);
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
    const task = await singlePendingTask(tenantId);
    expect(chzTrueApiAuthPayloadSchema.parse(task.payload).trueApiBaseUrl).toBe(
      "https://markirovka.crpt.ru/api/v3/true-api",
    );
    expect(chzTrueApiAuthPayloadSchema.parse(task.payload).tokenFormat).toBe("uuid");
  });

  it("restores the legacy signer task shape for an explicit JWT rollback", async () => {
    const previous = process.env.CHZ_TRUE_API_TOKEN_FORMAT;
    process.env.CHZ_TRUE_API_TOKEN_FORMAT = "jwt";
    try {
      const tenantId = await freshTenant();
      await insertAgent(tenantId);
      await svc.run(new Date());
      const task = await singlePendingTask(tenantId);
      expect(task.payload).not.toHaveProperty("tokenFormat");
    } finally {
      if (previous === undefined) delete process.env.CHZ_TRUE_API_TOKEN_FORMAT;
      else process.env.CHZ_TRUE_API_TOKEN_FORMAT = previous;
    }
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
    const task = await singlePendingTask(tenantId);
    const payload = chzTrueApiAuthPayloadSchema.parse(task.payload);
    expect(payload.trueApiBaseUrl).toBe("https://markirovka.sandbox.crptech.ru/api/v3/true-api");
    expect(payload.inn).toBe("7712345678");
    expect(payload.tokenFormat).toBe("uuid");
  });

  it("expires stale pending and claimed tasks", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    const inserted = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: {},
        createdAt: new Date(Date.now() - 31 * 60_000),
      })
      .returning();
    const t = firstRow(inserted, "insert did not return the seeded task row");
    await svc.run(new Date());
    const row = await taskRow(t.id);
    expect(row.status).toBe("expired");
  });

  it("keeps a claimed task alive when it was created long ago but claimed recently", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    const inserted = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: {},
        status: "claimed",
        createdAt: new Date(Date.now() - 45 * 60_000),
        claimedAt: new Date(Date.now() - 2 * 60_000),
      })
      .returning();
    const t = firstRow(inserted, "insert did not return the seeded task row");
    await svc.run(new Date());
    const row = await taskRow(t.id);
    expect(row.status).toBe("claimed");
  });

  it("expires a claimed task once claimedAt itself is stale", async () => {
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    const inserted = await db
      .insert(schema.chzSignerTasks)
      .values({
        tenantId,
        type: "true_api_auth",
        payload: {},
        status: "claimed",
        createdAt: new Date(Date.now() - 45 * 60_000),
        claimedAt: new Date(Date.now() - 31 * 60_000),
      })
      .returning();
    const t = firstRow(inserted, "insert did not return the seeded task row");
    await svc.run(new Date());
    const row = await taskRow(t.id);
    expect(row.status).toBe("expired");
  });

  async function errorEvents(tenantId: string) {
    return db
      .select()
      .from(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.tenantId, tenantId),
          eq(schema.integrationEvents.channelType, "chestny_znak"),
          eq(schema.integrationEvents.outcome, "error"),
        ),
      );
  }

  it("emits one degradation error event when the token expired within the last 15 minutes", async () => {
    const now = new Date();
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await setToken(tenantId, new Date(now.getTime() - 5 * 60_000));
    await svc.run(now);
    expect(await errorEvents(tenantId)).toHaveLength(1);
  });

  it("does not emit a degradation error event once the 15-minute window has passed", async () => {
    const now = new Date();
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await setToken(tenantId, new Date(now.getTime() - 20 * 60_000));
    await svc.run(now);
    expect(await errorEvents(tenantId)).toHaveLength(0);
  });

  it("does not emit a degradation error event for a token expiring in the future, but still enqueues a refresh", async () => {
    const now = new Date();
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await setToken(tenantId, new Date(now.getTime() + 5 * 60_000));
    await svc.run(now);
    expect(await errorEvents(tenantId)).toHaveLength(0);
    expect(await pendingTasks(tenantId)).toHaveLength(1);
  });

  // Final review, Finding A: without the key, an agent's real КЭП login
  // would only reach a 503 once it tries to report back
  // (SignerTasksService.complete), so an unconfigured key must stop the
  // scheduler from ever sending an agent through that login to begin with --
  // this must be a hard "no enqueue", not a slow-motion failure loop.
  it("does not enqueue when the encryption key is not configured", async () => {
    const unconfigured = new SignerSchedulerService(
      db,
      new JournalService(db),
      new ChzCryptoService(undefined),
    );
    const tenantId = await freshTenant();
    await insertAgent(tenantId);
    await unconfigured.run(new Date());
    expect(await pendingTasks(tenantId)).toHaveLength(0);
  });
});
