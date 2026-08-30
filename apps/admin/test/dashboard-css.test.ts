import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../src/pages/dashboard/dashboard.css"), "utf8");

function rule(selector: string): string {
  const declarations = [...css.matchAll(/([^{}]+)\{([^}]*)\}/gs)]
    .filter((match) =>
      match[1]
        ?.split(",")
        .map((candidate) => candidate.trim())
        .includes(selector),
    )
    .map((match) => match[2] ?? "");

  expect(declarations, `Missing CSS rule for ${selector}`).not.toHaveLength(0);
  return declarations.join("\n");
}

describe("dashboard chart layout contracts", () => {
  it("fits chart points inside the panel instead of creating a horizontal scroller", () => {
    expect(rule(".mk-dashboard-series__scroll")).toMatch(/overflow-x:\s*(?:clip|hidden)/);
    expect(rule(".mk-dashboard-bars")).toMatch(
      /grid-template-columns:\s*repeat\([^;]+minmax\(0,\s*1fr\)\)/,
    );
    expect(rule(".mk-dashboard-bars li")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(".mk-dashboard-bars li")).not.toMatch(/min-width:\s*42px/);
    expect(rule(".mk-dashboard-bars__label--hidden")).toMatch(/display:\s*none/);
  });

  it("keeps bars and dates in their own rows when dense value labels are omitted", () => {
    expect(rule(".mk-dashboard-bars__value")).toMatch(/grid-row:\s*1/);
    expect(rule(".mk-dashboard-bars__track")).toMatch(/grid-row:\s*2/);
    expect(rule(".mk-dashboard-bars__label")).toMatch(/grid-row:\s*3/);
  });

  it("keeps keyboard-focused tooltip targets visible", () => {
    expect(rule(".mk-dashboard-bars__track:focus-visible")).toMatch(
      /outline:\s*var\(--focus-ring-w\) solid var\(--focus-ring\)/,
    );
  });
});
