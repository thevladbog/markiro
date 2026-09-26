import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, toolRoot, waitForServer } from "./film-render.mjs";

const stationRoot = path.resolve(toolRoot, "../../apps/station");
const baseUrl = "http://127.0.0.1:5273";
// gallery state → file under apps/landing/src/assets/home/screens/<locale>/
const SHOTS = [
  ["work-aggregation", "station-aggregation"],
  ["work-pallet-20", "station-box"],
  ["offline", "station-offline"],
  ["conflicts-page-1", "station-conflicts"],
];

const server = spawn(
  process.execPath,
  [
    path.join(stationRoot, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5273",
    "--strictPort",
  ],
  { cwd: stationRoot, stdio: "inherit" },
);
try {
  await waitForServer(`${baseUrl}/`, server);
  const browser = await chromium.launch();
  for (const locale of ["ru", "en"]) {
    const outputRoot = path.join(landingRoot, "src/assets/home/screens", locale);
    mkdirSync(outputRoot, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1.25,
      colorScheme: "dark",
    });
    await context.addInitScript(() => localStorage.setItem("markiro.theme", "dark"));
    const page = await context.newPage();
    for (const [state, file] of SHOTS) {
      await page.goto(`${baseUrl}/?gallery=1&state=${state}&locale=${locale}&profile=landing`, {
        waitUntil: "networkidle",
      });
      await page.locator('[data-testid="station-screen-gallery"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputRoot, `${file}.png`) });
      console.log(`captured ${locale}/${file}.png`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
