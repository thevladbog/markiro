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

  it("draws the link dot's frame itself: a 64 px target with a transparent hairline, not the browser's outset", () => {
    const button = rule(rules, ".floor-link__button.mk-btn");
    expect(button["width"]).toBe("64px");
    expect(button["min-width"]).toBe("64px");
    // The kit's secondary border colour is `!important`; the dot beats it by specificity and says the style.
    const frame = rule(
      rules,
      ":where(.floor-frame, .station-screen) .floor-link__button.mk-btn.mk-btn--floor",
    );
    expect(frame["border"]).toBe("1px solid transparent !important");
  });

  it("anchors the link popover at the dot's left edge, within the window's width", () => {
    const popover = rule(rules, ".floor-link__popover");
    expect(popover["left"]).toBe("0");
    expect(popover["right"]).toBeUndefined();
    expect(popover["max-width"]).toContain("100vw");
  });

  it("gives the identity room: the scanner's words go before the operator's name does", () => {
    const narrow = rule(
      rules,
      '.station-status-pills__list .station-status-pill[data-tone="neutral"] dd',
      "@container (max-width: 1300px)",
    );
    expect(narrow["display"]).toBe("none");
    // The warning chips never collapse: the neutral rule names no `warn` or `error` tone.
    expect(
      rules
        .filter((r) => r.within.some((w) => w.startsWith("@container")))
        .flatMap((r) => selectorParts(r.selector))
        .some((part) => /data-tone="(warn|error)"/.test(part)),
    ).toBe(false);
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

  it("take the height of their content, with a square photo frame instead of a full-height strip", () => {
    expect(rule(hub, ".shift-hub .shift-selection__grid")["align-items"]).toBe("start");
    const body = rule(hub, ".shift-hub .shift-card__body");
    expect(body["height"]).toBe("auto");
    expect(body["grid-template-columns"]).toContain("var(--hub-photo, 120px)");
    const photo = rule(hub, ".shift-hub .shift-card__photo");
    expect(photo["width"]).toBe(photo["height"]);
  });

  it("set their facts at the floor's 16 px and up, and their tags at the floor's size", () => {
    for (const selector of [
      ".shift-hub .shift-card__number",
      ".shift-hub .shift-card__dates,\n.shift-hub .shift-card__plan",
    ]) {
      const css = rulesOf("src/floor/shifts/shift-hub.css").find((r) =>
        r.selector.replace(/\s+/g, " ").startsWith(selector.replace(/\s+/g, " ")),
      );
      expect(css?.body, selector).toMatch(/font: \d+ 16px\//);
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

  it("lets the message row grow with its words, and clips none of them", () => {
    expect(rule(signIn, ".operator-login")["grid-template-rows"]).toBe(
      "auto minmax(64px, auto) minmax(0, 1fr) auto",
    );
    const message = rule(signIn, ".operator-login__message");
    expect(message["overflow"]).toBeUndefined();
    expect(message["min-height"]).toBe("64px");
    expect(
      rule(signIn, ".operator-login", "@media (max-height: 760px)")["grid-template-rows"],
    ).toBe("auto minmax(56px, auto) minmax(0, 1fr) auto");
  });

  it("sets the badge help text at the floor's body size", () => {
    expect(rule(signIn, ".operator-login__badge-copy p")["font"]).toBe("var(--floor-body)");
  });
});

describe("the workstation setup's tabs", () => {
  const setup = rulesOf("src/floor/setup/workstation-setup.css");

  it("are the kit's segmented control: a track of tabs as wide as their words, the chosen one an `fg` fill", () => {
    const list = rule(setup, ".setup-tabs__list.mk-data-tabs");
    expect(list["display"]).toBe("flex");
    expect(list["width"]).toBe("fit-content");
    expect(rule(setup, ".setup-tabs")["grid-template-rows"]).toBe("auto minmax(0, 1fr)");
    const active = rule(setup, ".setup-tabs__list .mk-data-tabs__tab--active");
    expect(active["background"]).toBe("var(--fg)");
    expect(active["color"]).toBe("var(--bg)");
    expect(active["font-weight"]).toBe("700");
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
