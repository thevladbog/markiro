import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    // Node 24 ships `node:sqlite` as an experimental built-in; the flag marks
    // it usable in the test worker forks (no better-sqlite3 dependency).
    // NOTE: Vitest 4 flattened `poolOptions.forks.execArgv` to a top-level
    // `execArgv` option (the nested form still works but logs a deprecation
    // warning) — see the task-4 report for details.
    execArgv: ["--experimental-sqlite"],
    // Sized from measurement, not from a flake reflex. Across the 1236 tests
    // in this suite the local distribution is p50 40ms, p90 146ms, p99 943ms,
    // p99.5 2.1s -- and the handful above 2s are dominated by a FIXED real
    // `setTimeout` sleep (sync.test.ts waits out BACKOFF_START_MS), not by
    // work that a slow host stretches. So the default 5s left the suite's
    // slowest legitimate tests only ~2x of headroom.
    //
    // `verify-app-tests` runs on a 4-vCPU ubuntu-latest runner where Vitest
    // forks ~3 workers over jsdom + React + synchronous node:sqlite, and the
    // failing runs showed whole files at 6-14s against ~1.0-1.4s locally.
    // At a 6-10x host penalty a 2x margin is not a guard, it is a coin flip:
    // that is what took out `inventory-repacking-work.test.tsx`, an in-memory
    // (`:memory:`, zero filesystem) jsdom test that needs 0.52s locally.
    //
    // 15s restores proportionate headroom (~16x at p99) while still failing a
    // genuinely hung test promptly. It is a wall-clock guard, not an
    // assertion: nothing any test verifies depends on this number. The one
    // test that legitimately exceeds it keeps its own explicit override
    // (`App.test.tsx`, `}, 20_000)`).
    //
    // The I/O half of these flakes is fixed at the source instead -- see
    // `openFileDatabase` in test/support/sqlite-exec.ts.
    testTimeout: 15_000,
  },
});
