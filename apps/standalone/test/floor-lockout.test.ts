import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  clearOperatorFailures,
  lockRemainingMs,
  OPERATOR_LOCKOUT,
  operatorKey,
  recordFailure,
  STATION_LOCKOUT,
  STATION_QUIET_MS,
} from "../src/floor/lockout.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";

const NOW = 1_790_000_000_000;
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const POLICY = { limit: 3, durationMs: 60_000 };
/** `POLICY` with the station's rolling count: failures further apart than the quiet interval do not add up. */
const ROLLING = { ...POLICY, quietMs: STATION_QUIET_MS };

function rows(db: DatabaseSync) {
  const sql =
    "SELECT key, failures, locked_at, last_failure_at FROM floor_sign_in_failures ORDER BY key";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

describe("sign-in lockouts", () => {
  it("names the policies: ten failures within ten quiet minutes pause the station for a minute, five lock a PIN for five", () => {
    expect(STATION_QUIET_MS).toBe(600_000);
    expect(STATION_LOCKOUT).toEqual({ limit: 10, durationMs: 60_000, quietMs: 600_000 });
    expect(OPERATOR_LOCKOUT).toStrictEqual({ limit: 5, durationMs: 300_000 });
    expect(operatorKey(ANNA)).toBe(`operator:${ANNA}`);
  });

  it("counts failures and starts a lockout at the limit, for its whole duration", async () => {
    const { db, executor } = openLocalDb();
    expect(await recordFailure(executor, "station", POLICY, NOW)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, NOW + 1)).toBe(0);
    expect(rows(db)).toEqual([
      { key: "station", failures: 2, locked_at: null, last_failure_at: NOW + 1 },
    ]);
    expect(await recordFailure(executor, "station", POLICY, NOW + 2)).toBe(60_000);
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: NOW + 2, last_failure_at: NOW + 2 },
    ]);

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
    expect(rows(db)).toEqual([
      { key: "station", failures: 1, locked_at: null, last_failure_at: later },
    ]);
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
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: earlier, last_failure_at: NOW },
    ]);
    expect(await lockRemainingMs(executor, "station", POLICY, earlier + 60_000)).toBe(0);
  });

  it("keeps each operator's count apart from the station's and from the other operators'", async () => {
    const { db, executor } = openLocalDb();
    await recordFailure(executor, "station", POLICY, NOW);
    await recordFailure(executor, operatorKey(ANNA), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    expect(rows(db)).toEqual([
      { key: `operator:${BORIS}`, failures: 2, locked_at: null, last_failure_at: NOW },
      { key: `operator:${ANNA}`, failures: 1, locked_at: null, last_failure_at: NOW },
      { key: "station", failures: 1, locked_at: null, last_failure_at: NOW },
    ]);

    // A sign-in forgets that operator's failures only: not the station's, not another operator's.
    await clearOperatorFailures(executor, ANNA);
    expect(rows(db)).toEqual([
      { key: `operator:${BORIS}`, failures: 2, locked_at: null, last_failure_at: NOW },
      { key: "station", failures: 1, locked_at: null, last_failure_at: NOW },
    ]);
  });

  it("starts a lockout on the very first failure when the limit is one, and again after it ran out", async () => {
    const { db, executor } = openLocalDb();
    const once = { limit: 1, durationMs: 60_000 };
    expect(await recordFailure(executor, "station", once, NOW)).toBe(60_000);
    expect(rows(db)).toEqual([
      { key: "station", failures: 1, locked_at: NOW, last_failure_at: NOW },
    ]);
    expect(await recordFailure(executor, "station", once, NOW + 60_000)).toBe(60_000);
    expect(rows(db)).toEqual([
      { key: "station", failures: 1, locked_at: NOW + 60_000, last_failure_at: NOW + 60_000 },
    ]);
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
      "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
      "VALUES (?, ?, NULL, 1)";
    expect(() => db.prepare(insert).run("station", 0)).toThrow(/CHECK constraint/);
    db.prepare(insert).run("station", 1);
    expect(() => db.prepare(insert).run("station", 2)).toThrow(/UNIQUE constraint/);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('floor_sign_in_failures')")
      .all();
    expect(columns.map((column) => column["name"])).toEqual([
      "key",
      "failures",
      "locked_at",
      "last_failure_at",
    ]);
    const without =
      "INSERT INTO floor_sign_in_failures (key, failures, locked_at) VALUES ('operator:x', 1, NULL)";
    expect(() => db.prepare(without).run()).toThrow(/NOT NULL constraint/);
  });

  it("survives the application's restart: a database file closed and opened again still holds the lockout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "markiro-lockout-"));
    try {
      const file = join(directory, "station.sqlite");
      const first = openLocalDbFile(file);
      for (let failure = 0; failure < 3; failure += 1) {
        await recordFailure(first.executor, "station", POLICY, NOW);
      }
      await recordFailure(first.executor, operatorKey(ANNA), POLICY, NOW);
      first.db.close();

      const second = openLocalDbFile(file);
      const after = second.executor;
      expect(await lockRemainingMs(after, "station", POLICY, NOW + 10_000)).toBe(50_000);
      expect(rows(second.db)).toEqual([
        { key: `operator:${ANNA}`, failures: 1, locked_at: null, last_failure_at: NOW },
        { key: "station", failures: 3, locked_at: NOW, last_failure_at: NOW },
      ]);
      expect(await lockRemainingMs(after, "station", POLICY, NOW + 60_000)).toBe(0);
      expect(await recordFailure(after, operatorKey(ANNA), POLICY, NOW + 60_000)).toBe(0);
      expect(rows(second.db)[0]).toEqual({
        key: `operator:${ANNA}`,
        failures: 2,
        locked_at: null,
        last_failure_at: NOW + 60_000,
      });
      second.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the station's rolling count", () => {
  it("adds failures up while each comes within the quiet interval of the one before, however long they go on", async () => {
    const { db, executor } = openLocalDb();
    const many = { limit: 4, durationMs: 60_000, quietMs: STATION_QUIET_MS };
    let at = NOW;
    for (let failure = 1; failure <= 3; failure += 1) {
      expect(await recordFailure(executor, "station", many, at)).toBe(0);
      at += STATION_QUIET_MS - 1;
    }
    at -= STATION_QUIET_MS - 1;
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: null, last_failure_at: at },
    ]);
    expect(await recordFailure(executor, "station", many, at + 1)).toBe(60_000);
  });

  it("counts a failure exactly one quiet interval after the last still with it, and the next millisecond afresh", async () => {
    const { db, executor } = openLocalDb();
    await recordFailure(executor, "station", ROLLING, NOW);
    await recordFailure(executor, "station", ROLLING, NOW + STATION_QUIET_MS);
    expect(rows(db)).toEqual([
      { key: "station", failures: 2, locked_at: null, last_failure_at: NOW + STATION_QUIET_MS },
    ]);

    const later = NOW + 2 * STATION_QUIET_MS + 1;
    expect(await recordFailure(executor, "station", ROLLING, later)).toBe(0);
    expect(rows(db)).toEqual([
      { key: "station", failures: 1, locked_at: null, last_failure_at: later },
    ]);
    // The count restarted: two more are still no lockout, the third is.
    expect(await recordFailure(executor, "station", ROLLING, later + 1)).toBe(0);
    expect(await recordFailure(executor, "station", ROLLING, later + 2)).toBe(60_000);
  });

  it("measures the quiet from the last failure, not from the first", async () => {
    const { db, executor } = openLocalDb();
    const third = NOW + 2 * (STATION_QUIET_MS - 1);
    await recordFailure(executor, "station", ROLLING, NOW);
    await recordFailure(executor, "station", ROLLING, NOW + STATION_QUIET_MS - 1);
    expect(await recordFailure(executor, "station", ROLLING, third)).toBe(60_000);
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: third, last_failure_at: third },
    ]);
  });

  it("does not restart an operator's count after a quiet interval: that row counts until a sign-in or a lockout ends it", async () => {
    const { db, executor } = openLocalDb();
    const key = operatorKey(ANNA);
    await recordFailure(executor, key, OPERATOR_LOCKOUT, NOW);
    await recordFailure(executor, key, OPERATOR_LOCKOUT, NOW + 3 * STATION_QUIET_MS);
    expect(rows(db)).toEqual([
      { key, failures: 2, locked_at: null, last_failure_at: NOW + 3 * STATION_QUIET_MS },
    ]);
  });

  it("counts a failure when the clock went back as one more, not as a restart", async () => {
    const { db, executor } = openLocalDb();
    await recordFailure(executor, "station", ROLLING, NOW);
    const earlier = NOW - 86_400_000;
    await recordFailure(executor, "station", ROLLING, earlier);
    expect(rows(db)).toEqual([
      { key: "station", failures: 2, locked_at: null, last_failure_at: earlier },
    ]);
  });

  it("is not reset by a sign-in: only the signed-in operator's row goes", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 9; failure += 1) {
      await recordFailure(executor, "station", STATION_LOCKOUT, NOW + failure);
    }
    await recordFailure(executor, operatorKey(ANNA), OPERATOR_LOCKOUT, NOW);
    await clearOperatorFailures(executor, ANNA);
    expect(rows(db)).toEqual([
      { key: "station", failures: 9, locked_at: null, last_failure_at: NOW + 8 },
    ]);
    expect(await recordFailure(executor, "station", STATION_LOCKOUT, NOW + 9)).toBe(60_000);
  });
});

