/* global window */
// Layout measurement of the floor header and the shift hub (see main.tsx). Usage:
//   node measure.mjs [baseUrl]   with Playwright resolvable (PLAYWRIGHT_CORE=/path/to/playwright-core)
//   SHOT=/some/dir node measure.mjs   also writes a screenshot per case
// Runs `window.__inspect()` of the harness page in every viewport and scenario; prints one JSON
// object per case and exits 1 on any problem: a touch target under 64 px, a primary under its
// size, a header that wraps or runs under its rail, a card whose rows overflow or whose action
// leaves it, a page that scrolls.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://localhost:5291";
const VIEWPORTS = [
  [1280, 1024],
  [1280, 800],
  // The 1280×1024 and 1280×800 panels at Windows 125 % scaling.
  [1024, 820],
  [1024, 640],
];
const CASES = [
  { name: "one", query: "view=hub&shifts=1&queue=2" },
  { name: "one-photo-jpeg", query: "view=hub&shifts=1&photo=jpeg" },
  { name: "one-photo-png", query: "view=hub&shifts=1&photo=png" },
  { name: "one-photo-transparent", query: "view=hub&shifts=1&photo=transparent" },
  { name: "two-long", query: "view=hub&shifts=2&long=1" },
  { name: "three-offline", query: "view=hub&shifts=3&offline=1&queue=3&rejected=1" },
  { name: "three-long-offline", query: "view=hub&shifts=3&offline=1&queue=3&long=1" },
  { name: "page-two", query: "view=hub&shifts=3&page=2" },
  { name: "empty", query: "view=hub&shifts=0&offline=1" },
  { name: "work-problems", query: "view=work&queue=3&rejected=1&printer=error&scanner=off&long=1" },
  { name: "work-quiet", query: "view=work" },
  { name: "signin", query: "view=signin" },
  { name: "setup-partial", query: "view=hub&shifts=1&printer=none&scanner=partial" },
];
const THEMES = ["dark", "light"];

const browser = await chromium.launch();
let failed = false;
for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const theme of THEMES) {
    for (const c of CASES) {
      await page.goto(`${base}/test/harness/hub-header/index.html?theme=${theme}&${c.query}`);
      await page.waitForSelector(".station-status-bar");
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => window.__inspect());
      if (process.env.SHOT)
        await page.screenshot({
          path: `${process.env.SHOT}/${width}x${height}-${theme}-${c.name}.png`,
        });
      if (result.problems.length) failed = true;
      console.log(JSON.stringify({ width, height, theme, case: c.name, ...result }));
    }
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
