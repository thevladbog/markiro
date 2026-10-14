import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodePhoto,
  fitPhotoSize,
  PHOTO_MAX_FILE_BYTES,
  PHOTO_MAX_SOURCE_PIXELS,
  PhotoTooLargeError,
  PhotoUnreadableError,
} from "../src/office/products/photo-encode.js";

/** An `Image` that "loads" a picture of the given size at once (jsdom loads none). */
function stubImage(width: number, height: number) {
  const decode = vi.fn(async () => undefined);
  class LoadedImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode = decode;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);
  return decode;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a product photo's encoding (plan ТОВ): the guards before any canvas", () => {
  it("keeps the aspect within 640 on the longer side, and never enlarges", () => {
    expect(fitPhotoSize(4000, 3000)).toEqual({ width: 640, height: 480 });
    expect(fitPhotoSize(3000, 4000)).toEqual({ width: 480, height: 640 });
    expect(fitPhotoSize(320, 200)).toEqual({ width: 320, height: 200 });
    expect(fitPhotoSize(10_000, 1)).toEqual({ width: 640, height: 1 });
  });

  it("refuses a file of another type, or past the size cap, unread", async () => {
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    for (const file of [
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
      new File(["x"], "photo.gif", { type: "image/gif" }),
      new File([new Uint8Array(PHOTO_MAX_FILE_BYTES + 1)], "big.jpg", { type: "image/jpeg" }),
    ]) {
      await expect(encodePhoto(file)).rejects.toBeInstanceOf(PhotoUnreadableError);
    }
    expect(read).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("refuses a picture that declares too many pixels before decoding it", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const decode = stubImage(PHOTO_MAX_SOURCE_PIXELS / 1024 + 1, 1024);
    await expect(
      encodePhoto(
        new File([new Uint8Array([0xff, 0xd8, 0xff])], "huge.jpg", { type: "image/jpeg" }),
      ),
    ).rejects.toBeInstanceOf(PhotoUnreadableError);
    expect(decode).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});

/**
 * A canvas that has no pixels but answers as the browser's: `alpha` is the
 * alpha of the pixel `getImageData` returns, `encoders` the bytes `toBlob`
 * yields per type and attempt (a number is a blob of that many bytes).
 */
function stubCanvas(options: {
  alpha: number;
  sizeOf: (type: string, quality: number | undefined, width: number) => number | null;
}) {
  const requests: { type: string; quality: number | undefined; width: number }[] = [];
  const fills: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: vi.fn(),
      fillRect: vi.fn(function () {
        fills.push("white");
      }),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, options.alpha]) })),
      globalCompositeOperation: "source-over",
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: unknown,
  ) {
    const q = typeof quality === "number" ? quality : undefined;
    requests.push({ type: type ?? "", quality: q, width: this.width });
    const size = options.sizeOf(type ?? "", q, this.width);
    callback(size === null ? null : new Blob([new Uint8Array(size)], { type: type ?? "" }));
  } as never);
  return { requests, fills };
}

function pickable(type: string) {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
  return new File([new Uint8Array([1, 2, 3])], "p", { type });
}

describe("a product photo's encoding keeps transparency (beta 3.2)", () => {
  it("keeps a transparent PNG a PNG when it is the smallest, and never fills it white", async () => {
    stubImage(800, 400);
    const canvas = stubCanvas({
      alpha: 0,
      sizeOf: (type) => (type === "image/png" ? 40_000 : 90_000),
    });
    const photo = await encodePhoto(pickable("image/png"));
    expect(photo).toMatchObject({ width: 640, height: 320, mediaType: "image/png" });
    expect(canvas.fills).toEqual([]);
  });

  it("chooses a WebP with alpha when it is smaller than the PNG", async () => {
    stubImage(800, 400);
    stubCanvas({ alpha: 0, sizeOf: (type) => (type === "image/webp" ? 20_000 : 150_000) });
    expect((await encodePhoto(pickable("image/webp"))).mediaType).toBe("image/webp");
  });

  it("falls back to progressively smaller sizes when nothing fits the cap", async () => {
    stubImage(1000, 1000);
    const canvas = stubCanvas({
      alpha: 100,
      sizeOf: (_type, _quality, width) => (width <= 360 ? 100_000 : 900_000),
    });
    const photo = await encodePhoto(pickable("image/png"));
    expect(photo.width).toBeLessThanOrEqual(360);
    expect(photo.mediaType).toBe("image/png");
    expect(new Set(canvas.requests.map((request) => request.width))).toEqual(
      new Set([640, 480, 360]),
    );
  });

  it("gives up with the too-large error at the smallest size", async () => {
    stubImage(1000, 1000);
    stubCanvas({ alpha: 0, sizeOf: () => 900_000 });
    await expect(encodePhoto(pickable("image/png"))).rejects.toBeInstanceOf(PhotoTooLargeError);
  });

  it("keeps an opaque PNG a JPEG on white, and a JPEG source never reads its alpha", async () => {
    stubImage(800, 400);
    const canvas = stubCanvas({ alpha: 255, sizeOf: () => 60_000 });
    const photo = await encodePhoto(pickable("image/png"));
    expect(photo.mediaType).toBe("image/jpeg");
    expect(canvas.requests.map((request) => request.type)).toEqual(["image/jpeg"]);
    expect(canvas.fills).toEqual(["white"]);
  });

  it("steps down the JPEG quality for an opaque photo", async () => {
    stubImage(800, 400);
    const canvas = stubCanvas({
      alpha: 255,
      sizeOf: (_type, quality) => (quality === 0.5 ? 200_000 : 500_000),
    });
    await encodePhoto(pickable("image/jpeg"));
    expect(canvas.requests.map((request) => request.quality)).toEqual([0.85, 0.7, 0.5]);
  });
});
