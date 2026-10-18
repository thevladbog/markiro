import { describe, expect, it } from "vitest";

import tokenStyles from "virtual:ui-token-styles";

/**
 * Design kit 2026-10 §1.1: WCAG 2.x pairs computed from the values in tokens.css.
 * Text pairs 4.5:1, UI pairs 3:1. Values are parsed from the stylesheet itself so a
 * token edit that breaks a pair fails here.
 */
type ThemeName = "light" | "dark";

function blockOf(theme: ThemeName): Map<string, string> {
  const vars = new Map<string, string>();
  const blocks = [...tokenStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  // Light first; dark overrides on top of light, as the cascade does for `[data-theme=dark]`.
  const order: ThemeName[] = theme === "light" ? ["light"] : ["light", "dark"];
  for (const phase of order) {
    for (const [, selector, body] of blocks) {
      const sel = selector as string;
      const matches =
        phase === "light"
          ? sel.split(",").some((p) => [":root", '[data-theme="light"]'].includes(p.trim()))
          : sel.split(",").some((p) => p.trim() === '[data-theme="dark"]');
      if (!matches) continue;
      for (const [, name, value] of (body as string).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        vars.set(name as string, (value as string).replace(/\/\*.*?\*\//g, "").trim());
      }
    }
  }
  return vars;
}

function resolve(vars: Map<string, string>, name: string): string {
  let value = vars.get(`--${name}`);
  for (let depth = 0; value !== undefined && depth < 8; depth++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = vars.get(ref[1] as string);
  }
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`token --${name} does not resolve to a hex colour: ${String(value)}`);
  }
  return value;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT: ReadonlyArray<readonly [string, string]> = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["fg", "panel"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "panel"],
  ["muted2", "bg"],
  ["muted2", "surface"],
  ["muted2", "panel"],
  ["bg", "fg"],
  ["onerr", "err"],
  ["fg", "brand1"],
  ["ok", "okbg"],
  ["warn", "warnbg"],
  ["err", "errbg"],
  ["info", "infobg"],
  ["done", "donebg"],
  ["violet", "violetbg"],
  ["teal", "tealbg"],
  ["magenta", "magentabg"],
  ["steel", "steelbg"],
  ["ok", "surface"],
  ["err", "surface"],
];

const UI: ReadonlyArray<readonly [string, string]> = [
  ["focus", "bg"],
  ["focus", "surface"],
  ["accentui", "bg"],
  ["accentui", "surface"],
  ["linectl", "surface"],
  ["linectl", "panel"],
];

describe.each(["light", "dark"] as const)("kit contrast, %s theme", (theme) => {
  const vars = blockOf(theme);
  it.each(TEXT)("text %s on %s >= 4.5", (fg, bg) => {
    expect(ratio(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI)("UI %s on %s >= 3", (fg, bg) => {
    expect(ratio(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(3);
  });
  it("records the kit values of the new tokens", () => {
    const expected =
      theme === "light"
        ? {
            linectl: "#8a877f",
            accentui: "#0b9448",
            onerr: "#ffffff",
            brand1: "#f3d5db",
            brandline: "#e3b8c0",
          }
        : {
            linectl: "#6f6d76",
            accentui: "#3ddc7a",
            onerr: "#391a16",
            brand1: "#4e1d27",
            brandline: "#5a2a34",
          };
    for (const [name, value] of Object.entries(expected)) {
      expect(resolve(vars, name)).toBe(value);
    }
  });
  it("keeps the decorative pairs below UI contrast (documented exclusions)", () => {
    expect(ratio(resolve(vars, "line2"), resolve(vars, "surface"))).toBeLessThan(3);
    expect(ratio(resolve(vars, "dis"), resolve(vars, "surface"))).toBeLessThan(4.5);
  });
});

describe("kit contrast, brand-card pair (dark gradient end)", () => {
  it("fg on brand3 stays readable in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const vars = blockOf(theme);
      expect(ratio(resolve(vars, "fg"), resolve(vars, "brand3"))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
