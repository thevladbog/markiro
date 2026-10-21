import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cssRules, selectorParts, type CssRule } from "./support/css-rules.js";

/**
 * Station visual audit, 2026-10: contracts for what the Chromium pass of the whole floor found
 * wrong (docs/design-briefs/station-visual-signoff-2026-10.md). They read the stylesheets, as
 * floor-kit-work.test.ts does, and pin each fix so a later edit cannot bring the defect back.
 */
const APP = process.cwd();
const rulesOf = (path: string): CssRule[] => cssRules(readFileSync(join(APP, path), "utf8"));
const textOf = (path: string) => readFileSync(join(APP, path), "utf8");

/**
 * The declarations that reach `selector` in the stylesheet, from every rule (outside any at-rule
 * unless `within` says) whose selector list holds it, later rules over earlier ones.
 */
function rule(rules: CssRule[], selector: string, within = ""): Record<string, string> {
  const found = rules.filter(
    (candidate) =>
      selectorParts(candidate.selector).includes(selector) &&
      candidate.within.join(" > ") === within,
  );
  if (found.length === 0) throw new Error(`no rule for ${selector} ${within}`);
  return Object.fromEntries(
    found.flatMap((one) =>
      one.body
        .split(";")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
        }),
    ),
  );
}

describe("the status bar", () => {
  const rules = rulesOf("src/floor/floor-status-bar.css");

  it("draws the link chip's target itself: at least 64 px wide with a transparent hairline, not the browser's outset", () => {
    const button = rule(rules, ".floor-link__button.mk-btn");
    expect(button["min-width"]).toBe("64px");
    // The kit's secondary border colour is `!important`; the chip's target beats it by specificity.
    const frame = rule(
      rules,
      ":where(.floor-frame, .station-screen) .floor-link__button.mk-btn.mk-btn--floor",
    );
    expect(frame["border"]).toBe("1px solid transparent !important");
  });

  it("anchors the link popover at the chip's left edge, within the window's width", () => {
    const popover = rule(rules, ".floor-link__popover");
    expect(popover["left"]).toBe("0");
    expect(popover["right"]).toBeUndefined();
    expect(popover["max-width"]).toContain("100vw");
  });

  it("is one row of 64 px targets and a hairline (73 px), whose rail never shrinks", () => {
    const bar = rule(rules, ".station-status-bar");
    expect(bar["grid-template-rows"]).toBe("64px auto");
    expect(bar["padding"]).toBe("4px var(--sp-4)");
    expect(rule(rules, ".floor-bar__rail")["flex"]).toBe("none");
    const chip = rule(rules, ".floor-chip");
    expect(chip["height"]).toBe("40px");
    expect(chip["flex"]).toBe("0 0 auto");
    expect(chip["white-space"]).toBe("nowrap");
  });

  it("paints the tones with the kit's status tokens, words and glyph with them (no bare dot, no pulse)", () => {
    for (const tone of ["ok", "warn", "error"]) {
      const painted = rule(rules, `.floor-chip[data-tone="${tone}"]`);
      expect(painted["background"], tone).toMatch(/^var\(--(ok|warn|err)-bg\)$/);
      expect(painted["color"], tone).toMatch(/^var\(--(ok|warn|err)-fg\)$/);
    }
    const css = textOf("src/floor/floor-status-bar.css");
    expect(css).not.toContain("station-status-pill__dot");
    expect(css).not.toContain("@keyframes");
    expect(css).not.toContain("animation");
  });

  it("collapses by script, not by container query: the decision is `useHeaderCollapse`'s", () => {
    expect(rules.some((r) => r.within.some((w) => w.startsWith("@container")))).toBe(false);
  });
});

describe("the rail's window-mode error", () => {
  it("is as wide as its words, not as the 64 px button it hangs from", () => {
    const error = rule(rulesOf("src/floor/operator-switch.css"), ".floor-window-control__error");
    expect(error["width"]).toBe("max-content");
    expect(error["max-width"]).toContain("100vw");
    expect(error["border"]).toBe("2px solid var(--err)");
  });
});

