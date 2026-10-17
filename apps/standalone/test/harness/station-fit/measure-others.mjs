// The measuring guard (`measure-fit.ts`) run on the other floor screens that share the kit's
// components, through their own harness pages: the hub and its header, the sign-in header, the work
// screen's real components, and the warehouse reprint, at the real terminal's window sizes. Usage:
//   node measure-others.mjs [baseUrl]   with PLAYWRIGHT_CORE=/path/to/playwright-core
//   SIZES=1024x640,1024x700 THEME=dark ONLY=reprint node measure-others.mjs
// Prints one JSON object per case; exits 1 on any problem. The guard is loaded into each page from
// the dev server (`/test/harness/station-fit/measure-fit.ts`), so those pages need no change.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://localhost:5291";
const VIEWPORTS = process.env.SIZES
  ? process.env.SIZES.split(",").map((size) => size.split("x").map(Number))
  : [
      [1024, 640],
      [1024, 700],
      [1024, 768],
      [1024, 820],
      [1280, 700],
      [1280, 800],
      [1280, 1024],
    ];
const THEMES = process.env.THEME ? [process.env.THEME] : ["dark", "light"];

const REPRINT_STATES = [
  "setup",
  "setup-sheets",
  "setup-none",
  "empty",
  "journal",
  "notfound",
  "offline",
  "scanner",
  "box-prepared",
  "unit-prepared",
  "sending",
  "sent",
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
const WORK_CASES = [
  "mode=pallets&capacity=3&items=2",
  "mode=plain&capacity=3&items=2",
  "mode=plain&capacity=10&items=6",
  "mode=check",
  "mode=pallets&capacity=12&items=5",
  "mode=plain&capacity=48&items=20",
  "mode=pallets&capacity=3&items=3&rows=0",
  "mode=plain&capacity=12&items=5&rows=1&photo=transparent",
  "mode=pallets&capacity=6&items=4&big=1&long=1&photo=jpeg",
  "mode=check&rows=3&big=1",
  "mode=check&rows=0",
];
const HUB_CASES = [
  "view=hub&shifts=1&queue=2&photo=jpeg",
  "view=hub&shifts=3&offline=1&queue=3&rejected=1&photo=transparent",
  "view=hub&shifts=2&long=1&photo=png",
  "view=hub&shifts=0&offline=1",
  "view=work&queue=3&rejected=1&printer=error&scanner=off&long=1",
  "view=signin",
];

const PAGES = [
  ...HUB_CASES.map((query) => ({
    name: `hub-header ${query}`,
    path: "/test/harness/hub-header/index.html",
    query,
    ready: ".station-status-bar",
  })),
  ...WORK_CASES.map((query) => ({
    name: `work-fit ${query}`,
    path: "/test/harness/work-fit/index.html",
    query,
    ready: "#root > *",
  })),
  ...REPRINT_STATES.map((state) => ({
    name: `reprint ${state}`,
    path: "/test/harness/reprint/index.html",
    query: `state=${state}${state === "offline" ? "&online=0" : ""}`,
    ready: ".station-status-bar",
  })),
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let failed = false;
for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  for (const theme of THEMES) {
    for (const entry of PAGES) {
      if (process.env.ONLY && !entry.name.includes(process.env.ONLY)) continue;
      await page.goto(`${base}${entry.path}?theme=${theme}&${entry.query}`);
      await page.waitForSelector(entry.ready);
      await page.waitForTimeout(350);
      const result = await page.evaluate(async () => {
        const guard = await import("/test/harness/station-fit/measure-fit.ts");
        return guard.measureFit();
      });
      if (process.env.SHOT)
        await page.screenshot({
          path: `${process.env.SHOT}/${width}x${height}-${theme}-${entry.name.replace(/[^a-z0-9]+/gi, "_")}.png`,
        });
      if (result.problems.length) failed = true;
      console.log(JSON.stringify({ width, height, theme, case: entry.name, ...result }));
    }
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
