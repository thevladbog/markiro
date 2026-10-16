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
