import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

export default defineConfig({
  testDir: "./support-chat-tests",
  testMatch: "support-chat.spec.ts",
  outputDir: join(
    import.meta.dirname,
    "../../.superpowers/sdd/2026-10-06-markiro-support-chat/browser-output",
  ),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
