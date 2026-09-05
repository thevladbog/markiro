import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export interface DbPoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  statement_timeout?: number;
}

export function createDb(url: string, poolOptions: DbPoolOptions = {}) {
  const pool = new pg.Pool({ connectionString: url, ...poolOptions });
  const db = drizzle(pool);
  return { db, pool };
}
export type Db = ReturnType<typeof createDb>["db"];
