import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { CHZ_TRUE_API_BASE_URLS } from "../src/modules/signer-agents/chz-constants";
import { SignerTasksService } from "../src/modules/signer-agents/signer-tasks.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("National Catalog token provenance", () => {
  const databaseName = `markiro_nc_provenance_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${databaseName}`;
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  const crypto = new ChzCryptoService(randomBytes(32));
  let tokens: ChzTokenService;
  let tenantId: string;
  let agentId: string;
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(url.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    tokens = new ChzTokenService(db, crypto);
  }, 120_000);
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });
  beforeEach(async () => {
    tenantId = await createOrganization(db);
    agentId = randomUUID();
    await db
      .insert(schema.chzSignerAgents)
      .values({ id: agentId, tenantId, name: "test", secretHash: randomUUID() });
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } });
  });
  async function insertToken(sourceTrueApiBaseUrl: string | null) {
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...crypto.encrypt(tenantId, "local-test-bearer"),
      sourceTrueApiBaseUrl,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }
  async function claimedTask() {
    const id = randomUUID();
    await db.insert(schema.chzSignerTasks).values({
      id,
      tenantId,
      agentId,
      type: "true_api_auth",
      status: "claimed",
      payload: { trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS.sandbox },
    });
    return id;
  }
  it("blocks unknown legacy provenance and queues exactly one refresh without deleting token", async () => {
    await insertToken(null);
    await expect(tokens.getCatalogToken(tenantId, "sandbox")).resolves.toEqual({
      status: "provenance_unknown",
    });
    await expect(tokens.getCatalogToken(tenantId, "sandbox")).resolves.toEqual({
      status: "provenance_unknown",
    });
    const rows = await db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceTrueApiBaseUrl).toBeNull();
    const tasks = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "pending",
      payload: { trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS.sandbox },
    });
  });
  it("uses persisted provenance and blocks a channel switch without deleting the former token", async () => {
    await insertToken(CHZ_TRUE_API_BASE_URLS.sandbox);
    expect(await tokens.getCatalogToken(tenantId, "sandbox")).toMatchObject({
      status: "ok",
      auth: { baseUrl: CHZ_TRUE_API_BASE_URLS.sandbox, token: "local-test-bearer" },
    });
    await db
      .update(schema.integrationChannels)
      .set({ settings: { environment: "production" } })
      .where(eq(schema.integrationChannels.tenantId, tenantId));
    await expect(tokens.getCatalogToken(tenantId, "production")).resolves.toEqual({
      status: "environment_mismatch",
    });
    await expect(tokens.getCatalogToken(tenantId, "sandbox")).resolves.toEqual({
      status: "environment_mismatch",
    });
    expect(
      await db.select().from(schema.chzApiTokens).where(eq(schema.chzApiTokens.tenantId, tenantId)),
    ).toHaveLength(1);
  });
  it("stores source from validated matching signer task", async () => {
    const taskId = await claimedTask();
    const service = new SignerTasksService(db, crypto, new JournalService(db));
    await service.complete(tenantId, agentId, taskId, {
      token: "signed-local-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      certThumbprint: "local-cert",
    });
    expect(await tokens.getCatalogToken(tenantId, "sandbox")).toMatchObject({
      status: "ok",
      auth: { baseUrl: CHZ_TRUE_API_BASE_URLS.sandbox, token: "signed-local-token" },
    });
  });
  it("discards old in-flight signer completion after switch, preserves current token and records exact event", async () => {
    const taskId = await claimedTask();
    await insertToken(CHZ_TRUE_API_BASE_URLS.production);
    const [before] = await db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    await db
      .update(schema.integrationChannels)
      .set({ settings: { environment: "production" } })
      .where(eq(schema.integrationChannels.tenantId, tenantId));
    const service = new SignerTasksService(db, crypto, new JournalService(db));
    await service.complete(tenantId, agentId, taskId, {
      token: "stale-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      certThumbprint: "old-cert",
    });
    const [after] = await db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    expect(after).toEqual(before);
    const tasks = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.id === taskId)).toMatchObject({
      status: "failed",
      errorCode: "CHZ_ENVIRONMENT_CHANGED",
    });
    expect(tasks.find((task) => task.id !== taskId)).toMatchObject({
      status: "pending",
      payload: { trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS.production },
    });
    const events = await db
      .select()
      .from(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.tenantId, tenantId),
          eq(schema.integrationEvents.channelType, "chestny_znak"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      channelType: "chestny_znak",
      sessionId: null,
      direction: "in",
      outcome: "warn",
      grain: "item",
      message: "Stale True API token discarded",
      details: { taskId, agentId, reason: "CHZ_ENVIRONMENT_CHANGED" },
    });
    expect(Object.keys(events[0]?.details ?? {}).sort()).toEqual(["agentId", "reason", "taskId"]);
  });
  it("serializes completion with an uncommitted channel switch under the channel row lock", async () => {
    const taskId = await claimedTask();
    await insertToken(CHZ_TRUE_API_BASE_URLS.production);
    const service = new SignerTasksService(db, crypto, new JournalService(db));
    let completion: Promise<void> | undefined;
    let settled = false;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.integrationChannels)
        .set({ settings: { environment: "production" } })
        .where(eq(schema.integrationChannels.tenantId, tenantId));
      completion = service
        .complete(tenantId, agentId, taskId, {
          token: "stale-local",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          certThumbprint: "stale-cert",
        })
        .then(() => {
          settled = true;
        });
      // Observe PostgreSQL actually waiting on the channel lock, not merely a
      // timer during which the completion might not have started yet.
      let blocked = false;
      for (let poll = 0; poll < 100 && !blocked; poll++) {
        const waiting = await connection.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_channels%') AS waiting",
        );
        blocked = waiting.rows[0]?.waiting ?? false;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
    });
    await completion;
    const current = await tokens.getCatalogToken(tenantId, "production");
    expect(current).toMatchObject({
      status: "ok",
      auth: { token: "local-test-bearer", baseUrl: CHZ_TRUE_API_BASE_URLS.production },
    });
    const [task] = await db
      .select()
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.id, taskId));
    expect(task).toMatchObject({ status: "failed", errorCode: "CHZ_ENVIRONMENT_CHANGED" });
  });
});
