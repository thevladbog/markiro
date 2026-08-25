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

export function makeRotatingExec(
  databases: readonly DatabaseSync[],
  hooks: {
    beforeRun?(sql: string, params: unknown[]): void;
    afterRun?(sql: string, params: unknown[]): void;
  } = {},
): SqlExecutor {
  if (databases.length < 2) throw new Error("rotating executor needs two connections");
  let cursor = 0;
  const next = () => databases[cursor++ % databases.length]!;
  return {
    async run(sql, params = []) {
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
        throw new Error("multi-call transactions are unavailable");
      }
      hooks.beforeRun?.(sql, params);
      next()
        .prepare(sql)
        .run(...(params as never[]));
      hooks.afterRun?.(sql, params);
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return next()
        .prepare(sql)
        .all(...(params as never[])) as T[];
    },
  };
}
