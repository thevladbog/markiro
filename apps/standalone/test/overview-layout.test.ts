import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * «Обзор» is CSS jsdom does not compute, so these tests hold the rules that make the layout: one
 * page that fits 1280 x 690 without scrolling, the kit's tokens only, no animation, targets of at
 * least 40 px, and a series told apart by form as well as by colour. The look itself is checked in
 * a browser (the report says at which sizes).
 */
const css = readFileSync(join(__dirname, "../src/office/overview/overview.css"), "utf8");

/** The declarations of every rule (outside any @media) that lists `selector` among its own, joined. */
function rule(selector: string, source = css): string {
  const outside = source.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
  const found: string[] = [];
  for (const match of outside.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (match[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((each) => each.trim());
    if (selectors.includes(selector)) found.push(match[2] ?? "");
  }
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.join("\n");
}

/** The body of the `@media` block whose query is exactly `query`. */
function media(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) throw new Error(`no @media ${query}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  throw new Error("unbalanced");
}

const COMPACT = "(max-height: 799px), (max-width: 1365px)";

describe("the overview's layout rules", () => {
  it("is two columns, the side one 400 px, as tall as the window leaves it and never shorter than its content", () => {
    const page = rule(".office-shell__content > .ov-page");
    expect(page).toContain("display: grid");
    expect(page).toContain("grid-template-columns: minmax(0, 1fr) 400px");
    // `1 0 auto`: it fills a tall window and scrolls the shell's own page in a low one.
    expect(page).toContain("flex: 1 0 auto");
  });

  it("lets the chart take the room that is left, between a floor and the content", () => {
    expect(rule(".ov-main")).toContain("grid-template-rows: auto minmax(220px, 1fr) auto");
    expect(rule(".ov-side")).toContain("grid-template-rows: minmax(0, 1fr) auto auto");
  });

  it("becomes one column in a narrow window", () => {
    expect(media("(max-width: 1099px)")).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("is denser in a low or narrow window: less padding, three rows of attention, and the shell's page padding is cut so 690 px needs no scroll", () => {
    const dense = media(COMPACT);
    expect(dense).toMatch(/\.ov-attn__row\s*\{[^}]*min-height: 48px/);
    expect(dense).toMatch(/nth-child\(n \+ 4\)[^{]*\{[^}]*display: none/);
    expect(media("(max-height: 799px)")).toMatch(
      /office-shell__content:has\(> \.ov-page\)\s*\{[^}]*padding-block: var\(--sp-4\)/,
    );
  });

  it("keeps every target at 40 px or more, in the dense layout too", () => {
    const selectors = [".ov-days__link", ".ov-sys__link", ".ov-line__link", ".ov-panel__link"];
    const dense = media(COMPACT);
    for (const selector of selectors) {
      const min = /min-height: (\d+)px/.exec(rule(selector))?.[1];
      expect(Number(min), selector).toBeGreaterThanOrEqual(40);
      const denseMin = new RegExp(
        `${selector.replace(".", "\\.")}[^{]*\\{[^}]*min-height: (\\d+)px`,
      ).exec(dense)?.[1];
      if (denseMin !== undefined)
        expect(Number(denseMin), `${selector} dense`).toBeGreaterThanOrEqual(40);
    }
  });

  it("uses the kit's tokens only: no colour literal, no gradient", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/box-shadow:[^;]*\b\d+px \d+px \d+px/);
  });

  it("animates nothing, so reduced motion has nothing to turn off", () => {
    expect(css).not.toMatch(/@keyframes|animation|transition/);
  });

  it("tells the series apart by form: today a solid bar, the days before an outlined one", () => {
    expect(rule(".ov-chart__bar")).toContain("border: 2px solid var(--fg-3)");
    expect(rule(".ov-chart__bar--today")).toContain("background: var(--ok-solid)");
    expect(rule(".ov-chart__swatch--past")).toContain("border: 2px solid var(--fg-3)");
    expect(rule(".ov-chart__swatch--today")).toContain("background: var(--ok-solid)");
    // Today's label is also marked by a bar under it and a heavier weight, never colour alone.
    expect(rule(".ov-chart__label--today")).toContain("font-weight: 700");
    expect(rule(".ov-chart__label--today::after")).toContain("height: 3px");
  });

  it("hides the table of the chart's view from the eye without removing it from the page", () => {
    const hidden = rule(".ov-visually-hidden");
    expect(hidden).toContain("position: absolute");
    expect(hidden).toContain("clip-path: inset(50%)");
    expect(hidden).not.toContain("display: none");
  });
});
