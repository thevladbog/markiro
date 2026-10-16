import { once } from "node:events";
import type { createDb } from "@markiro/db";

/** Server code for "terminating connection due to administrator command". */
const ADMIN_SHUTDOWN = "57P01";

// apps/api does not depend on pg directly; name the pool type by reference.
type Pool = ReturnType<typeof createDb>["pool"];

/**
 * A fixture teardown may race a connection that the server is closing. Such a
 * late 57P01 must never surface as an unhandled 'error' event after the suite
 * has passed, but any other error code is a real defect and is rethrown (so it
 * still fails the run). Idle-client errors reach the pool; errors on a client
 * already removed by `pool.end()` reach the client itself, so listen on both.
 */
export function tolerateAdminShutdown(pool: Pick<Pool, "on">): void {
  const guard = (error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === ADMIN_SHUTDOWN) return;
    throw error;
  };
  pool.on("error", guard);
  pool.on("connect", (client) => client.on("error", guard));
}

/** pg Pool.end() resolves before the pooled sockets have really closed. Wait
 * for the real `end` events. The caller owns the pool and must have drained
 * every query before teardown. */
export async function closeFixturePool(pool: Pool): Promise<void> {
  if (pool.totalCount !== pool.idleCount)
    throw new Error("Fixture pool still has active clients at teardown");
  const clients = [];
  for (let i = 0, count = pool.totalCount; i < count; i++) clients.push(await pool.connect());
  const closed = clients.map((client) => once(client, "end"));
  for (const client of clients) client.release();
  await pool.end();
  await Promise.all(closed);
}

/**
 * Drop a scratch database only after every connection to it is gone. The app
 * under test owns pools this helper cannot see (auth, invitation advisory
 * lock, pg-boss), so wait for the server to report no backends instead of
 * trusting each `pool.end()`. FORCE then only reaps a genuine straggler
 * after the deadline, never a connection that is merely closing.
 */
export async function dropFixtureDatabase(
  maintenance: Pick<Pool, "query">,
  databaseName: string,
  options: { drainTimeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.drainTimeoutMs ?? 5_000);
  for (;;) {
    const { rows } = await maintenance.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    );
    if ((rows[0]?.n ?? 0) === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const quoted = `"${databaseName.replaceAll('"', '""')}"`;
  await maintenance.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
}
