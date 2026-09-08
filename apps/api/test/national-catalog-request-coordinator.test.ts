import { expect, it } from "vitest";
import { nextRetryAt } from "../src/modules/national-catalog/national-catalog-request-coordinator";

it("honors a Retry-After longer than the ordinary backoff", () => {
  const now = new Date("2026-09-08T09:00:00Z");
  expect(nextRetryAt(1, now, 1800).toISOString()).toBe("2026-09-08T09:30:00.000Z");
});

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createDb, schema, type Db } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, vi } from "vitest";
import {
  NationalCatalogRequestCoordinator,
  verifyCatalogEnvironment,
} from "../src/modules/national-catalog/national-catalog-request-coordinator";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { CHZ_TRUE_API_BASE_URLS } from "../src/modules/signer-agents/chz-constants";
import { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import { createOrganization } from "./support/subscription-fixtures";

const baseUrl = "https://api.nk.sandbox.crptech.ru";
const context = (tenantId: string) => ({ tenantId, environment: "sandbox" as const });
function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["https://api.nk.sandbox.crptech.ru:443", CHZ_TRUE_API_BASE_URLS.sandbox],
  ["https://api.nk.sandbox.crptech.ru/extra", CHZ_TRUE_API_BASE_URLS.sandbox],
  ["https://api.nk.sandbox.crptech.ru?x=1", CHZ_TRUE_API_BASE_URLS.sandbox],
  ["https://api.nk.sandbox.crptech.ru#x", CHZ_TRUE_API_BASE_URLS.sandbox],
  ["https://api.nk.sandbox.crptech.ru.attacker.test", CHZ_TRUE_API_BASE_URLS.sandbox],
  ["https://user@api.nk.sandbox.crptech.ru", CHZ_TRUE_API_BASE_URLS.sandbox],
  [baseUrl, "https://markirovka.sandbox.crptech.ru:443/api/v3/true-api"],
  [baseUrl, CHZ_TRUE_API_BASE_URLS.production],
])("rejects unregistered environment pair %s", (catalog, trueApi) => {
  expect(() => verifyCatalogEnvironment("sandbox", trueApi, catalog)).toThrow(
    "environment_mismatch",
  );
});
it("accepts only the registered production and sandbox pairs", () => {
  expect(() =>
    verifyCatalogEnvironment("sandbox", CHZ_TRUE_API_BASE_URLS.sandbox, baseUrl),
  ).not.toThrow();
  expect(() =>
    verifyCatalogEnvironment(
      "production",
      CHZ_TRUE_API_BASE_URLS.production,
      "https://апи.национальный-каталог.рф",
    ),
  ).not.toThrow();
  expect(() =>
    verifyCatalogEnvironment(
      "production",
      CHZ_TRUE_API_BASE_URLS.production,
      "https://xn--80aqu.xn----7sbabas4ajkhfocclk9d3cvfsa.xn--p1ai/",
    ),
  ).not.toThrow();
});

