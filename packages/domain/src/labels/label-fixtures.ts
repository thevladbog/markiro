/**
 * Label rendering cases the handheld's Kotlin `ZplEmitter` and `TsplEmitter`
 * must reproduce. Exported to
 * `apps/handheld/app/src/test/resources/label-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:labels`;
 * `test/label-fixtures.test.ts` fails when the committed JSON drifts.
 *
 * Two groups. `byteIdentical` holds specs whose every text run is printable
 * ASCII: no image command is emitted, both documents are printable text, and
 * the Kotlin port must produce them character for character. `structural`
 * holds specs with Cyrillic: the emitted image payload comes from the
 * platform's font engine, which on Android is a third implementation next to
 * the browser canvas the station and the cabinet preview share, so only the
 * command framing and the bitmap's dimensions and placement are pinned.
 */
import { generateTspl } from "./tspl.js";
import { generateZpl } from "./zpl.js";
import type { LabelField, LabelTemplateSpec } from "./model.js";
import type { RasterResult, RasterizeTextOptions } from "./raster-types.js";

export interface ByteIdenticalFixture {
  name: string;
  spec: LabelTemplateSpec;
  data: Record<LabelField, string>;
  zpl: string;
  tspl: string;
}

export interface RasterCall {
  text: string;
  fontSizePx: number;
  bold: boolean;
  maxWidthPx: number | null;
  maxLines: number;
}

export interface StructuralFixture {
  name: string;
  spec: LabelTemplateSpec;
  data: Record<LabelField, string>;
  /** Every rasterizeText call the emitters make, in order, from the ZPL pass. */
  rasterCalls: RasterCall[];
  /** The ZPL document with each `^GFA` payload replaced by `<hex:N>` where N is its length. */
  zplShape: string;
  /** The TSPL document's commands, one per entry, with each image payload replaced by its length. */
  tsplShape: string[];
}

export interface LabelFixtures {
  byteIdentical: ByteIdenticalFixture[];
  structural: StructuralFixture[];
}

const DATA: Record<LabelField, string> = {
  "product.name": "Вода питьевая 0,5 л",
  "product.printName": "Вода 0,5",
  "product.gtin": "04600682000013",
  "product.egais": "0101234567890123456",
  "km.code": "010460068200001321abcDEF1234567",
  sscc: "346006820000000014",
  "shift.no": "214",
  date: "23.07.2026",
  expiry: "19.01.2027",
  qty: "20",
  operator: "Smirnov A.",
  "counterparty.name": "Zavod Partner",
};

function spec(elements: LabelTemplateSpec["elements"], dpi: 203 | 300 = 203): LabelTemplateSpec {
  return { widthMm: 58, heightMm: 40, dpi, language: "zpl", elements };
}

/**
 * A deterministic stand-in for a font engine: every glyph is a fixed box, so a
 * fixture records what the emitters DO with a bitmap, never what a rasterizer
 * draws. Honours the maxWidthPx contract by clamping.
 */
function stubRasterizer(calls: RasterCall[]) {
  return (text: string, opts: RasterizeTextOptions): Promise<RasterResult> => {
    calls.push({
      text,
      fontSizePx: opts.fontSizePx,
      bold: opts.bold,
      maxWidthPx: opts.maxWidthPx ?? null,
      maxLines: opts.maxLines ?? 1,
    });
    const natural = Math.max(1, Array.from(text).length) * Math.ceil(opts.fontSizePx * 0.5);
    const width = opts.maxWidthPx === undefined ? natural : Math.min(natural, opts.maxWidthPx);
    const height = Math.ceil(opts.fontSizePx * 1.5);
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    return Promise.resolve({
      hex: "A5".repeat(totalBytes),
      totalBytes,
      bytesPerRow,
      width,
      height,
    });
  };
}

