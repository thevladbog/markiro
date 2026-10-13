import type { createDb } from "@markiro/db";
import { createHash } from "node:crypto";

/** Hash every public row in one MVCC snapshot without materializing whole tables. */
export async function snapshotUsDatasetTables(
  pool: Pick<ReturnType<typeof createDb>["pool"], "connect">,
): Promise<Record<string, string>> {
  const client = await pool.connect();
  let hasError = false;
  let failure: unknown;
  let discard = false;
  const result: Record<string, string> = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    for (const { tablename } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename))
        throw new Error("us_dataset_fixture_table_invalid");
    }
    const hashes = new Map(
      tables.rows.map(({ tablename }) => [
        tablename,
        { hash: createHash("sha256").update("["), first: true },
      ]),
    );
    if (tables.rows.length) {
      const selections = tables.rows.map(
        ({ tablename }) =>
          `SELECT '${tablename}' AS tablename, to_jsonb(t) AS body FROM public."${tablename}" t`,
      );
      // One cursor keeps the same per-table ordering and MVCC snapshot, while
      // empty tables no longer incur DECLARE/FETCH/CLOSE network round trips.
      await client.query(
        `DECLARE dataset_snapshot NO SCROLL CURSOR FOR SELECT tablename, body FROM (${selections.join(" UNION ALL ")}) dataset_snapshot_rows ORDER BY tablename, body::text`,
      );
      for (;;) {
        const batch = await client.query<{ tablename: string; body: unknown }>(
          "FETCH 64 FROM dataset_snapshot",
        );
        if (batch.rows.length === 0) break;
        for (const { tablename, body } of batch.rows) {
          const entry = hashes.get(tablename);
          if (!entry) throw new Error("us_dataset_fixture_table_invalid");
          if (!entry.first) entry.hash.update(",");
          entry.hash.update(JSON.stringify(body));
          entry.first = false;
        }
      }
      await client.query("CLOSE dataset_snapshot");
    }
    for (const [tablename, { hash }] of hashes) {
      // Match SHA256(JSON.stringify(jsonb_agg-body)), including empty arrays.
      Object.defineProperty(result, tablename, {
        value: hash.update("]").digest("hex"),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    hasError = true;
    failure = error;
    try {
      await client.query("ROLLBACK");
    } catch {
      // A connection with uncertain transaction state must not return to the pool.
      discard = true;
    }
  } finally {
    try {
      client.release(discard);
    } catch (error) {
      if (!hasError) {
        hasError = true;
        failure = error;
      }
    }
  }
  if (hasError) throw failure;
  return result;
}
