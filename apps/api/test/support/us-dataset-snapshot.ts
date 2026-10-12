import type { createDb } from "@markiro/db";
import { createHash } from "node:crypto";

/** Hash every public row in one MVCC snapshot without materializing whole tables. */
export async function snapshotUsDatasetTables(
  pool: ReturnType<typeof createDb>["pool"],
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
    for (const { tablename } of tables.rows) {
      await client.query(
        `DECLARE dataset_snapshot NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS body FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`,
      );
      const hash = createHash("sha256").update("[");
      let first = true;
      for (;;) {
        const batch = await client.query<{ body: unknown }>("FETCH 64 FROM dataset_snapshot");
        if (batch.rows.length === 0) break;
        for (const { body } of batch.rows) {
          if (!first) hash.update(",");
          hash.update(JSON.stringify(body));
          first = false;
        }
      }
      await client.query("CLOSE dataset_snapshot");
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
