import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./offers-tests",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: "./test-results/offers",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:43185",
    launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command:
      "node ../../apps/saas-admin/node_modules/vite/bin/vite.js preview ../../apps/saas-admin --host 127.0.0.1 --port 43185 --strictPort",
    url: "http://127.0.0.1:43185",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
