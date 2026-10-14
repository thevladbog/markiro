import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The office, the wizard and the shell use only `@markiro/ui`'s controls: a
 * native `<select>` (or the `native` flag of `Select`, which renders one),
 * `<datalist>`, `<input>`, `<textarea>` or a raw `<button>` looks and behaves
 * like the browser's, not like the product's, and its list cannot be searched.
 * The station's floor has its own touch controls and is not scanned.
 */
const ROOTS = ["src/office", "src/wizard", "src/app"].map((root) => join(__dirname, "..", root));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("the office's controls", () => {
  const files = ROOTS.flatMap(sources);

  it("scans the office, the wizard and the shell", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each([
    ["a native <select>", /<select[\s>]/],
    ["a <datalist> or an input list", /<datalist[\s>]|\slist=/],
    ["a raw <input>", /<input[\s>/]/],
    ["a raw <textarea>", /<textarea[\s>]/],
    ["a raw <button>", /<button[\s>]/],
    [
      "a Select that renders the browser's own list",
      /<Select\b[^>]*\snative\b|<Select\n(?:[^>]*\n)*?\s+native\n/,
    ],
  ])("has no %s", (_name, pattern) => {
    const found = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(found.map((file) => relative(join(__dirname, ".."), file))).toEqual([]);
  });
});
