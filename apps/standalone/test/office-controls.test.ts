import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
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

function hasNativeSelect(source: string): boolean {
  const file = ts.createSourceFile(
    "controls.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  function visit(node: ts.Node): boolean {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "Select" &&
      node.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "native",
      )
    ) {
      return true;
    }
    return ts.forEachChild(node, visit) ?? false;
  }
  return visit(file);
}

describe("native Select detection", () => {
  it("handles long unterminated opening tags without regex backtracking", () => {
    expect(hasNativeSelect("<Select\n" + "\n".repeat(100_000))).toBe(false);
  });

  it.each([
    ["a boolean attribute", "<Select native />"],
    ["a value attribute", "<Select native={true} />"],
    ["a false value attribute", "<Select native={false} />"],
    ["a multiline opening tag", "<Select\n  options={items}\n  native\n/>"],
    [
      "an attribute after an arrow function",
      "<Select onValueChange={(value) => update(value)} native />",
    ],
    ["a nested control", "<Panel><Select native /></Panel>"],
  ])("detects %s", (_name, source) => {
    expect(hasNativeSelect(source)).toBe(true);
  });

  it.each([
    ["a searchable Select", "<Select options={items} />"],
    ["a different component", "<SelectOther native />"],
    ["a different attribute", "<Select nativeOptions={items} />"],
    ["a string", 'const example = "<Select native />";'],
    ["a template literal", "const example = `<Select\n native />`;"],
    ["a line comment", "// <Select native />\nconst example = <Select />;"],
    ["a JSX comment", "<Panel>{/* <Select native /> */}<Select /></Panel>"],
    ["an attribute value", '<Select label=" native" />'],
  ])("ignores %s", (_name, source) => {
    expect(hasNativeSelect(source)).toBe(false);
  });
});

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
  ])("has no %s", (_name, pattern) => {
    const found = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(found.map((file) => relative(join(__dirname, ".."), file))).toEqual([]);
  });

  it("has no Select that renders the browser's own list", () => {
    const found = files.filter((file) => hasNativeSelect(readFileSync(file, "utf8")));
    expect(found.map((file) => relative(join(__dirname, ".."), file))).toEqual([]);
  });
});
