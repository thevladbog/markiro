import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Design kit 2026-10, step B: what the stylesheets of «Новая смена» promise, pinned as text (jsdom has
 * no layout; the browser screenshots and measurements are separate evidence). The contract: the photo
 * is a fixed square with the picture laid over it, every touch target is 64 px or more, and the details
 * step never scrolls at 1280 x 1024 and 1280 x 800.
 */
const APP = process.cwd();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const controls = strip(readFileSync(join(APP, "src/floor/kit/floor-controls.css"), "utf8"));
const hub = strip(readFileSync(join(APP, "src/floor/shifts/shift-hub.css"), "utf8"));

const normal = (text: string) => text.replace(/\s+/g, " ").trim();

/** The css without its `@media` blocks (their braces nest one level). */
function topLevel(css: string): string {
  let out = "";
  let depth = 0;
  let media = false;
  for (let at = 0; at < css.length; at += 1) {
    const char = css[at] ?? "";
    if (depth === 0 && css.startsWith("@media", at)) media = true;
    if (char === "{") depth += 1;
    if (!media) out += char;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) media = false;
    }
  }
  return out;
}

/** The declarations of the first top-level rule whose selector list contains `selector` exactly. */
function declarations(css: string, selector: string): string {
  const wanted = normal(selector);
  const pattern = /(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g;
  for (const match of topLevel(css).matchAll(pattern)) {
    const selectors = normal(match[1] ?? "")
      .split(/,(?![^()]*\))/)
      .map((part) => normal(part));
    if (selectors.includes(wanted)) return normal(match[2] ?? "");
  }
  throw new Error(`no rule for ${selector}`);
}

/** The px of `property` in declarations, from a number or a `var(--x, NNpx)` fallback. */
function px(block: string, property: string): number {
  const found = new RegExp(`(?:^|[; ])${property}:\\s*(?:var\\([^,)]+,\\s*)?(\\d+)px`).exec(block);
  if (found === null) throw new Error(`no ${property} px in: ${block}`);
  return Number(found[1]);
}

const FLOOR = ":where(.floor-frame, .station-screen)";

