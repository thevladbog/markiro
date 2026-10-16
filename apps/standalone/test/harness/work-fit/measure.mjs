/* global document, getComputedStyle */
// Layout measurement of the work screen (see main.tsx). Usage:
//   node measure.mjs [baseUrl]   with Playwright resolvable (PLAYWRIGHT_CORE=/path/to/playwright-core)
// Prints one JSON object per viewport and mode; exits 1 on any overflow or clipped row.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://localhost:5290";
const HEIGHTS = [1024, 960, 900, 800, 720];
// 1024 CSS px wide is the 1280-px panel at Windows 125 % scaling (a likely real terminal).
const WIDTHS = [1280, 1024];
const CASES = [
  { name: "pallets", query: "mode=pallets&capacity=3&items=2" },
  { name: "plain", query: "mode=plain&capacity=3&items=2" },
  { name: "cap10", query: "mode=plain&capacity=10&items=6" },
  { name: "check", query: "mode=check" },
  { name: "cap6", query: "mode=pallets&capacity=6&items=4" },
  { name: "cap12", query: "mode=pallets&capacity=12&items=5" },
  { name: "cap48", query: "mode=plain&capacity=48&items=20" },
];

/** Runs in the page: every measurement of one rendered case. */
function inspect() {
  const out = { problems: [] };
  const doc = document.documentElement;
  out.pageOverflowY = doc.scrollHeight - doc.clientHeight;
  if (out.pageOverflowY > 0) out.problems.push(`page scrolls by ${out.pageOverflowY}px`);
  const box = (el) => el.getBoundingClientRect();
  const clipped = (el) =>
    el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1;
  out.buttons = [...document.querySelectorAll(".work-box-fill__actions .mk-btn")].map((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const label = range;
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top / 4))).size;
    const entry = {
      action: el.dataset.action,
      w: Math.round(box(el).width),
      h: Math.round(box(el).height),
      lines,
      overflowY: el.scrollHeight - el.clientHeight,
      overflowX: el.scrollWidth - el.clientWidth,
      textFits: box(label).top >= box(el).top - 0.5 && box(label).bottom <= box(el).bottom + 0.5,
    };
    if (clipped(el) || !entry.textFits) out.problems.push(`button ${entry.action} overflows`);
    if (entry.h < 64) out.problems.push(`button ${entry.action} under 64px`);
    if (entry.lines > 2) out.problems.push(`button ${entry.action} has ${entry.lines} lines`);
    return entry;
  });
  const heights = new Set(out.buttons.map((b) => b.h));
  if (heights.size > 1) out.problems.push("box buttons differ in height");
  const list = document.querySelector(".scan-history--compact .scan-history__list");
  if (list) {
    const lb = box(list);
    const rows = [...list.querySelectorAll(".scan-history__row")].filter(
      (r) => getComputedStyle(r).display !== "none",
    );
    const bad = rows.filter((r) => box(r).bottom > lb.bottom + 0.5 || box(r).top < lb.top - 0.5);
    out.history = { listH: Math.round(lb.height), shown: rows.length, clippedRows: bad.length };
    if (bad.length) out.problems.push(`${bad.length} history row(s) clipped`);
    const codeBad = rows.filter((r) =>
      [...r.querySelectorAll(".scan-history__code, .scan-history__code *")].some(
        (c) => c.scrollWidth - c.clientWidth > 1 && getComputedStyle(c).textOverflow !== "ellipsis",
      ),
    );
    if (codeBad.length) out.problems.push("history code overflows its cell");
  }
  out.panels = [...document.querySelectorAll(".work-instrument, .work-shift-band")].map((el) => {
    const entry = {
      cls: el.className.split(" ").slice(0, 2).join("."),
      overflowY: el.scrollHeight - el.clientHeight,
    };
    return entry;
  });
  for (const p of out.panels) {
    if (p.overflowY > 1) out.problems.push(`panel ${p.cls} overflows by ${p.overflowY}px`);
  }
  out.cells = [...document.querySelectorAll(".work-box-fill__cell")].slice(0, 1).map((el) => ({
    w: Math.round(box(el).width),
    h: Math.round(box(el).height),
    serialShown: !!el.querySelector(".work-box-fill__serial"),
  }));
  for (const cell of document.querySelectorAll(".work-box-fill__cell")) {
    if (clipped(cell)) out.problems.push("box cell content overflows");
    const serial = cell.querySelector(".work-box-fill__serial");
    if (serial && serial.scrollWidth - serial.clientWidth > 1)
      out.problems.push("cell serial clipped");
    if (serial && parseFloat(getComputedStyle(serial).fontSize) < 12)
      out.problems.push("cell serial under 12px");
  }
  for (const code of document.querySelectorAll(".scan-code__serial, .scan-code__gtin")) {
    if (code.scrollWidth - code.clientWidth > 1) out.problems.push("code line clipped");
  }
  out.lastCode = (() => {
    const el = document.querySelector(".work-scan-hero__code");
    return el
      ? { overflowX: el.scrollWidth - el.clientWidth, overflowY: el.scrollHeight - el.clientHeight }
      : null;
  })();
  if (out.lastCode && (out.lastCode.overflowX > 1 || out.lastCode.overflowY > 1))
    out.problems.push("last scan code overflows");
  const band = document.querySelector(".work-shift-band");
  const photo = document.querySelector(".work-shift-band__photo");
  if (band && photo) {
    out.band = {
      h: Math.round(box(band).height),
      photoH: Math.round(box(photo).height),
      photoW: Math.round(box(photo).width),
    };
  }
  const head = document.querySelector(".work-box-fill__head");
  if (head) {
    const title = head.querySelector("h2");
    const count = head.querySelector(".work-box-fill__count");
    out.head = {
      titleLeft: Math.round(box(title).left),
      countRight: Math.round(box(count).right),
      headRight: Math.round(box(head).right),
    };
  }
  return out;
}

