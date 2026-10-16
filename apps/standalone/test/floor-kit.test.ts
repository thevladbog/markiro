import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

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

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

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

  it("scope every kit rule to the floor roots", () => {
    const css = stripComments(readFileSync(join(APP, "src/floor/floor-kit.css"), "utf8"));
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => (m[2] ?? "").trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      const parts = selector.split(/,(?![^()]*\))/).map((part) => part.trim());
      for (const part of parts) {
        expect(
          part.replace(/\s+/g, " ").startsWith(":where(.floor-frame, .station-screen)") ||
            part === ":root",
        ).toBe(true);
      }
    }
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
