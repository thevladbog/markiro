import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LAYOUT,
  buildContentsLines,
  layoutDocument,
  paginateListing,
  selectFragment,
  wrapLine,
  wrapPath,
} from "../listing.mjs";

const layout = { ...DEFAULT_LAYOUT, columns: 40, linesPerPage: 12, minimumLinesForFileHeader: 3 };

function entry(path, lineCount, overrides = {}) {
  const source = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
  return { path, ...selectFragment(source, overrides), comment: undefined };
}

test("wrapLine splits by code points and keeps short lines intact", () => {
  assert.deepEqual(wrapLine("abc", 5), ["abc"]);
  assert.deepEqual(wrapLine("абвгде", 4), ["абвг", "де"]);
  assert.throws(() => wrapLine("x", 0), /positive/u);
});

test("wrapPath breaks at slashes and falls back to hard wrapping", () => {
  assert.deepEqual(wrapPath("apps/handheld/app/src/main/Foo.kt", 20), [
    "apps/handheld/app/",
    "src/main/Foo.kt",
  ]);
  assert.deepEqual(wrapPath("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("selectFragment honours ranges, caps, tabs and CRLF endings", () => {
  const source = "a\r\n\tb\nc\nd\n";
  assert.deepEqual(selectFragment(source), {
    from: 1,
    to: 4,
    total: 4,
    lines: ["a", "    b", "c", "d"],
  });
  assert.deepEqual(selectFragment(source, { lines: [2, 3] }).lines, ["    b", "c"]);
  assert.deepEqual(selectFragment(source, { lines: [3, 99] }), {
    from: 3,
    to: 4,
    total: 4,
    lines: ["c", "d"],
  });
  assert.deepEqual(selectFragment(source, { maxLines: 2 }).lines, ["a", "    b"]);
  assert.throws(() => selectFragment(source, { lines: [5, 6] }), /after the end/u);
  assert.throws(() => selectFragment(source, { lines: [3, 2] }), /invalid line range/u);
  assert.throws(() => selectFragment(source, { lines: [1] }), /\[from, to\]/u);
});

test("paginateListing numbers lines, wraps long code and never orphans a file header", () => {
  const long = { path: "x.ts", from: 1, to: 1, total: 1, lines: ["y".repeat(70)] };
  const { pages } = paginateListing([long], layout);
  const body = pages[0].lines.slice(4);
  assert.equal(body.length, 3);
  assert.match(body[0], /^ {4}1 │ y+$/u);
  assert.match(body[1], /^ {6}┆ y+$/u);

  const first = entry("a.ts", 5); // 4 header lines + 5 code lines = 9 of 12
  const second = entry("b.ts", 2);
  const paged = paginateListing([first, second], layout);
  assert.equal(paged.pages.length, 2, "second header does not fit into the remaining 3 lines");
  assert.deepEqual(paged.starts, [1, 2]);
  assert.equal(paged.pages[1].file, "b.ts");
  assert.ok(paged.pages[1].lines[0].startsWith("═"));

  const spill = paginateListing([entry("c.ts", 30)], layout);
  assert.equal(spill.pages.length, 3);
  assert.ok(spill.pages.every((page) => page.lines.length <= layout.linesPerPage));
  assert.ok(spill.pages.every((page) => page.file === "c.ts"));
});

test("layoutDocument accounts for title and contents pages and reports real start pages", () => {
  const meta = {
    title: "Маркиро",
    holder: "Правообладатель",
    authors: ["Автор"],
    version: "1.0",
    languages: ["TypeScript"],
    sourceState: "git abc",
    year: 2026,
  };
  const entries = [entry("a.ts", 5), entry("b.ts", 30, { lines: [3, 20] })];
  assert.throws(() => layoutDocument(meta, entries, layout), /title page/u);
  const tall = { ...layout, linesPerPage: 40 };
  const document = layoutDocument(meta, entries, tall);
  assert.equal(document.pages[0].kind, "title");
  assert.equal(document.pages[1].kind, "contents");
  assert.equal(document.bodyStartPage, 3);
  assert.equal(document.totalPages, document.pages.length);
  assert.equal(document.sourceLines, 5 + 18);
  const contents = buildContentsLines(
    entries,
    document.starts,
    document.bodyStartPage,
    layout.columns,
  );
  assert.match(contents.at(-2) ?? "", /^1 {3}a\.ts/u);
  assert.match(contents.at(-1) ?? "", /3–20 из 30 {2,}\d+$/u);
  assert.ok(document.pages.every((page) => page.lines.length <= tall.linesPerPage));
});
