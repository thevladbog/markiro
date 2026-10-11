import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// An undefined custom property makes the whole declaration invalid at computed-value
// time: `font: 500 3rem / 1 var(--missing)` drops the size along with the family, and
// the element silently falls back to the inherited 16 px text.
const landingSource = fileURLToPath(new URL("../src/", import.meta.url));
const uiSource = path.dirname(createRequire(import.meta.url).resolve("@markiro/ui/styles.css"));

function filesUnder(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("landing CSS custom properties", () => {
  it("defines every property the landing reads without a fallback", () => {
    const landingFiles = filesUnder(landingSource, /\.(css|astro|ts)$/);
    const used = new Map<string, Set<string>>();
    for (const file of landingFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const name = match[1] ?? "";
        const files = used.get(name) ?? new Set<string>();
        files.add(path.relative(landingSource, file));
        used.set(name, files);
      }
    }

    const defined = new Set<string>();
    for (const file of [...landingFiles, ...filesUnder(uiSource, /\.css$/)]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(--[\w-]+)["']?\s*:/g)) defined.add(match[1] ?? "");
      for (const match of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g))
        defined.add(match[1] ?? "");
    }

    const missing = [...used]
      .filter(([name]) => !defined.has(name))
      .map(([name, files]) => `${name} (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
  });
});
