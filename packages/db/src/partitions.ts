import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

const PARENTS = ["codes", "scan_events"] as const;

export function partitionName(parent: string, month: Date): string {
  const y = month.getUTCFullYear();
  const m = String(month.getUTCMonth() + 1).padStart(2, "0");
  return `${parent}_${y}${m}`;
}

/** Extracts the Postgres SQLSTATE from a raw pg error or a drizzle-wrapped one. */
export function pgCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function monthBounds(month: Date): [string, string] {
  const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  return [from.toISOString(), to.toISOString()];
}

/** Idempotently creates monthly children; returns names actually created. */
export async function ensurePartitions(db: Db, months: Date[]): Promise<string[]> {
  const created: string[] = [];
  for (const month of months) {
    const [from, to] = monthBounds(month);
    for (const parent of PARENTS) {
      const name = partitionName(parent, month);
      const exists = await db.execute(
        sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ${name} AND n.nspname = current_schema()`,
      );
      if (exists.rows.length > 0) continue;
      try {
        await db.execute(
          sql.raw(
            `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}"
             FOR VALUES FROM ('${from}') TO ('${to}')`,
          ),
        );
      } catch (error) {
        // Concurrent bootstraps (parallel test files, multi-instance API) can
        // both pass the existence probe; PARTITION OF takes a lock on the
        // parent and the loser raises 42P07 even with IF NOT EXISTS. The
        // partition exists — that is the desired end state, so swallow it.
        // NB: drizzle wraps pg errors (DrizzleQueryError) — the SQLSTATE
        // lives on error.cause, so check both levels.
        if (pgCode(error) === "42P07") continue;
        throw error;
      }
      created.push(name);
    }
  }
  return created;
}