describe.skipIf(!process.env.DATABASE_URL)("National Catalog shared request coordination", () => {
  const name = `markiro_nc_coordinator_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  const crypto = new ChzCryptoService(randomBytes(32));
  let tokens: ChzTokenService;
  let a: NationalCatalogRequestCoordinator;
  let b: NationalCatalogRequestCoordinator;
  let tenant: string;
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    connection = createDb(url.toString(), { max: 12 });
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    tokens = new ChzTokenService(db, crypto);
  }, 120_000);
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.pool.end();
  });
  async function fixture() {
    const id = await createOrganization(db);
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId: id, type: "chestny_znak", settings: { environment: "sandbox" } });
    await db.insert(schema.chzApiTokens).values({
      tenantId: id,
      ...crypto.encrypt(id, "local-only"),
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      sourceTrueApiBaseUrl: CHZ_TRUE_API_BASE_URLS.sandbox,
    });
    return id;
  }
  beforeEach(async () => {
    tenant = await fixture();
    a = new NationalCatalogRequestCoordinator(db, tokens, baseUrl);
    b = new NationalCatalogRequestCoordinator(db, tokens, baseUrl);
  });
  async function lease() {
    const [row] = await db
      .select()
      .from(schema.nationalCatalogRequestLeases)
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
    if (!row) throw new Error("lease missing");
    return row;
  }
  it("serializes two workers for one tenant while a different tenant makes progress", async () => {
    const entered = latch();
    const finish = latch();
    const first = a.run(
      context(tenant),
      async () => {
        entered.resolve();
        await finish.promise;
        return "first";
      },
      { attempt: 0 },
    );
    await entered.promise;
    const http = vi.fn(async () => "duplicate");
    await expect(b.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      state: "deferred",
      reason: "lease_busy",
      consumesAttempt: false,
    });
    expect(http).not.toHaveBeenCalled();
    await expect(b.runExternal(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      reason: "lease_busy",
    });
    await expect(
      b.run(context(await fixture()), async () => "other", { attempt: 0 }),
    ).resolves.toBe("other");
    finish.resolve();
    await expect(first).resolves.toBe("first");
    await expect(b.run(context(tenant), async () => "second", { attempt: 0 })).resolves.toBe(
      "second",
    );
    expect((await lease()).fence).toBe(2n);
  });
  it("shares the process cap of four across coordinator instances and CDN preparation", async () => {
    const tenants = await Promise.all(Array.from({ length: 6 }, fixture));
    const entered = latch();
    const finish = latch();
    let active = 0;
    let maximum = 0;
    let starts = 0;
    const request = async () => {
      active++;
      starts++;
      maximum = Math.max(maximum, active);
      if (starts === 4) entered.resolve();
      await finish.promise;
      active--;
      return true;
    };
    const pending = tenants.map((id, i) =>
      i % 2
        ? b.run(context(id), request, { attempt: 0 })
        : a.runExternal(context(id), request, { attempt: 0 }),
    );
    await entered.promise;
    expect(starts).toBe(4);
    finish.resolve();
    await Promise.all(pending);
    expect(maximum).toBe(4);
    expect(starts).toBe(6);
  });
  it("uses database time despite worker clock skew and rejects expired result", async () => {
    await a.run(context(tenant), async () => "init", { attempt: 0 });
    const previous = await lease();
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ leaseUntil: sql`now() + interval '30 seconds'` })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400_000);
    try {
      await expect(
        b.runExternal(context(tenant), async () => true, { attempt: 0 }),
      ).rejects.toMatchObject({
        reason: "lease_busy",
      });
    } finally {
      clock.mockRestore();
    }
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
    await expect(
      b.runExternal(
        context(tenant),
        async () => {
          await db
            .update(schema.nationalCatalogRequestLeases)
            .set({ leaseUntil: sql`now() - interval '1 second'` })
            .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
          return "expired result";
        },
        { attempt: 0 },
      ),
    ).rejects.toMatchObject({ reason: "lease_lost" });
    expect((await lease()).fence).toBe(previous.fence + 1n);
  });
  it("fences a stale worker's result and release after a replacement acquires the expired lease", async () => {
    const entered = latch();
    const finishOld = latch();
    const replacementEntered = latch();
    const finishNew = latch();
    const old = a.run(
      context(tenant),
      async () => {
        entered.resolve();
        await finishOld.promise;
        return "stale";
      },
      { attempt: 0 },
    );
    const oldAssertion = expect(old).rejects.toMatchObject({ reason: "lease_lost" });
    await entered.promise;
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
    const replacement = b.run(
      context(tenant),
      async () => {
        replacementEntered.resolve();
        await finishNew.promise;
        return "fresh";
      },
      { attempt: 0 },
    );
    await replacementEntered.promise;
    const claimed = await lease();
    finishOld.resolve();
    await oldAssertion;
    expect(await lease()).toEqual(claimed);
    finishNew.resolve();
    await expect(replacement).resolves.toBe("fresh");
  });
  it("persists list failure quota before release, enforcing it after restart for detail and CDN", async () => {
    const client = new NationalCatalogClient({
      fetch: async () =>
        new Response(null, {
          status: 413,
          headers: {
            "API-Usage-Limit": "500/500",
            "API-Method-Usage-Limit": "10/10",
            "Retry-After": "1800",
          },
        }),
      scheduleAbort: () => () => {},
    });
    await expect(
      a.run(
        context(tenant),
        ({ auth, ...options }) =>
          client.listOwnProducts(
            auth,
            {
              updatedFrom: "2026-09-01 00:00:00",
              updatedTo: "2026-09-08 00:00:00",
              offset: 0,
              limit: 1,
            },
            options,
          ),
        { attempt: 0 },
      ),
    ).resolves.toEqual({ status: "selection_too_large" });
    const row = await lease();
    expect(row.totalQuota).toMatchObject({ used: 500, limit: 500 });
    expect(row.methodQuotas).toMatchObject({ "/v4/product-list": { used: 10, limit: 10 } });
    expect(row.nextAllowedAt.getTime() - row.updatedAt.getTime()).toBeGreaterThanOrEqual(1799_000);
    const restarted = new NationalCatalogRequestCoordinator(db, tokens, baseUrl);
    const http = vi.fn(async () => "detail");
    await expect(restarted.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      state: "deferred",
      reason: "quota_wait",
      consumesAttempt: false,
    });
    await expect(
      restarted.runExternal(context(tenant), http, { attempt: 0 }),
    ).rejects.toMatchObject({
      reason: "quota_wait",
    });
    expect(http).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3])(
    "keeps retry attempt %s caller-owned across restart and stops after three retries",
    async (attempt) => {
      const restarted = new NationalCatalogRequestCoordinator(db, tokens, baseUrl);
      await expect(
        restarted.run(context(tenant), async () => ({ status: "unavailable" }), { attempt }),
      ).rejects.toMatchObject({
        state: attempt < 3 ? "retry" : "failed",
        reason: "unavailable",
        consumesAttempt: true,
      });
      const row = await lease();
      if (attempt < 3)
        expect(row.nextAllowedAt.getTime() - row.updatedAt.getTime()).toBeGreaterThanOrEqual(
          60_000 * 2 ** attempt - 100,
        );
    },
  );
  it("blocks authentication and environment mismatches without any HTTP", async () => {
    const http = vi.fn(async () => true);
    await db
      .update(schema.chzApiTokens)
      .set({ sourceTrueApiBaseUrl: CHZ_TRUE_API_BASE_URLS.production })
      .where(eq(schema.chzApiTokens.tenantId, tenant));
    await expect(a.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      state: "blocked",
      reason: "environment_mismatch",
      consumesAttempt: false,
    });
    await db.delete(schema.chzApiTokens).where(eq(schema.chzApiTokens.tenantId, tenant));
    await expect(a.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      state: "blocked",
      reason: "missing",
      consumesAttempt: false,
    });
    const wrongUrl = new NationalCatalogRequestCoordinator(db, tokens, `${baseUrl}:443`);
    await expect(wrongUrl.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
      reason: "environment_mismatch",
    });
    expect(http).not.toHaveBeenCalled();
  });
  it("does not release a lease when received quota could not be durably saved", async () => {
    await connection.pool.query(
      `CREATE FUNCTION reject_nc_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.total_quota IS DISTINCT FROM OLD.total_quota THEN RAISE EXCEPTION 'test quota persistence failure'; END IF; RETURN NEW; END $$`,
    );
    await connection.pool.query(
      `CREATE TRIGGER reject_nc_quota BEFORE UPDATE ON national_catalog_request_leases FOR EACH ROW EXECUTE FUNCTION reject_nc_quota()`,
    );
    try {
      await expect(
        a.run(
          context(tenant),
          async ({ onResponse }) => {
            onResponse?.({
              method: "/v3/feed-product",
              status: 200,
              usage: { total: { used: 500, limit: 500 }, method: null },
              retryAfterSeconds: 1800,
            });
            return true;
          },
          { attempt: 0 },
        ),
      ).rejects.toThrow();
      const [row] = await db
        .select({ active: sql<boolean>`${schema.nationalCatalogRequestLeases.leaseUntil} > now()` })
        .from(schema.nationalCatalogRequestLeases)
        .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
      expect(row?.active).toBe(true);
      await expect(b.run(context(tenant), async () => true, { attempt: 0 })).rejects.toMatchObject({
        reason: "lease_busy",
      });
    } finally {
      await connection.pool.query(
        "DROP TRIGGER reject_nc_quota ON national_catalog_request_leases",
      );
      await connection.pool.query("DROP FUNCTION reject_nc_quota()");
    }
  });
  it("shares rate-limit backoff after restart without consuming another HTTP attempt", async () => {
    const client = new NationalCatalogClient({
      fetch: async () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "1800", "API-Method-Usage-Limit": "1/10" },
        }),
      scheduleAbort: () => () => {},
    });
    await expect(
      a.run(
        context(tenant),
        ({ auth, ...options }) => client.getFeedProducts(auth, ["04601234567890"], options),
        { attempt: 0 },
      ),
    ).rejects.toMatchObject({ state: "retry", reason: "rate_limited", consumesAttempt: true });
    const row = await lease();
    expect(row.nextAllowedAt.getTime() - row.updatedAt.getTime()).toBeGreaterThan(1799_000);
    await expect(b.run(context(tenant), async () => true, { attempt: 1 })).rejects.toMatchObject({
      state: "deferred",
      consumesAttempt: false,
    });
  });
  it("CDN callback receives only a signal and never any bearer", async () => {
    const callback = vi.fn(async (_signal: AbortSignal) => "image");
    await expect(a.runExternal(context(tenant), callback, { attempt: 0 })).resolves.toBe("image");
    expect(callback.mock.calls).toHaveLength(1);
    expect(callback.mock.calls[0]).toHaveLength(1);
    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty("auth");
  });
  it.each(["expired", "unknown"])(
    "never starts HTTP for %s token provenance or auth",
    async (kind) => {
      await db
        .update(schema.chzApiTokens)
        .set(kind === "expired" ? { expiresAt: new Date(0) } : { sourceTrueApiBaseUrl: null })
        .where(eq(schema.chzApiTokens.tenantId, tenant));
      const http = vi.fn(async () => true);
      await expect(a.run(context(tenant), http, { attempt: 0 })).rejects.toMatchObject({
        state: "blocked",
        reason: kind === "expired" ? "expired" : "provenance_unknown",
      });
      expect(http).not.toHaveBeenCalled();
    },
  );
  it("401 becomes blocked, invalidates only the rejected token, and queues fresh auth", async () => {
    await db
      .insert(schema.chzSignerAgents)
      .values({ tenantId: tenant, name: "test", secretHash: randomUUID() });
    await expect(
      a.run(context(tenant), async () => ({ status: "unauthorized" }), { attempt: 0 }),
    ).rejects.toMatchObject({
      state: "blocked",
      reason: "unauthorized",
      consumesAttempt: true,
      nextRetryAt: null,
    });
    expect(
      await db.select().from(schema.chzApiTokens).where(eq(schema.chzApiTokens.tenantId, tenant)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.chzSignerTasks)
        .where(eq(schema.chzSignerTasks.tenantId, tenant)),
    ).toHaveLength(1);
  });
  it("aborts an actual hanging HTTP response at 15 seconds even with a longer legacy timeout", async () => {
    const closed = latch();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"apiversion":3,"result":[');
      res.on("close", closed.resolve);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server missing");
    const localUrl = `http://127.0.0.1:${address.port}`;
    const client = new NationalCatalogClient(
      {
        fetch: (_url, init) => fetch(localUrl, init),
        scheduleAbort: (controller, ms) => {
          const timer = setTimeout(() => controller.abort(), ms);
          return () => clearTimeout(timer);
        },
      },
      120_000,
    );
    const start = performance.now();
    try {
      await expect(
        a.run(
          context(tenant),
          ({ auth, ...options }) => client.getFeedProducts(auth, ["04601234567890"], options),
          { attempt: 0 },
        ),
      ).rejects.toMatchObject({ reason: "request_timeout", state: "retry" });
      await closed.promise;
      expect(performance.now() - start).toBeGreaterThanOrEqual(14_900);
      expect(performance.now() - start).toBeLessThan(18_000);
      const [released] = await db
        .select({
          expired: sql<boolean>`${schema.nationalCatalogRequestLeases.leaseUntil} <= now()`,
        })
        .from(schema.nationalCatalogRequestLeases)
        .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenant));
      expect(released?.expired).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 22_000);
});
