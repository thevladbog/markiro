/* global window */
// Fit measurement of «Новая смена» and «Рабочее место» (see main.tsx and measure-fit.ts). Usage:
//   node measure.mjs [baseUrl]   with Playwright resolvable (PLAYWRIGHT_CORE=/path/to/playwright-core)
//   SHOT=/some/dir node measure.mjs   also writes a screenshot per case
//   ONLY=substring node measure.mjs   runs the cases whose name contains it
// Runs `window.__inspect()` of the harness page in every window size and theme after the case's
// steps (clicks); prints one JSON object per case and exits 1 on any problem.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://localhost:5291";
// The real terminal: a 1280×1024 panel at Windows 125 % (about 1024×720 of CSS pixels once the
// title bar and the taskbar are gone) and its neighbours.
const ALL_VIEWPORTS = [
  [1024, 640],
  [1024, 700],
  [1024, 768],
  [1024, 820],
  [1280, 700],
  [1280, 800],
  [1280, 1024],
];
const VIEWPORTS = process.env.SIZES
  ? process.env.SIZES.split(",").map((size) => size.split("x").map(Number))
  : ALL_VIEWPORTS;
const THEMES = process.env.THEME ? [process.env.THEME] : ["dark", "light"];

/** The product the form starts on: found by name, as an operator does. */
async function chooseProduct(page, name = "мол") {
  await page.getByLabel("Название товара").fill(name);
  await page.locator(".new-shift__result").first().click();
  await page.waitForSelector(".new-shift__zones");
  await page.waitForTimeout(150);
}

const CASES = [
  {
    name: "newshift-aggregation-pallets",
    query: "view=newshift&pallets=1",
    steps: chooseProduct,
  },
  {
    name: "newshift-aggregation-pallets-long",
    query: "view=newshift&pallets=1&long=1",
    steps: (page) => chooseProduct(page, "сидр"),
  },
  {
    name: "newshift-aggregation-nopallets",
    query: "view=newshift&pallets=0",
    steps: chooseProduct,
  },
  {
    name: "newshift-validation-dup-on",
    query: "view=newshift&pallets=1",
    steps: async (page) => {
      await chooseProduct(page);
      await page.getByRole("radio", { name: "Проверка" }).click();
      await page.getByRole("switch", { name: /Печатать дубликат/ }).click();
    },
  },
  {
    name: "newshift-validation-dup-off",
    query: "view=newshift&pallets=1",
    steps: async (page) => {
      await chooseProduct(page);
      await page.getByRole("radio", { name: "Проверка" }).click();
    },
  },
  {
    name: "newshift-error-capacity",
    query: "view=newshift&pallets=1",
    steps: async (page) => {
      await chooseProduct(page);
      await page.getByRole("button", { name: /В коробе, шт\./ }).click();
      await page.getByRole("button", { name: "Очистить" }).click();
      await page.getByRole("button", { name: "Далее" }).click();
      await page.waitForSelector(".new-shift__pad-error");
    },
  },
  {
    name: "newshift-search",
    query: "view=newshift",
    steps: async (page) => {
      await page.getByLabel("Название товара").fill("мол");
      await page.waitForTimeout(150);
    },
  },
  { name: "signin", query: "view=signin", steps: null },
  {
    name: "signin-by-name",
    query: "view=signin",
    steps: async (page) => {
      await page.getByRole("button", { name: "Найти по имени" }).click();
      await page.waitForTimeout(200);
    },
  },
  { name: "setup-printers", query: "view=setup&tab=printer&printers=4", steps: null },
  { name: "setup-printers-long", query: "view=setup&tab=printer&printers=4&long=1", steps: null },
  { name: "setup-printers-one", query: "view=setup&tab=printer&printers=1", steps: null },
  { name: "setup-scanners", query: "view=setup&tab=scanner", steps: null },
  {
    name: "setup-scanners-keypad",
    query: "view=setup&tab=scanner",
    steps: async (page) => {
      await page.getByLabel("Скорость, бод").first().click();
    },
  },
  { name: "setup-sound", query: "view=setup&tab=sound", steps: null },
  { name: "setup-station", query: "view=setup&tab=station", steps: null },
  {
    name: "setup-printer-editor-tcp",
    query: "view=setup&tab=printer&printers=2",
    steps: async (page) => {
      await page.getByRole("button", { name: "Добавить принтер" }).click();
      await page.waitForTimeout(200);
    },
  },
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let failed = false;
for (const [width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(5000);
  for (const theme of THEMES) {
    for (const c of CASES) {
      if (process.env.ONLY && !c.name.includes(process.env.ONLY)) continue;
      await page.goto(`${base}/test/harness/station-fit/index.html?theme=${theme}&${c.query}`);
      await page.waitForSelector(".station-status-bar");
      await page.waitForTimeout(350);
      let stepError = null;
      try {
        if (c.steps) await c.steps(page);
      } catch (error) {
        stepError = String(error).split("\n")[0];
      }
      await page.waitForTimeout(250);
      const result = await page.evaluate(() => window.__inspect());
      if (stepError) result.problems.push(`step failed: ${stepError}`);
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
