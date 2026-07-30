import type { DatabaseSync } from "node:sqlite";
import type { SqlExecutor } from "../../src/lib/mirror.js";

/** Wraps a node:sqlite `DatabaseSync` as the `SqlExecutor` station code is tested through. */
export function makeExec(db: DatabaseSync): SqlExecutor {
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}
