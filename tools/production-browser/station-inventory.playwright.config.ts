import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  testDir: "./station-inventory-tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  outputDir: join(tmpdir(), "markiro-station-inventory-playwright"),
  use: {
    baseURL: "http://127.0.0.1:43179",
    browserName: "chromium",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "../../apps/station/node_modules/.bin/vite --config ../../docs/acceptance/station-touch-vite.config.mjs --host 127.0.0.1 --port 43179 --strictPort",
    url: "http://127.0.0.1:43179/?gallery=1&state=inventory-simple-box-accepted&locale=ru",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
