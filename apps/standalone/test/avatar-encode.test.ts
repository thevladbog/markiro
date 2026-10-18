import { describe, expect, it, vi } from "vitest";

import { AvatarEncodeError, encodeAvatar } from "../src/office/avatar/avatar-encode.js";

function stubCanvas(blobs: (Blob | null)[]) {
  const drawn: unknown[][] = [];
  const fills: unknown[][] = [];
  const asked: { type: string | undefined; quality: number | undefined }[] = [];
  const queue = [...blobs];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: (...args: unknown[]) => fills.push(args),
      drawImage: (...args: unknown[]) => drawn.push(args),
    }),
    toBlob: (done: (blob: Blob | null) => void, type?: string, quality?: number) => {
      asked.push({ type, quality });
      done(queue.shift() ?? null);
    },
  };
  return { canvas, drawn, fills, asked };
}

const IMAGE = { naturalWidth: 1000, naturalHeight: 600 } as unknown as HTMLImageElement;
const webp = (size: number) => new Blob([new Uint8Array(size)], { type: "image/webp" });

describe("encodeAvatar", () => {
  it("draws only the chosen square, scaled to 256, onto a white ground, and sends WebP bytes only", async () => {
    const stub = stubCanvas([webp(3)]);
    const out = await encodeAvatar(IMAGE, { sx: 100, sy: 0, side: 600 }, () => stub.canvas);
    expect(stub.canvas.width).toBe(256);
    expect(stub.canvas.height).toBe(256);
    expect(stub.fills).toEqual([[0, 0, 256, 256]]);
    expect(stub.drawn).toEqual([[IMAGE, 100, 0, 600, 600, 0, 0, 256, 256]]);
    expect(stub.asked[0]).toEqual({ type: "image/webp", quality: 0.85 });
    expect(out).toEqual({
      dataBase64: btoa("\u0000\u0000\u0000"),
      mediaType: "image/webp",
      side: 256,
    });
  });

  it("never writes less than the host's 128 px floor", async () => {
    const stub = stubCanvas([webp(3)]);
    const out = await encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 40 }, () => stub.canvas);
    expect(out.side).toBe(128);
    expect(stub.canvas.width).toBe(128);
  });

  it("falls back to JPEG where the webview cannot encode WebP (it answers PNG)", async () => {
    const png = new Blob([new Uint8Array(5)], { type: "image/png" });
    const jpeg = new Blob([new Uint8Array(4)], { type: "image/jpeg" });
    const stub = stubCanvas([png, jpeg]);
    const out = await encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 600 }, () => stub.canvas);
    expect(stub.asked.map((a) => a.type)).toEqual(["image/webp", "image/jpeg"]);
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("lowers the quality when the bytes exceed the host's 2 MiB, then gives up", async () => {
    const big = webp(2 * 1024 * 1024 + 1);
    const ok = stubCanvas([big, webp(10)]);
    expect(
      (await encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 600 }, () => ok.canvas)).mediaType,
    ).toBe("image/webp");
    expect(ok.asked.map((a) => a.quality)).toEqual([0.85, 0.7]);
    const never = stubCanvas([big, big, big, big]);
    await expect(
      encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 600 }, () => never.canvas),
    ).rejects.toBeInstanceOf(AvatarEncodeError);
  });

  it("fails when there is no 2d context or the canvas gives no blob", async () => {
    const noContext = { width: 0, height: 0, getContext: () => null, toBlob: vi.fn() };
    await expect(
      encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 600 }, () => noContext),
    ).rejects.toBeInstanceOf(AvatarEncodeError);
    const empty = stubCanvas([null, null, null, null]);
    await expect(
      encodeAvatar(IMAGE, { sx: 0, sy: 0, side: 600 }, () => empty.canvas),
    ).rejects.toBeInstanceOf(AvatarEncodeError);
  });
});
