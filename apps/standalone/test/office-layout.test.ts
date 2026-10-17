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
    expect(rule(".office-shell__content")).toContain("flex-direction: column");
    expect(rule(".office-shell__content > *")).toContain("min-width: 0");
    expect(rule(".office-shell__main")).toContain("min-width: 0");
  });

  it("is as tall as the window, and the page scrolls inside the shell, not the window (pinned lists need a bounded page)", () => {
    const shell = rule(".office-shell");
    expect(shell).toContain("height: 100vh");
    expect(shell).toContain("overflow: hidden");
    expect(rule(".office-shell__main")).toContain("min-height: 0");
    const page = rule(".office-shell__content");
    expect(page).toContain("min-height: 0");
    expect(page).toContain("overflow: auto");
    expect(page).toContain("flex: 1 1 auto");
  });

  it("wraps the header, the page header and their buttons in a narrow window", () => {
    expect(rule(".office-header")).toContain("flex-wrap: wrap");
    expect(rule(".office-header__actions")).toContain("flex-wrap: wrap");
    expect(rule(".office-shell__content .mk-page-header")).toContain("flex-wrap: wrap");
    // The actions' box; the title box of a header with a description (`__titles`) is not one of them.
    expect(
      rule(".office-shell__content .mk-page-header > div:not(.mk-page-header__titles)"),
    ).toContain("flex-wrap: wrap");
  });

  it("keeps the menu in view and lets it scroll by itself in a low window", () => {
    const sidebar = rule(".office-menu");
    expect(sidebar).toContain("position: sticky");
    expect(sidebar).toContain("max-height: 100vh");
    expect(sidebar).toContain("overflow: hidden auto");
  });

  it("sizes the menu from the kit's tokens: 272 open, 76 collapsed", () => {
    expect(rule(".office-menu")).toContain("width: var(--sidebar-w)");
    expect(rule(".office-menu--collapsed")).toContain("width: var(--sidebar-w-collapsed)");
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

  it("sets a filter bar's result, on a page and in a drawer, at the right edge, level with the controls, like a list card's count", () => {
    const bar = rule(".office-shell__content .mk-filter-bar,\n.mk-side-panel .mk-filter-bar");
    expect(bar).toContain("display: grid");
    expect(bar).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(bar).toContain("align-items: start");
    const result = rule(
      ".office-shell__content .mk-filter-bar__result,\n.mk-side-panel .mk-filter-bar__result",
    );
    expect(result).toContain("margin-top: 22px");
    expect(result).toContain("min-height: 44px");
    expect(result).toContain("justify-content: flex-end");
    expect(result).toContain("text-align: right");
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

  it("draws every menu entry in one style at one height token, the settings block set apart by a rule alone", () => {
    // The first and the second half of the menu are one style (beta feedback); the entry's height is
    // the single token `--menu-item-h`, so the kit's 44 is a one-line change.
    expect(rule(".office-menu__link")).toContain("height: var(--menu-item-h)");
    expect(css.match(/var\(--menu-item-h\)/g)?.length).toBe(1);
    expect(css).not.toMatch(/\.office-menu__link[^{]*\{[^}]*\bheight: \d/);
    expect(rule(".office-menu__rule")).toContain("border-top: 1px solid var(--line)");
    expect(css).not.toMatch(/\.office-menu-settings/);
    // The active entry is the `fg` fill with inverse text, not a second look.
    const active = rule(".office-menu__link--active,\n.office-menu__link--active:hover");
    expect(active).toContain("background: var(--surface-inverse)");
    expect(active).toContain("color: var(--fg-on-inverse)");
  });

  it("collapses the menu to icons: the name stays for a screen reader, out of sight", () => {
    const label = rule(".office-menu--collapsed .office-menu__label");
    expect(label).toContain("position: absolute");
    expect(label).toContain("clip: rect(0 0 0 0)");
    expect(rule(".office-menu--collapsed .office-menu__wordmark")).toContain("display: none");
  });

  it("gives the menu entry a visible focus ring", () => {
    expect(rule(".office-menu__link:focus-visible")).toContain(
      "outline: var(--focus-ring-w) solid var(--focus-ring)",
    );
  });

  it("keeps the top bar's only shadow on its overlay (one layer)", () => {
    expect(rule(".user-menu__panel")).toContain("box-shadow: var(--shadow-overlay)");
    expect(
      css.slice(css.indexOf(".office-header {"), css.indexOf(".user-menu__panel {")),
    ).not.toContain("box-shadow");
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
