import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { z } from "zod";

import { LocalDbError, type LocalExecutor } from "../../src/local/executor.js";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const moduleUrl = import.meta.url;
const MIGRATIONS = new URL("../../src-tauri/migrations/", moduleUrl);

/** Same limits as `src-tauri/src/local_db.rs`. */
const MAX_STATEMENTS = 32;
const MAX_SQL_BYTES = 64 * 1024;
const MAX_VALUES = 256;

/** Same words as `FORBIDDEN_WORDS` in `src-tauri/src/local_db.rs`. */
const FORBIDDEN_WORDS = [
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "CREATE",
  "DROP",
  "ALTER",
  "REINDEX",
  "ANALYZE",
];

/**
 * SQL split the same way as the shell's `words`: one split per character
 * that is not a letter, digit or `_` (not per run), so two delimiters in a
 * row yield an empty segment between them — this mirrors Rust's
 * `str::split` on a `char` predicate exactly. `created_at` stays one word.
 * Do not filter out empty segments: `firstWord` relies on a leading one.
 */
function words(sql: string): string[] {
  return sql.split(/[^A-Za-z0-9_]/);
}

/**
 * The statement's first word: `""` before any letter, digit or `_` (never
 * `undefined` — `split` always yields at least one item, matching the
 * shell's `first_word`).
 */
function firstWord(sql: string): string {
  return words(sql.trimStart())[0] ?? "";
}

/**
 * Ported from the shell's `check_statement` (`src-tauri/src/local_db.rs`):
 * same rules, so a statement the shell refuses fails in tests too. `sql`'s
 * byte length (not its character length) is what the shell bounds.
 */
export function checkStatement(sql: string, valueCount: number): boolean {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return false;
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES || valueCount > MAX_VALUES) return false;
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (body.includes(";") || body.includes("--") || body.includes("/*")) return false;
  const forbidden = words(body).some((word) =>
    FORBIDDEN_WORDS.some((bad) => bad.toLowerCase() === word.toLowerCase()),
  );
  // SQLite treats a bare `END` (or `END TRANSACTION`) as `COMMIT`, so a
  // leading `END` is refused like the words above; `CASE … END` mid-statement
  // is unaffected, since only the first word is checked.
  const startsWithEnd = firstWord(body).toLowerCase() === "end";
  return !forbidden && !startsWithEnd;
}

/** Ported from the shell's `is_query`: only `SELECT` and `WITH` are queries. */
export function isQuery(sql: string): boolean {
  const first = firstWord(sql).toLowerCase();
  return first === "select" || first === "with";
}

/**
 * The shell's local database on node:sqlite: the same migrations, in
 * memory, behind the same `LocalExecutor` the app uses. SQL behaves as in
 * the shell; the shell's statement rules are enforced by `checkStatement`/
 * `isQuery` here too, so a statement the shell refuses fails in tests too.
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
      if (!checkStatement(sql, params.length) || !isQuery(sql)) {
        throw new LocalDbError("invalid_statement", sql);
      }
      const rows = z.array(row).safeParse(db.prepare(sql).all(...params.map(toSqlValue)));
      if (!rows.success) throw new LocalDbError("invalid_response", rows.error.message);
      return rows.data;
    },
    async transaction(statements) {
      if (statements.length < 1 || statements.length > MAX_STATEMENTS) {
        throw new LocalDbError("invalid_statement", `a batch of ${statements.length} statements`);
      }
      for (const { sql, values = [] } of statements) {
        if (!checkStatement(sql, values.length)) throw new LocalDbError("invalid_statement", sql);
      }
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

/**
 * The shell binds an integral JSON number as INTEGER (`serde_json`'s
 * `as_i64`) and any other number as REAL; so does this; node:sqlite binds a
 * `bigint` as INTEGER and a `number` as REAL. Booleans become 0/1; a
 * non-finite number, an array or an object is refused, matching the shell's
 * `unsupported_value`.
 */
function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LocalDbError("unsupported_value", "cannot bind a non-finite number");
    }
    // Integers beyond `Number.MAX_SAFE_INTEGER` cannot come from JSON safely
    // anyway, so no extra guard is needed here.
    return Number.isInteger(value) ? BigInt(value) : value;
  }
  throw new LocalDbError("unsupported_value", `cannot bind a value of type ${typeof value}`);
}
