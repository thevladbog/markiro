import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const port = 61_592;

export default defineConfig({
  testDir: "./tests",
  testMatch: "tenant-billing.visual.spec.ts",
  outputDir: join(
    import.meta.dirname,
    "../../.superpowers/sdd/2026-08-27-tenant-admin-billing/browser-output",
  ),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/vite.config.ts --host 127.0.0.1 --port ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/test/browser/tenant-billing.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