describe("a failure recorded on a running lockout", () => {
  it("changes nothing: neither the count, nor the lockout's start, nor the time of the last failure", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW + failure);
    }
    const locked = rows(db);
    expect(locked).toEqual([
      { key: "station", failures: 3, locked_at: NOW + 2, last_failure_at: NOW + 2 },
    ]);
    expect(await recordFailure(executor, "station", POLICY, NOW + 10_000)).toBe(50_002);
    expect(rows(db)).toEqual(locked);
  });

  it("changes nothing either when this computer's clock went back behind the lockout, which starts again from now", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    const earlier = NOW - 86_400_000;
    expect(await recordFailure(executor, "station", POLICY, earlier)).toBe(60_000);
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: earlier, last_failure_at: NOW },
    ]);
  });

  it("counts again from the very millisecond the lockout runs out", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    expect(await recordFailure(executor, "station", POLICY, NOW + 59_999)).toBe(1);
    expect(rows(db)).toEqual([
      { key: "station", failures: 3, locked_at: NOW, last_failure_at: NOW },
    ]);
    expect(await recordFailure(executor, "station", POLICY, NOW + 60_000)).toBe(0);
    expect(rows(db)).toEqual([
      { key: "station", failures: 1, locked_at: null, last_failure_at: NOW + 60_000 },
    ]);
  });
});
