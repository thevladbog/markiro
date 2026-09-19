import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
import {
  CHZ_SIGNER_TASK_TYPES,
  chzKmCodes,
  chzKmIssues,
  chzKmOrders,
  chzOmsTokens,
} from "../src/schema/chz.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

// `chz_product_groups` (migration 0099) seeds code 15 as alias "beer", the
// group cider belongs to; 12 is "otp", a different group entirely, and
// `product_group_code` is a foreign key into that table.
const BEER_GROUP_CODE = 15;

describe("chz km orders schema", () => {
  it("declares the three signer task types", () => {
    expect([...CHZ_SIGNER_TASK_TYPES]).toEqual(["true_api_auth", "oms_auth", "sign_detached"]);
  });
  it("carries order, code and issue columns", () => {
    expect(Object.keys(chzKmOrders)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "productId",
        "gtin14",
        "quantity",
        "state",
        "requestBody",
        "omsOrderId",
        "fetchedCount",
        "issuedCount",
        "deadlineAt",
      ]),
    );
    expect(Object.keys(chzKmCodes)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "orderId",
        "seq",
        "encryptedCode",
        "codeNonce",
        "codeTag",
        "codeHash",
        "blockId",
        "status",
        "issueId",
      ]),
    );
    expect(Object.keys(chzKmIssues)).toEqual(
      expect.arrayContaining(["kind", "format", "fromSeq", "toSeq", "count"]),
    );
    expect(Object.keys(chzOmsTokens)).toEqual(
      expect.arrayContaining(["sourceOmsConnection", "expiresAt"]),
    );
  });
});

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("chz km orders migration", () => {
  const databaseName = `markiro_chz_km_orders_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool, { schema });
  let temporaryRoot = "";
  let created = false;
  const tenantId = `km-${randomUUID()}`;
  const userId = `km-user-${randomUUID()}`;
  const productId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-km-orders-"));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 164,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'KM tenant', $2, now())`,
      [tenantId, tenantId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'U', $2, true, now(), now())`,
      [userId, `${userId}@example.com`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, name, gtin14, chz_product_group_code) VALUES ($1, $2, 'Сидр', '04607034690014', ${BEER_GROUP_CODE})`,
      [productId, tenantId],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("seeds the stock KM template for an existing tenant exactly once", async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM label_templates WHERE tenant_id = $1 AND purpose = 'product_km' AND name = 'Этикетка КМ 58×40'`,
      [tenantId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("accepts a created order and refuses issued > fetched", async () => {
    const [order] = await db
      .insert(chzKmOrders)
      .values({
        tenantId,
        productId,
        gtin14: "04607034690014",
        productGroupAlias: "beer",
        productGroupCode: BEER_GROUP_CODE,
        templateId: 18,
        quantity: 10,
        requestBody: "{}",
        createdByUserId: userId,
        deadlineAt: new Date(Date.now() + 48 * 3600_000),
      })
      .returning({ id: chzKmOrders.id, state: chzKmOrders.state });
    expect(order?.state).toBe("created");
    await expect(
      db.update(chzKmOrders).set({ issuedCount: 1 }).where(eq(chzKmOrders.id, order!.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/chz_km_orders_counts_check/),
      }),
    });
  });

  it("refuses a completed order whose fetched count is short", async () => {
    await expect(
      db.insert(chzKmOrders).values({
        tenantId,
        productId,
        gtin14: "04607034690014",
        productGroupAlias: "beer",
        productGroupCode: BEER_GROUP_CODE,
        templateId: 18,
        quantity: 10,
        requestBody: "{}",
        createdByUserId: userId,
        state: "completed",
        omsOrderId: randomUUID(),
        fetchedCount: 9,
        deadlineAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/chz_km_orders_state_consistency_check/),
      }),
    });
  });
});
