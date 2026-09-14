import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { SqlExecutor } from "./mirror.js";

let dbPromise: Promise<Database> | null = null;

/** Opens (once) the on-device SQLite mirror DB via tauri-plugin-sql. */
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:station-mirror.db");
  return dbPromise;
}

/**
 * SqlExecutor backed by tauri-plugin-sql. drizzle-orm/sqlite-proxy can be
 * layered on top later for typed queries; the mirror layer only needs
 * run/all, kept identical to the node:sqlite test executor.
 */
export const tauriExecutor: SqlExecutor = {
  async run(sql, params = []) {
    await (await db()).execute(sql, params);
  },
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db()).select<T[]>(sql, params);
  },
  async atomic(statements) {
    return invoke<number[]>("grant_atomic_execute", {
      statements: statements.map(({ sql, values = [], expectedChanges }) => ({
        sql,
        values,
        ...(expectedChanges === undefined ? {} : { expectedChanges }),
      })),
    });
  },
};
