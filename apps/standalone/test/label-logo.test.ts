import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sheetLogoFingerprint, type MonoBitmap } from "@markiro/domain";

import {
  decodeLogoFile,
  decodeLogoImage,
  fitLogoSize,
  labelLogo,
  logoFromWire,
  logoToWire,
  LogoDecodeError,
  MAX_LOGO_BASE64,
  MAX_LOGO_FILE_BYTES,
  MAX_LOGO_SOURCE_PIXELS,
  sheetLogoOf,
} from "../src/labels/logo.js";

/** 10 × 2 dots: stride 2, the last 6 bits of each row are padding (zero). */
const BITMAP: MonoBitmap = {
  width: 10,
  height: 2,
  stride: 2,
  pixels: Uint8Array.from([0b1111_0000, 0b1100_0000, 0b0000_1111, 0b0100_0000]),
};

afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logo on the wire", () => {
  it("round-trips a bitmap through its wire form", () => {
    const wire = logoToWire(BITMAP);
    expect(wire).toEqual({ width: 10, height: 2, pixelsBase64: "8MAPQA==" });
    expect(logoFromWire(wire)).toEqual(BITMAP);
  });

  it("reads nothing from a logo whose padding bits are set", () => {
    expect(logoFromWire({ width: 10, height: 2, pixelsBase64: "8MEPQA==" })).toBeNull();
  });

  it("reads nothing from a logo of the wrong length or size", () => {
    expect(logoFromWire({ width: 10, height: 3, pixelsBase64: "8MAPQA==" })).toBeNull();
    expect(logoFromWire({ width: 2000, height: 1, pixelsBase64: "AA==" })).toBeNull();
    expect(logoFromWire({ width: 8, height: 1, pixelsBase64: "not base64" })).toBeNull();
  });

  it("keeps the largest logo under the host's base64 bound", () => {
    // 1024 × 512 dots → 65 536 bytes → 87 384 base64 characters.
    expect(Math.ceil(((1024 / 8) * 512) / 3) * 4).toBeLessThanOrEqual(MAX_LOGO_BASE64);
  });

  it("writes the largest logo and reads it back", () => {
    const stride = 128;
    const full: MonoBitmap = {
      width: 1024,
      height: 512,
      stride,
      pixels: new Uint8Array(stride * 512).fill(0xaa),
    };
    const wire = logoToWire(full);
    expect(wire.pixelsBase64.length).toBeLessThanOrEqual(MAX_LOGO_BASE64);
    expect(logoFromWire(wire)).toEqual(full);
  });

  it("refuses to write a bitmap the domain would not print", () => {
    expect(() =>
      logoToWire({ ...BITMAP, pixels: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) }),
    ).toThrow();
  });

  it("reads nothing from a size outside 1..1024 × 1..512 or a fraction", () => {
    const row = (width: number, height: number) => {
      const bytes = Math.ceil(width / 8) * height;
      return { width, height, pixelsBase64: btoa("\0".repeat(bytes)) };
    };
    expect(logoFromWire(row(1024, 1))).not.toBeNull();
    expect(logoFromWire(row(1025, 1))).toBeNull();
    expect(logoFromWire(row(8, 512))).not.toBeNull();
    expect(logoFromWire(row(8, 513))).toBeNull();
    expect(logoFromWire({ ...row(8, 1), width: 0 })).toBeNull();
    expect(logoFromWire({ ...row(8, 1), height: 0 })).toBeNull();
    expect(logoFromWire({ ...row(8, 1), width: 8.5 })).toBeNull();
    expect(logoFromWire({ ...row(8, 1), height: Number.NaN })).toBeNull();
  });

  it("decodes nothing from a text over the bound, and only the canonical spelling", () => {
    const atobSpy = vi.spyOn(globalThis, "atob");
    // A long text of valid base64: refused by its length, before it is decoded.
    expect(
      logoFromWire({ width: 1024, height: 512, pixelsBase64: "A".repeat(MAX_LOGO_BASE64 + 4) }),
    ).toBeNull();
    expect(atobSpy).not.toHaveBeenCalled();
    // The same bytes with whitespace or without padding are not what the host stores.
    expect(logoFromWire({ width: 10, height: 2, pixelsBase64: "8MAP QA==" })).toBeNull();
    expect(logoFromWire({ width: 10, height: 2, pixelsBase64: "8MAPQA" })).toBeNull();
    expect(atobSpy).toHaveBeenCalled();
  });
});

