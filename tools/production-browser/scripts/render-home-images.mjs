import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, openLiveFilm, scrollToFilmTime, startLandingServer } from "./film-render.mjs";

const outputRoot = path.join(landingRoot, "src/assets/home");
const { filmTime } = JSON.parse(
  readFileSync(path.join(landingRoot, "src/content/home-map.json"), "utf8"),
);
// The film page image shows the warehouse chapter with its card over the scene. At 3.8 the
// packing chapter's card has left the frame and the camera shows the whole hall.
const FILM_PAGE_TIME = 3.8;
// Phones show a crop around the hall in the stage's 16:10 shape (CSS pixels of the 1440 × 900 frame).
const PHONE_CROP = { x: 576, y: 180, width: 752, height: 470 };
const FRAME = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  reducedMotion: "no-preference",
};

mkdirSync(outputRoot, { recursive: true });
const server = await startLandingServer();
try {
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const shot of [
    { file: "map-wide.jpg", sceneOnly: true, time: filmTime, crop: "map-phone.jpg" },
    { file: "film-page.jpg", sceneOnly: false, time: FILM_PAGE_TIME, crop: null },
  ]) {
    const context = await browser.newContext(FRAME);
    const page = await context.newPage();
    await openLiveFilm(page, { sceneOnly: shot.sceneOnly });
    await scrollToFilmTime(page, shot.time);
    await page.screenshot({ path: path.join(outputRoot, shot.file), type: "jpeg", quality: 86 });
    console.log(`rendered ${shot.file} at film time ${shot.time}`);
    if (shot.crop !== null) {
      await page.screenshot({
        path: path.join(outputRoot, shot.crop),
        type: "jpeg",
        quality: 86,
        clip: PHONE_CROP,
      });
      console.log(`rendered ${shot.crop}`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
