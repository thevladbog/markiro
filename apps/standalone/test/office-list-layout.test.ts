import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cssRules } from "./support/css-rules.js";

/**
 * The pinned list layout is CSS, which jsdom does not compute: these tests hold the rules that
 * make a list one hairline card whose table scrolls its rows under a pinned heading, with the
 * pagination bar pinned under it. The look at 1440 x 900 and 1280 x 800, dark and light, is
 * checked in a browser.
 */
const source = readFileSync(join(__dirname, "../src/office/list/list.css"), "utf8");
const rules = cssRules(source);
// The shared kit's stylesheet: since the 2026 kit scope the destructive ink and the field's error rule
// are tokens defined there (under `.mk-kit-2026`), no longer `!important` overrides in this app.
const kitRules = cssRules(
  readFileSync(join(__dirname, "../../../packages/ui/src/components.css"), "utf8"),
);

/** The declarations of the kit's rules whose selector list contains `selector`. */
function kitDeclarations(selector: string): string {
  const found = kitRules.filter((rule) =>
    rule.selector.split(",").some((each) => each.trim() === selector),
  );
  if (found.length === 0) throw new Error(`no rule for ${selector} in the kit's components.css`);
  return found.map((rule) => rule.body).join("\n");
}

/** The declarations of every rule whose selector list contains `selector`, joined. */
function declarations(selector: string): string {
  const found = rules.filter((rule) =>
    rule.selector.split(",").some((each) => each.trim() === selector),
  );
  if (found.length === 0) throw new Error(`no rule for ${selector} in list.css`);
  return found.map((rule) => rule.body).join("\n");
}

describe("the list card (pinned layout contract)", () => {
  it("is one L1 layer: a surface with a hairline and a card radius, and no shadow", () => {
    const card = declarations(".office-list-card");
    expect(card).toContain("border: 1px solid var(--line)");
    expect(card).toContain("border-radius: var(--r-card)");
    expect(card).toContain("background: var(--surface-card)");
    expect(card).not.toContain("box-shadow");
  });

  it("shrinks to the room the window leaves, but never below a usable table, and bounds its children", () => {
    const sized = declarations(".office-shell__content > .office-list-card");
    expect(sized).toContain("flex: 0 1 auto");
    expect(sized).toContain("min-height: 320px");
    const card = declarations(".office-list-card");
    expect(card).toContain("display: flex");
    expect(card).toContain("flex-direction: column");
    expect(card).toContain("min-height: 0");
    expect(card).toContain("overflow: hidden");
  });

  it("lets the table take what is left and keeps the filters and the pagination bar out of its scroll", () => {
    expect(declarations(".office-list-card .office-paged")).toContain("flex: 1 1 auto");
    expect(declarations(".office-list-card .office-paged")).toContain("min-height: 0");
    expect(declarations(".office-list-card .office-paged > .mk-table")).toContain("min-height: 0");
    expect(declarations(".office-list-card .office-paged > :not(.mk-table)")).toContain(
      "flex: none",
    );
    expect(declarations(".office-list-filters")).toContain("flex: none");
  });

  it("gives the card the frame: the table inside has none of its own", () => {
    const card = declarations(".office-list-card");
    expect(card).toContain("--table-border: 0");
    expect(card).toContain("--table-radius: 0");
    expect(card).toContain("--table-bg: transparent");
  });

  it("sets the office's table rows at 56 px, with the heading tokens read by the shared Table", () => {
    const shell = declarations(".office-shell");
    expect(shell).toContain("--table-row-h: 56px");
    expect(shell).toContain("--table-th-py: 13px");
  });

  it("pins a hairline over the pagination bar", () => {
    const bar = declarations(".office-list-card .office-pagination");
    expect(bar).toContain("border-top: 1px solid var(--line)");
  });
});

describe("the filters", () => {
  it("keeps a period on one line, each date wide enough for «10 октября 2026»", () => {
    expect(declarations(".office-range__row")).toContain("display: flex");
    expect(declarations(".office-range__row > .mk-date-picker")).toContain("min-width: 212px");
  });
});

describe("the row actions, the menu and the tooltip", () => {
  it("keeps the actions of a row on one line", () => {
    expect(declarations(".office-row-actions")).toContain("flex-wrap: nowrap");
  });

  it("draws the menu entry 40 px high and the destructive one in the error tone", () => {
    expect(declarations(".office-row-menu__item")).toContain("min-height: 40px");
    expect(declarations('.office-row-menu__item[data-destructive="true"]')).toContain(
      "color: var(--err-fg)",
    );
  });

  it("gives the menu and the tooltip the only shadows, and keeps them above a drawer", () => {
    expect(declarations(".office-row-menu")).toContain("box-shadow: var(--shadow-overlay)");
    expect(declarations(".office-tooltip")).toContain("box-shadow: var(--shadow-overlay)");
    expect(declarations(".office-tooltip")).toContain("pointer-events: none");
    expect(declarations(".office-tooltip")).toContain("z-index: 450");
  });

  it("gives every icon control, menu entry and segment a visible focus ring", () => {
    const ring = declarations(".office-row-menu__item:focus-visible");
    expect(ring).toContain("outline: var(--focus-ring-w) solid var(--focus-ring)");
    expect(declarations(".office-segmented__item:focus-visible")).toContain("var(--focus-ring)");
  });
});

describe("the segmented control", () => {
  it("is a panel track with 40 px segments, the selected one filled with the inverse colour", () => {
    expect(declarations(".office-segmented")).toContain("background: var(--surface-panel)");
    expect(declarations(".office-segmented__item")).toContain("min-height: 40px");
    const selected = declarations(".office-segmented__item.office-segmented__item--selected");
    expect(selected).toContain("background: var(--surface-inverse)");
    expect(selected).toContain("font-weight: 600");
  });
});

describe("the destructive button and the field error", () => {
  it("takes the label colour that pairs with the solid error fill, not a literal white", () => {
    expect(kitDeclarations(".mk-kit-2026")).toContain(
      "--mk-btn-destructive-fg: var(--fg-on-err-solid)",
    );
  });

  it("draws a wrong field with a 2 px border and opens its message with the word from i18n", () => {
    expect(kitDeclarations(".mk-kit-2026 .mk-input--error")).toContain(
      "--mk-input-border: 2px solid var(--err-solid)",
    );
    const before = declarations('.mk-field > span[id$="-error"]::before');
    expect(before).toContain("var(--mk-error-prefix");
  });

  it("marks unsaved changes in the drawer's footer in the warning tone", () => {
    expect(declarations(".entity-drawer__dirty")).toContain("color: var(--warn-fg)");
  });
});

describe("the search form's filter rows", () => {
  it("lets a search field grow and keeps the buttons level with its input, not with its hint", () => {
    expect(declarations(".office-filter-row > .mk-field:has(> .mk-input)")).toContain(
      "flex: 1 1 320px",
    );
    const top = declarations(".office-filter-row__end--top");
    expect(top).toContain("align-self: flex-start");
    expect(top).toContain("margin-top: 22px");
  });
});

describe("motion", () => {
  it("spins only for a visitor who has not asked for less motion", () => {
    const animated = rules.find((rule) => rule.body.includes("animation: office-spin"));
    expect(animated?.within).toEqual(["@media (prefers-reduced-motion: no-preference)"]);
  });

  it("draws the skeleton static: bars only, no shimmer", () => {
    expect(source).not.toMatch(/shimmer|@keyframes\s+(?!office-spin)/);
  });
});
