import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The office suites drive whole pages through jsdom: under CI load a
// single template-editor test takes longer than Vitest's 5 s default.
// A hung test still fails, after 30 s.
const shared = {
  environment: "jsdom",
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 30_000,
} as const;

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: "standalone",
          include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
          exclude: ["test/late-effects/**", "**/node_modules/**"],
          setupFiles: ["test/setup.ts"],
        },
      },
      {
        // React's scheduler binds setImmediate when it first loads: this project runs with
        // that clock late, as on a loaded CI machine, to prove a suite waits for the real
        // condition (a passive effect, a focus) and not for the next tick.
        extends: true,
        test: {
          ...shared,
          name: "late-effects",
          include: ["test/late-effects/**/*.test.tsx"],
          setupFiles: ["test/late-effects/delay-immediate.ts", "test/setup.ts"],
        },
      },
    ],
  },
});
