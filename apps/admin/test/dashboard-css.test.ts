import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../src/pages/dashboard/dashboard.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s").exec(css);
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
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
});