function asciiCases(): { name: string; spec: LabelTemplateSpec }[] {
  return [
    {
      name: "plain text and a field",
      spec: spec([
        { kind: "text", id: "t1", xMm: 2, yMm: 2, text: "ACME Foods", fontSizePt: 12 },
        { kind: "field", id: "f1", xMm: 2, yMm: 10, field: "product.gtin", fontSizePt: 10 },
      ]),
    },
    {
      name: "wrapped and aligned text",
      spec: spec([
        {
          kind: "text",
          id: "t1",
          xMm: 2,
          yMm: 2,
          text: "Cold storage keep upright",
          fontSizePt: 9,
          maxWidthMm: 30,
          maxLines: 3,
          align: "center",
        },
        {
          kind: "text",
          id: "t2",
          xMm: 2,
          yMm: 20,
          text: "Right",
          fontSizePt: 9,
          maxWidthMm: 30,
          align: "right",
        },
      ]),
    },
    {
      name: "sscc barcode with a module width",
      spec: spec([
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: "sscc",
          sizeMm: 15,
          moduleWidthMm: 0.25,
        },
        { kind: "field", id: "f1", xMm: 4, yMm: 30, field: "sscc", fontSizePt: 8 },
      ]),
    },
    {
      name: "literal barcode without a module width",
      spec: spec([
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: { literal: "ABC-123" },
          sizeMm: 10,
        },
      ]),
    },
    {
      name: "lines and boxes including a reversed line",
      spec: spec([
        { kind: "line", id: "l1", xMm: 0, yMm: 20, x2Mm: 58, y2Mm: 20, thicknessMm: 0.25 },
        { kind: "line", id: "l2", xMm: 40, yMm: 30, x2Mm: 10, y2Mm: 30, thicknessMm: 0.5 },
        { kind: "box", id: "x1", xMm: 0, yMm: 0, widthMm: 58, heightMm: 40, thicknessMm: 0.25 },
      ]),
    },
    {
      name: "negative and half millimetre coordinates at 300 dpi",
      spec: spec(
        [
          { kind: "text", id: "t1", xMm: -1.5, yMm: 2.5, text: "Edge", fontSizePt: 8 },
          {
            kind: "box",
            id: "x1",
            xMm: 0.5,
            yMm: 0.5,
            widthMm: 10.5,
            heightMm: 5.5,
            thicknessMm: 0.5,
          },
        ],
        300,
      ),
    },
    {
      name: "text needing zpl hex escapes",
      spec: spec([{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "A^B~C_D", fontSizePt: 10 }]),
    },
    {
      name: "text needing tspl quote escapes",
      spec: spec([{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: 'Say "hi"', fontSizePt: 10 }]),
    },
    {
      name: "empty element list",
      spec: spec([]),
    },
  ];
}

function cyrillicCases(): { name: string; spec: LabelTemplateSpec }[] {
  return [
    {
      name: "cyrillic product name unbounded",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 2, field: "product.name", fontSizePt: 12 },
      ]),
    },
    {
      name: "cyrillic product name centred in a box",
      spec: spec([
        {
          kind: "field",
          id: "f1",
          xMm: 2,
          yMm: 2,
          field: "product.name",
          fontSizePt: 10,
          maxWidthMm: 40,
          maxLines: 2,
          align: "center",
        },
      ]),
    },
    {
      name: "qty always rasterizes because of its unit suffix",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 20, field: "qty", fontSizePt: 9, bold: true },
      ]),
    },
    {
      name: "cyrillic beside an ascii barcode",
      spec: spec([
        { kind: "field", id: "f1", xMm: 2, yMm: 2, field: "product.name", fontSizePt: 10 },
        {
          kind: "barcode",
          id: "b1",
          xMm: 4,
          yMm: 12,
          format: "code128",
          data: "sscc",
          sizeMm: 15,
          moduleWidthMm: 0.25,
        },
      ]),
    },
  ];
}

const GFA = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]*)/g;

function reduceZpl(document: string): string {
  return document.replace(
    GFA,
    (_m, a, b, c, hex: string) => `^GFA,${a},${b},${c},<hex:${hex.length}>`,
  );
}

/**
 * TSPL carries the bitmap as raw bytes, so this cannot split on newlines: a 0x0A inside
 * the payload would look like a line ending and leave the rest of the image masquerading
 * as its own command. The scanner reads an image command's parameters, computes the exact
 * payload length from them, and skips that many bytes.
 */
function reduceTspl(document: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < document.length) {
    if (document.startsWith("BITMAP ", index)) {
      let commas = 0;
      let cursor = index;
      while (cursor < document.length && commas < 5) {
        if (document[cursor] === ",") commas += 1;
        cursor += 1;
      }
      const header = document.slice(index, cursor);
      const params = header.slice("BITMAP ".length).split(",");
      const payloadLength = Number(params[2]) * Number(params[3]);
      out.push(`${header}<payload:${payloadLength}>`);
      // Skip the payload and the newline that follows it.
      index = cursor + payloadLength + 1;
      continue;
    }
    const end = document.indexOf("\n", index);
    const line = end === -1 ? document.slice(index) : document.slice(index, end);
    if (line !== "") out.push(line);
    index = end === -1 ? document.length : end + 1;
  }
  return out;
}

export async function buildLabelFixtures(): Promise<LabelFixtures> {
  const byteIdentical: ByteIdenticalFixture[] = [];
  for (const { name, spec: s } of asciiCases()) {
    byteIdentical.push({
      name,
      spec: s,
      data: DATA,
      zpl: await generateZpl(s, DATA),
      tspl: await generateTspl(s, DATA),
    });
  }
  const structural: StructuralFixture[] = [];
  for (const { name, spec: s } of cyrillicCases()) {
    const calls: RasterCall[] = [];
    const zpl = await generateZpl(s, DATA, { rasterizeText: stubRasterizer(calls) });
    const tspl = await generateTspl(s, DATA, { rasterizeText: stubRasterizer([]) });
    structural.push({
      name,
      spec: s,
      data: DATA,
      rasterCalls: calls,
      zplShape: reduceZpl(zpl),
      tsplShape: reduceTspl(tspl),
    });
  }
  return { byteIdentical, structural };
}
