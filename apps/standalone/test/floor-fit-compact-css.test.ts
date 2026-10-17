import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wholeRowsThatFit } from "../src/floor/work/ScanHistory.js";

/**
 * The work screen and the stages of the work on the real terminal's short window (a 1280 x 1024
 * panel at Windows 125 %: ~1024 x 640-720 CSS px), pinned as text: jsdom has no layout, so the
 * measured proof is the browser guard (`test/harness/station-fit/measure-others.mjs` for the work
 * screen, `measure-screens.mjs` for its stages; `station-fit.browser.test.ts` runs both). These are
 * the decisions that guard measured.
 */
const APP = process.cwd();
const read = (path: string) => readFileSync(join(APP, path), "utf8");
const normal = (text: string) => text.replace(/\s+/g, " ").trim();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = (path: string) => normal(strip(read(path)));

/** The bodies of every top-level `@media` block that starts with `query`, braces balanced, joined. */
function media(css: string, query: string): string {
  const bodies: string[] = [];
  for (let start = css.indexOf(`@media ${query} {`); start !== -1;) {
    let depth = 0;
    let end = -1;
    for (let at = css.indexOf("{", start); at < css.length; at += 1) {
      if (css[at] === "{") depth += 1;
      if (css[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = at;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced @media ${query}`);
    bodies.push(normal(css.slice(css.indexOf("{", start) + 1, end)));
    start = css.indexOf(`@media ${query} {`, end);
  }
  if (bodies.length === 0) throw new Error(`no @media ${query}`);
  return bodies.join(" ");
}

const work = sheet("src/floor/work/work-screen.css");
const history = sheet("src/floor/work/scan-history.css");
const pallets = sheet("src/floor/pallets/pallet-strip.css");
const exceptions = sheet("src/floor/exceptions/exception-flow.css");
const close = sheet("src/floor/close/shift-close.css");
const labels = sheet("src/floor/unit-labels/unit-labels.css");
const reconfirm = sheet("src/floor/reconfirm.css");
const signIn = sheet("src/floor/sign-in/operator-sign-in.css");

/** Every `height: Npx` / `min-height: Npx` declaration of a block, with its rule's selector. */
function heights(block: string): { selector: string; px: number }[] {
  const found: { selector: string; px: number }[] = [];
  for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaration of (rule[2] ?? "").matchAll(/(?:^|[ ;])(?:min-)?height: (\d+)px/g)) {
      found.push({ selector: (rule[1] ?? "").trim(), px: Number(declaration[1]) });
    }
  }
  return found;
}

describe("the work screen below 780 px of window height", () => {
  const compact = media(work, "(max-height: 780px)");

  it("keeps the primary action row at 72 px and the touch targets at 64 px", () => {
    expect(compact).toContain("--work-footer-h: calc(72px + var(--sp-2))");
    expect(compact).toMatch(
      /\.work-footer__action\.mk-btn\.floor-primary \{[^}]*height: 72px !important/,
    );
    // No control of the compact layout is shorter than the floor's 64 px.
    for (const { selector, px } of heights(compact)) {
      if (/\.mk-btn|button|choice|key/.test(selector))
        expect(px, selector).toBeGreaterThanOrEqual(64);
    }
    // The open box's three buttons keep their 64 px row (the base rule, which the compact block never lowers).
    expect(work).toMatch(/\.work-box-fill__actions \.mk-btn \{[^}]*min-height: 64px !important/);
    expect(compact).toContain("minmax(64px, auto)");
  });

  it("slims the band to a title line and a row of chips, and drops the plan's bar before the count", () => {
    expect(compact).toMatch(/\.work-shift-band__copy h2 \{[^}]*-webkit-line-clamp: 1/);
    expect(compact).toMatch(/\.work-shift-band__chips \{[^}]*flex-wrap: nowrap/);
    expect(compact).toMatch(/\.work-shift-band__bar, \.work-shift-band__meta \{ display: none; \}/);
    // The accepted count stays on screen and large.
    expect(compact).toMatch(/\.work-shift-band__count \{ font-size: 40px; \}/);
    expect(compact).not.toMatch(/\.work-shift-band__total[^{]*\{[^}]*display: none/);
  });

  it("gives the open box's cells the remaining height, never under a readable 72 px", () => {
    expect(compact).toContain("grid-template-rows: auto minmax(72px, 1fr) minmax(64px, auto)");
  });

  it("slims the pallet strip to the height of its own 64 px button", () => {
    const strip = media(pallets, "(max-height: 780px)");
    expect(strip).toContain(".pallet-strip");
    expect(strip).not.toMatch(/\.pallet-strip__actions[^{]*\{[^}]*height/);
  });

  it("lets the history keep whole 48 px rows under the 64 px «Вся история» row", () => {
    const rows = media(history, "(max-height: 780px)");
    expect(rows).toMatch(/\.scan-history--compact \.scan-history__row \{[^}]*min-height: 48px/);
    // The list is never a scroll region: whole rows only (`useWholeRows`), the rest one press away.
    expect(history).toMatch(/\.scan-history--compact \.scan-history__list \{[^}]*overflow: hidden/);
  });
});

describe("the whole-rows rule of the history", () => {
  it("fits whole rows only, none when not even one fits", () => {
    expect(wholeRowsThatFit(100, 48, 4)).toBe(2);
    expect(wholeRowsThatFit(204, 48, 4)).toBe(4);
    expect(wholeRowsThatFit(203, 48, 4)).toBe(3);
    expect(wholeRowsThatFit(47, 48, 4)).toBe(0);
    expect(wholeRowsThatFit(0, 48, 4)).toBe(0);
    expect(wholeRowsThatFit(300, 0, 4)).toBe(0);
  });
});

describe("the stages of the work on the short window", () => {
  it("gives a filling stage the stage's whole height as its one track", () => {
    expect(work).toMatch(
      /\.work-screen__stage:has\(> \.exception-flow\), [^{]*\.work-screen__stage:has\(> \.scan-history--full\), [^{]*\.work-screen__stage:has\(> \.unit-label-history\) \{ grid-template-rows: minmax\(0, 1fr\); \}/,
    );
  });

  it("lays the full history's seven rows out in the window's height, 40 to 64 px each", () => {
    expect(history).toMatch(
      /\.scan-history--full > \.scan-history__list \{[^}]*grid-auto-rows: minmax\(40px, 64px\)/,
    );
    expect(history).toMatch(/\.scan-history--full > \.scan-history__list \{[^}]*flex: 1 1 0/);
  });

  it("keeps the labels' history's way back in view: the list shrinks and scrolls, the actions do not", () => {
    expect(labels).toMatch(/\.unit-label-history \{[^}]*display: flex[^}]*flex-direction: column/);
    expect(labels).toMatch(/\.unit-label-history > \* \{ flex: none; \}/);
    expect(labels).toMatch(/\.unit-label-history__rows \{[^}]*flex: 0 1 auto !important/);
  });

  it("puts the exceptions' digit pad in two rows of six 64 px keys below 780 px", () => {
    const short = media(exceptions, "(max-height: 780px)");
    expect(short).toMatch(
      /\.sscc-search__pad \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/,
    );
    expect(short).toMatch(/\.shift-boxes__list \{[^}]*overflow-y: auto/);
    for (const { selector, px } of heights(short)) {
      if (/\.mk-btn|button|key|row/.test(selector)) expect(px, selector).toBeGreaterThanOrEqual(64);
    }
  });

  it("compacts the close below 860 px, its three reasons to a row, its actions outside the scrolling body", () => {
    const short = media(close, "(max-height: 860px)");
    expect(short).toMatch(
      /\.shift-close \.floor-choice-group \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/,
    );
    expect(short).toMatch(/\.shift-close__body \{[^}]*overflow-y: auto/);
    // The actions are never in the body (they stay pinned under it).
    expect(read("src/floor/close/ShiftClosePanel.tsx")).toMatch(
      /<\/div>\s*<div className="shift-close__actions">\s*\{back\}\s*<Button\s*size="floor"\s*disabled=\{summary\.reasonRequired/,
    );
    for (const { selector, px } of heights(short)) {
      if (/\.mk-btn|button|choice/.test(selector)) expect(px, selector).toBeGreaterThanOrEqual(64);
    }
  });
});

describe("the 640 px terminal keeps the 72 px primary actions", () => {
  it("lowers the sign-in's and the re-confirmation's actions to 64 px only below 640 px", () => {
    for (const source of [signIn, reconfirm]) {
      expect(source).toContain("@media (max-height: 639px) {");
      expect(source).not.toContain("@media (max-height: 640px) {");
    }
  });
});
