import { readFile } from "node:fs/promises";

import { Font, Glyph } from "opentype.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkCyrillicCoverage,
  checkFamilyCoverage,
  CYRILLIC_SAMPLE,
  FONT_SUBSET_URLS,
  sampleCoveredByFont,
} from "../src/labels/font-coverage.js";
import {
  mapFontFamily,
  MAX_RASTER_DOTS,
  RasterTooLargeError,
  RasterUnavailableError,
  rasterizeText,
} from "../src/labels/rasterizer.js";

/** A real, serializable font of `.notdef` and one glyph per character: no outlines, no file. */
function syntheticFont(chars: readonly string[]): Font {
  const glyphs = [new Glyph({ name: ".notdef", advanceWidth: 500 })];
  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    glyphs.push(new Glyph({ name: `g${codePoint}`, unicode: codePoint, advanceWidth: 500 }));
  }
  return new Font({
    familyName: "MarkiroSyntheticTestFont",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
}

/** Answers each `fetch` with the next buffer, as a successful response. */
function answerFetches(buffers: readonly ArrayBuffer[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const buffer = buffers[call];
    call += 1;
    return { ok: true, status: 200, arrayBuffer: async () => buffer };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The file behind a font's asset URL. Vite serves a file outside the app's
 * root as `/@fs/<absolute path>` in tests; the build gives it `/assets/…`.
 */
async function bundledFile(url: string): Promise<ArrayBuffer> {
  const bytes = await readFile(decodeURIComponent(url.replace(/^\/@fs/, "")));
  return new Uint8Array(bytes).buffer;
}

interface FakeSurface {
  width: number;
  height: number;
  kind: string;
  font: string;
  fillStyle: string;
  textBaseline: string;
  rects: { rect: number[]; fillStyle: string }[];
  texts: { text: string; x: number; y: number; fillStyle: string; textBaseline: string }[];
  reads: number[][];
  measureText(line: string): { width: number };
  fillRect(...rect: number[]): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
}

/** The jsdom canvas's `getContext` as `test/setup.ts` left it, saved before each test. */
let realGetContext: PropertyDescriptor = {};

beforeEach(() => {
  const saved = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (saved === undefined) throw new Error("test/setup.ts defines no canvas getContext");
  realGetContext = saved;
});

/**
 * jsdom has no canvas: every `<canvas>` the rasterizer makes gets a recording
 * surface that measures a character as `charWidth` dots and answers
 * `getImageData` with a white bitmap whose first column is black. The surfaces
 * come back in creation order: the 1x1 measuring one first, the drawing one
 * second.
 */
function fakeCanvases({
  charWidth = 10,
  measureFails,
}: {
  charWidth?: number | ((fontPx: number) => number);
  measureFails?: () => never;
} = {}): FakeSurface[] {
  const surfaces: FakeSurface[] = [];
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement, kind: string): FakeSurface {
      const surface: FakeSurface = {
        width: this.width,
        height: this.height,
        kind,
        font: "",
        fillStyle: "",
        textBaseline: "",
        rects: [],
        texts: [],
        reads: [],
        measureText: (line) => {
          if (measureFails) measureFails();
          // The width follows the font set on this very context, as a real one's does.
          const fontPx = Number(/(\d+)px/.exec(surface.font)?.[1] ?? 0);
          const perChar = typeof charWidth === "function" ? charWidth(fontPx) : charWidth;
          return { width: line.length * perChar };
        },
        fillRect: (...rect) => {
          surface.rects.push({ rect, fillStyle: surface.fillStyle });
        },
        fillText: (text, x, y) => {
          surface.texts.push({
            text,
            x,
            y,
            fillStyle: surface.fillStyle,
            textBaseline: surface.textBaseline,
          });
        },
        getImageData: (x, y, width, height) => {
          surface.reads.push([x, y, width, height]);
          const data = new Uint8ClampedArray(width * height * 4).fill(255);
          for (let row = 0; row < height; row += 1)
            data.fill(0, row * width * 4, row * width * 4 + 3);
          return { data };
        },
      };
      surfaces.push(surface);
      return surface;
    },
  });
  return surfaces;
}

