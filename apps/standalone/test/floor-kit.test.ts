import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { cssRules, selectorParts, stripCssComments } from "./support/css-rules.js";

/**
 * Design kit 2026-10, step A: the floor takes its colour from tokens, follows the
 * global theme, and its kit rules never leak into the office.
 */
const APP = process.cwd();

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const stripComments = stripCssComments;

describe("floor stylesheets", () => {
  const floorCss = cssFiles(join(APP, "src/floor"));

  it("hold no literal colour except the physical paper block of floor-kit.css", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    const offenders = floorCss.filter((file) => {
      let css = stripComments(readFileSync(file, "utf8"));
      if (file.endsWith("floor-kit.css")) css = css.replace(/:root\s*\{[^}]*\}/, "");
      return literal.test(css);
    });
    expect(offenders).toEqual([]);
  });

  it("scope every kit rule to the floor roots (all rules, also those in @media)", () => {
    const rules = cssRules(readFileSync(join(APP, "src/floor/floor-kit.css"), "utf8"));
    expect(rules.length).toBeGreaterThan(30);
    const offenders = rules.flatMap((rule) =>
      selectorParts(rule.selector)
        .filter(
          (part) =>
            !(
              part.replace(/\s+/g, " ").startsWith(":where(.floor-frame, .station-screen)") ||
              part === ":root"
            ),
        )
        .map((part) => `${rule.within.join(" > ") || "(top)"}: ${part}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the only literal colours in the one :root block, with nothing else in it", () => {
    const rules = cssRules(readFileSync(join(APP, "src/floor/floor-kit.css"), "utf8"));
    const roots = rules.filter((rule) => rule.selector === ":root");
    expect(roots).toHaveLength(1);
    const names = [...(roots[0]?.body ?? "").matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
    expect(names).toEqual([
      "--floor-paper",
      "--floor-paper-ink",
      "--floor-scan-ink",
      "--floor-paper-ok",
      "--floor-paper-warn",
      "--floor-paper-err",
    ]);
  });

  it("defines the kit floor type scale, the 84 px primary and the press tokens in use", () => {
    const css = readFileSync(join(APP, "src/floor/floor-kit.css"), "utf8");
    expect(css).toContain("--floor-title: 700 32px/38px");
    expect(css).toContain("--floor-lg: 600 24px/30px");
    expect(css).toContain("--floor-body-strong: 600 20px/28px");
    expect(css).toContain("height: var(--control-floor-primary)");
    expect(css).toContain("scale(var(--press-scale))");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transform: none/);
  });
});

describe("the pre-paint theme", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const script = readFileSync(join(APP, "public/theme-init.js"), "utf8");

  function themeFor(stored: string | null, osDark: boolean): string | null {
    let attribute: string | null = null;
    runInNewContext(script, {
      window: {
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: osDark }),
      },
      document: {
        documentElement: {
          setAttribute: (_name: string, value: string) => {
            attribute = value;
          },
        },
      },
    });
    return attribute;
  }

  it("no longer forces a dark theme before the app starts", () => {
    expect(html).not.toMatch(/data-theme/);
    expect(html).toContain('<script src="/theme-init.js"></script>');
  });

  it("follows the OS by default and honours the stored choice", () => {
    expect(themeFor(null, true)).toBe("dark");
    expect(themeFor(null, false)).toBe("light");
    expect(themeFor("system", true)).toBe("dark");
    expect(themeFor("light", true)).toBe("light");
    expect(themeFor("dark", false)).toBe("dark");
    expect(themeFor("garbage", false)).toBe("light");
  });
});

describe("the stylesheet tokenizer behind the guards", () => {
  it("sees every rule of back-to-back blocks, nested at-rules included, and no keyframe step", () => {
    const rules = cssRules(`
      /* a, b { color: red } */
      a { color: red }
      b { color: blue }
      c, d:is(e, f) { margin: 0 }
      @media (max-width: 10px) { g { top: 0 } h { top: 1px } }
      @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
      @container (max-width: 1px) { @supports (x: y) { i { left: 0 } } }
      j { right: 0 }
    `);
    expect(rules.map((rule) => rule.selector)).toEqual([
      "a",
      "b",
      "c, d:is(e, f)",
      "g",
      "h",
      "i",
      "j",
    ]);
    expect(rules[3]?.within).toEqual(["@media (max-width: 10px)"]);
    expect(rules[5]?.within).toEqual(["@container (max-width: 1px)", "@supports (x: y)"]);
    expect(selectorParts("c, d:is(e, f)")).toEqual(["c", "d:is(e, f)"]);
  });

  it("the old regex never saw the first rule of an at-rule block: the guard now counts them", () => {
    // `(^|\})\s*([^{}@]+)\{` needs a `}` or the start before a selector, so in
    // `@media (x) { .g { } .h { } }` it matched `.h` but not `.g`: a floor-kit rule that broke the
    // scope inside a media query went unnoticed.
    const css = ".a { x: 1 } @media (max-width: 1px) { .g { x: 2 } .h { x: 3 } }";
    const old = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => (m[2] ?? "").trim());
    expect(old).toEqual([".a", ".h"]);
    expect(cssRules(css).map((rule) => rule.selector)).toEqual([".a", ".g", ".h"]);
  });
});
