import { describe, expect, it } from "vitest";

import componentStyles from "virtual:ui-component-styles";

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(componentStyles);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("the data tabs' look", () => {
  it("never underlines a tab, whatever element it is drawn on (a router link included)", () => {
    expect(rule(".mk-data-tabs__tab")).toContain("text-decoration: none");
  });

  it("marks the open tab by one bar and rings the focused one, on every tab bar", () => {
    expect(rule(".mk-data-tabs__tab--active")).toContain(
      "border-bottom-color: var(--mk-accent-operational)",
    );
    expect(rule(".mk-data-tabs__tab:focus-visible")).toContain(
      "outline: var(--focus-ring-w) solid var(--focus-ring)",
    );
  });
});
