import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { ChzOmsTokenService } from "../src/modules/chz-km-orders/chz-oms-token.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);
const OMS_ID = "cdf12109-10d3-11e6-8b6f-0050569977a1";
const OMS_CONNECTION = "b7f0c8b0-10d3-11e6-8b6f-0050569977a1";

describe.skipIf(!ready)("ChzOmsTokenService", () => {
  const databaseName = `markiro_chz_oms_token_service_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantId: string;
  const key = randomBytes(32);
  let crypto: ChzCryptoService;
  let service: ChzOmsTokenService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    crypto = new ChzCryptoService(key);
    service = new ChzOmsTokenService(db, crypto);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = await createOrganization(db);
  });

  async function seedChannel(overrides: Record<string, unknown> = {}) {
    await db.insert(schema.integrationChannels).values({
      tenantId,
      type: "chestny_znak",
      settings: {
        environment: "sandbox",
        omsId: OMS_ID,
        omsConnection: OMS_CONNECTION,
        ...overrides,
      },
    });
  }

  it("returns the decrypted client token, base URL and omsId", async () => {
    await seedChannel();
    const obtainedAt = new Date();
    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await expect(service.getActiveToken(tenantId)).resolves.toMatchObject({
      status: "ok",
      auth: {
        baseUrl: "https://suz.sandbox.crptech.ru/api/v3",
        clientToken: "tok",
        omsId: OMS_ID,
      },
    });
  });

  it("reports settings_missing when the channel lacks omsId/omsConnection", async () => {
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } });

    await expect(service.getActiveToken(tenantId)).resolves.toEqual({
      status: "settings_missing",
    });
  });

  it("reports settings_missing when the channel row does not exist at all", async () => {
    await expect(service.getActiveToken(tenantId)).resolves.toEqual({
      status: "settings_missing",
    });
  });

  it("refuses when no token row exists", async () => {
    await seedChannel();
    await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "missing" });
  });

  it("reports missing rather than usable when the stored token belongs to a different installation", async () => {
    await seedChannel();
    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: "aaaaaaaa-0000-0000-0000-000000000000",
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // A token stored for a since-abandoned installation must not be treated
    // as usable: СУЗ issues one token per installation, and reusing a stale
    // one would be rejected or, worse, act on the wrong installation.
    await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "missing" });
  });

  it("refuses an expired token", async () => {
    await seedChannel();
    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(Date.now() - 11 * 3_600_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "expired" });
  });

  it("refuses when the encryption key is unconfigured", async () => {
    const unconfigured = new ChzOmsTokenService(db, new ChzCryptoService(undefined));
    await expect(unconfigured.getActiveToken(tenantId)).resolves.toEqual({
      status: "unconfigured",
    });
  });

  it("refuses when the stored ciphertext cannot be decrypted with the configured key", async () => {
    await seedChannel();
    const encryptionKey1 = randomBytes(32);
    const encryptionKey2 = randomBytes(32);
    const crypto1 = new ChzCryptoService(encryptionKey1);
    const crypto2 = new ChzCryptoService(encryptionKey2);
    const serviceWithDifferentKey = new ChzOmsTokenService(db, crypto2);

    const encrypted = crypto1.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await expect(serviceWithDifferentKey.getActiveToken(tenantId)).resolves.toEqual({
      status: "undecryptable",
    });
  });

  it("reports a usable token present and unexpired without decrypting it", async () => {
    await seedChannel();
    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const decryptSpy = vi.spyOn(crypto, "decrypt");

    await expect(service.hasUsableToken(tenantId)).resolves.toBe(true);
    expect(decryptSpy).not.toHaveBeenCalled();
    decryptSpy.mockRestore();
  });

  it("reports no usable token when none exists", async () => {
    await expect(service.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("reports no usable token once it has expired", async () => {
    await seedChannel();
    const encrypted = crypto.encrypt(tenantId, "tok");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt: new Date(Date.now() - 11 * 3_600_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("reports no usable token when the encryption key is unconfigured", async () => {
    const unconfigured = new ChzOmsTokenService(db, new ChzCryptoService(undefined));
    await expect(unconfigured.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("invalidates a rejected token and enqueues exactly one immediate refresh task", async () => {
    await seedChannel({ mchdInn: "7707083893" });
    const obtainedAt = new Date();
    const encrypted = crypto.encrypt(tenantId, "rejected-token");
    await db.insert(schema.chzOmsTokens).values({
      tenantId,
      ...encrypted,
      sourceOmsConnection: OMS_CONNECTION,
      sourceTrueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      obtainedAt,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "OMS token refresh fixture",
      secretHash: `hash-${randomUUID()}`,
    });

    await service.invalidateAndRequestRefresh(tenantId, obtainedAt);
    await service.invalidateAndRequestRefresh(tenantId, obtainedAt);

    const tokens = await db
      .select({ tenantId: schema.chzOmsTokens.tenantId })
      .from(schema.chzOmsTokens)
      .where(eq(schema.chzOmsTokens.tenantId, tenantId));
    expect(tokens).toEqual([]);

    const tasks = await db
      .select({ type: schema.chzSignerTasks.type, payload: schema.chzSignerTasks.payload })
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toEqual([
      {
        type: "oms_auth",
        payload: {
          trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
          omsConnection: OMS_CONNECTION,
          inn: "7707083893",
        },
      },
    ]);
  });

  it("requestRefresh inserts exactly one open task on repeated calls (partial unique index)", async () => {
    await seedChannel();
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "OMS token refresh fixture",
      secretHash: `hash-${randomUUID()}`,
    });

    await service.requestRefresh(tenantId);
    await service.requestRefresh(tenantId);

    const tasks = await db
      .select({ id: schema.chzSignerTasks.id })
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toHaveLength(1);
  });

  it("does not insert a refresh task when the channel settings cannot produce a payload", async () => {
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "OMS token refresh fixture",
      secretHash: `hash-${randomUUID()}`,
    });
    // No integration channel at all -> omsConnection is undefined -> no payload.

    await service.requestRefresh(tenantId);

    const tasks = await db
      .select({ id: schema.chzSignerTasks.id })
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toEqual([]);
  });

  it("does not request a refresh when the encryption key is unconfigured", async () => {
    const unconfigured = new ChzOmsTokenService(db, new ChzCryptoService(undefined));
    await seedChannel();
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "OMS token refresh fixture",
      secretHash: `hash-${randomUUID()}`,
    });

    await unconfigured.requestRefresh(tenantId);

    const tasks = await db
      .select({ id: schema.chzSignerTasks.id })
      .from(schema.chzSignerTasks)
      .where(eq(schema.chzSignerTasks.tenantId, tenantId));
    expect(tasks).toEqual([]);
  });
});
