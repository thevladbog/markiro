/* global document, innerWidth, innerHeight, getComputedStyle */
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
/*
 * The measuring guard of the window-mode work (not a CI test: it needs Chromium, and on macOS
 * the sandbox switched off). Steps:
 *   1. pnpm --filter @markiro/standalone exec vite build --outDir $R/site --emptyOutDir
 *   2. pnpm --filter @markiro/standalone exec vitest run --config test/harness/window-mode/vitest.harness.config.ts
 *      (writes $R/html/*.json: the sign-in and the re-confirmation in each state)
 *   3. PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node measure.mjs <screenshots-dir> [sizes]
 * Each state is measured dark and light at the full-screen panels (1280x1024, 1280x800,
 * 1024x768, 1024x640) and at windowed sizes (960x560 and 900x600 are an ordinary window at its
 * least, then 1280x720, 1366x680, 1920x1000, 2560x1300): no page scroll, nothing off the
 * viewport or clipped by its container, every control at least 64 px, no overlap; the
 * re-confirmation card's margins show that it stays centred. `R` is WINDOW_MODE_SHOTS.
 */
const R = (process.env.WINDOW_MODE_SHOTS ?? "/tmp/claude/shots/floor-window-mode") + "/";
const OUTDIR = process.argv[2] ?? "after";
const css = readdirSync(R + "site/assets")
  .filter((f) => f.endsWith(".css"))
  .map((f) => `<link rel="stylesheet" href="../site/assets/${f}">`)
  .join("");
mkdirSync(R + "pages", { recursive: true });
const names = ["signin", "reconfirm-badge", "reconfirm-entry", "reconfirm-error"];
const SIZES = {
  // full-screen / kiosk panels
  "kiosk-1280x1024": [1280, 1024],
  "kiosk-1280x800": [1280, 800],
  "kiosk-1024x768": [1024, 768],
  "kiosk-1024x640": [1024, 640],
  // windowed: the page under a title bar and a frame
  "win-1280x720": [1280, 720],
  "win-960x560": [960, 560],
  "win-900x600": [900, 600],
  "win-1366x680": [1366, 680],
  "win-1920x1000": [1920, 1000],
  "win-2560x1300": [2560, 1300],
};
const only = process.argv[3] ? process.argv[3].split(",") : Object.keys(SIZES);
const check = () => {
  const out = {
    docScroll: document.documentElement.scrollHeight - innerHeight,
    docScrollX: document.documentElement.scrollWidth - innerWidth,
    small: [],
    clipped: [],
    overlap: [],
    card: null,
    content: null,
  };
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let a = e; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    return true;
  };
  const lab = (e) =>
    (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
  const overlay = document.querySelector(".reconfirm-overlay");
  const sel = "button,[role=button],input,[tabindex]:not([tabindex='-1']):not([role=dialog])";
  const scope = overlay ? overlay : document;
  for (const e of scope.querySelectorAll(sel)) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (e.closest(".station-visually-hidden")) continue;
    if (r.height < 63.5 || r.width < 63.5)
      out.small.push(
        `${e.className.toString().split(" ")[0]} «${lab(e)}» ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
    if (r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.left < -0.5 || r.top < -0.5)
      out.clipped.push(`off-viewport «${lab(e)}» b${Math.round(r.bottom)} r${Math.round(r.right)}`);
  }
  // text clipped by an overflow:hidden ancestor
  for (const e of scope.querySelectorAll("h1,h2,h3,p,span,output,dd,button")) {
    if (!vis(e) || e.closest(".station-visually-hidden")) continue;
    const r = e.getBoundingClientRect();
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(hidden|clip)/.test(cs.overflowY) || /(hidden|clip)/.test(cs.overflowX)) {
        const ar = a.getBoundingClientRect();
        if (
          r.bottom > ar.bottom + 1 ||
          r.top < ar.top - 1 ||
          r.right > ar.right + 1 ||
          r.left < ar.left - 1
        )
          out.clipped.push(
            `${e.tagName.toLowerCase()} «${lab(e)}» exits ${a.className.toString().split(" ")[0]} by ${Math.round(Math.max(r.bottom - ar.bottom, ar.top - r.top, r.right - ar.right, ar.left - r.left))}`,
          );
        break;
      }
    }
  }
  // overlap of interactive controls
  const ctl = [...scope.querySelectorAll("button,input")].filter(vis);
  for (let i = 0; i < ctl.length; i++)
    for (let j = i + 1; j < ctl.length; j++) {
      const a = ctl[i].getBoundingClientRect(),
        b = ctl[j].getBoundingClientRect();
      if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue;
      if (
        a.left < b.right - 1 &&
        b.left < a.right - 1 &&
        a.top < b.bottom - 1 &&
        b.top < a.bottom - 1
      )
        out.overlap.push(`«${lab(ctl[i])}» × «${lab(ctl[j])}»`);
    }
  const card = document.querySelector(".reconfirm-card");
  if (card) {
    const r = card.getBoundingClientRect();
    out.card = {
      l: Math.round(r.left),
      r: Math.round(innerWidth - r.right),
      t: Math.round(r.top),
      b: Math.round(innerHeight - r.bottom),
      w: Math.round(r.width),
    };
  }
  const body = document.querySelector(".operator-login__body");
  if (body) {
    const r = body.getBoundingClientRect();
    out.content = {
      l: Math.round(r.left),
      r: Math.round(innerWidth - r.right),
      w: Math.round(r.width),
    };
    const k = document.querySelector(".operator-login .floor-keypad__key");
    if (k)
      out.key =
        Math.round(k.getBoundingClientRect().width) +
        "x" +
        Math.round(k.getBoundingClientRect().height);
  }
  return out;
};
const browser = await chromium.launch({ chromiumSandbox: false });
let bad = 0,
  total = 0;
for (const n of names) {
  const m = JSON.parse(readFileSync(R + `html/${n}.json`, "utf8"));
  for (const theme of ["dark", "light"]) {
    const file = R + `pages/${n}-${theme}.html`;
    writeFileSync(
      file,
      `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8">${css}<style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"><main class="standalone-screen">${m.screen}</main></div></body></html>`,
    );
    for (const sz of only) {
      const [w, h] = SIZES[sz];
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto("file://" + file);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(100);
      const res = await page.evaluate(`(${check.toString()})()`);
      mkdirSync(`${R}${OUTDIR}/`, { recursive: true });
      await page.screenshot({ path: `${R}${OUTDIR}/${n}-${theme}-${sz}.png` });
      total++;
      const issues = [];
      if (res.docScroll > 0) issues.push("scrollY+" + res.docScroll);
      if (res.docScrollX > 0) issues.push("scrollX+" + res.docScrollX);
      if (res.small.length) issues.push("small:" + res.small.slice(0, 3).join("; "));
      if (res.clipped.length) issues.push("clipped:" + res.clipped.slice(0, 3).join("; "));
      if (res.overlap.length) issues.push("overlap:" + res.overlap.slice(0, 2).join("; "));
      const extra =
        (res.card ? ` card=${JSON.stringify(res.card)}` : "") +
        (res.content ? ` body=${JSON.stringify(res.content)} key=${res.key}` : "");
      if (issues.length) {
        bad++;
        console.log(n.padEnd(17), theme.padEnd(5), sz.padEnd(16), issues.join(" | "));
      }
      if (process.env.VERBOSE)
        console.log(n.padEnd(17), theme.padEnd(5), sz.padEnd(16), "ok" + extra);
      await page.close();
    }
  }
}
await browser.close();
console.log(`${total} shots, ${bad} with issues`);
