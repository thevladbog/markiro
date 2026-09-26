import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, openLiveFilm, scrollToFilmTime, startLandingServer } from "./film-render.mjs";

const outputRoot = path.join(landingRoot, "src/assets/film");
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

const server = await startLandingServer();
try {
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const layout of LAYOUTS) {
    const context = await browser.newContext({ ...layout, reducedMotion: "no-preference" });
    const page = await context.newPage();
    await openLiveFilm(page, { sceneOnly: true });
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
