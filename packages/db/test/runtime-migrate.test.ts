import { afterEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const db = {};
  const drizzle = vi.fn(() => db);
  const migration = vi.fn();
  const readFile = vi.fn();
  const client = {
    query: vi.fn(async (query: string, values?: unknown[]) => {
      calls.push(["query", query, values]);
    }),
    release: vi.fn(() => {
      calls.push(["release"]);
    }),
  };
  const pool = {
    connect: vi.fn(async () => {
      calls.push(["connect"]);
      return client;
    }),
    end: vi.fn(async () => {
      calls.push(["pool.end"]);
    }),
  };
  const Pool = vi.fn(function Pool() {
    return pool;
  });

  return { Pool, calls, client, db, drizzle, migration, pool, readFile };
});

vi.mock("pg", () => ({ default: { Pool: harness.Pool } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: harness.drizzle }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: harness.migration,
}));
vi.mock("node:fs/promises", () => ({ readFile: harness.readFile }));

import { runRuntimeMigrations } from "../src/runtime-migrate.js";

const databaseUrl = "postgres://user:secret@db.internal/markiro";
const migrationsFolder = "/bundle/migrations";
const lockQuery = "SELECT pg_advisory_lock($1, $2)";
const unlockQuery = "SELECT pg_advisory_unlock($1, $2)";
const lockKeys = [1296126539, 1230131023];

function resetHarness() {
  harness.calls.splice(0);
  harness.Pool.mockClear();
  harness.client.query.mockReset();
  harness.client.query.mockImplementation(async (query: string, values?: unknown[]) => {
    harness.calls.push(["query", query, values]);
  });
  harness.client.release.mockClear();
  harness.drizzle.mockClear();
  harness.migration.mockClear();
  harness.pool.connect.mockClear();
  harness.pool.end.mockClear();
  harness.readFile.mockReset();
  harness.readFile.mockResolvedValue(
    JSON.stringify({ entries: [{ tag: "0028_avatar-owner-integrity" }] }),
  );
  harness.migration.mockImplementation(async (_db: unknown, config: { migrationsFolder: string }) => {
    harness.calls.push(["migrate", config.migrationsFolder]);
  });
}

afterEach(resetHarness);
resetHarness();

describe("runRuntimeMigrations", () => {
  test("holds one session advisory lock across the runtime migration", async () => {
    const logs: string[] = [];

    const result = await runRuntimeMigrations({
      databaseUrl,
      migrationsFolder,
      log: (message) => logs.push(message),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", lockQuery, lockKeys],
      ["migrate", migrationsFolder],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
    expect(harness.drizzle).toHaveBeenCalledWith(harness.client);
    expect(harness.migration).toHaveBeenCalledWith(harness.db, { migrationsFolder });
    expect(result).toEqual({
      packaged: ["0028_avatar-owner-integrity"],
      completedAt: "2026-08-04T12:00:00.000Z",
    });
  });

  test("releases the lock, client, and pool when migration fails", async () => {
    const migrationError = new Error("provider says " + databaseUrl);
    harness.migration.mockRejectedValueOnce(migrationError);

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: vi.fn() }),
    ).rejects.toBe(migrationError);

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", lockQuery, lockKeys],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
  });

  test("preserves the migration error when unlock also fails", async () => {
    const migrationError = new Error("migration failed");
    harness.migration.mockRejectedValueOnce(migrationError);
    harness.client.query.mockImplementationOnce(async (query: string, values?: unknown[]) => {
      harness.calls.push(["query", query, values]);
    }).mockImplementationOnce(async (query: string, values?: unknown[]) => {
      harness.calls.push(["query", query, values]);
      throw new Error("unlock failed");
    });

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: vi.fn() }),
    ).rejects.toBe(migrationError);
    expect(harness.client.release).toHaveBeenCalledOnce();
    expect(harness.pool.end).toHaveBeenCalledOnce();
  });

  test("unlocks and closes resources when advisory lock acquisition fails", async () => {
    const logs: string[] = [];
    const lockError = new Error("provider says " + databaseUrl);
    harness.client.query.mockImplementationOnce(async (query: string, values?: unknown[]) => {
      harness.calls.push(["query", query, values]);
      throw lockError;
    }).mockImplementationOnce(async (query: string, values?: unknown[]) => {
      harness.calls.push(["query", query, values]);
      throw new Error("unlock failed");
    });

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: (message) => logs.push(message) }),
    ).rejects.toBe(lockError);

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", lockQuery, lockKeys],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
    expect(logs).toEqual([
      "runtime migration started",
      "migration packaged: 0028_avatar-owner-integrity",
      "runtime migration failed",
    ]);
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("logs packaged tags without SQL or connection secrets", async () => {
    const logs: string[] = [];
    harness.readFile.mockResolvedValueOnce(
      JSON.stringify({
        entries: [{ tag: "0028_avatar-owner-integrity", sql: "secret migration SQL" }],
      }),
    );

    await runRuntimeMigrations({ databaseUrl, migrationsFolder, log: (message) => logs.push(message) });

    expect(logs).toContain("migration packaged: 0028_avatar-owner-integrity");
    expect(logs.join("\n")).not.toContain("secret migration SQL");
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("logs only a stable failure phrase when migration fails", async () => {
    const logs: string[] = [];
    harness.migration.mockRejectedValueOnce(new Error("provider says " + databaseUrl));

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: (message) => logs.push(message) }),
    ).rejects.toThrow("provider says");

    expect(logs).toContain("runtime migration failed");
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("rejects an empty database URL before constructing a pool", async () => {
    await expect(
      runRuntimeMigrations({ databaseUrl: "", migrationsFolder, log: vi.fn() }),
    ).rejects.toThrow("DATABASE_URL is required");

    expect(harness.Pool).not.toHaveBeenCalled();
  });
});
