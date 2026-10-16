import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Design kit 2026-10, step C: the work screen is a fixed-height grid that never scrolls the
 * page, its footer is the kit's 84 px row, and its colour comes from tokens that exist in both
 * themes.
 */
const APP = process.cwd();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (path: string) => strip(readFileSync(join(APP, path), "utf8"));
const WORK = read("src/floor/work/work-screen.css");
const HISTORY = read("src/floor/work/scan-history.css");
const UNIT = read("src/floor/unit-labels/unit-labels.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("the work screen's no-scroll contract", () => {
  it("holds the screen to the window: the frame is the window's height and clips", () => {
    expect(rule(WORK, ".floor-frame:has(> .work-screen)")).toMatch(/height:\s*100dvh/);
    expect(rule(WORK, ".floor-frame:has(> .work-screen)")).toMatch(/overflow:\s*hidden/);
    expect(rule(WORK, ".standalone-screen:has(> .floor-frame > .work-screen)")).toMatch(
      /overflow:\s*hidden/,
    );
  });

  it("is a grid of the content row and the 84 px footer row, neither scrolling", () => {
    const screen = rule(WORK, ".work-screen");
    expect(screen).toMatch(/--work-footer-h:\s*calc\(var\(--control-floor-primary\)/);
    expect(screen).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s*var\(--work-footer-h\)/);
    expect(screen).toMatch(/overflow:\s*hidden/);
    expect(rule(WORK, ".work-screen__content")).toMatch(/overflow:\s*hidden/);
    expect(rule(WORK, ".work-screen__content")).not.toMatch(/overflow:\s*auto/);
  });

  it("gives the instruments one row of the region's height, so a long list scrolls inside", () => {
    expect(rule(WORK, ".work-screen__instruments")).toMatch(
      /grid-template-rows:\s*minmax\(0,\s*1fr\)/,
    );
    expect(rule(WORK, ".work-screen__work")).toMatch(
      /grid-template-rows:\s*auto minmax\(0,\s*1fr\)/,
    );
    // The history list is the one region that scrolls.
    expect(rule(HISTORY, ".scan-history--compact .scan-history__list")).toMatch(/overflow:\s*auto/);
    expect(rule(HISTORY, ".scan-history--compact .scan-history__list")).toMatch(/min-height:\s*0/);
  });

  it("makes the footer's three actions the kit's 84 px, sharing the row", () => {
    const footer = rule(WORK, ".work-screen .station-floor-footer");
    expect(footer).toMatch(/height:\s*var\(--work-footer-h\)/);
    expect(footer).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule(WORK, ".work-footer__action.mk-btn")).toMatch(/width:\s*100%/);
  });
});

describe("the work screen's colour", () => {
  const tokens = readFileSync(join(APP, "../../packages/ui/src/tokens.css"), "utf8");
  const light = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
  const dark = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
  const names = (block: string) => new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const inLight = names(light);
  const inDark = names(dark);
  const anywhere = names(tokens);
  const local = names(strip(readFileSync(join(APP, "src/floor/floor-kit.css"), "utf8")));

  function used(css: string): string[] {
    const own = names(css);
    return [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? ""))].filter(
      (name) => !own.has(name) && !local.has(name),
    );
  }

  it("takes every colour token the screen uses from the theme blocks, in both themes", () => {
    for (const css of [WORK, HISTORY, UNIT]) {
      for (const name of used(css)) {
        expect(anywhere.has(name), `${name} is not a token`).toBe(true);
        // A themed token is declared in the light block and the dark block alike.
        if (inLight.has(name) || inDark.has(name)) {
          expect(inLight.has(name) && inDark.has(name), `${name} is in one theme only`).toBe(true);
        }
      }
    }
  });

  it("paints the verdict on its own pair: ok, warn (duplicate) and err", () => {
    expect(rule(WORK, '.work-scan-result .work-screen__last[data-verdict="ok"]')).toMatch(
      /var\(--ok-bg\)[\s\S]*var\(--ok-fg\)/,
    );
    expect(
      rule(
        WORK,
        '.work-scan-result .work-screen__last[data-verdict="duplicate"],\n.work-scan-result .work-screen__last[data-verdict="warn"]',
      ),
    ).toMatch(/var\(--warn-bg\)[\s\S]*var\(--warn-fg\)/);
    expect(rule(WORK, '.work-scan-result .work-screen__last[data-verdict="error"]')).toMatch(
      /var\(--err-bg\)[\s\S]*var\(--err-fg\)/,
    );
  });

  it("paints the duplicate's steps on ok, panel, a fg-outlined highlight and err", () => {
    expect(rule(UNIT, '.work-unit-label__step[data-state="ready"]')).toMatch(/var\(--ok-bg\)/);
    expect(rule(UNIT, '.work-unit-label__step[data-state="current"]')).toMatch(/var\(--fg\)/);
    expect(rule(UNIT, '.work-unit-label__step[data-state="error"]')).toMatch(/var\(--err-bg\)/);
    expect(rule(UNIT, ".work-unit-label__step")).toMatch(/var\(--panel\)/);
  });

  it("keeps no per-product accent on the floor's work screen", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(tsx|css)$/.test(name) ? [path] : [];
      });
    for (const file of sources(join(APP, "src/floor/work"))) {
      const text = strip(readFileSync(file, "utf8")).replace(/^\s*\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/useProductAccent|data-accent="true"|--product-hue:/);
    }
  });
});
