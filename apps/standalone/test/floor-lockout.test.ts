import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  clearFailures,
  lockRemainingMs,
  OPERATOR_LOCKOUT,
  operatorKey,
  recordFailure,
  STATION_LOCKOUT,
} from "../src/floor/lockout.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { openLocalDb } from "./support/local-db.js";

const NOW = 1_790_000_000_000;
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const POLICY = { limit: 3, durationMs: 60_000 };

// Bound before use: the jsdom environment rewrites a literal `new URL(..., import.meta.url)`.
const moduleUrl = import.meta.url;
const MIGRATION = new URL("../src-tauri/migrations/0005_floor_sign_in_failures.sql", moduleUrl);

/** A `LocalExecutor` over any database, binding integers as the shell does. */
function fileExecutor(db: DatabaseSync): LocalExecutor {
  const bind = (value: unknown): SQLInputValue =>
    typeof value === "number" ? BigInt(value) : (value as SQLInputValue);
  return {
    async query(sql, params, row) {
      return z.array(row).parse(db.prepare(sql).all(...params.map(bind)));
    },
    async transaction(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map(({ sql, values = [] }) =>
          Number(db.prepare(sql).run(...values.map(bind)).changes),
        );
        db.exec("COMMIT");
        return changes;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function rows(db: DatabaseSync) {
  const sql = "SELECT key, failures, locked_at FROM floor_sign_in_failures ORDER BY key";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

describe("sign-in lockouts", () => {
  it("names the policies: ten failures pause the station for a minute, five lock a PIN for five", () => {
    expect(STATION_LOCKOUT).toEqual({ limit: 10, durationMs: 60_000 });
    expect(OPERATOR_LOCKOUT).toEqual({ limit: 5, durationMs: 300_000 });
    expect(operatorKey(ANNA)).toBe(`operator:${ANNA}`);
  });

  it("counts failures and starts a lockout at the limit, for its whole duration", async () => {
    const { db, executor } = openLocalDb();
    expect(await recordFailure(executor, "station", POLICY, NOW)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, NOW + 1)).toBe(0);
    expect(rows(db)).toEqual([{ key: "station", failures: 2, locked_at: null }]);
    expect(await recordFailure(executor, "station", POLICY, NOW + 2)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 3, locked_at: NOW + 2 }]);

    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 2)).toBe(60_000);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 40_002)).toBe(20_000);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 60_001)).toBe(1);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 60_002)).toBe(0);
  });

  it("allows the same number of tries again after a lockout ran out", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    const later = NOW + 60_000;
    expect(await lockRemainingMs(executor, "station", POLICY, later)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, later)).toBe(0);
    expect(rows(db)).toEqual([{ key: "station", failures: 1, locked_at: null }]);
    expect(await recordFailure(executor, "station", POLICY, later)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, later + 5)).toBe(60_000);
  });

  it("starts a lockout again from now when this computer's clock went back behind it", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    // The clock went back a day: still locked, for no more than the duration.
    const earlier = NOW - 86_400_000;
    expect(await lockRemainingMs(executor, "station", POLICY, earlier)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 3, locked_at: earlier }]);
    expect(await lockRemainingMs(executor, "station", POLICY, earlier + 60_000)).toBe(0);
  });

  it("keeps each operator's count apart from the station's and from the other operators'", async () => {
    const { db, executor } = openLocalDb();
    await recordFailure(executor, "station", POLICY, NOW);
    await recordFailure(executor, operatorKey(ANNA), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    expect(rows(db)).toEqual([
      { key: `operator:${BORIS}`, failures: 2, locked_at: null },
      { key: `operator:${ANNA}`, failures: 1, locked_at: null },
      { key: "station", failures: 1, locked_at: null },
    ]);

    // A sign-in forgets the station's failures and that operator's only.
    await clearFailures(executor, ANNA);
    expect(rows(db)).toEqual([{ key: `operator:${BORIS}`, failures: 2, locked_at: null }]);
  });

  it("starts a lockout on the very first failure when the limit is one, and again after it ran out", async () => {
    const { db, executor } = openLocalDb();
    const once = { limit: 1, durationMs: 60_000 };
    expect(await recordFailure(executor, "station", once, NOW)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 1, locked_at: NOW }]);
    expect(await recordFailure(executor, "station", once, NOW + 60_000)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 1, locked_at: NOW + 60_000 }]);
  });

  it("fails, rather than answers, when the lockout it re-anchors was forgotten meanwhile", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    const forgetting: LocalExecutor = {
      query: async (sql, params, row) => {
        const found = await executor.query(sql, params, row);
        db.exec("DELETE FROM floor_sign_in_failures");
        return found;
      },
      transaction: (statements) => executor.transaction(statements),
    };
    await expect(
      lockRemainingMs(forgetting, "station", POLICY, NOW - 86_400_000),
    ).rejects.toBeInstanceOf(LocalDbError);
  });

  it("knows nothing of a key that never failed, and writes nothing when asked", async () => {
    const { db, executor } = openLocalDb();
    expect(await lockRemainingMs(executor, operatorKey(ANNA), OPERATOR_LOCKOUT, NOW)).toBe(0);
    expect(rows(db)).toEqual([]);
  });

  it("keeps only a count and a time: no zero count, no second row for a key", () => {
    const { db } = openLocalDb();
    const insert =
      "INSERT INTO floor_sign_in_failures (key, failures, locked_at) VALUES (?, ?, NULL)";
    expect(() => db.prepare(insert).run("station", 0)).toThrow(/CHECK constraint/);
    db.prepare(insert).run("station", 1);
    expect(() => db.prepare(insert).run("station", 2)).toThrow(/UNIQUE constraint/);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('floor_sign_in_failures')")
      .all();
    expect(columns.map((column) => column["name"])).toEqual(["key", "failures", "locked_at"]);
  });

  it("survives the application's restart: a database file closed and opened again still holds the lockout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "markiro-lockout-"));
    try {
      const file = join(directory, "station.sqlite");
      const first = new DatabaseSync(file);
      first.exec(readFileSync(MIGRATION, "utf8"));
      const before = fileExecutor(first);
      for (let failure = 0; failure < 3; failure += 1) {
        await recordFailure(before, "station", POLICY, NOW);
      }
      await recordFailure(before, operatorKey(ANNA), POLICY, NOW);
      first.close();

      const second = new DatabaseSync(file);
      const after = fileExecutor(second);
      expect(await lockRemainingMs(after, "station", POLICY, NOW + 10_000)).toBe(50_000);
      expect(rows(second)).toEqual([
        { key: `operator:${ANNA}`, failures: 1, locked_at: null },
        { key: "station", failures: 3, locked_at: NOW },
      ]);
      expect(await lockRemainingMs(after, "station", POLICY, NOW + 60_000)).toBe(0);
      expect(await recordFailure(after, operatorKey(ANNA), POLICY, NOW + 60_000)).toBe(0);
      expect(rows(second)[0]).toEqual({ key: `operator:${ANNA}`, failures: 2, locked_at: null });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
