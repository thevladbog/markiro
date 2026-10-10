import { once } from "node:events";
import type pg from "pg";
/** pg Pool.end removes idle clients before their sockets finish closing. Wait
 * for their real end events before dropping a fixture database. These suites
 * own the pool and must have drained every query before teardown. */
export async function closeFixturePool(pool: pg.Pool): Promise<void> {
  if (pool.totalCount !== pool.idleCount)
    throw new Error("Fixture pool still has active clients at teardown");
  const count = pool.totalCount;
  const clients = [];
  for (let i = 0; i < count; i++) clients.push(await pool.connect());
  const closed = clients.map((client) => once(client, "end"));
  for (const client of clients) client.release();
  await pool.end();
  await Promise.all(closed);
}