/** The ZPL hex of `fakeCanvases`' bitmap: the first column black, so each row is 0x80 then zeros. */
function firstColumnHex(width: number, height: number): string {
  return ("80" + "00".repeat(Math.ceil(width / 8) - 1)).repeat(height);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", realGetContext);
});

describe("the text rasterizer", () => {
  it("refuses with RasterUnavailableError where the webview gives no 2D canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const outcome = rasterizeText("Партия", {
      fontFamily: "sans-serif",
      fontSizePx: 34,
      bold: false,
    });
    await expect(outcome).rejects.toBeInstanceOf(RasterUnavailableError);
    await expect(outcome).rejects.toHaveProperty("name", "RasterUnavailableError");
  });

  it("loads the bundled face for the text's own script before it draws", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const load = vi.fn(async () => []);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    try {
      await rasterizeText("Партия", { fontFamily: "sans-serif", fontSizePx: 34, bold: true }).catch(
        () => undefined,
      );
      expect(load).toHaveBeenCalledWith("700 34px IBM Plex Sans, sans-serif", "Партия");
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("maps the generic families the domain asks for to the bundled IBM Plex faces", () => {
    expect(mapFontFamily("sans-serif")).toBe("IBM Plex Sans, sans-serif");
    expect(mapFontFamily("monospace")).toBe("IBM Plex Mono, monospace");
    expect(mapFontFamily("IBM Plex Sans")).toBe("IBM Plex Sans");
  });
});

