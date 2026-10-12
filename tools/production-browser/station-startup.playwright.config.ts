import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  testDir: "./station-startup-tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  outputDir: join(tmpdir(), "markiro-station-startup-playwright"),
  use: {
    baseURL: "http://127.0.0.1:43188",
    browserName: "chromium",
    locale: "ru-RU",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "corepack pnpm --dir ../.. --filter @markiro/station build && node ../../apps/station/node_modules/vite/bin/vite.js preview ../../apps/station --host 127.0.0.1 --port 43188 --strictPort",
    cwd: import.meta.dirname,
    url: "http://127.0.0.1:43188",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
