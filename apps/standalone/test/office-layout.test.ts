import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The office has to hold at its smallest window (960 x 600) and at any larger
 * one: the page never grows wider than the window, a table scrolls inside its
 * own card, and nothing breaks letter by letter. Layout is CSS, which jsdom
 * does not compute, so these tests hold the rules that make it so; the pages'
 * look at 960, 1280 and 1920 px is checked in a browser.
 */
const css = readFileSync(join(__dirname, "../src/app/shell.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (!match) throw new Error(`no rule for ${selector} in shell.css`);
  return match[1] ?? "";
}

describe("the office layout rules", () => {
  it("makes the page one column as wide as the window leaves it, so a wide table cannot push the page sideways", () => {
    expect(rule(".office-shell__content")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(".office-shell__main")).toContain("min-width: 0");
  });

  it("wraps the header, the page header and their buttons in a narrow window", () => {
    expect(rule(".office-header")).toContain("flex-wrap: wrap");
    expect(rule(".office-header__actions")).toContain("flex-wrap: wrap");
    expect(rule(".office-shell__content .mk-page-header")).toContain("flex-wrap: wrap");
    expect(rule(".office-shell__content .mk-page-header > div")).toContain("flex-wrap: wrap");
  });

  it("keeps the menu in view and lets it scroll by itself in a low window", () => {
    const sidebar = rule(".office-shell > .mk-sidebar");
    expect(sidebar).toContain("position: sticky");
    expect(sidebar).toContain("max-height: 100vh");
    expect(sidebar).toContain("overflow-y: auto");
  });

  it("lays a card's parts one gap apart, so a note, a table and a pager never touch", () => {
    const body = rule(".office-shell__content .mk-card__body");
    expect(body).toContain("display: grid");
    expect(body).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(body).toContain("gap: var(--sp-4)");
  });

  it("keeps a filter bar's controls level and wrapping, with a minimum width for each", () => {
    expect(rule(".office-shell__content .mk-filter-bar__controls")).toContain(
      "align-items: flex-start",
    );
    expect(rule(".office-shell__content .mk-filter-bar__controls > .mk-field")).toContain(
      "min-width: 168px",
    );
  });

  it("starts a table row's buttons at their heading, and lays many of them out by the table's room", () => {
    expect(rule(".office-shell__content .mk-table .mk-row-actions")).toContain(
      "justify-content: flex-start",
    );
    expect(css).toContain("@container office-table (min-width:");
    expect(rule(".office-shell__content .mk-table__scroll")).toContain(
      "container: office-table / inline-size",
    );
  });

  it("gives a warning in a table cell its own wrapping sentence, not a chip", () => {
    const warn = rule(".shift-cell__warn");
    expect(warn).toContain("white-space: normal");
    expect(warn).toContain("overflow-wrap: break-word");
  });

  it("keeps the station's .shift-card box to the station", () => {
    // The office's page stack once shared this name with the station's padded card.
    expect(css).not.toMatch(/\.office-stack\s*\{[^}]*padding/);
    expect(css).toMatch(/\.office-stack\s*\{[^}]*display: grid/);
  });
});
