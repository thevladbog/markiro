import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";

// Failed sign-ins and the lockouts they start (plan 1f), kept in the local
// database so that restarting the app does not reset them. Time is this
// computer's clock in Unix milliseconds, injected by the caller.

/** How many failures in a row start a lockout, and how long it lasts. */
export interface LockoutPolicy {
  limit: number;
  durationMs: number;
}

/**
 * Every failure on this station, whoever it was for: ten in a row pause the
 * whole sign-in for a minute. It bounds guessing across personnel numbers
 * (one common PIN tried for many people) and badge codes typed by hand, and
 * stays short because it stops the whole line.
 */
export const STATION_LOCKOUT: LockoutPolicy = { limit: 10, durationMs: 60_000 };

/** A wrong PIN for one operator: five in a row lock that operator's PIN for five minutes. */
export const OPERATOR_LOCKOUT: LockoutPolicy = { limit: 5, durationMs: 5 * 60_000 };

/** The station's counter, or one operator's (by id, never by a typed number). */
export type LockoutKey = "station" | `operator:${string}`;

export function operatorKey(operatorId: string): LockoutKey {
  return `operator:${operatorId}`;
}

const lockRow = z.object({ lockedAt: z.number().int().nullable() });

/**
 * Counts one failure, in one statement. A lockout that has run out (the
 * caller records only while not locked) starts the count again from one, so
 * after every lockout the same number of tries is allowed before the next.
 * The failure that reaches the limit starts a lockout now. SQLite evaluates
 * every `SET` expression against the row as it was, so both read the old
 * `failures` and `locked_at`.
 */
const RECORD_FAILURE =
  "INSERT INTO floor_sign_in_failures (key, failures, locked_at) " +
  "VALUES (?, 1, CASE WHEN 1 >= ? THEN ? END) " +
  "ON CONFLICT (key) DO UPDATE SET " +
  "failures = CASE WHEN locked_at IS NULL THEN failures + 1 ELSE 1 END, " +
  "locked_at = CASE WHEN (CASE WHEN locked_at IS NULL THEN failures + 1 ELSE 1 END) >= ? " +
  "THEN ? END";

/**
 * How long `key` stays locked, in milliseconds; 0 when it is not. When this
 * computer's clock went back behind the lockout's start, the lockout starts
 * again from now: never longer than its duration, and never shorter because
 * of a clock moved back.
 */
export async function lockRemainingMs(
  local: LocalExecutor,
  key: LockoutKey,
  policy: LockoutPolicy,
  now: number,
): Promise<number> {
  const [row] = await local.query(
    "SELECT locked_at AS lockedAt FROM floor_sign_in_failures WHERE key = ?",
    [key],
    lockRow,
  );
  const lockedAt = row?.lockedAt ?? null;
  if (lockedAt === null) return 0;
  const elapsed = now - lockedAt;
  if (elapsed >= policy.durationMs) return 0;
  if (elapsed < 0) {
    await local.transaction([
      {
        sql: "UPDATE floor_sign_in_failures SET locked_at = ? WHERE key = ?",
        values: [now, key],
        expectedChanges: 1,
      },
    ]);
    return policy.durationMs;
  }
  return policy.durationMs - elapsed;
}

/**
 * Counts a failure for `key` (which the caller found unlocked) and answers
 * how long the lockout it started lasts: 0 when it started none.
 */
export async function recordFailure(
  local: LocalExecutor,
  key: LockoutKey,
  policy: LockoutPolicy,
  now: number,
): Promise<number> {
  await local.transaction([
    { sql: RECORD_FAILURE, values: [key, policy.limit, now, policy.limit, now] },
  ]);
  return lockRemainingMs(local, key, policy, now);
}

/** A successful sign-in forgets the station's failures and the operator's. */
export async function clearFailures(local: LocalExecutor, operatorId: string): Promise<void> {
  await local.transaction([
    {
      sql: "DELETE FROM floor_sign_in_failures WHERE key IN ('station', ?)",
      values: [operatorKey(operatorId)],
    },
  ]);
}
