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
    // The same rhythm on a page and in a drawer (`.mk-side-panel`): a card there is not a page's.
    const body = rule(":is(.office-shell__content, .mk-side-panel) .mk-card__body");
    expect(body).toContain("display: grid");
    expect(body).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(body).toContain("gap: var(--sp-4)");
  });

  it("lays a filter bar's controls in one grid of equal tracks, their tops level, on a page and in a drawer alike", () => {
    const bar = rule(":is(.office-shell__content, .mk-side-panel) .mk-filter-bar__controls");
    expect(bar).toContain("display: grid");
    expect(bar).toContain("grid-template-columns: repeat(auto-fill, minmax(212px, 1fr))");
    expect(bar).toContain("align-items: start");
    // A field may shrink to its track; a button starts level with the inputs, not with a hint.
    expect(
      rule(":is(.office-shell__content, .mk-side-panel) .mk-filter-bar__controls > .mk-field"),
    ).toContain("min-width: 0");
    const button = rule(
      ":is(.office-shell__content, .mk-side-panel) .mk-filter-bar__controls > .mk-btn",
    );
    expect(button).toContain("margin-top: 22px");
    expect(button).toContain("justify-self: start");
  });

  it("makes every table a scroll region with an edge shade, a thin scrollbar and a focus ring", () => {
    const scroll = rule(".office-shell .mk-table__scroll,\n.mk-side-panel .mk-table__scroll");
    expect(scroll).toContain("scrollbar-width: thin");
    // The shade is drawn only where more lies beyond: `local` covers hide it at the ends.
    expect(scroll).toContain("local");
    expect(scroll).toContain("scroll");
    expect(
      rule(
        ".office-shell .mk-table__scroll:focus-visible,\n.mk-side-panel .mk-table__scroll:focus-visible",
      ),
    ).toContain("outline: var(--focus-ring-w) solid var(--focus-ring)");
  });

  it("keeps a table and its pagination one block, the pagination one step under the table", () => {
    expect(rule(".office-paged")).toContain("gap: var(--sp-3)");
    expect(rule(".office-pagination")).toContain("flex-wrap: wrap");
  });

  it("draws every menu entry in one style: the settings block has a rule above it and nothing more", () => {
    // The first and the second half of the menu are the same size, weight and colour (beta feedback).
    expect(css).not.toMatch(/\.office-menu-settings\s+\.mk-sidebar__link/);
    expect(css).not.toMatch(/\.office-menu-settings\s+\.mk-sidebar__section/);
    expect(rule(".office-menu-settings")).toContain("border-top: 1px solid var(--line)");
    expect(rule(".office-shell > .mk-sidebar .mk-sidebar__link")).toContain("padding-block: 6px");
  });

  it("starts a table row's buttons at their heading and keeps them on one line", () => {
    const actions = rule(".office-shell__content .mk-table .mk-row-actions");
    expect(actions).toContain("justify-content: flex-start");
    expect(actions).toContain("flex-wrap: nowrap");
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

  it("centres a banner's icon, its text and its button on one axis, whatever the tone or the line count", () => {
    const alert = rule(".office-banner .mk-alert");
    expect(alert).toContain("align-items: center");
    // The icon and the text share one 20px line box, so a single line has the same centre.
    expect(rule(".office-banner .mk-alert__icon")).toContain("align-self: center");
    expect(rule(".office-banner .mk-alert__action")).toContain("align-self: center");
    expect(rule(".office-banner .mk-alert__action")).toContain("display: flex");
  });

  it("keeps a date filter's value on one line, with room for the calendar icon and the clear button", () => {
    expect(rule(".mk-date-picker__trigger > span:first-child")).toContain("white-space: nowrap");
    expect(
      rule(
        ":is(.office-shell__content, .mk-side-panel) .mk-filter-bar__controls > .mk-date-picker",
      ),
    ).toContain("min-width: 212px");
  });
});