describe("the text rasterizer's drawing", () => {
  const font = "400 21px IBM Plex Sans, sans-serif";

  it("draws a canvas of up to 4096 dots on a side, and refuses a larger one before making it", async () => {
    const fits = fakeCanvases({ charWidth: 1 });
    await rasterizeText("Ш".repeat(MAX_RASTER_DOTS), {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    expect(fits.map((s) => s.width)).toEqual([1, 4096]);

    const wide = fakeCanvases({ charWidth: 1 });
    const tooWide = rasterizeText("Ш".repeat(MAX_RASTER_DOTS + 1), {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    await expect(tooWide).rejects.toBeInstanceOf(RasterTooLargeError);
    await expect(tooWide).rejects.toMatchObject({ width: 4097, height: 32 });
    // Only the 1x1 measuring canvas was made.
    expect(wide.map((s) => [s.width, s.height])).toEqual([[1, 1]]);

    // 2731 px of font is a line of ceil(2731 x 1.5) = 4097 dots.
    const tall = fakeCanvases();
    await expect(
      rasterizeText("Ш", { fontFamily: "sans-serif", fontSizePx: 2731, bold: false }),
    ).rejects.toMatchObject({ name: "RasterTooLargeError", height: 4097 });
    expect(tall).toHaveLength(1);
    // Sixteen lines of a 171 px font: 16 x 257 = 4112 dots.
    fakeCanvases({ charWidth: 100 });
    await expect(
      rasterizeText("а б в г д е ж з и к л м н о п р", {
        fontFamily: "sans-serif",
        fontSizePx: 171,
        bold: false,
        maxWidthPx: 150,
        maxLines: 16,
      }),
    ).rejects.toMatchObject({ height: 4112 });
  });

  it("draws one unbounded line black on white and packs exactly what it read back", async () => {
    const surfaces = fakeCanvases();
    const raster = await rasterizeText("Партия", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    expect(surfaces.map((s) => [s.width, s.height, s.kind])).toEqual([
      [1, 1, "2d"],
      [60, 32, "2d"],
    ]);
    const [measuring, drawing] = surfaces;
    expect(measuring?.font).toBe(font);
    expect(drawing?.font).toBe(font);
    expect(drawing?.rects).toEqual([{ rect: [0, 0, 60, 32], fillStyle: "#ffffff" }]);
    expect(drawing?.texts).toEqual([
      { text: "Партия", x: 0, y: 16, fillStyle: "#000000", textBaseline: "middle" },
    ]);
    expect(drawing?.reads).toEqual([[0, 0, 60, 32]]);
    expect(raster).toEqual({
      hex: firstColumnHex(60, 32),
      totalBytes: 8 * 32,
      bytesPerRow: 8,
      width: 60,
      height: 32,
    });
  });

  it("draws bold text in weight 700", async () => {
    const surfaces = fakeCanvases();
    await rasterizeText("Партия", { fontFamily: "monospace", fontSizePx: 21, bold: true });
    expect(surfaces.map((s) => s.font)).toEqual([
      "700 21px IBM Plex Mono, monospace",
      "700 21px IBM Plex Mono, monospace",
    ]);
  });

  it("wraps to maxWidthPx and maxLines, ends a cut line in an ellipsis and sizes the box to it", async () => {
    const surfaces = fakeCanvases();
    const raster = await rasterizeText("aaaa bbbbbb cccc", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
      maxWidthPx: 100,
      maxLines: 2,
    });
    const drawing = surfaces[1];
    expect(drawing?.texts.map((t) => [t.text, t.x, t.y])).toEqual([
      ["aaaa", 0, 16],
      ["bbbbbb…", 0, 48],
    ]);
    expect([drawing?.width, drawing?.height]).toEqual([70, 64]);
    expect(drawing?.rects).toEqual([{ rect: [0, 0, 70, 64], fillStyle: "#ffffff" }]);
    expect(drawing?.reads).toEqual([[0, 0, 70, 64]]);
    expect(raster).toEqual({
      hex: firstColumnHex(70, 64),
      totalBytes: 9 * 64,
      bytesPerRow: 9,
      width: 70,
      height: 64,
    });
  });

  it("keeps one line when maxLines is not given", async () => {
    const surfaces = fakeCanvases();
    await rasterizeText("aaaa bbbbbb cccc", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
      maxWidthPx: 100,
    });
    expect(surfaces[1]?.texts.map((t) => t.text)).toEqual(["aaaa…"]);
    expect([surfaces[1]?.width, surfaces[1]?.height]).toEqual([50, 32]);
  });

  it("never makes the bitmap wider than maxWidthPx, nor narrower than one dot", async () => {
    // Whitespace only measures 30 dots but is a single unwrapped line: the clamp keeps it at 20.
    const wide = fakeCanvases();
    const clamped = await rasterizeText("   ", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
      maxWidthPx: 20,
    });
    expect(clamped.width).toBe(20);
    expect([wide[1]?.width, wide[1]?.height]).toEqual([20, 32]);
    // A glyph wider than the box is cut to nothing: still one dot wide, so the bitmap is valid.
    const narrow = fakeCanvases();
    const cut = await rasterizeText("ПП", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
      maxWidthPx: 5,
    });
    expect(cut.width).toBe(1);
    expect([narrow[1]?.width, narrow[1]?.height]).toEqual([1, 32]);
    // Empty text is a one-dot bitmap too.
    fakeCanvases();
    expect(
      (await rasterizeText("", { fontFamily: "sans-serif", fontSizePx: 21, bold: false })).width,
    ).toBe(1);
  });

  it("keeps a line that is exactly maxWidthPx wide whole", async () => {
    for (const text of ["aaaaaaaaaa", "aaaa bbbbb"]) {
      const surfaces = fakeCanvases();
      await rasterizeText(text, {
        fontFamily: "sans-serif",
        fontSizePx: 21,
        bold: false,
        maxWidthPx: 100,
      });
      expect(surfaces[1]?.texts.map((t) => t.text)).toEqual([text]);
      expect([surfaces[1]?.width, surfaces[1]?.height]).toEqual([100, 32]);
    }
  });

  it("cuts a line that is a hair wider than maxWidthPx", async () => {
    const surfaces = fakeCanvases({ charWidth: 10.05 });
    await rasterizeText("aaaaaaaaaa", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
      maxWidthPx: 100,
    });
    expect(surfaces[1]?.texts.map((t) => t.text)).toEqual(["aaaaaaaa…"]);
    expect(surfaces[1]?.width).toBe(91);
  });

  it("does not wrap without a positive maxWidthPx", async () => {
    for (const maxWidthPx of [undefined, 0, -5]) {
      const surfaces = fakeCanvases();
      const raster = await rasterizeText("aaaa bbbbbb cccc", {
        fontFamily: "sans-serif",
        fontSizePx: 21,
        bold: false,
        maxWidthPx,
        maxLines: 3,
      });
      expect(surfaces[1]?.texts.map((t) => t.text)).toEqual(["aaaa bbbbbb cccc"]);
      expect([raster.width, raster.height]).toEqual([160, 32]);
    }
  });

  it("rounds a fractional measure up to a whole dot, so no ink is clipped", async () => {
    const surfaces = fakeCanvases({ charWidth: 10.4 });
    const raster = await rasterizeText("Партия", {
      fontFamily: "sans-serif",
      fontSizePx: 21,
      bold: false,
    });
    expect([surfaces[1]?.width, raster.width, raster.bytesPerRow]).toEqual([63, 63, 8]);
  });

  it("waits for the face to load before it makes a canvas", async () => {
    const surfaces = fakeCanvases();
    let loaded: () => void = () => undefined;
    const load = vi.fn(() => new Promise<void>((resolve) => (loaded = resolve)));
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    try {
      const pending = rasterizeText("Партия", {
        fontFamily: "sans-serif",
        fontSizePx: 21,
        bold: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(load).toHaveBeenCalledTimes(1);
      expect(surfaces).toHaveLength(0);
      loaded();
      await pending;
      expect(surfaces).toHaveLength(2);
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("draws anyway when the face fails to load", async () => {
    const surfaces = fakeCanvases();
    const load = vi.fn(async () => {
      throw new Error("no such face");
    });
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    try {
      await expect(
        rasterizeText("Партия", { fontFamily: "sans-serif", fontSizePx: 21, bold: false }),
      ).resolves.toMatchObject({ width: 60, height: 32 });
      expect(surfaces).toHaveLength(2);
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("rejects with an Error whatever was thrown, and keeps an Error as it was", async () => {
    fakeCanvases({
      measureFails: () => {
        throw "plain text";
      },
    });
    const options = { fontFamily: "sans-serif", fontSizePx: 21, bold: false };
    const thrown = rasterizeText("Партия", options);
    await expect(thrown).rejects.toBeInstanceOf(Error);
    await expect(thrown).rejects.toHaveProperty("message", "plain text");
    const own = new RasterUnavailableError("no canvas memory");
    fakeCanvases({
      measureFails: () => {
        throw own;
      },
    });
    await expect(rasterizeText("Партия", options)).rejects.toBe(own);
  });

  it("says what is missing, and keeps a message it was given", () => {
    expect(new RasterUnavailableError().message).toContain("2D canvas");
    expect(new RasterUnavailableError("gone").message).toBe("gone");
  });
});

describe("the text rasterizer's line height and shrink-to-fit (#703)", () => {
  // A character is half the font's size wide: 8 characters are 84 dots at 21 px, 68 at 17 px.
  const halfFont = (fontPx: number) => fontPx / 2;
  const options = { fontFamily: "sans-serif", bold: false } as const;

  it("sizes each line box by the element's line height, and keeps 1.5 em without one", async () => {
    const own = fakeCanvases();
    await rasterizeText("aaaa bbbb cccc", {
      ...options,
      fontSizePx: 20,
      maxWidthPx: 100,
      maxLines: 2,
      lineHeight: 1.2,
    });
    // ceil(20 x 1.2) = 24 a line, two lines.
    expect([own[1]?.width, own[1]?.height]).toEqual([90, 48]);
    expect(own[1]?.texts.map((t) => [t.text, t.y])).toEqual([
      ["aaaa bbbb", 12],
      ["cccc", 36],
    ]);

    const plain = fakeCanvases();
    await rasterizeText("aaaa bbbb cccc", {
      ...options,
      fontSizePx: 20,
      maxWidthPx: 100,
      maxLines: 2,
    });
    expect(plain[1]?.height).toBe(60); // 2 x ceil(20 x 1.5)
    expect(plain[1]?.texts.map((t) => t.y)).toEqual([15, 45]);
  });

  it("rounds the line box up to a whole dot", async () => {
    const surfaces = fakeCanvases();
    await rasterizeText("aaaa", { ...options, fontSizePx: 21, lineHeight: 1.1 });
    expect(surfaces[1]?.height).toBe(24); // ceil(23.1)
  });

  it("shrinks the font one dot at a time until the text fits its box, and draws at that size", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    const raster = await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 21,
      maxWidthPx: 70,
      minFontSizePx: 14,
    });
    // 84, 80, 76, 72 dots at 21..18 px do not fit 70; 68 at 17 px does.
    expect(surfaces.map((s) => s.font)).toEqual([
      "400 17px IBM Plex Sans, sans-serif",
      "400 17px IBM Plex Sans, sans-serif",
    ]);
    expect([raster.width, raster.height]).toEqual([68, 26]); // ceil(17 x 1.5)
    expect(surfaces[1]?.texts.map((t) => t.text)).toEqual(["abcdefgh"]);
  });

  it("takes a line height from the shrunk size, not the requested one", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 21,
      maxWidthPx: 70,
      minFontSizePx: 14,
      lineHeight: 1.2,
    });
    expect(surfaces[1]?.height).toBe(21); // ceil(17 x 1.2)
  });

  it("keeps the requested size when the text already fits, and when it fits exactly", async () => {
    const fits = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 21,
      maxWidthPx: 84,
      minFontSizePx: 14,
    });
    expect(fits[1]?.font).toBe("400 21px IBM Plex Sans, sans-serif");
    // 68 dots in a 68-dot box fit: only a wider text shrinks.
    const exact = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 17,
      maxWidthPx: 68,
      minFontSizePx: 14,
    });
    expect(exact[1]?.font).toBe("400 17px IBM Plex Sans, sans-serif");
  });

  it("shrinks down to the minimum, which is itself allowed", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 21,
      maxWidthPx: 56,
      minFontSizePx: 14,
    });
    // 8 x 7 = 56 dots at 14 px: the minimum fits exactly.
    expect(surfaces[1]?.font).toBe("400 14px IBM Plex Sans, sans-serif");
  });

  it("throws when the text still does not fit at the minimum size, and never goes below it", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await expect(
      rasterizeText("abcdefgh", { ...options, fontSizePx: 21, maxWidthPx: 70, minFontSizePx: 18 }),
    ).rejects.toThrow("Label quantity exceeds its box at minimum font size");
    // 72 dots at 18 px, which is the floor: 17 px would have fitted, and was not tried.
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.font).toBe("400 18px IBM Plex Sans, sans-serif");
  });

  it("does not shrink, nor throw, without a minimum: the text wraps and ends in an ellipsis", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", { ...options, fontSizePx: 21, maxWidthPx: 70 });
    expect(surfaces[1]?.font).toBe("400 21px IBM Plex Sans, sans-serif");
    expect(surfaces[1]?.texts.map((t) => t.text)).toEqual(["abcde…"]);
  });

  it("does not shrink an unbounded text", async () => {
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", { ...options, fontSizePx: 21, minFontSizePx: 14 });
    expect(surfaces[1]?.font).toBe("400 21px IBM Plex Sans, sans-serif");
    expect(surfaces[1]?.width).toBe(84);
  });

  it("measures the next size on the context it measures with", async () => {
    // The measure must follow the shrinking font; if it stayed at 21 px every size would
    // look too wide, and the loop would run to the floor.
    const surfaces = fakeCanvases({ charWidth: halfFont });
    await rasterizeText("abcdefgh", {
      ...options,
      fontSizePx: 21,
      maxWidthPx: 70,
      minFontSizePx: 10,
    });
    expect(surfaces[0]?.font).toBe("400 17px IBM Plex Sans, sans-serif");
  });
});

