import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    // The office suites drive whole pages through jsdom: under CI load a
    // single template-editor test takes longer than Vitest's 5 s default.
    // A hung test still fails, after 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
