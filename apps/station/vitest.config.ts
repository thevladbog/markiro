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
  },
});
