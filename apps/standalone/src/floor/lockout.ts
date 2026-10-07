import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";

// Failed sign-ins and the lockouts they start (plan 1f), kept in the local
// database so that restarting the app does not reset them. Time is this
// computer's clock in Unix milliseconds, injected by the caller.

/**
 * How many failures in a row start a lockout, and how long it lasts. With
 * `quietMs`, failures further apart than that (the latest older than
 * `quietMs`) do not add up: the count starts again from one.
 */
export interface LockoutPolicy {
  limit: number;
  durationMs: number;
  quietMs?: number;
}

/**
 * How long the station's counter waits without a failure before it starts
 * again from one. A successful sign-in does NOT reset the station's counter
 * (a worker with any valid credential could otherwise interleave their own
 * sign-in and guess badge codes without the bound), so the counter decays
 * with time instead: ten minutes, long enough that a slow guesser (one
 * failure a minute) still reaches the limit, short enough that an honest
 * station is not paused by the stray failures of a whole shift.
 */
export const STATION_QUIET_MS = 10 * 60_000;

/**
 * Every failure on this station, whoever it was for: ten within a rolling
 * quiet interval (`STATION_QUIET_MS` since the one before) pause the whole
 * sign-in for a minute. It bounds guessing across personnel numbers (one
 * common PIN tried for many people) and badge codes typed by hand, and stays
 * short because it stops the whole line. A success does not reset it, so the
 * bound holds against someone with a valid credential too; per-operator PIN
 * guessing is bounded by the operator's own row (`OPERATOR_LOCKOUT`).
 *
 * The sustained ceiling: when a lockout ends the count restarts at one with
 * no escalation, so a patient guesser gets about ten guesses per 70 seconds
 * (roughly 500–600 an hour from the station alone); escalation is an open
 * owner question.
 */
export const STATION_LOCKOUT: LockoutPolicy = {
  limit: 10,
  durationMs: 60_000,
  quietMs: STATION_QUIET_MS,
};

/**
 * A wrong PIN for one operator: five in a row lock that operator's PIN for
 * five minutes. Only that operator's own successful sign-in clears the row;
 * time does not.
 */
export const OPERATOR_LOCKOUT: LockoutPolicy = { limit: 5, durationMs: 5 * 60_000 };

/** The station's counter, or one operator's (by id, never by a typed number). */
export type LockoutKey = "station" | `operator:${string}`;

export function operatorKey(operatorId: string): LockoutKey {
  return `operator:${operatorId}`;
}

const lockRow = z.object({ lockedAt: z.number().int().nullable() });

/**
 * Counts one failure, in one statement, and stamps its time. The count
 * starts again from one when the lockout it was in has run out, or, for a
 * policy with a quiet interval, when the previous failure is more than that
 * interval older than this one (exactly the interval still counts; a clock
 * moved back gives a negative age, which counts too). The failure that
 * reaches the limit starts a lockout now. SQLite evaluates every `SET`
 * expression against the row as it was, so all read the old `failures`,
 * `locked_at` and `last_failure_at`. A policy without a quiet interval binds
 * NULL, which makes the comparison NULL and the count never restart that way.
 *
 * The `WHERE` leaves a row whose lockout is still running as it is: a
 * failure recorded then (by a caller that did not check first) must not end
 * the lockout or move its start. A lockout counts as running while its start
 * is less than its duration behind `now`, which includes a clock moved back
 * behind it (`lockRemainingMs` starts that one again from now).
 */
const RECORD_FAILURE =
  "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
  "VALUES (?, 1, CASE WHEN 1 >= ? THEN ? END, ?) " +
  "ON CONFLICT (key) DO UPDATE SET " +
  "failures = CASE WHEN locked_at IS NOT NULL THEN 1 " +
  "WHEN ? - last_failure_at > ? THEN 1 ELSE failures + 1 END, " +
  "locked_at = CASE WHEN (CASE WHEN locked_at IS NOT NULL THEN 1 " +
  "WHEN ? - last_failure_at > ? THEN 1 ELSE failures + 1 END) >= ? THEN ? END, " +
  "last_failure_at = ? " +
  "WHERE locked_at IS NULL OR ? - locked_at >= ?";

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
  const quiet = policy.quietMs ?? null;
  await local.transaction([
    {
      sql: RECORD_FAILURE,
      values: [
        ...[key, policy.limit, now, now],
        ...[now, quiet, now, quiet, policy.limit, now, now],
        ...[now, policy.durationMs],
      ],
    },
  ]);
  return lockRemainingMs(local, key, policy, now);
}

/**
 * A successful sign-in forgets that operator's failures, and only theirs:
 * the station's counter is not reset by a success (see `STATION_QUIET_MS`).
 */
export async function clearOperatorFailures(
  local: LocalExecutor,
  operatorId: string,
): Promise<void> {
  await local.transaction([
    { sql: "DELETE FROM floor_sign_in_failures WHERE key = ?", values: [operatorKey(operatorId)] },
  ]);
}
