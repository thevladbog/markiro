/* global window, document, getComputedStyle */
// Fit measurement of the work screen's stages (exceptions, the close, the closed shift, the full
// scan history, the labels' history) and of the re-confirmation card, through `screens.html` (see
// screens.tsx and measure-fit.ts). Usage:
//   node measure-screens.mjs [baseUrl]   with PLAYWRIGHT_CORE=/path/to/playwright-core
//   SIZES=1024x640,1024x700 THEME=dark ONLY=close SHOT=/dir node measure-screens.mjs
// Prints one JSON object per case and size; exits 1 on any problem.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://localhost:5291";
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

/** Lists that are long by nature and keep their own scroll: the picker's boxes, the labels. */
const LISTS = ["shift-boxes__list", "unit-label-history__rows"];

const press = (page, name) => page.getByRole("button", { name }).first().click();
const settle = (page) => page.waitForTimeout(250);
/** Past the view guard that ignores a press right after a change of view. */
const guarded = async (page) => page.waitForTimeout(700);

const toTarget = (action) => async (page) => {
  await guarded(page);
  await press(page, action);
  await settle(page);
};
const toReason = (action, pick) => async (page) => {
  await toTarget(action)(page);
  await guarded(page);
  await press(page, pick);
  await settle(page);
};
const toConfirm =
  (action, pick, reason = "Этикетка повреждена") =>
  async (page) => {
    await toReason(action, pick)(page);
    await guarded(page);
    await press(page, reason);
    await settle(page);
  };

const CASES = [
  { name: "exceptions-actions", query: "view=exceptions" },
  { name: "exceptions-actions-nopallets", query: "view=exceptions&variant=nopallets" },
  { name: "exceptions-empty", query: "view=exceptions&variant=empty" },
  {
    name: "exceptions-confirm-clear",
    query: "view=exceptions",
    steps: async (page) => {
      await guarded(page);
      await press(page, "Очистить короб");
      await settle(page);
    },
  },
  {
    name: "exceptions-target-box",
    query: "view=exceptions",
    steps: toTarget("Перепечатать этикетку"),
  },
  {
    name: "exceptions-target-pallet",
    query: "view=exceptions",
    steps: toTarget("Перепечатать этикетку паллеты"),
  },
  {
    name: "exceptions-reason",
    query: "view=exceptions",
    steps: toReason("Расформировать короб", /· 12 шт\./),
  },
  {
    name: "exceptions-confirm-reprint",
    query: "view=exceptions",
    steps: toConfirm("Перепечатать этикетку", /· 12 шт\./),
  },
  {
    name: "exceptions-confirm-reprint-noprinter",
    query: "view=exceptions&variant=noprinter",
    steps: toConfirm("Перепечатать этикетку", /· 12 шт\./),
  },
  {
    name: "exceptions-confirm-disassemble",
    query: "view=exceptions",
    steps: toConfirm("Расформировать короб", /· 12 шт\./, "Не тот товар"),
  },
  { name: "close-plain", query: "view=close&variant=plain" },
  { name: "close-reason", query: "view=close&variant=reason" },
  { name: "close-openbox", query: "view=close&variant=openbox" },
  { name: "close-label", query: "view=close&variant=label" },
  { name: "close-pallet", query: "view=close&variant=pallet" },
  { name: "close-note", query: "view=close&variant=note" },
  { name: "closed", query: "view=closed" },
  { name: "closed-held", query: "view=closed&variant=held" },
  { name: "history-full", query: "view=history" },
  {
    name: "history-full-page2",
    query: "view=history",
    steps: async (page) => {
      await page.waitForTimeout(500);
      await press(page, "Следующая страница");
      await settle(page);
    },
  },
  { name: "unithistory", query: "view=unithistory" },
  { name: "unithistory-closed", query: "view=unithistory&variant=closed" },
  { name: "unithistory-empty", query: "view=unithistory&variant=empty" },
  { name: "reconfirm-badge", query: "view=reconfirm" },
  {
    name: "reconfirm-entry",
    query: "view=reconfirm",
    steps: async (page) => {
      await press(page, "Ввести табельный номер");
      await settle(page);
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
      await page.goto(`${base}/test/harness/station-fit/screens.html?theme=${theme}&${c.query}`);
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
      // A stage of the work holds all it shows in the window. The only scroll allowed is a list
      // that is long by nature (`LISTS`, or the case's own `scrolls`), and nothing outside that list
      // may wait below the fold: the pad, the header and the way back are in view.
      const allowed = [...LISTS, ...(c.scrolls ?? [])];
      const scrolling = result.scrollers.filter(
        (name) => !allowed.some((cls) => name.includes(cls)),
      );
      if (scrolling.length > 0) result.problems.push(`scrolls inside: ${scrolling.join(" | ")}`);
      const hidden = await page.evaluate(
        (selector) => {
          const out = [];
          for (const el of document.querySelectorAll(
            "button, a[href], input, select, textarea, [role=button]",
          )) {
            const box = el.getBoundingClientRect();
            if (box.width === 0 || (selector !== "" && el.closest(selector))) continue;
            let clipped = box.bottom > window.innerHeight + 1 || box.top < -1;
            for (let node = el.parentElement; node && !clipped; node = node.parentElement) {
              const overflow = getComputedStyle(node).overflowY;
              if (overflow === "visible") continue;
              const outer = node.getBoundingClientRect();
              clipped = box.bottom > outer.bottom + 1 || box.top < outer.top - 1;
            }
            if (clipped)
              out.push((el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30));
          }
          return out;
        },
        allowed.map((cls) => `.${cls}`).join(","),
      );
      if (hidden.length > 0)
        result.problems.push(`below the fold or clipped: ${hidden.join(" | ")}`);
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
