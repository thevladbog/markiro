import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
const adminPort = Number(process.env.PRODUCT_LABELS_ADMIN_PORT ?? 43181);
const stationPort = Number(process.env.PRODUCT_LABELS_STATION_PORT ?? 43182);
export default defineConfig({
  testDir: "./product-labels-tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: "list",
  outputDir: join(tmpdir(), "markiro-dm-browser"),
  use: {
    browserName: "chromium",
    // Capture the scrolling affordances that are present in the installed Station shell.
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
    actionTimeout: 10000,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/product-labels-vite.config.ts --host 127.0.0.1 --port ${adminPort} --strictPort`,
      url: `http://127.0.0.1:${adminPort}`,
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: `node ../../apps/station/node_modules/vite/bin/vite.js --config ../../apps/station/test/browser/product-labels-vite.config.mjs --host 127.0.0.1 --port ${stationPort} --strictPort`,
      url: `http://127.0.0.1:${stationPort}`,
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
