import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { z } from "zod";

import { LocalDbError, type LocalExecutor } from "../../src/local/executor.js";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const moduleUrl = import.meta.url;
const MIGRATIONS = new URL("../../src-tauri/migrations/", moduleUrl);

/**
 * The shell's local database on node:sqlite: the same migrations, in
 * memory, behind the same `LocalExecutor` the app uses. SQL behaves as in
 * the shell; the shell's statement limits are pinned by its Rust tests.
 */
export function openLocalDb(): { db: DatabaseSync; executor: LocalExecutor } {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  return { db, executor: nodeExecutor(db) };
}

function nodeExecutor(db: DatabaseSync): LocalExecutor {
  return {
    async query(sql, params, row) {
      const rows = z.array(row).safeParse(db.prepare(sql).all(...params.map(toSqlValue)));
      if (!rows.success) throw new LocalDbError("invalid_response", rows.error.message);
      return rows.data;
    },
    async transaction(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map(({ sql, values = [], expectedChanges }) => {
          const changed = Number(db.prepare(sql).run(...values.map(toSqlValue)).changes);
          if (expectedChanges !== undefined && changed !== expectedChanges) {
            throw new LocalDbError("changes_mismatch", sql);
          }
          return changed;
        });
        db.exec("COMMIT");
        return changes;
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof LocalDbError) throw error;
        throw new LocalDbError("statement_failed", String(error));
      }
    },
  };
}

/** The shell binds booleans as 0 and 1 and refuses arrays and objects; so does this. */
function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new LocalDbError("unsupported_value", `cannot bind a value of type ${typeof value}`);
}
