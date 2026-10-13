import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodePhoto,
  fitPhotoSize,
  PHOTO_MAX_FILE_BYTES,
  PHOTO_MAX_SOURCE_PIXELS,
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
