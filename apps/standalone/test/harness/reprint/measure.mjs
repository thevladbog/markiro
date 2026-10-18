/* global window */
// Layout measurement of the warehouse reprint (see main.tsx). Usage:
//   node measure.mjs [baseUrl]   with Playwright resolvable (PLAYWRIGHT_CORE=/path/to/playwright-core)
//   SHOT=/some/dir node measure.mjs   also writes a screenshot per case
// Runs `window.__inspect()` of the harness page in every viewport, theme and state; prints one JSON
// object per case and exits 1 on any problem: a touch target under 64 px, a primary under 84, a
// frame that leaves the window, a footer button that wraps or clips, a page that scrolls.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://127.0.0.1:5301";
const VIEWPORTS = [
  // The owner's terminal at Windows 125 % scaling (a CSS viewport about 1024 wide, 640-720 high)
  // and the panels it stands for.
  [1024, 640],
  [1024, 700],
  [1024, 768],
  [1024, 820],
  [1280, 700],
  [1280, 800],
  [1280, 1024],
];
const STATES = [
  "setup",
  "setup-sheets",
  "setup-none",
  "setup-long",
  "setup-check",
  "empty",
  "journal",
  "notfound",
  "offline",
  "scanner",
  "box-prepared",
  "unit-prepared",
  "sending",
  "sent",
  "sent-check",
  "sent-check-verifying",
  "sent-check-long",
  "failed-setup",
  "journal-blocked",
  "unit-sent",
  "unknown",
  "verifying",
  "failed",
  "printer-a4",
  "again",
  "finish",
  "manual",
  "dup",
  "dup-error",
  "dup-busy",
  "dup-none",
];
const THEMES = ["dark", "light"];

const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
let failed = false;
for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const theme of THEMES) {
    for (const state of STATES) {
      const offline = state === "offline" ? "&online=0" : "";
      await page.goto(
        `${base}/test/harness/reprint/index.html?theme=${theme}&state=${state}${offline}`,
      );
      await page.waitForSelector(".station-status-bar");
      await page.waitForTimeout(250);
      const result = await page.evaluate(() => window.__inspect());
      if (process.env.SHOT)
        await page.screenshot({
          path: `${process.env.SHOT}/${width}x${height}-${theme}-${state}.png`,
        });
      if (result.problems.length) failed = true;
      console.log(JSON.stringify({ width, height, theme, state, ...result }));
    }
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
