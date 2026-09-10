// Minimal dependency-free PDF writer for the Rospatent deposit listing.
//
// Scope is deliberately narrow: A4 pages of monospaced text drawn with TrueType
// fonts embedded as CIDFontType2 (Identity-H) so Cyrillic comments and Latin
// code share one font program. Every embedded font carries a ToUnicode CMap so
// `pdftotext` and the Rospatent reviewer can search the listing. Streams are
// Flate-compressed with node:zlib.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const A4 = Object.freeze({ width: 595.28, height: 841.89 });

const REPLACEMENT_CHARACTER = "?";

function readTableDirectory(buffer) {
  if (buffer.length < 12) throw new Error("TrueType font is truncated");
  const numTables = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const offset = 12 + index * 16;
    if (offset + 16 > buffer.length) throw new Error("TrueType table directory is truncated");
    tables.set(buffer.toString("latin1", offset, offset + 4), {
      offset: buffer.readUInt32BE(offset + 8),
      length: buffer.readUInt32BE(offset + 12),
    });
  }
  return tables;
}

function selectFormat4Subtable(buffer, cmap) {
  const subtableCount = buffer.readUInt16BE(cmap.offset + 2);
  let fallback = null;
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = buffer.readUInt16BE(record);
    const encoding = buffer.readUInt16BE(record + 2);
    const subtable = cmap.offset + buffer.readUInt32BE(record + 4);
    if (buffer.readUInt16BE(subtable) !== 4) continue;
    if (platform === 3 && encoding === 1) return subtable;
    fallback ??= subtable;
  }
  if (fallback === null) throw new Error("TrueType font has no format 4 cmap subtable");
  return fallback;
}

function createGlyphLookup(buffer, subtable) {
  const segCountX2 = buffer.readUInt16BE(subtable + 6);
  const segCount = segCountX2 / 2;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;
  const cache = new Map();
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    const cached = cache.get(codePoint);
    if (cached !== undefined) return cached;
    let glyph = 0;
    for (let index = 0; index < segCount; index += 1) {
      const end = buffer.readUInt16BE(endCodes + index * 2);
      if (codePoint > end) continue;
      const start = buffer.readUInt16BE(startCodes + index * 2);
      if (codePoint < start) break;
      const delta = buffer.readUInt16BE(idDeltas + index * 2);
      const rangeOffsetAddress = idRangeOffsets + index * 2;
      const rangeOffset = buffer.readUInt16BE(rangeOffsetAddress);
      if (rangeOffset === 0) {
        glyph = (codePoint + delta) & 0xffff;
      } else {
        const address = rangeOffsetAddress + rangeOffset + (codePoint - start) * 2;
        const raw = buffer.readUInt16BE(address);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      break;
    }
    cache.set(codePoint, glyph);
    return glyph;
  };
}

/**
 * Parses the TrueType tables needed to embed a font as CIDFontType2.
 * All metrics are returned in the PDF glyph space (1/1000 em).
 */
export function parseTrueTypeFont(buffer) {
  const tables = readTableDirectory(buffer);
  const need = (tag) => {
    const table = tables.get(tag);
    if (!table) throw new Error(`TrueType font lacks the ${tag} table`);
    return table;
  };
  const head = need("head");
  const hhea = need("hhea");
  const hmtx = need("hmtx");
  const maxp = need("maxp");
  const os2 = need("OS/2");
  const post = need("post");
  for (const tag of ["glyf", "loca"]) need(tag);

  const unitsPerEm = buffer.readUInt16BE(head.offset + 18);
  const scale = 1000 / unitsPerEm;
  const toGlyphSpace = (value) => Math.round(value * scale);
  const numberOfHMetrics = buffer.readUInt16BE(hhea.offset + 34);
  const numGlyphs = buffer.readUInt16BE(maxp.offset + 4);
  const os2Version = buffer.readUInt16BE(os2.offset);
  const ascent = toGlyphSpace(buffer.readInt16BE(hhea.offset + 4));
  const descent = toGlyphSpace(buffer.readInt16BE(hhea.offset + 6));
  const capHeight =
    os2Version >= 2 ? toGlyphSpace(buffer.readInt16BE(os2.offset + 88)) : Math.round(ascent * 0.7);
  const glyphIndex = createGlyphLookup(buffer, selectFormat4Subtable(buffer, need("cmap")));
  const advanceWidth = (glyph) => {
    const metric = Math.min(glyph, numberOfHMetrics - 1);
    return toGlyphSpace(buffer.readUInt16BE(hmtx.offset + metric * 4));
  };

  return {
    program: buffer,
    numGlyphs,
    metrics: {
      ascent,
      descent,
      capHeight,
      italicAngle: buffer.readInt32BE(post.offset + 4) / 65536,
      bbox: [36, 38, 40, 42].map((delta) => toGlyphSpace(buffer.readInt16BE(head.offset + delta))),
      fixedPitch: buffer.readUInt32BE(post.offset + 12) !== 0,
    },
    glyphIndex,
    advanceWidth,
  };
}

