import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

const PARENTS = ["codes", "scan_events"] as const;

export function partitionName(parent: string, month: Date): string {
  const y = month.getUTCFullYear();
  const m = String(month.getUTCMonth() + 1).padStart(2, "0");
  return `${parent}_${y}${m}`;
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
      const exists = await db.execute(sql`SELECT 1 FROM pg_class WHERE relname = ${name}`);
      if (exists.rows.length > 0) continue;
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}"
           FOR VALUES FROM ('${from}') TO ('${to}')`,
        ),
      );
      created.push(name);
    }
  }
  return created;
}
