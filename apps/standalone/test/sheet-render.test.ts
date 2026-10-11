import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  type MonoBitmap,
  type MonoRaster,
  type RasterizeTextFn,
} from "@markiro/domain";

import { sheetLogoOf } from "../src/labels/logo.js";
import { RasterUnavailableError } from "../src/labels/rasterizer.js";
import {
  downsampleMonoRaster,
  paintMonoRaster,
  renderSheetBytes,
  renderSheetRaster,
  sampleSheetContext,
} from "../src/labels/sheet-render.js";

/** A text as a bar one dot per character wide and one line high: enough to lay out a sheet. */
const fakeRasterize: RasterizeTextFn = async (text, options) => {
  const width = Math.max(1, Math.min(text.length * 4, options.maxWidthPx ?? text.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };
const OTHER_LOGO: MonoBitmap = {
  width: 16,
  height: 8,
  stride: 2,
  pixels: new Uint8Array(16).fill(0x0f),
};
const ORGANIZATION = { name: "ООО «Пример»", inn: "7700000000" };

function firstPreset() {
  const [preset] = buildPalletSheetPresets();
  if (preset === undefined) throw new Error("no stock sheet");
  return preset;
}

afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
});

describe("renderSheetRaster", () => {
  it.each(buildPalletSheetPresets().map((preset) => [preset.key, preset] as const))(
    "renders the stock sheet %s at A4 300 dpi",
    async (_key, preset) => {
      const context = sampleSheetContext(ORGANIZATION, sheetLogoOf(LOGO, "organization"));
      const raster = await renderSheetRaster(preset.spec, context, fakeRasterize);
      const portrait = preset.spec.page.orientation === "portrait";
      expect(raster.dpi).toBe(300);
      expect([raster.widthMm, raster.heightMm]).toEqual(portrait ? [210, 297] : [297, 210]);
      const bytes = await renderSheetBytes(preset.spec, context, fakeRasterize);
      expect(decodeMonoRaster(bytes).widthDots).toBe(raster.widthDots);
    },
  );

  it("prints the logo it is given: the organization's differs from Markiro's, the same one repeats", async () => {
    const preset = firstPreset();
    const render = (logo: MonoBitmap, source: "organization" | "markiro") =>
      renderSheetBytes(
        preset.spec,
        sampleSheetContext(ORGANIZATION, sheetLogoOf(logo, source)),
        fakeRasterize,
      );
    const own = await render(LOGO, "organization");
    const markiro = await render(OTHER_LOGO, "markiro");
    expect(Buffer.compare(own, markiro)).not.toBe(0);
    expect(Buffer.compare(own, await render(LOGO, "organization"))).toBe(0);
  });

  it("freezes the SSCC bars on the sheet as ink", async () => {
    const preset = firstPreset();
    const raster = await renderSheetRaster(
      preset.spec,
      sampleSheetContext(ORGANIZATION, sheetLogoOf(LOGO, "organization")),
      fakeRasterize,
    );
    expect(raster.pixels.some((byte) => byte !== 0)).toBe(true);
  });

  it("draws its text with the bundled face only: a face that did not load refuses the sheet", async () => {
    // A canvas that would draw, so only the face check can refuse.
    const realGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: () => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        measureText: (line: string) => ({ width: line.length * 4 }),
        fillRect: () => undefined,
        fillText: () => undefined,
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      }),
    });
    try {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { load: async () => [], check: () => true },
      });
      await expect(
        renderSheetRaster(
          firstPreset().spec,
          sampleSheetContext(ORGANIZATION, sheetLogoOf(LOGO, "organization")),
        ),
      ).rejects.toBeInstanceOf(RasterUnavailableError);
    } finally {
      if (realGetContext !== undefined) {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", realGetContext);
      }
    }
  });
});

describe("sampleSheetContext", () => {
  it("is never a code of production and carries the organization it was given", () => {
    const logo = sheetLogoOf(LOGO, "markiro");
    const context = sampleSheetContext({ name: "ООО «Пример»", inn: null }, logo);
    expect(context.sscc).toHaveLength(18);
    expect(context.sscc.slice(1, 5)).toBe("9999");
    expect(context.organizationName).toBe("ООО «Пример»");
    expect(context.organizationInn).toBeNull();
    expect(context.logo).toBe(logo);
    expect(sampleSheetContext(ORGANIZATION, logo).organizationInn).toBe("7700000000");
  });
});

/** A 10 × 3 page: the dots (0, 0) and (9, 2), and a stray bit in the first row's padding (x = 15). */
function tinyRaster(): MonoRaster {
  return {
    format: "mono-raster-v1",
    widthMm: 10,
    heightMm: 3,
    dpi: 300,
    widthDots: 10,
    heightDots: 3,
    stride: 2,
    requiredBounds: { left: 0, top: 0, right: 10, bottom: 3 },
    pixels: Uint8Array.from([0b1000_0000, 0b0000_0001, 0, 0, 0, 0b0100_0000]),
  };
}

describe("downsampleMonoRaster", () => {
  it("paints an output pixel black when any dot of its square is black", async () => {
    const preset = firstPreset();
    const raster = await renderSheetRaster(
      preset.spec,
      sampleSheetContext({ name: "ООО «Пример»", inn: null }, sheetLogoOf(LOGO, "markiro")),
      fakeRasterize,
    );
    const small = downsampleMonoRaster(raster, 4);
    expect(small.width).toBe(Math.ceil(raster.widthDots / 4));
    expect(small.data.length).toBe(small.width * small.height * 4);
    // The SSCC bars are ink somewhere on the sheet.
    expect(small.data.some((value, index) => index % 4 === 0 && value === 0)).toBe(true);
  });

  it("maps each dot to its square, keeps white white and ignores the padding bits", () => {
    const small = downsampleMonoRaster(tinyRaster(), 4);
    expect([small.width, small.height]).toEqual([3, 1]);
    const pixel = (x: number) => Array.from(small.data.subarray(x * 4, x * 4 + 4));
    expect(pixel(0)).toEqual([0, 0, 0, 255]);
    expect(pixel(1)).toEqual([255, 255, 255, 255]);
    // Dot (9, 2) falls in the third square.
    expect(pixel(2)).toEqual([0, 0, 0, 255]);
    const whole = downsampleMonoRaster(tinyRaster(), 1);
    expect([whole.width, whole.height]).toEqual([10, 3]);
    const inked = Array.from({ length: 30 }, (_value, index) => whole.data[index * 4]).flatMap(
      (value, index) => (value === 0 ? [index] : []),
    );
    expect(inked).toEqual([0, 29]);
  });

  it("refuses a factor that is not a whole number of at least 1", () => {
    for (const factor of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => downsampleMonoRaster(tinyRaster(), factor)).toThrow(RangeError);
    }
  });
});

describe("paintMonoRaster", () => {
  it("sizes the canvas to the shrunk sheet and puts its pixels on it", () => {
    const put = vi.fn();
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", { value: () => ({ putImageData: put }) });
    paintMonoRaster(canvas, tinyRaster(), 4);
    expect([canvas.width, canvas.height]).toEqual([3, 1]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toMatchObject({ width: 3, height: 1 });
    expect(put.mock.calls[0]?.[1]).toBe(0);
    expect(put.mock.calls[0]?.[2]).toBe(0);
    vi.unstubAllGlobals();
  });

  it("draws nothing on a canvas the webview will not give a context", () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", { value: () => null });
    expect(() => paintMonoRaster(canvas, tinyRaster(), 4)).not.toThrow();
    expect([canvas.width, canvas.height]).toEqual([3, 1]);
  });
});
