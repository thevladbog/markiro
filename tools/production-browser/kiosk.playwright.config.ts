import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 61_591;

export default defineConfig({
  testDir: "./tests",
  testMatch: "kiosk-touch-flow.spec.ts",
  outputDir: join(tmpdir(), "markiro-kiosk-touch-playwright"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node ../../apps/kiosk/node_modules/vite/bin/vite.js ../../apps/kiosk --host 127.0.0.1 --port ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