describe("the kit's field focus", () => {
  it("rings the field when its control has no outline of its own", () => {
    const focus = rule(
      rulesOf("src/floor/floor-kit.css"),
      ":where(.floor-frame, .station-screen) .mk-input:focus-within",
    );
    expect(focus["outline"]).toBe("3px solid var(--focus)");
    expect(focus["outline-offset"]).toBe("2px");
  });
});

describe("the calendar of the new shift", () => {
  const hub = rulesOf("src/floor/shifts/shift-hub.css");

  it("has 64 px days and arrows: it is a popover outside the floor frame, reached through the floor's presence", () => {
    const day = rule(hub, "body:has(.floor-frame) .mk-date-picker__navigation");
    expect(day["width"]).toBe("64px");
    const days = rule(hub, "body:has(.floor-frame) .mk-date-picker__day");
    expect(days["min-height"]).toBe("64px");
    expect(days["min-width"]).toBe("64px");
    // Type variables of the frame are not defined out there: literals only.
    expect(days["font"]).not.toContain("var(--floor-");
    const popover = rule(hub, "body:has(.floor-frame) .mk-date-picker__popover");
    expect(popover["width"]).toContain("7 * 64px");
  });
});

describe("the hub's shift cards", () => {
  const hub = rulesOf("src/floor/shifts/shift-hub.css");

  it("fill the zone: the card is the grid cell's full height, its photo the whole left half", () => {
    const grid = rule(hub, ".shift-hub .shift-selection__grid");
    expect(grid["height"]).toBe("100%");
    expect(grid["grid-auto-rows"]).toBe("minmax(0, 1fr)");
    // One shift: one wide column and the 520 px photo; two and more: two columns and 260 px.
    expect(grid["--hub-photo"]).toBe("260px");
    const single = rule(hub, '.shift-hub .shift-selection__grid[data-columns="1"]');
    expect(single["grid-template-columns"]).toBe("minmax(0, 1fr)");
    expect(single["--hub-photo"]).toBe("520px");
    expect(rule(hub, ".shift-hub .shift-card")["height"]).toBe("100%");
    const body = rule(hub, ".shift-hub .shift-card__body");
    expect(body["height"]).toBe("100%");
    // The photo's width is capped by a share of the card: a 1024 px window keeps room for the facts.
    expect(body["grid-template-columns"]).toBe("min(var(--hub-photo, 260px), 43%) minmax(0, 1fr)");
    const photo = rule(hub, ".shift-hub .shift-card__photo");
    expect(photo["border-radius"]).toBe("0");
    expect(photo["padding"]).toBe("var(--sp-4)");
  });

  it("fit the photo whole inside the panel and sit the tags on its lower edge", () => {
    const image = rule(hub, ".shift-hub .shift-card__photo .product-photo");
    expect(image["object-fit"]).toBe("contain");
    expect(rule(hub, ".shift-hub .shift-card__tags")["position"]).toBe("absolute");
  });

  it("set the actions at 84 px with bold words, and the footer's three buttons the same", () => {
    expect(textOf("src/floor/shifts/ShiftCard.tsx")).toContain("floor-primary");
    expect(rule(hub, ".shift-hub .station-floor-footer .mk-btn")["height"]).toBe(
      "var(--control-floor-primary) !important",
    );
    expect(rule(hub, ".shift-hub .shift-card__action.mk-btn")["font-weight"]).toBe("700");
  });

  it("set their facts at the floor's 16 px and up, and their tags at the floor's size", () => {
    for (const selector of [
      ".shift-hub .shift-card__number",
      ".shift-hub .shift-card__fact dd",
      ".shift-hub .shift-card__progress-count",
    ]) {
      const css = rule(hub, selector);
      expect(css["font"], selector).toMatch(/^\d+ (2\d|3\d)px\//);
    }
    const card = textOf("src/floor/shifts/ShiftCard.tsx");
    expect(card).not.toContain('size="office"');
    expect(card.match(/size="floor"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("lift every tag a shared component writes at the office's size (the host's line, a status chip)", () => {
    const tag = rule(
      rulesOf("src/floor/floor-kit.css"),
      ":where(.floor-frame, .station-screen) .mk-tag--office",
    );
    expect(tag["height"]).toBe("34px");
    expect(tag["font-size"]).toBe("16px");
  });

  it("keep the 64 px targets of the title row: the pager and the reprint", () => {
    expect(rule(hub, ".shift-hub .shift-pager .mk-btn")["min-height"]).toBe("64px");
    const header = rule(hub, ".shift-hub .shift-selection__header-action .mk-btn");
    expect(header["min-height"]).toBe("64px");
  });
});

describe("the exception flow against the kit", () => {
  const flow = rulesOf("src/floor/exceptions/exception-flow.css");

  it("lets an action card wear the kit's border and radius; only the danger card paints its own", () => {
    const card = rule(flow, ".exception-action.mk-btn");
    expect(card["border-color"]).toBeUndefined();
    expect(card["border-radius"]).toBe("var(--floor-r-card) !important");
    expect(rule(flow, '.exception-action[data-danger="true"]:not(:disabled)')["border-color"]).toBe(
      "var(--err-border) !important",
    );
  });

  it("marks the typed-tail field as the kit's active field: a 2 px `fg` border, no blue and no red", () => {
    const field = rule(flow, ".sscc-search__field");
    expect(field["border"]).toBe("2px solid var(--fg)");
    expect(field["border-radius"]).toBe("var(--floor-r-ctl)");
    expect(
      flow.some(
        (r) => r.selector.includes('[data-action$="disassemble"]') && /border/.test(r.body),
      ),
    ).toBe(false);
    expect(textOf("src/floor/exceptions/exception-flow.css")).not.toContain("--focus-ring");
  });
});

describe("the shift close card", () => {
  it("is flat and wears the kit's card radius", () => {
    const card = rule(rulesOf("src/floor/close/shift-close.css"), ".shift-close");
    expect(card["box-shadow"]).toBe("none");
    expect(card["border-radius"]).toBe("var(--floor-r-card)");
  });
});

describe("the sign-in screen", () => {
  const signIn = rulesOf("src/floor/sign-in/operator-sign-in.css");
  const controls = rulesOf("src/floor/kit/floor-controls.css");
  const frame = ":where(.floor-frame, .station-screen)";

  it("holds the message slot out of the layout until it has words, and keeps its room only in a tall window", () => {
    expect(rule(signIn, ".operator-login")["grid-template-rows"]).toBe(
      "auto auto minmax(0, 1fr) auto",
    );
    const message = rule(signIn, ".operator-login__message");
    expect(message["overflow"]).toBeUndefined();
    // Empty, it keeps its row (the rows below must not slip up into it) and gives its gap back.
    expect(rule(signIn, ".operator-login__message:empty")["margin-block-start"]).toBe(
      "calc(-1 * var(--login-gap))",
    );
    expect(
      rule(signIn, ".operator-login__message", "@media (min-height: 900px)")["min-height"],
    ).toBe("96px");
  });

  it("sets the badge help text at the floor's body size", () => {
    expect(rule(signIn, ".operator-login__badge-copy p")["font"]).toBe("var(--floor-body)");
  });

  it("is on one layer: the page's own colour, no card or backing behind the halves", () => {
    expect(rule(signIn, ".operator-login")["background"]).toBe("var(--bg)");
    const css = textOf("src/floor/sign-in/operator-sign-in.css");
    expect(css).not.toContain("badge-panel");
    expect(css).not.toContain("--surface-card");
    expect(css).not.toContain("--surface-panel");
  });

  it("sets 72 px keypad keys and 64 px-or-more Cyrillic keys, edged in `linectl`", () => {
    const key = rule(controls, `${frame} .floor-keypad__key`);
    expect(key["min-height"]).toBe("72px");
    expect(key["border"]).toBe("1px solid var(--linectl)");
    const letter = rule(controls, `${frame} .floor-cyrillic__key`);
    expect(letter["border"]).toBe("1px solid var(--linectl)");
    expect(letter["min-height"]).toBe("64px");
    expect(
      Number.parseInt(letter["height"]?.match(/(\d+)px\)$/)?.[1] ?? "0", 10),
    ).toBeGreaterThanOrEqual(64);
    // The short-window step shrinks the keys, never below 64.
    const short = rule(
      signIn,
      ".operator-login__body--search .floor-cyrillic",
      "@media (max-height: 860px)",
    );
    expect(Number.parseInt(short["--floor-cyrillic-key"] ?? "0", 10)).toBeGreaterThanOrEqual(64);
    expect(
      rule(signIn, ".operator-name-search__row.mk-btn", "@media (max-height: 860px)")["height"],
    ).toBe("64px !important");
  });

  it("gives the fields the kit's 84 px, an always-present line, and a still caret", () => {
    expect(rule(controls, `${frame} .floor-entry__box`)["height"]).toBe("84px");
    expect(rule(controls, `${frame} .floor-entry__hint`)["min-height"]).toBe("26px");
    const css = textOf("src/floor/kit/floor-controls.css");
    expect(css).not.toMatch(/animation:[^;]*floor-entry/);
    expect(css).not.toContain("@keyframes");
  });

  it("moves only once and only by opacity and transform: no looping animation, none on an error", () => {
    const css = textOf("src/floor/sign-in/operator-sign-in.css");
    expect(css).not.toMatch(/infinite/);
    expect(rule(signIn, ".operator-login")["animation"]).toBe("sign-in-fade 140ms linear both");
    expect(rule(signIn, ".operator-login__sweep")["animation"]).toBe(
      "sign-in-sweep 600ms var(--ease) 140ms 1 both",
    );
    for (const animation of ["shake", "flash", "pulse", "blink"])
      expect(css).not.toContain(animation);
    // Reduced motion keeps the end states: the screen and the line sit still.
    expect(
      rule(signIn, ".operator-login__sweep", "@media (prefers-reduced-motion: reduce)")[
        "animation"
      ],
    ).toBe("none");
    expect(
      rule(signIn, ".operator-login", "@media (prefers-reduced-motion: reduce)")["animation"],
    ).toBe("none");
  });

  it("keeps every action of the row at the kit's 84 px", () => {
    const action = rule(signIn, ".operator-login__actions .mk-btn--floor");
    expect(action["height"]).toBe("var(--control-floor-primary) !important");
  });
});

describe("the workstation setup's tabs", () => {
  const setup = rulesOf("src/floor/setup/workstation-setup.css");

  it("are the kit's segmented control: a track of tabs as wide as their words, the chosen one an `fg` fill", () => {
    const list = rule(setup, ".setup-tabs__list.mk-data-tabs");
    expect(list["display"]).toBe("flex");
    expect(list["width"]).toBe("fit-content");
    const active = rule(setup, ".setup-tabs__list .mk-data-tabs__tab--active");
    expect(active["background"]).toBe("var(--fg)");
    expect(active["color"]).toBe("var(--bg)");
    // The kit's selected segment: fill, check and weight 600 (not 700).
    expect(active["font-weight"]).toBe("600");
    const check = rule(setup, ".setup-tabs__list .mk-data-tabs__tab--active::before");
    expect(check["content"]).toBe('""');
    expect(check["background"]).toBe("currentColor");
  });

  it("does not add a second, blue outline to the chosen scanner-check kind", () => {
    expect(setup.some((r) => r.selector.includes(".self-test__kind[data-checked"))).toBe(false);
  });
});

describe("the work screen", () => {
  const work = rulesOf("src/floor/work/work-screen.css");

  it("wraps the band's chips instead of squeezing the counterparty's to «для: ...»", () => {
    expect(rule(work, ".work-shift-band__chips")["flex-wrap"]).toBe("wrap");
  });

  it("sets a smaller hero on a short window so the code under the verdict is not cut", () => {
    const word = rule(work, ".work-scan-hero__word", "@media (max-height: 900px)");
    expect(word["font-size"]).toBe("44px");
    expect(rule(work, ".work-scan-hero__code", "@media (max-height: 900px)")["font-size"]).toBe(
      "22px",
    );
  });
});

describe("the redesigned workstation setup (design kit 2026-10)", () => {
  const setup = rulesOf("src/floor/setup/workstation-setup.css");
  const controls = rulesOf("src/floor/kit/floor-controls.css");
  const keypadKey = ":where(.floor-frame, .station-screen) .floor-ipkeypad__key";

  it("ends in an 84 px footer, and the footer's primary and back buttons are as tall", () => {
    expect(rule(setup, "section.workstation-setup")["grid-template-rows"]).toBe(
      "auto minmax(0, 1fr) auto 84px",
    );
    expect(rule(setup, ".workstation-setup__footer")["height"]).toBe("84px");
    expect(rule(setup, ".workstation-setup__footer .setup-footer__back")["height"]).toBe(
      "84px !important",
    );
  });

  it("gives the keypad 64 px keys with a `linectl` edge, in a 380 px panel", () => {
    const key = rule(controls, keypadKey);
    expect(key["height"]).toBe("64px");
    expect(key["border"]).toBe("1px solid var(--linectl)");
    expect(key["font"]).toContain("var(--font-mono)");
    expect(rule(controls, ":where(.floor-frame, .station-screen) .floor-ipkeypad")["width"]).toBe(
      "380px",
    );
    expect(rule(setup, ".setup-editor--keypad")["grid-template-columns"]).toBe(
      "minmax(0, 1fr) 380px",
    );
  });

  it("holds every interactive row element at 64 px or more", () => {
    expect(rule(setup, ".setup-tabs__list .mk-data-tabs__tab")["min-height"]).toBe("64px");
    expect(rule(setup, ".setup-printer-row__actions > .setup-printer-row__remove")["width"]).toBe(
      "64px",
    );
    expect(rule(setup, ".setup-printer-row")["min-height"]).toBe("84px");
    expect(rule(setup, ".setup-scanner-row")["min-height"]).toBe("84px");
    expect(rule(setup, ".setup-station__row")["min-height"]).toBe("64px");
    expect(rule(setup, ".setup-volume__step")["height"]).toBe("84px !important");
  });

  it("rings the keypad's field 2 px `fg` and fills the volume's divisions with `fg`", () => {
    const active = rule(
      setup,
      '.setup-keyfield[data-active="true"] .mk-input:not(.mk-input--error)',
    );
    expect(active["border-color"]).toBe("var(--fg) !important");
    expect(rule(setup, '.setup-volume__division[data-filled="true"]')["background"]).toBe(
      "var(--fg)",
    );
    expect(rule(setup, ".setup-volume__division")["background"]).toBe("var(--panel)");
  });

  it("keeps one layer: a switch card inside a list or a card has no border of its own", () => {
    expect(rule(setup, ".setup-printer-verification .floor-switch-card")["border"]).toBe("0");
    expect(rule(setup, ".setup-sound > .floor-switch-card")["border-radius"]).toBe("0");
  });
});

describe("the warehouse reprint (design: station reprint, 2026-10)", () => {
  const reprint = rulesOf("src/floor/warehouse/reprint.css");
  const reprintText = textOf("src/floor/warehouse/reprint.css");
  const frame = rulesOf("src/floor/warehouse/warehouse.css");

  it("holds the screen to the window: a fixed grid of heading, body and the answers, never the page", () => {
    const screen = rule(frame, "section.warehouse-reprint");
    expect(screen["height"]).toBe("100%");
    expect(screen["overflow"]).toBe("hidden");
    expect(screen["grid-template-rows"]).toBe("auto minmax(0, 1fr) auto");
    expect(rule(reprint, "section.warehouse-reprint")["position"]).toBe("relative");
  });

  it("makes the answers the kit's 84 px, 72 px on a short window", () => {
    for (const selector of [
      ".rp-footer .rp-footer__action.mk-btn",
      ".rp-dialog__actions .mk-btn",
    ]) {
      const answers = rule(reprint, selector);
      expect(answers["height"], selector).toBe("var(--control-floor-primary) !important");
      expect(answers["border-radius"], selector).toBe("var(--floor-r-primary) !important");
      expect(rule(reprint, selector, "@media (max-height: 700px)")["height"], selector).toBe(
        "72px !important",
      );
    }
    expect(
      rule(reprint, ".rp-footer .floor-primary.mk-btn", "@media (max-height: 700px)")["height"],
    ).toBe("72px !important");
  });

  it("draws the reasons as 84 px rows from the left, the chosen one a `fg` fill", () => {
    const row = rule(reprint, ".rp-reason.mk-btn");
    expect(row["justify-content"]).toBe("flex-start !important");
    expect(row["height"]).toBe("var(--control-floor-primary) !important");
    const chosen = rule(reprint, '.rp-reason[aria-checked="true"]');
    expect(chosen["background"]).toBe("var(--fg) !important");
    expect(chosen["color"]).toBe("var(--bg) !important");
    expect(rule(reprint, ".rp-reason.mk-btn", "@media (max-height: 700px)")["height"]).toBe(
      "64px !important",
    );
  });

  it("makes the journal's row a transparent 84 px ghost button between hairlines (one layer)", () => {
    const row = rule(reprint, ".rp-journal__row.mk-btn");
    expect(row["min-height"]).toBe("84px !important");
    expect(row["background"]).toBe("transparent !important");
    expect(rule(reprint, ".rp-journal__list li")["border-bottom"]).toBe("1px solid var(--line)");
    // The list scrolls inside its column (`.rp-scroll`), as every zone of the reprint does.
    expect(rule(reprint, ".rp-scroll")["overflow-y"]).toBe("auto");
    expect(rule(reprint, ".rp-journal__list")["overflow-y"]).toBeUndefined();
  });

  it("makes a zone's scroll visible to a glove: a 16 px track, a thumb, a fade, no hidden platform bar", () => {
    const own = rule(reprint, ".warehouse-reprint .rp-scroll");
    // The global style hides the bar until a hover; here the standard properties go back to auto.
    expect(own["scrollbar-width"]).toBe("auto");
    expect(own["scrollbar-color"]).toBe("auto");
    const width = rule(reprint, ".warehouse-reprint .rp-scroll::-webkit-scrollbar")["width"];
    expect(Number.parseInt(width ?? "0", 10)).toBeGreaterThanOrEqual(14);
    expect(
      rule(reprint, ".warehouse-reprint .rp-scroll::-webkit-scrollbar-thumb")["background-color"],
    ).toBe("var(--muted)");
    // The fade at the foot shows only while more stands below (`data-more`).
    expect(rule(reprint, ".rp-col::after")["opacity"]).toBe("0");
    expect(rule(reprint, '.rp-col[data-more="true"]::after')["opacity"]).toBe("1");
    expect(rule(reprint, ".rp-col::after")["pointer-events"]).toBe("none");
  });

  it("says a state in a 40 px tag with a glyph and a word, tone by tone on the kit's pairs", () => {
    expect(rule(reprint, ".rp-tag")["height"]).toBe("40px");
    for (const [tone, bg, fg] of [
      ["ok", "ok-bg", "ok-fg"],
      ["warn", "warn-bg", "warn-fg"],
      ["error", "err-bg", "err-fg"],
      ["info", "info-bg", "info-fg"],
    ] as const) {
      const painted = rule(reprint, `.rp-tag[data-tone="${tone}"]`);
      expect(painted["background"], tone).toBe(`var(--${bg})`);
      expect(painted["color"], tone).toBe(`var(--${fg})`);
    }
  });

  it("lifts the dialog alone with the overlay's shadow, and moves nothing but the press", () => {
    expect(rule(reprint, ".rp-dialog")["box-shadow"]).toBe("var(--shadow-overlay)");
    expect(reprintText.match(/box-shadow/g)).toHaveLength(1);
    expect(reprintText).not.toContain("@keyframes");
    expect(reprintText).not.toContain("animation");
  });

  it("shares the print rows' columns so the values stand on one line", () => {
    expect(rule(reprint, ".rp-print__row")["grid-template-columns"]).toBe("subgrid");
    expect(rule(reprint, ".rp-print__rows")["grid-template-columns"]).toContain("auto");
  });
});

describe("the duplicate's steps on the work screen", () => {
  const unit = rulesOf("src/floor/unit-labels/unit-labels.css");

  it("are 64 px rows between hairlines with a 40 px tag, no card of their own", () => {
    expect(rule(unit, ".work-unit-label__step")["min-height"]).toBe("64px");
    expect(rule(unit, ".work-unit-label__step")["border-bottom"]).toBe("1px solid var(--line)");
    expect(rule(unit, ".work-unit-label__tag")["height"]).toBe("40px");
  });
});

describe("the shared shift's card (plan 2b)", () => {
  const hub = rulesOf("src/floor/shifts/shift-hub.css");

  it("keeps who works the shift on one line, cut with an ellipsis, the full list in its title", () => {
    const line = rule(hub, ".shift-hub .shift-card__participants");
    expect([line["white-space"], line["text-overflow"], line["overflow"]]).toEqual([
      "nowrap",
      "ellipsis",
      "hidden",
    ]);
    expect(textOf("src/floor/shifts/ShiftCard.tsx")).toContain(
      'className="shift-card__participants" title={participantsLine}',
    );
  });

  it("measures the shared cards on the hub's whole matrix", () => {
    const cases = textOf("test/harness/station-fit/measure-others.mjs");
    for (const multi of ["join", "full", "mine", "closed"]) {
      expect(cases).toContain(`multi=${multi}`);
    }
  });
});

describe("the shared shift's strip (plan 2b)", () => {
  const work = rulesOf("src/floor/work/work-screen.css");

  it("keeps the age of the host's figures on a short window, where the plan's bar and percent go", () => {
    expect(rule(work, ".work-shift-band__stale")["white-space"]).toBe("nowrap");
    expect(
      rule(work, ".work-shift-band__stale", "@media (max-height: 780px)")["display"],
    ).toBeUndefined();
    expect(rule(work, ".work-shift-band__meta", "@media (max-height: 780px)")["display"]).toBe(
      "none",
    );
  });

  it("measures the shared strip on the whole matrix, stale and big", () => {
    const cases = textOf("test/harness/station-fit/measure-others.mjs");
    expect(cases).toContain("shared=1");
    expect(cases).toContain("shared=1&stale=1");
  });
});

describe("the close of a part (plan 2b)", () => {
  const close = rulesOf("src/floor/close/shift-close.css");

  it("sets the part's line in the floor's body face, smaller on a short window", () => {
    expect(rule(close, ".shift-close__part")["font"]).toBe("var(--floor-body)");
    expect(rule(close, ".shift-close__part", "@media (max-height: 860px)")["font"]).toBe(
      "400 15px/20px var(--font-ui)",
    );
  });

  it("gives the last closer's line up to the reasons, and keeps a part's six tiles in one row", () => {
    const short = "@media (max-height: 860px)";
    expect(
      rule(close, ".shift-close__body:has(> .shift-close__reasons) > .shift-close__part", short)[
        "display"
      ],
    ).toBe("none");
    expect(rule(close, ".shift-close__facts:has(> :nth-child(7))")["grid-template-columns"]).toBe(
      "repeat(auto-fit, minmax(112px, 1fr))",
    );
  });

  it("measures every part panel on the whole matrix", () => {
    const cases = textOf("test/harness/station-fit/measure-screens.mjs");
    for (const variant of [
      "part",
      "part-last",
      "part-offline",
      "part-pallet",
      "queued",
      "waiting",
      "shift_closed",
      "reason_missing",
      "refused",
      "unknown",
    ]) {
      expect(cases).toContain(`variant=${variant}"`);
    }
  });
});
