import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor } from "../../src/lib/mirror.js";

/**
 * Opens a REAL on-disk SQLite file for a test, with power-loss durability
 * traded away and nothing else.
 *
 * Why this exists. `applyMigrations` replays all 162 `STATION_MIGRATIONS`
 * statements as individual autocommits (it must: the rotating executor
 * forbids BEGIN/COMMIT, and each statement's duplicate-column error is
 * caught on its own). At the default `synchronous=FULL` that is ~2 durability
 * barriers per statement, and the cost is entirely a function of how
 * expensive the host's barrier is:
 *
 *     162 migrations, one file connection   cheap barrier      60 ms
 *                                           real drive barrier 1973 ms
 *                                           + synchronous=OFF    57 ms
 *     162 migrations, two rotating conns    cheap barrier     142 ms
 *                                           real drive barrier 2082 ms
 *                                           + synchronous=OFF   121 ms
 *
 * A developer SSD has an effectively free barrier, so these suites run in
 * ~100ms locally. A contended CI runner does not, and the same statements
 * cost seconds. Re-running the four file-backed suites against a real
 * barrier reproduces the CI failure set exactly, and this pragma removes it:
 *
 *                                                     FULL      OFF
 *     boxes        restores a pending print ...      7.31s    0.11s
 *     mirror       retains the mirrored ... date     6.42s    0.12s
 *     outbox       atomically persists evidence      6.92s    0.21s
 *     outbox       keeps rows intact on a fault      4.45s    0.21s
 *     inv-sync     reruns receipt migrations         7.44s    0.32s
 *
 * That is why these blew the 5s per-test timeout on CI while being
 * unreproducible locally. The worst of them replay the migrations twice
 * (`boxes.test.ts` migrates two file connections; `inventory-sync.test.ts`
 * calls `applyMigrations` twice over a rotating pair) -- so they were the
 * first to go, but every file-backed suite here sat on the same cliff.
 *
 * `synchronous=OFF` removes ONLY the fsync barriers. It does not change the
 * file format, inter-connection locking and visibility, or what survives
 * `db.close()` -- SQLite still writes every page through to the file, so
 * closing and reopening the path reads the data back exactly as before. The
 * single guarantee dropped is survival of a power cut or kernel panic
 * mid-write, which no station test asserts.
 *
 * `journal_mode=MEMORY` is the Windows half of the same trade. In the default
 * `delete` mode every autocommit statement creates a `-journal` file next to
 * the database and deletes it again, so a migration replay is ~330 file
 * creations and deletions per connection pair. On the hosted Windows runner
 * that runs the station release build, a real-time scanner opens each new
 * file, `DeleteFileW` then fails with a sharing violation, and SQLite's
 * Windows VFS sleeps and retries (up to ~2.5 s per delete) instead of
 * failing. The stall is invisible on Linux and macOS and shows up on Windows
 * exactly when the other vitest worker is busy loading a fresh test file:
 * three Publish station beta runs in a row (35480730035, 35493576374,
 * 35504179192) timed out in three different file-backed suites, and in each
 * one the slow tests began the moment `product-labels-recovery.test.ts`
 * started in the other worker, the same 2-3 s test taking 14, 21 and 35 s.
 *
 * A memory journal keeps the rollback journal in RAM. Locking is the same
 * rollback-journal protocol as `delete` (SHARED/RESERVED/EXCLUSIVE on the
 * database file), statement rollback still works, and cross-connection
 * visibility is unchanged; what goes is the journal file and, with it, hot
 * journal recovery after a crash mid-transaction, which no station test
 * exercises. `WAL` would also drop the churn but changes reader/writer
 * visibility, and the acceptance suites assert real contention between
 * two connections, so it is deliberately not used here.
 */
export function openFileDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA journal_mode = MEMORY");
  return db;
}

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
