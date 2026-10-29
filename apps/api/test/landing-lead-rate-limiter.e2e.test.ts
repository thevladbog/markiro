import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LandingLeadRateLimiter } from "../src/modules/landing-leads/landing-lead-rate-limiter";

const databaseUrl = process.env.DATABASE_URL;
const windows = schema.landingLeadRateWindows;
const options = {
  windowMs: 900_000,
  sourceBudget: 2,
  globalBudget: 20,
  sourceKeySecret: "test-only-stable-platform-secret",
};

describe.skipIf(!databaseUrl)("persistent public lead admission", () => {
  const databaseName = `markiro_lead_limits_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${databaseName}`;
  const connection = createDb(url.toString());
  let created = false;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
  }, 120_000);
  beforeEach(async () => {
    await connection.db.delete(windows);
  });
  afterAll(async () => {
    await connection.pool.end();
    if (created) await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  it("shares source counters across instances and restarts without storing IP addresses", async () => {
    await new LandingLeadRateLimiter(connection.db, options).assertAllowed("203.0.113.7");
    await new LandingLeadRateLimiter(connection.db, options).assertAllowed("203.0.113.7");
    await expect(
      new LandingLeadRateLimiter(connection.db, options).assertAllowed("203.0.113.7"),
    ).rejects.toMatchObject({ status: 429, response: { code: "rate_limited" } });
    const rows = await connection.db.select().from(windows);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.key === "global")?.attempts).toBe(3);
    expect(rows.find((row) => row.key !== "global")).toMatchObject({
      key: expect.stringMatching(/^source:[0-9a-f]{64}$/u),
      attempts: 3,
    });
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
  });

  it("atomically enforces the source budget under concurrent admission", async () => {
    const instances = Array.from(
      { length: 3 },
      () =>
        new LandingLeadRateLimiter(connection.db, {
          ...options,
          sourceBudget: 3,
          globalBudget: 50,
        }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) => instances[index % 3]?.assertAllowed("203.0.113.8")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429 });
    const rows = await connection.db.select().from(windows);
    expect(rows.find((row) => row.key !== "global")?.attempts).toBe(4);
    expect(rows.find((row) => row.key === "global")?.attempts).toBe(30);
  });

  it("bounds global admission and source-key growth across concurrent instances", async () => {
    const a = new LandingLeadRateLimiter(connection.db, { ...options, globalBudget: 5 });
    const b = new LandingLeadRateLimiter(connection.db, { ...options, globalBudget: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        (index % 2 ? a : b).assertAllowed(`203.0.113.${index}`),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429 });
    const rows = await connection.db.select().from(windows);
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.key === "global")?.attempts).toBe(6);
  });

  it("uses database expiry to reset budgets and remove expired source keys", async () => {
    const limiter = new LandingLeadRateLimiter(connection.db, { ...options, globalBudget: 2 });
    await limiter.assertAllowed("203.0.113.7");
    await limiter.assertAllowed("203.0.113.8");
    await connection.db
      .update(windows)
      .set({ windowStartedAt: sql`statement_timestamp() - interval '2 hours'` });
    await limiter.assertAllowed("203.0.113.7");
    const rows = await connection.db.select().from(windows);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
  });

  it("fails closed with a bounded public error when storage is unavailable", async () => {
    const unavailable = createDb("postgres://unused:unused@127.0.0.1:1/unused");
    try {
      await expect(
        new LandingLeadRateLimiter(unavailable.db, options).assertAllowed("203.0.113.7"),
      ).rejects.toMatchObject({ status: 503, response: { code: "submission_unavailable" } });
    } finally {
      await unavailable.pool.end();
    }
  });
});
