import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./service-periods-tests",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "./test-results/service-periods",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:43186",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command:
      "node ../../apps/saas-admin/node_modules/vite/bin/vite.js preview ../../apps/saas-admin --host 127.0.0.1 --port 43186 --strictPort",
    url: "http://127.0.0.1:43186",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