describe("fitLogoSize", () => {
  it("shrinks to 1024 × 512 keeping the aspect, never enlarges", () => {
    expect(fitLogoSize(2048, 512)).toEqual({ width: 1024, height: 256 });
    expect(fitLogoSize(600, 1200)).toEqual({ width: 256, height: 512 });
    expect(fitLogoSize(300, 100)).toEqual({ width: 300, height: 100 });
  });

  it("never returns a zero side", () => {
    expect(fitLogoSize(4000, 1)).toEqual({ width: 1024, height: 1 });
    expect(fitLogoSize(1, 4000)).toEqual({ width: 1, height: 512 });
  });
});

describe("labelLogo", () => {
  it("prefers the organization's logo", async () => {
    const fallback = vi.fn(async () => BITMAP);
    await expect(labelLogo(BITMAP, fallback)).resolves.toBe(BITMAP);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to Markiro, and to nothing when Markiro does not load", async () => {
    await expect(labelLogo(null, async () => BITMAP)).resolves.toBe(BITMAP);
    await expect(
      labelLogo(null, async () => {
        throw new Error("no canvas");
      }),
    ).resolves.toBeNull();
  });
});

describe("sheetLogoOf", () => {
  it("names its source and the domain's fingerprint", () => {
    const logo = sheetLogoOf(BITMAP, "organization");
    expect(logo.source).toBe("organization");
    expect(logo.digest).toBe(sheetLogoFingerprint(BITMAP));
    expect(sheetLogoOf(BITMAP, "markiro").source).toBe("markiro");
  });
});

describe("the bundled Markiro print logo", () => {
  const testModuleUrl = import.meta.url;

  it("is the cloud station's file, byte for byte, pinned by its hash", () => {
    const bytes = readFileSync(new URL("../src/assets/markiro-print-logo.svg", testModuleUrl));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "d341de9b29681ccb62f5625c1ef1a934181f1e086556bba92b9230e6d6858f45",
    );
    const cloud = readFileSync(
      new URL("../../station/src/assets/markiro-print-logo.svg", testModuleUrl),
    );
    expect(Buffer.compare(bytes, cloud)).toBe(0);
  });
});

