import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const port = 61_596;

export default defineConfig({
  testDir: "./tests",
  testMatch: "catalog-import.visual.spec.ts",
  outputDir: join(import.meta.dirname, "../../.superpowers/sdd/catalog-import-browser-output"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The National Catalog harness needs the widened `server.fs.allow` from
    // `product-labels-vite.config.ts`; the plain browser config cannot serve
    // it.
    command: `node ../../apps/admin/node_modules/vite/bin/vite.js ../../apps/admin --config ../../apps/admin/test/browser/product-labels-vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/test/browser/national-catalog-harness.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