const browser = await chromium.launch();
let failed = false;
for (const width of WIDTHS)
  for (const height of HEIGHTS) {
    const page = await browser.newPage({ viewport: { width, height } });
    for (const c of CASES) {
      await page.goto(`${base}/test/harness/work-fit/index.html?${c.query}`);
      await page.waitForSelector(".work-screen");
      await page.waitForTimeout(150);
      const result = await page.evaluate(inspect);
      if (process.env.SHOT)
        await page.screenshot({ path: `${process.env.SHOT}/${width}x${height}-${c.name}.png` });
      if (result.problems.length) failed = true;
      console.log(JSON.stringify({ width, height, case: c.name, ...result }));
    }
    await page.close();
  }

/** The photo's frame fills its banner or card in height, is square (the work band's; the hub card's is the left half, not square), and has the right backing. */
function inspectPhoto(selectors) {
  const frame = document.querySelector(selectors.frame);
  const holder = document.querySelector(selectors.holder);
  const f = frame.getBoundingClientRect();
  const h = holder.getBoundingClientRect();
  const inner = holder.clientHeight;
  const style = getComputedStyle(frame);
  const problems = [];
  if (selectors.full && Math.abs(f.height - inner) > 1.5)
    problems.push(`photo ${f.height} high in a ${inner} holder`);
  if (selectors.square !== false && Math.abs(f.width - f.height) > 1.5)
    problems.push(`photo frame not square ${f.width}x${f.height}`);
  const img = frame.querySelector("img");
  if (img) {
    const i = img.getBoundingClientRect();
    if (i.width > f.width + 0.5 || i.height > f.height + 0.5)
      problems.push("picture grows past its frame");
  }
  return {
    backing: frame.dataset.photoBacking,
    gradient: style.backgroundImage.includes("gradient"),
    frame: `${Math.round(f.width)}x${Math.round(f.height)}`,
    holder: `${Math.round(h.width)}x${Math.round(h.height)}`,
    problems,
  };
}
const EXPECT = { transparent: "gradient", opaque: "none", jpeg: "none", none: "gradient" };
for (const [width, height] of [
  [1280, 1024],
  [1024, 800],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const kind of ["transparent", "opaque", "jpeg", "none"]) {
    for (const [view, selectors] of [
      ["work", { frame: ".work-shift-band__photo", holder: ".work-shift-band", full: true }],
      [
        "hub",
        { frame: ".shift-card__photo", holder: ".shift-card__body", full: true, square: false },
      ],
    ]) {
      await page.goto(
        `${base}/test/harness/work-fit/index.html?view=${view === "hub" ? "hub" : "work"}&photo=${kind}`,
      );
      await page.waitForSelector(selectors.frame);
      await page.waitForTimeout(400);
      const result = await page.evaluate(inspectPhoto, selectors);
      if (result.backing !== EXPECT[kind])
        result.problems.push(`backing ${result.backing}, expected ${EXPECT[kind]}`);
      if ((result.backing === "gradient") !== result.gradient)
        result.problems.push("backing attribute and painted face differ");
      if (process.env.SHOT)
        await page.screenshot({
          path: `${process.env.SHOT}/photo-${width}x${height}-${view}-${kind}.png`,
        });
      if (result.problems.length) failed = true;
      console.log(JSON.stringify({ width, height, photo: kind, view, ...result }));
    }
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