/** A canvas the logo is drawn on and an image of a given size, recording what the decoder did. */
function stubBrowser({
  naturalWidth = 280,
  naturalHeight = 64,
  decode = async () => undefined,
  context = true,
  loads = true,
}: {
  naturalWidth?: number;
  naturalHeight?: number;
  decode?: () => Promise<void>;
  context?: boolean;
  /** Whether the picture loads (`onload`) or not (`onerror`) once its `src` is set. */
  loads?: boolean;
} = {}) {
  const calls: string[] = [];
  const surfaces: { width: number; height: number }[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = naturalWidth;
    naturalHeight = naturalHeight;
    decode = async () => {
      calls.push("decode");
      await decode();
    };
    #src = "";
    get src() {
      return this.#src;
    }
    set src(value: string) {
      this.#src = value;
      // As a webview: the size is known once the picture has loaded, later.
      queueMicrotask(() => {
        if (loads) this.onload?.();
        else this.onerror?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      const element = original(tag, options);
      if (tag !== "canvas") return element;
      const canvas = element as HTMLCanvasElement;
      surfaces.push(canvas);
      Object.defineProperty(canvas, "getContext", {
        value: () =>
          context
            ? {
                set fillStyle(value: string) {
                  calls.push(`fillStyle ${value}`);
                },
                fillRect: (...rect: number[]) => calls.push(`fillRect ${rect.join(" ")}`),
                drawImage: (_image: unknown, ...rest: number[]) =>
                  calls.push(`drawImage ${rest.join(" ")}`),
                getImageData: (_x: number, _y: number, width: number, height: number) => ({
                  // Opaque black on the left half, white on the right.
                  data: Uint8ClampedArray.from({ length: width * height * 4 }, (_value, index) =>
                    index % 4 === 3 ? 255 : Math.floor(index / 4) % width < width / 2 ? 0 : 255,
                  ),
                }),
              }
            : null,
      });
      return canvas;
    },
  );
  return { calls, surfaces };
}

describe("decodeLogoImage", () => {
  it("draws on white at the scaled size, within 1024 × 512, and thresholds to ink", async () => {
    const { calls, surfaces } = stubBrowser({ naturalWidth: 280, naturalHeight: 64 });
    const bitmap = await decodeLogoImage("data:image/svg+xml;base64,AAAA", 2);
    expect(bitmap.width).toBe(560);
    expect(bitmap.height).toBe(128);
    expect(surfaces[0]).toMatchObject({ width: 560, height: 128 });
    expect(calls).toEqual([
      "decode",
      "fillStyle #ffffff",
      "fillRect 0 0 560 128",
      "drawImage 0 0 560 128",
    ]);
    // The black left half is ink (bit set), the white right half is not.
    expect(bitmap.pixels[0]).toBe(0xff);
    expect(bitmap.pixels[bitmap.stride - 1]).toBe(0);
  });

  it("shrinks a picture larger than the bounds", async () => {
    stubBrowser({ naturalWidth: 4000, naturalHeight: 1000 });
    const bitmap = await decodeLogoImage("blob:x");
    expect([bitmap.width, bitmap.height]).toEqual([1024, 256]);
  });

  it("refuses a picture the webview cannot decode, with a precise code", async () => {
    stubBrowser({
      decode: async () => {
        throw new Error("EncodingError");
      },
    });
    await expect(decodeLogoImage("blob:x")).rejects.toMatchObject({
      name: "LogoDecodeError",
      code: "decode_failed",
    });
  });

  it("refuses a picture that does not load, without decoding it", async () => {
    const { calls, surfaces } = stubBrowser({ loads: false });
    await expect(decodeLogoImage("blob:x")).rejects.toMatchObject({ code: "decode_failed" });
    expect(calls).toEqual([]);
    expect(surfaces).toHaveLength(0);
  });

  it("refuses a picture that declares more pixels than allowed before decoding it or making a canvas", async () => {
    const { calls, surfaces } = stubBrowser({ naturalWidth: 8192, naturalHeight: 4097 });
    await expect(decodeLogoImage("blob:x", 1, MAX_LOGO_SOURCE_PIXELS)).rejects.toMatchObject({
      name: "LogoDecodeError",
      code: "too_many_pixels",
    });
    expect(calls).toEqual([]);
    expect(surfaces).toHaveLength(0);
  });

  it("decodes a picture of exactly the allowed pixels, and any size without a limit", async () => {
    stubBrowser({ naturalWidth: 8192, naturalHeight: 4096 });
    const bitmap = await decodeLogoImage("blob:x", 1, MAX_LOGO_SOURCE_PIXELS);
    expect([bitmap.width, bitmap.height]).toEqual([1024, 512]);
    vi.restoreAllMocks();
    stubBrowser({ naturalWidth: 20_000, naturalHeight: 20_000 });
    const vector = await decodeLogoImage("blob:x");
    expect([vector.width, vector.height]).toEqual([512, 512]);
  });

  it("refuses a picture with no size and a webview with no canvas", async () => {
    stubBrowser({ naturalWidth: 0, naturalHeight: 10 });
    await expect(decodeLogoImage("blob:x")).rejects.toMatchObject({ code: "empty" });
    stubBrowser({ naturalWidth: 10, naturalHeight: 0 });
    await expect(decodeLogoImage("blob:x")).rejects.toMatchObject({ code: "empty" });
    vi.restoreAllMocks();
    stubBrowser({ context: false });
    await expect(decodeLogoImage("blob:x")).rejects.toMatchObject({ code: "canvas_unavailable" });
  });
});

describe("decodeLogoFile", () => {
  function stubObjectUrls() {
    const create = vi.fn(() => "blob:logo");
    const revoke = vi.fn();
    // jsdom has neither; they are removed again after each test.
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    return { create, revoke };
  }

  it("decodes a PNG, JPEG, WebP or SVG and frees its object URL", async () => {
    const { create, revoke } = stubObjectUrls();
    stubBrowser({ naturalWidth: 100, naturalHeight: 50 });
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
      const bitmap = await decodeLogoFile(new Blob(["x"], { type }));
      expect([bitmap.width, bitmap.height]).toEqual([100, 50]);
    }
    expect(create).toHaveBeenCalledTimes(4);
    expect(revoke).toHaveBeenCalledTimes(4);
  });

  it("refuses a raster file that declares a huge picture, and counts no SVG's declared size", async () => {
    const { revoke } = stubObjectUrls();
    const { calls, surfaces } = stubBrowser({ naturalWidth: 20_000, naturalHeight: 20_000 });
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      await expect(decodeLogoFile(new Blob(["x"], { type }))).rejects.toMatchObject({
        code: "too_many_pixels",
      });
    }
    expect(calls).toEqual([]);
    expect(surfaces).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(3);
    // An SVG is drawn at the logo's size: its declared size is no bomb.
    const vector = await decodeLogoFile(new Blob(["x"], { type: "image/svg+xml" }));
    expect([vector.width, vector.height]).toEqual([512, 512]);
  });

  it("frees the object URL when the picture does not decode", async () => {
    const { revoke } = stubObjectUrls();
    stubBrowser({
      decode: async () => {
        throw new Error("EncodingError");
      },
    });
    await expect(decodeLogoFile(new Blob(["x"], { type: "image/png" }))).rejects.toBeInstanceOf(
      LogoDecodeError,
    );
    expect(revoke).toHaveBeenCalledWith("blob:logo");
  });

  it("refuses any other type unread, and a file over the size cap unread", async () => {
    const { create } = stubObjectUrls();
    stubBrowser();
    for (const type of ["", "image/gif", "application/pdf", "text/html"]) {
      await expect(decodeLogoFile(new Blob(["x"], { type }))).rejects.toMatchObject({
        code: "unsupported_type",
      });
    }
    const big = new Blob([new Uint8Array(MAX_LOGO_FILE_BYTES + 1)], { type: "image/png" });
    await expect(decodeLogoFile(big)).rejects.toMatchObject({ code: "too_large" });
    const exact = new Blob([new Uint8Array(MAX_LOGO_FILE_BYTES)], { type: "image/png" });
    await expect(decodeLogoFile(exact)).resolves.toBeDefined();
    // Only the file at the cap reached the decoder.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("loadBundledMarkiroLogo", () => {
  it("decodes the shipped logo at 3.5 times its size, once per session", async () => {
    const { surfaces } = stubBrowser({ naturalWidth: 280, naturalHeight: 64 });
    const { loadBundledMarkiroLogo: load } = await import("../src/labels/logo.js");
    const first = await load();
    expect([first.width, first.height]).toEqual([980, 224]);
    await expect(load()).resolves.toBe(first);
    expect(surfaces).toHaveLength(1);
  });

  it("does not keep a failure: the next label tries again", async () => {
    let failing = true;
    stubBrowser({
      decode: async () => {
        if (failing) throw new Error("EncodingError");
      },
    });
    const { loadBundledMarkiroLogo: load } = await import("../src/labels/logo.js");
    await expect(load()).rejects.toBeInstanceOf(Error);
    failing = false;
    await expect(load()).resolves.toMatchObject({ width: 980 });
  });
});
