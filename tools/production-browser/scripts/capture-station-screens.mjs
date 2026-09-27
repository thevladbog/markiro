import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, toolRoot, waitForServer } from "./film-render.mjs";

const stationRoot = path.resolve(toolRoot, "../../apps/station");
const baseUrl = "http://127.0.0.1:5273";
// gallery state → file under apps/landing/src/assets/home/screens/<locale>/
const SHOTS = [
  ["work-aggregation", "station-aggregation"],
  ["work-pallet-20", "station-box"],
  ["conflicts-page-1", "station-conflicts"],
];
// The offline section shows a close-up of the offline work screen at double density: the
// status pills, the shift counter and the journal. Each point of the section's text gets a
// numbered mark on it; the mark positions are written next to the copy as fractions of the image.
const OFFLINE_STATE = "offline";
const OFFLINE_FILE = "station-offline";
const offlineMarksFile = path.join(landingRoot, "src/content/home-offline.json");

async function galleryContext(browser, deviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor,
    colorScheme: "dark",
  });
  await context.addInitScript(() => localStorage.setItem("markiro.theme", "dark"));
  return context;
}

async function openState(context, state, locale) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?gallery=1&state=${state}&locale=${locale}&profile=landing`, {
    waitUntil: "networkidle",
  });
  await page.locator('[data-testid="station-screen-gallery"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return page;
}

// Runs in the page: the close-up's clip, and one mark per point in the order of the section's
// list: a code accepted on the station, the operations waiting to sync, the unreachable server.
// A mark's point is the edge it touches; `side` says where the badge sits so it covers no text:
// to the left of a journal row, below a status pill.
function measureOfflineCloseUp() {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`the offline screen has no ${selector}`);
    return (element.closest(".station-status-pill") ?? element).getBoundingClientRect();
  };
  const server = box('[data-testid="server-status"]');
  const sync = box('[data-testid="sync-status"]');
  const rows = [...document.querySelectorAll(".work-recent li")].map((row) =>
    row.getBoundingClientRect(),
  );
  const [first, , third] = rows;
  if (first === undefined || third === undefined) throw new Error("the journal needs three rows");
  const left = Math.max(0, Math.floor(server.left - 24));
  const clip = { x: left, y: 0, width: innerWidth - left, height: Math.ceil(third.bottom + 4) };
  const at = (x, y, side) => ({
    x: Number(((x - clip.x) / clip.width).toFixed(4)),
    y: Number(((y - clip.y) / clip.height).toFixed(4)),
    side,
  });
  return {
    clip,
    marks: [
      at(first.left - 4, first.top + first.height / 2, "left"),
      at(sync.left + sync.width / 2, sync.bottom + 4, "below"),
      at(server.left + server.width / 2, server.bottom + 4, "below"),
    ],
  };
}

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
  try {
    await waitForServer(`${baseUrl}/`, server);
  } catch (error) {
    server.kill("SIGTERM");
    throw error;
  }
  const browser = await chromium.launch();
  try {
    const offlineMarks = {};
    for (const locale of ["ru", "en"]) {
      const outputRoot = path.join(landingRoot, "src/assets/home/screens", locale);
      mkdirSync(outputRoot, { recursive: true });
      const context = await galleryContext(browser, 1.25);
      for (const [state, file] of SHOTS) {
        const page = await openState(context, state, locale);
        await page.screenshot({ path: path.join(outputRoot, `${file}.png`) });
        await page.close();
        console.log(`captured ${locale}/${file}.png`);
      }
      await context.close();

      const closeUpContext = await galleryContext(browser, 2);
      const page = await openState(closeUpContext, OFFLINE_STATE, locale);
      const { clip, marks } = await page.evaluate(measureOfflineCloseUp);
      await page.screenshot({ path: path.join(outputRoot, `${OFFLINE_FILE}.png`), clip });
      offlineMarks[locale] = marks;
      await closeUpContext.close();
      console.log(`captured ${locale}/${OFFLINE_FILE}.png (close-up ${clip.width}×${clip.height})`);
    }
    writeFileSync(offlineMarksFile, `${JSON.stringify(offlineMarks, null, 2)}\n`);
    console.log(`wrote ${path.relative(landingRoot, offlineMarksFile)}`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