/**
 * Tracks the glyphs a font actually draws so the embedded font gets a ToUnicode
 * map and width array covering exactly what the document uses.
 */
export class FontUsage {
  constructor(font, resourceName) {
    this.font = font;
    this.resourceName = resourceName;
    this.glyphToCodePoint = new Map();
    this.replacementGlyph = font.glyphIndex(REPLACEMENT_CHARACTER.codePointAt(0));
    if (this.replacementGlyph === 0) throw new Error("Font lacks a replacement glyph");
  }

  encode(text) {
    const glyphs = [];
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      let glyph = this.font.glyphIndex(codePoint);
      let mapped = codePoint;
      if (glyph === 0) {
        glyph = this.replacementGlyph;
        mapped = REPLACEMENT_CHARACTER.codePointAt(0);
      }
      if (!this.glyphToCodePoint.has(glyph)) this.glyphToCodePoint.set(glyph, mapped);
      glyphs.push(glyph);
    }
    return glyphs;
  }

  /** Width of `text` in text-space units for a 1pt font. */
  measure(text) {
    return this.encode(text).reduce((sum, glyph) => sum + this.font.advanceWidth(glyph), 0) / 1000;
  }
}

function pdfString(value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/\(/gu, "\\(")
    .replace(/\)/gu, "\\)")
    .replace(/[\r\n]/gu, " ");
  // Non-ASCII metadata goes through the UTF-16BE BOM form.
  if (/^[\x20-\x7e]*$/u.test(escaped)) return `(${escaped})`;
  const utf16 = Buffer.from(`\ufeff${String(value)}`, "utf16le");
  utf16.swap16();
  return `<${utf16.toString("hex")}>`;
}

function utf16beHex(codePoint) {
  const text = String.fromCodePoint(codePoint);
  const buffer = Buffer.from(text, "utf16le");
  buffer.swap16();
  return buffer.toString("hex");
}

export function glyphHex(glyphs) {
  return glyphs.map((glyph) => glyph.toString(16).padStart(4, "0")).join("");
}

function pdfDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function buildToUnicode(usage) {
  const entries = [...usage.glyphToCodePoint.entries()].sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    blocks.push(
      `${chunk.length} beginbfchar\n` +
        chunk
          .map(([glyph, codePoint]) => `<${glyphHex([glyph])}> <${utf16beHex(codePoint)}>`)
          .join("\n") +
        "\nendbfchar",
    );
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
    "",
  ].join("\n");
}

export class PdfDocument {
  constructor({ title, author, subject, creator, creationDate }) {
    this.objects = [];
    this.pages = [];
    this.fonts = [];
    this.info = { title, author, subject, creator, creationDate };
  }

  reserveObject() {
    this.objects.push(null);
    return this.objects.length;
  }

  setObject(number, body) {
    this.objects[number - 1] = body;
  }

  addObject(body) {
    this.objects.push(body);
    return this.objects.length;
  }