describe("the font coverage check", () => {
  it("finds a glyph for every character of the Cyrillic sample, or says one is missing", () => {
    expect(sampleCoveredByFont(syntheticFont([...CYRILLIC_SAMPLE]))).toBe(true);
    expect(sampleCoveredByFont(syntheticFont([...CYRILLIC_SAMPLE].filter((c) => c !== "ё")))).toBe(
      false,
    );
    expect(sampleCoveredByFont(syntheticFont([]))).toBe(false);
  });

  it("parses font bytes with opentype.js and checks them", () => {
    expect(checkCyrillicCoverage(syntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer())).toBe(true);
    expect(checkCyrillicCoverage(syntheticFont(["A", "B", "C"]).toArrayBuffer())).toBe(false);
  });

  it("reads both subsets of a family and passes when either covers the sample", async () => {
    const latin = syntheticFont(["A", "B"]).toArrayBuffer();
    const cyrillic = syntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer();
    const fetchMock = answerFetches([latin, cyrillic]);
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      ...FONT_SUBSET_URLS["IBM Plex Sans"],
    ]);
    answerFetches([latin, syntheticFont(["C"]).toArrayBuffer()]);
    await expect(checkFamilyCoverage("IBM Plex Mono")).resolves.toBe(false);
  });

  it("fails on a font file that did not load instead of parsing an error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => {
          throw new Error("the status is checked first");
        },
      })),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow(/HTTP 404/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no file");
      }),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow("no file");
  });

  it("checks the app's own WOFF files, never a network address or WOFF2", () => {
    for (const urls of Object.values(FONT_SUBSET_URLS)) {
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url.startsWith("/")).toBe(true);
        expect(url).toMatch(/ibm-plex-(sans|mono)-(latin|cyrillic)-400-normal\.woff$/);
      }
    }
  });

  it("finds Cyrillic in the bundled IBM Plex files themselves, in the Cyrillic subset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        arrayBuffer: () => bundledFile(url),
      })),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    await expect(checkFamilyCoverage("IBM Plex Mono")).resolves.toBe(true);
    const [latin, cyrillic] = FONT_SUBSET_URLS["IBM Plex Sans"];
    expect(checkCyrillicCoverage(await bundledFile(latin))).toBe(false);
    expect(checkCyrillicCoverage(await bundledFile(cyrillic))).toBe(true);
  });

  it("needs every letter of the sample, and the sample is the cloud's", () => {
    expect(CYRILLIC_SAMPLE).toBe("АЯЁЖЩыёя");
    expect([...CYRILLIC_SAMPLE]).toEqual(["А", "Я", "Ё", "Ж", "Щ", "ы", "ё", "я"]);
    for (const missing of CYRILLIC_SAMPLE) {
      const rest = [...CYRILLIC_SAMPLE].filter((char) => char !== missing);
      expect(sampleCoveredByFont(syntheticFont(rest))).toBe(false);
    }
  });

  it("checks the sample it is given, not only the default one", () => {
    const font = syntheticFont(["A", "B"]);
    expect(sampleCoveredByFont(font, "AB")).toBe(true);
    expect(sampleCoveredByFont(font, "ABC")).toBe(false);
    expect(checkCyrillicCoverage(font.toArrayBuffer(), "AB")).toBe(true);
    expect(checkCyrillicCoverage(font.toArrayBuffer(), "ABC")).toBe(false);
  });

  it("passes when the first subset alone covers the sample", async () => {
    answerFetches([
      syntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer(),
      syntheticFont(["A"]).toArrayBuffer(),
    ]);
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
  });

  it("pairs each family with its own Latin and Cyrillic files, Latin first", () => {
    const [sansLatin, sansCyrillic] = FONT_SUBSET_URLS["IBM Plex Sans"];
    const [monoLatin, monoCyrillic] = FONT_SUBSET_URLS["IBM Plex Mono"];
    expect(sansLatin).toContain("ibm-plex-sans-latin-");
    expect(sansCyrillic).toContain("ibm-plex-sans-cyrillic-");
    expect(monoLatin).toContain("ibm-plex-mono-latin-");
    expect(monoCyrillic).toContain("ibm-plex-mono-cyrillic-");
  });

  it("names the file and the status when a font file does not load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const [latin] = FONT_SUBSET_URLS["IBM Plex Sans"];
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow(
      `failed to fetch font subset ${latin}: HTTP 503`,
    );
  });
});

describe("the fake canvases of these tests", () => {
  // The two tests run one after the other, in this order: the second looks at
  // what the first left behind.
  it("are installed by a test that needs them", () => {
    fakeCanvases();
    expect(document.createElement("canvas").getContext("2d")).not.toBeNull();
  });

  it("are gone again in the next test, which finds jsdom's own quiet canvas", () => {
    expect(document.createElement("canvas").getContext("2d")).toBeNull();
  });
});
