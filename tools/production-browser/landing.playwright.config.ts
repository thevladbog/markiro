import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  testDir: "./tests",
  testMatch: "landing-seo.spec.ts",
  outputDir: join(tmpdir(), "markiro-landing-playwright"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  webServer: {
    command: "node scripts/serve-landing.mjs",
    url: "http://127.0.0.1:5473/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ASTRO_TELEMETRY_DISABLED: "1",
      PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
      PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_playwright-test-key",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:5473",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
