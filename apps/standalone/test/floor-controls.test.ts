import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The floor's screens (the touch panel) use only `@markiro/ui`'s controls, as the office does: a
 * native `<select>` or a `Select` that renders one (the `native` flag, or the floor size without
 * `custom`), `<datalist>`, a raw `<input>`, `<textarea>` or `<button>` looks and behaves like the
 * browser's, not like the product's, and the owner's test of beta 3 found them on the printer
 * screen. `office-controls.test.ts` keeps the office to the same.
 */
const ROOTS = ["src/floor", "src/hardware"].map((root) => join(__dirname, "..", root));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** The opening tags of every `<Select …>` of a source. */
function selectTags(source: string): string[] {
  return source.match(/<Select\b[^>]*?(?:=>[^>]*?)*>/gs) ?? [];
}

describe("the floor's controls", () => {
  const files = ROOTS.flatMap(sources);

  it("scans the floor's screens", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each([
    ["a native <select>", /<select[\s>]/],
    ["a <datalist> or an input list", /<datalist[\s>]|\slist=/],
    ["a raw <input>", /<input[\s>/]/],
    ["a raw <textarea>", /<textarea[\s>]/],
    ["a raw <button>", /<button[\s>]/],
    ["a Select that renders the browser's own list", /<Select\b[^>]*\snative\b/s],
  ])("has no %s", (name, pattern) => {
    const found = files
      // The kit's own controls (src/floor/kit: keypad keys, radios, switch cards, readouts) ARE
      // the product's buttons, drawn by floor-controls.css; a screen still takes none raw.
      .filter((file) => !(name === "a raw <button>" && file.includes(join("src", "floor", "kit"))))
      .filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(found.map((file) => relative(join(__dirname, ".."), file))).toEqual([]);
  });

  it("keeps the raw buttons of the floor to the kit directory alone", () => {
    const raw = files.filter((file) => /<button[\s>]/.test(readFileSync(file, "utf8")));
    expect(raw.map((file) => relative(join(__dirname, ".."), file)).sort()).toEqual(
      [
        "src/floor/kit/IpKeypad.tsx",
        "src/floor/kit/ModeSegment.tsx",
        "src/floor/kit/NumericKeypad.tsx",
        "src/floor/kit/NumericReadout.tsx",
        "src/floor/kit/SwitchCard.tsx",
      ].sort(),
    );
  });

  it("finds the Selects of the setup it checks", () => {
    const setup = join(__dirname, "..", "src/floor/setup/WorkstationSetup.tsx");
    expect(selectTags(readFileSync(setup, "utf8")).length).toBeGreaterThanOrEqual(7);
  });

  it("gives every floor-sized Select the product's own list (`custom`)", () => {
    const bare = files.flatMap((file) =>
      selectTags(readFileSync(file, "utf8"))
        .filter((tag) => /size="floor"/.test(tag) && !/\scustom\b/.test(tag))
        .map(() => relative(join(__dirname, ".."), file)),
    );
    expect(bare).toEqual([]);
  });
});
