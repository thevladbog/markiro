import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("ChzTokenService", () => {
  const databaseName = `markiro_chz_token_service_${randomUUID().replaceAll("-", "_")}`;
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
  let service: ChzTokenService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    crypto = new ChzCryptoService(key);
    service = new ChzTokenService(db, crypto);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = await createOrganization(db);
  });

  it("returns the decrypted token and the environment's base URL", async () => {
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } });

    await expect(service.getActiveToken(tenantId)).resolves.toEqual({
      status: "ok",
      auth: {
        baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
        token: "the-bearer-token",
      },
    });
  });

  it("defaults to the production base URL when the channel has no settings row", async () => {
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const result = await service.getActiveToken(tenantId);
    expect(result).toMatchObject({
      status: "ok",
      auth: { baseUrl: "https://markirovka.crpt.ru/api/v3/true-api" },
    });
  });

  it("refuses when no token row exists", async () => {
    await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "missing" });
  });

  it("refuses an expired token rather than letting True API answer 401", async () => {
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(Date.now() - 11 * 3_600_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "expired" });
  });

  it("refuses when the encryption key is unconfigured", async () => {
    const unconfigured = new ChzTokenService(db, new ChzCryptoService(undefined));
    await expect(unconfigured.getActiveToken(tenantId)).resolves.toEqual({
      status: "unconfigured",
    });
  });

  it("refuses when the stored ciphertext cannot be decrypted with the configured key", async () => {
    // Encrypt with one key, but construct the service with a different one.
    const encryptionKey1 = randomBytes(32);
    const encryptionKey2 = randomBytes(32);
    const crypto1 = new ChzCryptoService(encryptionKey1);
    const crypto2 = new ChzCryptoService(encryptionKey2);
    const serviceWithDifferentKey = new ChzTokenService(db, crypto2);

    const encrypted = crypto1.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // The service should catch the decryption error and return the undecryptable
    // variant rather than rejecting the promise.
    await expect(serviceWithDifferentKey.getActiveToken(tenantId)).resolves.toEqual({
      status: "undecryptable",
    });
  });

  it("reports a usable token present and unexpired without decrypting it", async () => {
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const decryptSpy = vi.spyOn(crypto, "decrypt");

    await expect(service.hasUsableToken(tenantId)).resolves.toBe(true);
    // The whole point of this check: `preflight()` polls it while any run is
    // non-terminal, and has no use for the plaintext.
    expect(decryptSpy).not.toHaveBeenCalled();
    decryptSpy.mockRestore();
  });

  it("reports no usable token when none exists", async () => {
    await expect(service.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("reports no usable token once it has expired", async () => {
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(Date.now() - 11 * 3_600_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(service.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("reports no usable token when the encryption key is unconfigured", async () => {
    const unconfigured = new ChzTokenService(db, new ChzCryptoService(undefined));
    await expect(unconfigured.hasUsableToken(tenantId)).resolves.toBe(false);
  });

  it("reports a usable token even when it cannot be decrypted with the configured key", async () => {
    // The honest trade-off documented on `hasUsableToken`: a presence-and-
    // expiry check cannot see a rotated key or corrupted ciphertext, only
    // `getActiveToken` can. Confirms preflight will read this token as
    // present; the runner still catches it downstream via `getActiveToken`.
    const encryptionKey1 = randomBytes(32);
    const encryptionKey2 = randomBytes(32);
    const crypto1 = new ChzCryptoService(encryptionKey1);
    const serviceWithDifferentKey = new ChzTokenService(db, new ChzCryptoService(encryptionKey2));

    const encrypted = crypto1.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await expect(serviceWithDifferentKey.hasUsableToken(tenantId)).resolves.toBe(true);
  });
});
