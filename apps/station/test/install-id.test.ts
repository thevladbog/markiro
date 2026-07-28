import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { getInstallId } from "../src/lib/install-id.js";

async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

describe("getInstallId (Finding 3)", () => {
  it("persists an id that a later call against the SAME database returns unchanged, surviving a reload", async () => {
    const exec = await migratedExec();
    const first = await getInstallId(exec);

    // No in-memory state carries over between these two calls -- each reads
    // `station_meta` independently, exactly like two separate app starts
    // against the same on-disk database would.
    const second = await getInstallId(exec);

    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("gives two different installations (two different databases) different ids", async () => {
    const execA = await migratedExec();
    const execB = await migratedExec();

    const idA = await getInstallId(execA);
    const idB = await getInstallId(execB);

    expect(idA).not.toBe(idB);
  });

  it("agrees on one id even when the row does not exist yet and two callers race to create it", async () => {
    const exec = await migratedExec();

    // Simulates two concurrent first-ever calls against the same fresh
    // database (e.g. two engines built in the same process) racing the
    // INSERT: `ON CONFLICT DO NOTHING` plus a read-back is what makes both
    // resolve to whichever id actually landed, rather than each trusting the
    // id it happened to generate.
    const [a, b] = await Promise.all([getInstallId(exec), getInstallId(exec)]);

    expect(a).toBe(b);
  });
});
