import { readFileSync } from "node:fs";
import { join } from "node:path";

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cssRules, type CssRule } from "./support/css-rules.js";
import { openShifts, SHARED, shiftsSession } from "./support/shifts.js";

/**
 * The layout contract of what plan 2b adds to the office (design kit §3, §7): one layer, tokens only,
 * state by icon and text, no new column in the lists that are already at their limit at 1280 px. The
 * look at 1280 x 690 and 1280 x 800, dark and light, is a browser check (the plan's last task lists it).
 */
const shell = cssRules(readFileSync(join(__dirname, "../src/app/shell.css"), "utf8"));
const overview = cssRules(
  readFileSync(join(__dirname, "../src/office/overview/overview.css"), "utf8"),
);

const DENSE = "@media (max-height: 799px), (max-width: 1365px)";

/** The declarations of the rules listing `selector`; `inside` is the at-rule they sit in, `null` for none. */
function declarations(rules: readonly CssRule[], selector: string, inside: string | null): string {
  const found = rules.filter(
    (rule) =>
      rule.selector.split(",").some((each) => each.trim() === selector) &&
      (inside === null ? rule.within.length === 0 : rule.within[0] === inside),
  );
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.map((rule) => rule.body).join("\n");
}

const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/;

describe("the multi-station office's own rules", () => {
  it("titles a shift's per-device figures quietly, in the kit's tokens", () => {
    const title = declarations(shell, ".shift-breakdown__title", null);
    expect(title).toContain("font: var(--text-body-sm)");
    expect(title).toContain("color: var(--fg-2)");
    expect(title).toContain("font-weight: 600");
  });

  it("draws a line card's stations as one icon-and-text row that wraps by words", () => {
    const stations = declarations(overview, ".ov-line__stations", null);
    expect(stations).toContain("display: inline-flex");
    expect(stations).toContain("align-items: center");
    expect(stations).toContain("color: var(--fg-2)");
    expect(stations).toContain("font: var(--text-meta)");
    expect(stations).toContain("white-space: normal");
  });

  it("adds no colour literal, gradient, shadow or animation", () => {
    for (const body of [
      declarations(shell, ".shift-breakdown__title", null),
      declarations(overview, ".ov-line__stations", null),
    ]) {
      expect(body).not.toMatch(LITERAL_COLOUR);
      expect(body).not.toMatch(/gradient\(|box-shadow|animation|transition/);
    }
  });

  it("keeps the line cards' dense spacing, so the extra row costs one line and a 4 px gap in a low window", () => {
    const dense = declarations(overview, ".ov-line", DENSE);
    expect(dense).toContain("gap: var(--sp-1)");
    expect(dense).toContain("padding: var(--sp-3) var(--sp-4)");
  });
});

describe("the column budget of the lists at 1280 px (plan 2b adds none)", () => {
  it("keeps the shift list at its seven columns: the participants are one quiet line in the status cell", async () => {
    await openShifts(shiftsSession([SHARED]));
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });
});
