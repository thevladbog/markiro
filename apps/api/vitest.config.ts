import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The e2e suite shares one Postgres instance; default file-parallelism
    // intermittently races cross-tenant-creation cases (stray sign-up 404s /
    // "Parse Error: Expected HTTP/"). Running files serially is a minimal,
    // known fix for this pre-existing flake.
    fileParallelism: false,
  },
});
