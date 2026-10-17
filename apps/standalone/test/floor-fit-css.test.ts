import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The real terminal (a 1280 x 1024 panel at Windows 125 %: the app's window is about 1024 x 640-720
 * CSS pixels), pinned as text: jsdom has no layout, so the measured proof is the browser guard
 * (`test/harness/station-fit/measure.mjs`, `station-fit.browser.test.ts`). These are the decisions
 * that guard measured: where the compact layouts begin, what they keep, and that the brand gradient
 * has a fallback a runtime that drops it still paints.
 */
const APP = process.cwd();
const read = (path: string) => readFileSync(join(APP, path), "utf8");
const normal = (text: string) => text.replace(/\s+/g, " ").trim();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const hub = normal(strip(read("src/floor/shifts/shift-hub.css")));
const setup = normal(strip(read("src/floor/setup/workstation-setup.css")));
const controls = normal(strip(read("src/floor/kit/floor-controls.css")));

/** The body of the first `@media` block that starts with `query`, braces balanced. */
function media(css: string, query: string): string {
  const start = css.lastIndexOf(`@media ${query} {`);
  if (start === -1) throw new Error(`no @media ${query}`);
  let depth = 0;
  for (let at = css.indexOf("{", start); at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    if (css[at] === "}") {
      depth -= 1;
      if (depth === 0) return normal(css.slice(css.indexOf("{", start) + 1, at));
    }
  }
  throw new Error(`unbalanced @media ${query}`);
}

describe("«Новая смена» on the short terminal window", () => {
  const short = media(hub, "(max-height: 780px)");

  it("begins below 780 px, so 1024 x 768 is compact and 1280 x 800 keeps its own sizes", () => {
    expect(short).toContain(".new-shift .station-floor-footer");
    // The primary is 72 px here (84 on a tall window), never under.
    expect(short).toMatch(/height: 72px !important/);
  });

  it("keeps every left row at its content's height, and the column scrolls rather than clips", () => {
    expect(hub).toMatch(/\.new-shift \.new-shift__left > \* \{ flex: none; \}/);
    expect(hub).toMatch(/\.new-shift \.new-shift__left \{[^}]*overflow-y: auto/);
  });

  it("puts the two readouts in a row over 64 px keys and gives the explanation up", () => {
    expect(short).toMatch(/\.new-shift__readouts \{[^}]*grid-auto-flow: column/);
    expect(short).toMatch(
      /\.new-shift \.new-shift__pad-slot:has\(\.new-shift__pad-hint\) \{ display: none/,
    );
    expect(short).toMatch(/\.floor-keypad \{[^}]*minmax\(64px, 1fr\)/);
    expect(short).toMatch(/\.floor-keypad__key \{[^}]*min-height: 64px/);
  });

  it("drops the mode's explanation, never the caption or the two words", () => {
    expect(short).toMatch(/\.floor-mode__hint \{ display: none/);
    expect(short).not.toMatch(/\.floor-mode__label \{ display: none/);
  });

  it("gives an error two lines in the tall short panels too (it was cut at 52 px)", () => {
    expect(media(hub, "(max-height: 860px)")).toMatch(
      /\.new-shift__pad-slot \{ height: 58px; min-height: 58px; \}/,
    );
  });
});

describe("the switch card", () => {
  it("cuts its hint at two lines (the full text is the line's title) and never at the next row", () => {
    expect(controls).toMatch(/\.floor-switch-card__hint \{[^}]*-webkit-line-clamp: 2[^}]*\}/);
    expect(controls).toMatch(/\.floor-switch-card__hint \{[^}]*overflow: hidden/);
  });

  it("gives a readout's label an ellipsis and its note no shrink: the note never crowds the label", () => {
    expect(controls).toMatch(/\.floor-readout__label > span \{[^}]*text-overflow: ellipsis/);
    expect(controls).toMatch(/\.floor-readout__label em \{[^}]*flex: none/);
    expect(controls).toMatch(/\.floor-readout__label \{[^}]*gap: 16px/);
  });
});

describe("«Рабочее место» on the narrow or short window", () => {
  const compact = media(setup, "(max-width: 1100px), (max-height: 780px)");

  it("makes a printer's row actions icons of 64 px and hides their words (they are aria-label and title)", () => {
    expect(compact).toMatch(/\.setup-row__action-text \{ display: none; \}/);
    expect(compact).toMatch(/\.setup-printer-row__actions > button[^{]*\{[^}]*width: 64px/);
    expect(compact).toMatch(/\.setup-scanner-row__remove \{[^}]*width: 64px/);
  });

  it("keeps the scanners' keypad docked on the right, 380 px, at 1024 px (not under the form)", () => {
    expect(compact).toMatch(
      /\.setup-scanners \{ grid-template-columns: minmax\(0, 1fr\) 380px; \}/,
    );
    // The old rule folded the columns into one: the keypad then landed below the form.
    expect(media(setup, "(max-width: 1100px)")).not.toContain(".setup-scanners");
    expect(compact).toMatch(/\.setup-scanners__side \{[^}]*overflow-y: auto/);
  });

  it("pins a 72 px footer on a short window and leaves the panel the rest", () => {
    const short = media(setup, "(max-height: 780px)");
    expect(short).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto 72px/);
    expect(short).toMatch(/\.setup-footer__back,[^{]*\{ height: 72px !important/);
  });

  it("cuts a long printer name in two lines and its line in one, inside the row", () => {
    expect(setup).toMatch(/\.setup-printer-row h3 \{[^}]*-webkit-line-clamp: 2/);
    expect(setup).toMatch(/\.setup-printer-row__connection \{[^}]*text-overflow: ellipsis/);
    expect(setup).toMatch(
      /\.setup-printer-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/,
    );
  });

  it("keeps a long printer name inside its select and the self-test's buttons inside their card", () => {
    expect(setup).toMatch(
      /\.setup-printer-assignments \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
    expect(setup).toMatch(
      /\.setup-printer-assignments \.mk-select__value \{[^}]*text-overflow: ellipsis/,
    );
    expect(setup).toMatch(
      /\.self-test__result-side \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});

/** Every stylesheet of the floor. */
function floorCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return floorCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("the brand gradient", () => {
  const GRADIENT = /linear-gradient\([^;]*var\(--brand1\)[^;]*\);/;

  it("is declared in the floor's styles only where a flat `brand` face comes before it", () => {
    const declared: string[] = [];
    for (const path of floorCss(join(APP, "src/floor"))) {
      const css = strip(readFileSync(path, "utf8"));
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = rule[2] ?? "";
        if (!GRADIENT.test(body)) continue;
        declared.push(normal(rule[1] ?? ""));
        const before = body.slice(0, body.search(GRADIENT));
        // A runtime that drops the gradient still paints the brand: a feature-free line first.
        expect(before, normal(rule[1] ?? "")).toMatch(/background(-color)?:\s*var\(--brand\d\);/);
      }
    }
    // The three faces of a product: the work band, the new shift's card, every other frame's backing.
    expect(declared.sort()).toEqual(
      [
        ".work-shift-band",
        ".new-shift .new-shift__product",
        ':where(.floor-frame, .station-screen) [data-photo-backing="gradient"]',
      ].sort(),
    );
  });

  it("is the whole face of the hub card's panel whatever the photo is", () => {
    expect(read("src/floor/shifts/ShiftCard.tsx")).toMatch(
      /className="shift-card__photo"\s+faceAlways/,
    );
  });
});