describe("the photo square", () => {
  it("is a fixed relative square and the picture is laid over it, whole", () => {
    const frame = declarations(controls, `${FLOOR} .floor-photo-square`);
    expect(frame).toContain("position: relative");
    expect(frame).toContain("width: var(--floor-photo, 132px)");
    expect(frame).toContain("height: var(--floor-photo, 132px)");
    expect(frame).toContain("overflow: hidden");
    // The border's colour and the face are the backing's (`data-photo-backing`).
    expect(frame).toContain("border: 1px solid transparent");
    expect(frame).not.toContain("background:");
    const image = declarations(controls, `${FLOOR} .floor-photo-square > .product-photo`);
    expect(image).toContain("position: absolute");
    expect(image).toContain("inset: 0");
    expect(image).toContain("width: 100%");
    expect(image).toContain("height: 100%");
    expect(image).toContain("object-fit: contain");
    expect(image).toContain("max-width: none");
    expect(image).toContain("max-height: none");
  });

  it("is not sized by a percentage that a grid track can grow (the owner's cropped photo)", () => {
    // The old rule: `max-height: 100%` on the picture in a grid: its track grew to the picture's height.
    expect(hub).not.toMatch(/new-shift__product-photo/);
    expect(hub).not.toMatch(/new-shift[^{]*product[^{]*\{[^}]*max-height:\s*100%/);
    expect(controls).not.toMatch(/floor-photo-square[^{]*\{[^}]*max-height:\s*100%/);
  });

  it("takes a smaller side on a short panel; its face is the backing's, the same in both themes", () => {
    expect(hub).toMatch(/@media \(max-height: 860px\)[\s\S]*--floor-photo: 104px/);
    expect(declarations(hub, ".new-shift .new-shift__panel--found")).toContain(
      "--floor-photo: 208px",
    );
    // No flat grey (or paper) face of its own: the brand gradient behind a cut-out, nothing
    // behind an opaque photo (shifts/photo-backing.css), both from theme tokens.
    expect(declarations(controls, `${FLOOR} .floor-photo-square`)).not.toContain("background");
  });
});

describe("touch targets", () => {
  it("keeps the keys at 72 px and up, the radios and the footer at 64 px and up", () => {
    const keys = declarations(controls, `${FLOOR} .floor-keypad__key`);
    expect(px(keys, "min-width")).toBeGreaterThanOrEqual(72);
    expect(px(keys, "min-height")).toBeGreaterThanOrEqual(72);
    const grid = declarations(controls, `${FLOOR} .floor-keypad`);
    expect(grid).toContain("grid-template-rows: repeat(4, minmax(72px, 1fr))");
    expect(
      px(declarations(controls, `${FLOOR} .floor-segmented > .floor-segmented__option`), "height"),
    ).toBeGreaterThanOrEqual(64);
    expect(
      px(declarations(controls, `${FLOOR} .floor-switch-card`), "min-height"),
    ).toBeGreaterThanOrEqual(80);
    const footer = declarations(hub, ".new-shift .station-floor-footer .mk-btn");
    expect(footer).toContain("height: var(--control-floor-primary) !important");
    expect(footer).toContain("min-height: var(--control-floor-primary) !important");
    expect(px(declarations(hub, ".new-shift .station-floor-footer"), "height")).toBe(84);
  });

  it("keeps every readout at 64 px and up, in both sizes", () => {
    expect(px(declarations(controls, `${FLOOR} .floor-readout`), "height")).toBeGreaterThanOrEqual(
      64,
    );
    const sizes = [...hub.matchAll(/--floor-readout:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(64);
  });

  it("sizes the 84 px primary action of the footer wide", () => {
    expect(declarations(hub, ".new-shift .station-floor-footer > .floor-primary")).toContain(
      "flex-grow: 2",
    );
  });
});

describe("no scrolling on the details step", () => {
  it("clips the details panel instead of scrolling it, as one grid whose keypad spans both rows", () => {
    const fields = declarations(hub, ".new-shift .new-shift__panel--found .new-shift__fields");
    expect(fields).toContain("display: contents");
    const panel = declarations(hub, ".new-shift .new-shift__panel");
    expect(panel).toContain("overflow: hidden");
    expect(declarations(hub, ".new-shift .new-shift__panel--found")).toContain(
      "grid-template-columns: minmax(0, 3fr) minmax(0, 2fr)",
    );
    expect(declarations(hub, ".new-shift .new-shift__panel--found")).toContain(
      "grid-template-rows: minmax(0, 1fr) auto",
    );
    // The keypad is not shortened by a message: it spans the message's row too.
    expect(declarations(hub, ".new-shift .new-shift__pad")).toContain("grid-row: 1 / span 2");
    expect(declarations(hub, ".new-shift .new-shift__panel--found .new-shift__message")).toContain(
      "grid-column: 1",
    );
    expect(hub).not.toMatch(/new-shift__panel--found[^{]*\{[^}]*overflow(-y)?:\s*(auto|scroll)/);
    for (const zone of [".new-shift__left", ".new-shift__pad"]) {
      expect(declarations(hub, `.new-shift ${zone}`)).toContain("min-height: 0");
    }
  });

  it("fixes the slot under the readouts, so an error never moves the keys", () => {
    const slot = declarations(hub, ".new-shift .new-shift__pad-slot");
    expect(px(slot, "height")).toBe(px(slot, "min-height"));
    expect(slot).toContain("overflow: hidden");
  });

  it("holds the short panel to its own sizes: the facts go, the left zone tightens", () => {
    const short = hub.slice(hub.indexOf("@media (max-height: 860px)"));
    expect(short).toMatch(/--floor-readout: 84px/);
    expect(short).toMatch(/\.new-shift__facts \{\s*display: none/);
    expect(short).toMatch(/\.station-screen\.new-shift \{[^}]*padding: var\(--sp-3\)/);
  });
});

describe("the colour of the new controls", () => {
  it("comes from the kit tokens only, with no blurred shadow", () => {
    expect(controls).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    // A ring is `inset 0 0 0 1px`; a blur would be a second layer of decoration.
    for (const shadow of controls.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(shadow[1]).toMatch(/^inset 0 0 0 [12]px var\(--[a-z0-9-]+\)$/);
    }
    for (const colour of controls.matchAll(
      /(?:^|[ ;])(?:color|background|border(?:-color)?)\s*:\s*([^;]+);/gm,
    )) {
      const value = colour[1] ?? "";
      expect(value).not.toMatch(/#|rgb|hsl/);
    }
  });

  it("is scoped to the floor roots, like the rest of the kit", () => {
    const selectors = [...controls.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) =>
      (m[2] ?? "").trim(),
    );
    expect(selectors.length).toBeGreaterThan(30);
    for (const selector of selectors) {
      for (const part of selector.split(/,(?![^()]*\))/)) {
        expect(normal(part).startsWith(FLOOR)).toBe(true);
      }
    }
  });

  it("presses with the kit's scale and shows the press as a fill under reduced motion", () => {
    expect(controls).toContain("scale(var(--press-scale))");
    expect(controls).toMatch(/prefers-reduced-motion: reduce[\s\S]*transform: none/);
  });
});
