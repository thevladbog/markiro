import { setTimeout as pollInterval } from "node:timers/promises";
import type { createDb } from "@markiro/db";
import type { TestContext } from "vitest";

export function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export const outcome = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function startObservation(
  test: Pick<TestContext, "signal" | "onTestFinished">,
  work: (signal: AbortSignal, ready: () => Promise<void>) => Promise<void>,
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([test.signal, abort.signal]);
  const announced = barrier(),
    release = barrier();
  const running = outcome(
    Promise.resolve().then(() =>
      work(signal, async () => {
        announced.release();
        await release.promise;
      }),
    ),
  );
  const cleanup = async () => {
    abort.abort(new Error("owned_observation_cleanup"));
    release.release();
    await running;
  };
  // Synchronous registration precedes all setup, so timed-out test bodies drain
  // actual transactions before fixture disposal or any subsequent reset.
  test.onTestFinished(cleanup);
  const ready = abortable(
    Promise.race([
      announced.promise,
      running.then(({ error }) => {
        throw error ?? new Error("worker_finished_before_readiness");
      }),
    ]),
    signal,
  );
  return { abort, ready, running, cleanup, proceed: release.release };
}

export async function waitBlocked(
  connection: ReturnType<typeof createDb>,
  blocker: number,
  blocked: number,
  signal: AbortSignal,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  for (;;) {
    deadline.throwIfAborted();
    const rows = await abortable(
      connection.pool.query<{
        blocker: number;
        blocked: number;
        blockers: number[];
        database: string;
      }>(
        "SELECT $1::int AS blocker,$2::int AS blocked,pg_blocking_pids($2::int) AS blockers,current_database() AS database",
        [blocker, blocked],
      ),
      deadline,
    );
    if (rows.rows[0]?.blockers.includes(blocker)) {
      console.info("Observed owned PostgreSQL blocker", rows.rows[0]);
      return;
    }
    await pollInterval(10, undefined, { signal: deadline });
  }
}

/** Pool shutdown is local bookkeeping; PostgreSQL owns the backend's actual lifetime. */
export async function waitOwnedBackendsGone(
  connection: Pick<ReturnType<typeof createDb>, "pool">,
  pids: readonly number[],
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    const observed = await abortable(
      connection.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
        [pids],
      ),
      signal,
    );
    signal.throwIfAborted();
    const count = observed.rows[0]?.n;
    if (count === 0) return;
    if (count === undefined || !Number.isInteger(count) || count < 0)
      throw new Error("owned_backend_probe_invalid");
    await abortable(pollInterval(10, undefined, { signal }), signal);
  }
}

export function driverCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error) return error.code;
  return "cause" in error ? driverCode(error.cause) : undefined;
}

export type OwnCleanup = (phase: string, cleanup: () => Promise<void>) => void;
type ConnectCallback = Parameters<ReturnType<typeof createDb>["pool"]["connect"]>[0];
export type OwnedClient = NonNullable<Parameters<ConnectCallback>[1]>;
export const connectClient = (pool: ReturnType<typeof createDb>["pool"]): Promise<OwnedClient> =>
  pool.connect();
export type CleanupEvidence = {
  primaryError: unknown;
  cleanupFailures: { phase: string; error: unknown }[];
};

export async function withOwnedWork<T>(
  run: (own: OwnCleanup) => Promise<T>,
  report: (evidence: CleanupEvidence) => void = ({ cleanupFailures }) => {
    for (const failure of cleanupFailures)
      console.error(
        "Owned lock cleanup failure",
        failure.phase,
        driverCode(failure.error) ?? "connection_error",
      );
  },
): Promise<T> {
  const cleanups: { phase: string; run: () => Promise<void> }[] = [];
  let result: { value: T } | undefined;
  let primary: { error: unknown } | undefined;
  try {
    result = { value: await run((phase, cleanup) => cleanups.push({ phase, run: cleanup })) };
  } catch (error) {
    primary = { error };
  }
  const cleanupFailures: CleanupEvidence["cleanupFailures"] = [];
  // A failed gate release must not bypass actual worker drain, trigger removal,
  // checked-out client destruction or any independently acquired pool shutdown.
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup.run();
    } catch (error) {
      cleanupFailures.push({ phase: cleanup.phase, error });
    }
  }
  try {
    report({ primaryError: primary?.error, cleanupFailures });
  } catch (error) {
    cleanupFailures.push({ phase: "cleanup-report", error });
  }
  if (primary) throw primary.error;
  if (cleanupFailures.length)
    throw new AggregateError(
      cleanupFailures.map(({ error }) => error),
      "owned_lock_cleanup_failed",
    );
  if (!result) throw new Error("owned_work_missing_result");
  return result.value;
}

export function ownClient(
  own: OwnCleanup,
  client: OwnedClient,
  phase: string,
  cleanupSql: () => Promise<unknown>,
  destroy = () => client.release(true),
) {
  own(phase, async () => {
    try {
      await cleanupSql();
    } finally {
      destroy();
    }
  });
}
