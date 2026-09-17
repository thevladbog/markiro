import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./device-replacement-tests",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  reporter: "list",
  outputDir: "./test-results/device-replacement",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:43188",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command:
      "node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/vite.config.ts --host 127.0.0.1 --port 43188 --strictPort",
    url: "http://127.0.0.1:43188/test/browser/production.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
