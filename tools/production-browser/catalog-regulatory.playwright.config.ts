import { defineConfig, devices } from "@playwright/test";
const port = 61598;
export default defineConfig({
  testDir: "./tests",
  testMatch: "catalog-regulatory.spec.ts",
  outputDir: "./test-results/catalog-regulatory",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/vite.config.ts --host 127.0.0.1 --port ${port}`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/test/browser/production.html`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
