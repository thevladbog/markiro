import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { FontUsage, PdfDocument, glyphHex, parseTrueTypeFont } from "../pdf.mjs";

const FONT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/legal-documents/fonts/IBMPlexMono-Regular.ttf",
);

async function loadFont() {
  return parseTrueTypeFont(await readFile(FONT_PATH));
}

test("parseTrueTypeFont reads metrics and maps Latin and Cyrillic to glyphs", async () => {
  const font = await loadFont();
  assert.equal(font.metrics.fixedPitch, true);
  assert.ok(font.metrics.ascent > 0 && font.metrics.descent < 0);
  const a = font.glyphIndex("a".codePointAt(0));
  const ya = font.glyphIndex("я".codePointAt(0));
  assert.ok(a > 0 && ya > 0 && a !== ya);
  assert.equal(font.advanceWidth(a), 600);
  assert.equal(font.advanceWidth(ya), 600);
  assert.equal(font.glyphIndex(0x1f600), 0, "emoji is outside the BMP subtable");
});

test("FontUsage substitutes missing glyphs and records ToUnicode pairs", async () => {
  const usage = new FontUsage(await loadFont(), "F1");
  const glyphs = usage.encode("a😀");
  assert.equal(glyphs.length, 2);
  assert.equal(glyphs[1], usage.replacementGlyph);
  assert.equal(usage.glyphToCodePoint.get(usage.replacementGlyph), "?".codePointAt(0));
  assert.equal(usage.measure("ab"), 1.2);
  assert.equal(glyphHex([1, 0x10a]), "0001010a");
});

test("PdfDocument renders a well-formed file with embedded fonts and searchable text", async () => {
  const pdf = new PdfDocument({
    title: "Тест",
    author: "Автор",
    subject: "subject",
    creator: "creator",
    creationDate: new Date("2026-09-10T00:00:00Z"),
  });
  const regular = pdf.registerFont(await loadFont(), "IBMPlexMono-Regular");
  pdf.addPage({
    runs: [{ usage: regular, size: 9, x: 40, y: 800, text: "Привет, world" }],
    lines: [{ x1: 40, y1: 790, x2: 500, y2: 790 }],
  });
  const bytes = pdf.render();
  const text = bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.5\n"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.match(text, /\/Subtype \/CIDFontType2/u);
  assert.match(text, /\/Encoding \/Identity-H/u);
  assert.match(text, /\/Title <feff/iu);
  assert.match(text, /\/CreationDate \(D:20260910000000Z\)/u);

  // Every xref offset must point at the matching "N 0 obj" header.
  const xrefStart = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(text)[1]);
  const xref = text.slice(xrefStart);
  const entries = [...xref.matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]));
  assert.ok(entries.length >= 8);
  entries.forEach((offset, index) => {
    assert.ok(text.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1} offset`);
  });

  // The ToUnicode CMap is Flate-compressed and maps the used glyphs back to text.
  const streams = [...bytes.toString("latin1").matchAll(/stream\n/gu)].map(
    (match) => match.index + 7,
  );
  const cmap = streams
    .map((start) => {
      const end = bytes.indexOf("\nendstream", start, "latin1");
      try {
        return inflateSync(bytes.subarray(start, end)).toString("latin1");
      } catch {
        return "";
      }
    })
    .find((content) => content.includes("begincmap"));
  assert.ok(cmap, "ToUnicode stream present");
  assert.match(cmap, /beginbfchar/u);
  const glyphOfP = regular.font.glyphIndex("П".codePointAt(0));
  assert.ok(cmap.includes(`<${glyphHex([glyphOfP])}> <041f>`));
});
