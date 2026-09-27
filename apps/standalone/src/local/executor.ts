import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/** One statement of a batch: literals go in `values`, never in `sql`. */
export interface LocalStatement {
  sql: string;
  values?: readonly unknown[];
  /** Roll the whole batch back unless this statement changes exactly this many rows. */
  expectedChanges?: number;
}

/** Codes the shell rejects the local commands with (`LocalDbError::code` in src-tauri). */
export const LOCAL_DB_ERROR_CODES = [
  "local_db_unavailable",
  "invalid_statement",
  "unsupported_value",
  "statement_failed",
  "changes_mismatch",
] as const;
/** Plus `invalid_response`: the shell answered in a shape this build cannot read. */
export type LocalDbErrorCode = (typeof LOCAL_DB_ERROR_CODES)[number] | "invalid_response";

export class LocalDbError extends Error {
  readonly code: LocalDbErrorCode;

  constructor(code: LocalDbErrorCode, message: string) {
    super(message);
    this.name = "LocalDbError";
    this.code = code;
  }
}

/**
 * The station's local database (stage 1 spec §5.2): the shell's
 * `local_query` and `local_transaction` in the app, node:sqlite with the same
 * migrations in tests (`test/support/local-db.ts`).
 */
export interface LocalExecutor {
  /** One `SELECT` or `WITH` statement; every row is checked against `row`. */
  query<T>(sql: string, params: readonly unknown[], row: z.ZodType<T>): Promise<T[]>;
  /** All statements in one transaction; the rows each changed. */
  transaction(statements: readonly LocalStatement[]): Promise<number[]>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const changesSchema = z.array(z.number().int().nonnegative());

export function createTauriLocalExecutor(call: Invoke = invoke): LocalExecutor {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code =
        LOCAL_DB_ERROR_CODES.find((candidate) => candidate === error) ?? "statement_failed";
      throw new LocalDbError(code, `${command}: ${String(error)}`);
    }
  }

  return {
    async query(sql, params, row) {
      const rows = z.array(row).safeParse(await run("local_query", { sql, params: [...params] }));
      if (!rows.success) throw new LocalDbError("invalid_response", rows.error.message);
      return rows.data;
    },
    async transaction(statements) {
      const changes = changesSchema.safeParse(
        await run("local_transaction", { statements: statements.map(toShellStatement) }),
      );
      if (!changes.success) throw new LocalDbError("invalid_response", changes.error.message);
      return changes.data;
    },
  };
}

function toShellStatement({ sql, values = [], expectedChanges }: LocalStatement) {
  return expectedChanges === undefined
    ? { sql, values: [...values] }
    : { sql, values: [...values], expectedChanges };
}
