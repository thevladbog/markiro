import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
export default defineConfig({
  testDir: "./national-catalog-tests",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: "list",
  outputDir: join(tmpdir(), "markiro-national-catalog-browser"),
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:43183",
    locale: "ru-RU",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/product-labels-vite.config.ts --host 127.0.0.1 --port 43183 --strictPort",
    url: "http://127.0.0.1:43183/test/browser/national-catalog-harness.html",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
