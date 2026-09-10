import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./reports-tests",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: "./test-results/reports",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:43184",
    locale: "ru-RU",
    launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node ../../apps/saas-admin/node_modules/vite/bin/vite.js ../../apps/saas-admin --host 127.0.0.1 --port 43184 --strictPort",
    url: "http://127.0.0.1:43184",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
