import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  return { db, pool };
}
export type Db = ReturnType<typeof createDb>["db"];
