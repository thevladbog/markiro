import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeFixturePool,
  dropFixtureDatabase,
  tolerateAdminShutdown,
} from "./support/fixture-pool";

describe("tolerateAdminShutdown", () => {
  function fakePool() {
    const pool = new EventEmitter();
    const client = new EventEmitter();
    tolerateAdminShutdown(pool as never);
    pool.emit("connect", client);
    return { pool, client };
  }

  it("swallows a late 57P01 on the pool and on a client", () => {
    const { pool, client } = fakePool();
    const shutdown = Object.assign(new Error("terminating connection"), { code: "57P01" });
    expect(() => pool.emit("error", shutdown)).not.toThrow();
    expect(() => client.emit("error", shutdown)).not.toThrow();
  });

  it("still fails on any other error code", () => {
    const { pool, client } = fakePool();
    const other = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    expect(() => pool.emit("error", other)).toThrow("connection reset");
    expect(() => client.emit("error", other)).toThrow("connection reset");
    expect(() => client.emit("error", new Error("no code"))).toThrow("no code");
  });
});

const maintenanceUrl = process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL;
describe.skipIf(process.env.SUPPORT_CHAT_ISOLATED_DB !== "1" || !maintenanceUrl)(
  "fixture database teardown",
  () => {
    const maintenance = createDb(maintenanceUrl ?? "postgres://unused");
    beforeAll(() => tolerateAdminShutdown(maintenance.pool));
    afterAll(() => closeFixturePool(maintenance.pool));

    async function scratch() {
      const name = `markiro_fixture_pool_${randomUUID().replaceAll("-", "_")}`;
      await maintenance.pool.query(`CREATE DATABASE "${name}"`);
      const url = new URL(maintenanceUrl!);
      url.pathname = `/${name}`;
      return { name, url: url.toString() };
    }
    const exists = async (name: string) =>
      (await maintenance.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]))
        .rowCount;

    it("drains real sockets, then drops, without terminating a live client", async () => {
      for (let i = 0; i < 20; i++) {
        const { name, url } = await scratch();
        const pool = createDb(url, { max: 5 }).pool;
        const errors: unknown[] = [];
        tolerateAdminShutdown(pool);
        pool.on("error", (error) => errors.push(error));
        await Promise.all([1, 2, 3, 4, 5].map(() => pool.query("select pg_sleep(0.01)")));
        // Plain pool.end() leaves the server-side backends alive for a moment.
        await pool.end();
        await dropFixtureDatabase(maintenance.pool, name);
        expect(await exists(name)).toBe(0);
        expect(errors).toEqual([]);
      }
    });

    it("waits for a connection that is still closing instead of terminating it", async () => {
      const { name, url } = await scratch();
      const closing = createDb(url, { max: 1 }).pool;
      const errors: unknown[] = [];
      closing.on("error", (error) => errors.push(error));
      const client = await closing.connect();
      client.on("error", (error) => errors.push(error));
      client.release();
      setTimeout(() => void closing.end(), 200);
      await dropFixtureDatabase(maintenance.pool, name);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await exists(name)).toBe(0);
      expect(errors).toEqual([]);
    });

    it("force-drops a genuine straggler only after the drain deadline", async () => {
      const { name, url } = await scratch();
      const straggler = createDb(url, { max: 1 }).pool;
      tolerateAdminShutdown(straggler);
      await straggler.query("select 1");
      await dropFixtureDatabase(maintenance.pool, name, { drainTimeoutMs: 100 });
      expect(await exists(name)).toBe(0);
      await straggler.end().catch(() => undefined);
    });

    it("closeFixturePool refuses a pool with an active client", async () => {
      const { name, url } = await scratch();
      const pool = createDb(url, { max: 1 }).pool;
      const client = await pool.connect();
      await expect(closeFixturePool(pool)).rejects.toThrow("active clients");
      client.release();
      await closeFixturePool(pool);
      await dropFixtureDatabase(maintenance.pool, name);
    });
  },
);
