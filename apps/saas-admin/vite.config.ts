import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { parseServerProfile } from "./src/server-profile.js";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  parseServerProfile(loadEnv(mode, process.cwd(), "VITE_").VITE_SERVER_PROFILE);
  return {
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: /^js-yaml$/,
          replacement: fileURLToPath(new URL("./src/lib/js-yaml-default.ts", import.meta.url)),
        },
      ],
    },
    server: {
      proxy: {
        "/api/platform-auth": {
          target: "http://localhost:3000",
          changeOrigin: true,
        },
        "/api/platform": {
          target: "http://localhost:3000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    test: {
      environment: "jsdom",
      // Bound CPU contention between jsdom suites and their interactive queries.
      maxWorkers: 2,
      // The catalog form suites drive a large jsdom form through real user-event
      // clicks and Radix selects, and every interaction re-renders the whole form
      // (~35-100 ms each, locally). Measured on an idle laptop, `catalog.test.tsx`
      // takes 44 s for 64 tests and 14 of them need 1.7-2.9 s, so the default 5 s
      // leaves the slowest only ~1.7x of headroom. `verify-app-tests` runs on a
      // 4-vCPU runner with several jsdom workers, where the same work is stretched
      // 2x or more: with the host oversubscribed 2x, 9-14 of those tests hit 5 s on
      // every one of six runs, while the unchanged assertions all passed once given
      // time (CI run 38786519203 lost `submits complete plan commercial terms` at
      // 5044 ms). Nothing a test verifies depends on this number; it is a wall-clock
      // guard that still fails a hung test promptly. The cost of the slowest test is
      // also cut at the source, see its own comment.
      testTimeout: 15_000,
      setupFiles: ["./test/setup.ts"],
    },
  };
});
