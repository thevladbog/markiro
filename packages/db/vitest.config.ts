import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Node 24 ships `node:sqlite` as an experimental built-in; the flag marks
    // it usable in the test worker forks (no better-sqlite3 dependency).
    // NOTE: Vitest 4 flattened `poolOptions.forks.execArgv` to a top-level
    // `execArgv` option (the nested form still works but logs a deprecation
    // warning) — see the task-4 report for details.
    execArgv: ["--experimental-sqlite"],
    // `pickup-b1-schema`, `pickup-rejections-schema`, `pickup-schema` and
    // `tenant-isolation` each insert their own `organization` row in
    // `beforeAll` and `DELETE FROM organization` in `afterAll` against the
    // shared dev Postgres. That delete has to walk every table with a FK to
    // `organization` (~20+, and integrations added 5 more in this branch's
    // task 1 migration `0018_stiff_genesis.sql`) to verify none of them still
    // reference the row being removed. When two of these files' transactions
    // run concurrently, one file's DELETE FROM organization walking that FK
    // list overlaps with another file's concurrent INSERT/DELETE into one of
    // those same referencing tables, and Postgres ends up trying to grant
    // conflicting locks in opposite orders across the two transactions --
    // classic deadlock (40P01), not a row-id collision (each file already
    // uses distinct randomUUID-based org ids). Growing the FK fan-out only
    // grows the odds of hitting this, so it will keep flaking as more tables
    // reference organization. Serializing this package's files is cheap (9
    // files, 33 tests) versus manually choreographing lock-acquisition order
    // inside every test's setup/teardown. Do not re-enable file parallelism
    // here without removing the shared-organization mutation instead.
    fileParallelism: false,
  },
});