  streamObject(dictionary, data) {
    const compressed = deflateSync(data);
    return Buffer.concat([
      Buffer.from(
        `<< ${dictionary} /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      ),
      compressed,
      Buffer.from("\nendstream"),
    ]);
  }

  registerFont(font, baseFont) {
    const usage = new FontUsage(font, `F${this.fonts.length + 1}`);
    this.fonts.push({ usage, baseFont, objectNumber: this.reserveObject() });
    return usage;
  }

  /**
   * @param {{ runs: Array<{ usage: FontUsage, size: number, x: number, y: number, text: string }>,
   *           lines?: Array<{ x1: number, y1: number, x2: number, y2: number, width?: number }> }} page
   */
  addPage(page) {
    const operations = [];
    for (const line of page.lines ?? []) {
      operations.push(
        `q ${(line.width ?? 0.5).toFixed(2)} w ${line.x1.toFixed(2)} ${line.y1.toFixed(2)} m ` +
          `${line.x2.toFixed(2)} ${line.y2.toFixed(2)} l S Q`,
      );
    }
    for (const run of page.runs) {
      const glyphs = run.usage.encode(run.text);
      if (glyphs.length === 0) continue;
      operations.push(
        `BT /${run.usage.resourceName} ${run.size} Tf ${run.x.toFixed(2)} ${run.y.toFixed(2)} Td ` +
          `<${glyphHex(glyphs)}> Tj ET`,
      );
    }
    this.pages.push(operations.join("\n"));
  }

  embedFont({ usage, baseFont, objectNumber }) {
    const { font } = usage;
    const fileNumber = this.addObject(
      this.streamObject(`/Length1 ${font.program.length}`, font.program),
    );
    const flags = (font.metrics.fixedPitch ? 1 : 0) | 4;
    const descriptorNumber = this.addObject(
      `<< /Type /FontDescriptor /FontName /${baseFont} /Flags ${flags} ` +
        `/FontBBox [${font.metrics.bbox.join(" ")}] /ItalicAngle ${font.metrics.italicAngle} ` +
        `/Ascent ${font.metrics.ascent} /Descent ${font.metrics.descent} ` +
        `/CapHeight ${font.metrics.capHeight} /StemV 80 /FontFile2 ${fileNumber} 0 R >>`,
    );
    const defaultWidth = 600;
    const widths = [...usage.glyphToCodePoint.keys()]
      .sort((a, b) => a - b)
      .filter((glyph) => font.advanceWidth(glyph) !== defaultWidth)
      .map((glyph) => `${glyph} [${font.advanceWidth(glyph)}]`)
      .join(" ");
    const cidFontNumber = this.addObject(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptorNumber} 0 R /DW ${defaultWidth} /W [${widths}] ` +
        `/CIDToGIDMap /Identity >>`,
    );
    const toUnicodeNumber = this.addObject(
      this.streamObject("", Buffer.from(buildToUnicode(usage), "latin1")),
    );
    this.setObject(
      objectNumber,
      `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H ` +
        `/DescendantFonts [${cidFontNumber} 0 R] /ToUnicode ${toUnicodeNumber} 0 R >>`,
    );
  }

  render() {
    for (const font of this.fonts) this.embedFont(font);
    const fontResources = this.fonts
      .map((font) => `/${font.usage.resourceName} ${font.objectNumber} 0 R`)
      .join(" ");
    const pagesNumber = this.reserveObject();
    const pageNumbers = this.pages.map((content) => {
      const contentNumber = this.addObject(this.streamObject("", Buffer.from(content, "latin1")));
      return this.addObject(
        `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
          `/Resources << /Font << ${fontResources} >> >> /Contents ${contentNumber} 0 R >>`,
      );
    });
    this.setObject(
      pagesNumber,
      `<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] >>`,
    );
    const catalogNumber = this.addObject(
      `<< /Type /Catalog /Pages ${pagesNumber} 0 R /PageMode /UseNone /Lang (ru-RU) >>`,
    );
    const { title, author, subject, creator, creationDate } = this.info;
    const infoNumber = this.addObject(
      `<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Subject ${pdfString(subject)} ` +
        `/Creator ${pdfString(creator)} /Producer ${pdfString(creator)} ` +
        `/CreationDate (${pdfDate(creationDate)}) /ModDate (${pdfDate(creationDate)}) >>`,
    );

    const chunks = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [];
    this.objects.forEach((body, index) => {
      if (body === null) throw new Error(`PDF object ${index + 1} was reserved but never written`);
      offsets.push(offset);
      const chunk = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`),
        Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"),
        Buffer.from("\nendobj\n"),
      ]);
      chunks.push(chunk);
      offset += chunk.length;
    });
    const xrefOffset = offset;
    const xref = [
      "xref",
      `0 ${this.objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    ].join("\n");
    const id = createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(0, 32);
    chunks.push(
      Buffer.from(
        `${xref}\ntrailer\n<< /Size ${this.objects.length + 1} /Root ${catalogNumber} 0 R ` +
          `/Info ${infoNumber} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ),
    );
    return Buffer.concat(chunks);
  }
}
