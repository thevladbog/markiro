import { spawn } from "node:child_process";
import path from "node:path";

import { chromium } from "@playwright/test";

const toolRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.resolve(toolRoot, "../../apps/landing/src/assets/film");
const baseUrl = "http://127.0.0.1:5473";
const filmUrl = `${baseUrl}/kak-rabotaet/?film-tier=high&film-budget=off`;
const CHAPTERS = ["district", "line", "packing", "warehouse", "offline", "kiosk", "office"];
const LAYOUTS = [
  {
    name: "wide",
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: "tall",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
];
// Posters carry the scene only: the page draws its own text over them.
const SCENE_ONLY = `
  .film-top, .film-hero, .film-card, .film__rail, [data-consent-panel],
  .film-chapter__poster, .film-chapter--hero::before { visibility: hidden !important; }
`;

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error("landing server exited early");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("landing server did not start");
}

async function scrollToFilmTime(page, filmTime) {
  await page.evaluate((target) => {
    const sections = [...document.querySelectorAll("[data-film-chapter]")];
    const index = Math.min(sections.length - 1, Math.floor(target));
    const local = target - index;
    const section = sections[index];
    const top = section.getBoundingClientRect().top + window.scrollY;
    const viewport = window.innerHeight;
    const y =
      index === 0
        ? top + local * (section.offsetHeight - viewport)
        : top - viewport + local * section.offsetHeight;
    window.scrollTo({ top: Math.round(y), behavior: "instant" });
  }, filmTime);
  await page.waitForFunction(
    (target) =>
      Math.abs(Number(document.querySelector("[data-film]")?.dataset.filmTime ?? -1) - target) <
      0.01,
    filmTime,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
}

const server = spawn(process.execPath, [path.join(toolRoot, "scripts/serve-landing.mjs")], {
  stdio: "inherit",
});
try {
  await waitForServer(`${baseUrl}/kak-rabotaet/`, server);
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const layout of LAYOUTS) {
    const context = await browser.newContext({ ...layout, reducedMotion: "no-preference" });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[page] ${message.text()}`);
    });
    await page.goto(filmUrl, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: SCENE_ONLY });
    await page.evaluate(() => window.scrollBy({ top: 1, behavior: "instant" }));
    await page.waitForFunction(
      () => document.querySelector("[data-film]")?.classList.contains("film--live"),
      null,
      {
        timeout: 120_000,
      },
    );
    for (const [index, id] of CHAPTERS.entries()) {
      await scrollToFilmTime(page, index === 0 ? 0 : index + 0.5);
      await page.screenshot({
        path: path.join(outputRoot, `${id}-${layout.name}.jpg`),
        type: "jpeg",
        quality: 88,
      });
      console.log(`rendered ${id}-${layout.name}.jpg`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
