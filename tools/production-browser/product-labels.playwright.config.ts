import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
export function productLabelsEndpoints(env: NodeJS.ProcessEnv = process.env) {
  function port(key: string, fallback: number): number {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      throw new Error(`${key} must be an integer TCP port from 1 to 65535`);
    return parsed;
  }
  const adminPort = port("PRODUCT_LABELS_ADMIN_PORT", 43181);
  const stationPort = port("PRODUCT_LABELS_STATION_PORT", 43182);
  return {
    adminPort,
    stationPort,
    adminUrl: `http://127.0.0.1:${adminPort}`,
    stationUrl: env.STATION_PRODUCT_LABELS_URL ?? `http://127.0.0.1:${stationPort}`,
  };
}
const { adminPort, stationPort, stationUrl } = productLabelsEndpoints();
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
    baseURL: stationUrl,
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
