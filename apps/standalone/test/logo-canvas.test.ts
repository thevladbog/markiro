import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonoBitmap } from "@markiro/domain";

import { hasInk, paintBitmap } from "../src/office/org/logo-canvas.js";

/** 10 × 2 dots, two bytes a row: ink at (0,0), (9,0) and (8,1). */
const BITMAP: MonoBitmap = {
  width: 10,
  height: 2,
  stride: 2,
  pixels: new Uint8Array([0b1000_0000, 0b0100_0000, 0b0000_0000, 0b1000_0000]),
};

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function paint(bitmap: MonoBitmap) {
  vi.stubGlobal("ImageData", FakeImageData);
  const put = vi.fn<(image: FakeImageData, x: number, y: number) => void>();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", { value: () => ({ putImageData: put }) });
  paintBitmap(canvas, bitmap);
  return { canvas, put };
}

/** The pixel at (x, y) of a painted image as [r, g, b, a]. */
function pixel(image: FakeImageData, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.data.slice(offset, offset + 4)];
}

describe("paintBitmap", () => {
  it("draws each dot of the bitmap, most significant bit first, black on white", () => {
    const { canvas, put } = paint(BITMAP);
    expect([canvas.width, canvas.height]).toEqual([10, 2]);
    expect(put).toHaveBeenCalledTimes(1);
    const image = put.mock.calls[0]?.[0];
    if (image === undefined) throw new Error("nothing drawn");
    expect([image.width, image.height]).toEqual([10, 2]);
    const ink: string[] = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 10; x++) {
        const [r, g, b, a] = pixel(image, x, y);
        expect(a).toBe(255);
        if (r === 0 && g === 0 && b === 0) ink.push(`${String(x)},${String(y)}`);
        else expect([r, g, b]).toEqual([255, 255, 255]);
      }
    }
    expect(ink).toEqual(["0,0", "9,0", "8,1"]);
    expect(put.mock.calls[0]?.slice(1)).toEqual([0, 0]);
  });

  it("draws nothing on a canvas the webview gives no context", () => {
    vi.stubGlobal("ImageData", FakeImageData);
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", { value: () => null });
    expect(() => paintBitmap(canvas, BITMAP)).not.toThrow();
    expect([canvas.width, canvas.height]).toEqual([10, 2]);
  });
});

describe("hasInk", () => {
  it("is true for a bitmap with a dot, false for a white one", () => {
    expect(hasInk(BITMAP)).toBe(true);
    expect(hasInk({ ...BITMAP, pixels: new Uint8Array(4) })).toBe(false);
    expect(hasInk({ ...BITMAP, pixels: new Uint8Array([0, 0, 0, 1]) })).toBe(true);
  });
});
