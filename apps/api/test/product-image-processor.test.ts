import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processProductImage } from "../src/modules/media/product-image-processor";

describe("processProductImage", () => {
  it("normalizes a landscape source to a 1200px-longest-edge WebP", async () => {
    const result = await processProductImage(
      await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: "#2463eb" },
      })
        .jpeg()
        .toBuffer(),
    );

    expect(result).toMatchObject({
      contentType: "image/webp",
      width: 1200,
      height: 600,
      byteSize: result.buffer.byteLength,
    });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(sharp(result.buffer).metadata()).resolves.toMatchObject({
      format: "webp",
      width: 1200,
      height: 600,
    });
  });

  it("preserves portrait ratio within the 1200px boundary", async () => {
    const result = await processProductImage(
      await sharp({
        create: { width: 1000, height: 2000, channels: 3, background: "#2463eb" },
      })
        .png()
        .toBuffer(),
    );

    expect(result).toMatchObject({ width: 600, height: 1200 });
  });

  it("does not enlarge a source already within the boundary", async () => {
    const result = await processProductImage(
      await sharp({
        create: { width: 320, height: 160, channels: 3, background: "#2463eb" },
      })
        .webp()
        .toBuffer(),
    );

    expect(result).toMatchObject({ width: 320, height: 160 });
  });

  it("rejects source bodies over 5 MiB before decode", async () => {
    await expect(processProductImage(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow(/5 MiB/);
  });

  it("rejects content that is not a JPEG, PNG, or WebP image", async () => {
    await expect(
      processProductImage(Buffer.from("<svg><script>alert(1)</script></svg>")),
    ).rejects.toThrow(/JPEG, PNG, or WebP/);
  });

  it("rejects animated sources before worker processing", async () => {
    const frameSize = 64 * 64 * 3;
    const animated = await sharp(
      Buffer.concat([Buffer.alloc(frameSize, 0), Buffer.alloc(frameSize, 255)]),
      { raw: { width: 64, height: 128, pageHeight: 64, channels: 3 } },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();

    await expect(processProductImage(animated)).rejects.toThrow(/Animated product images/);
  });

  it("rejects dimensions above 8192 before normalization", async () => {
    const oversized = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();

    await expect(processProductImage(oversized)).rejects.toThrow(/8192/);
  });

  it("rejects more than 25 million source pixels", async () => {
    const oversized = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();

    await expect(processProductImage(oversized)).rejects.toThrow(/25 million/);
  });

  it("produces deterministic metadata-free normalized bytes", async () => {
    const source = await sharp({
      create: { width: 1400, height: 700, channels: 3, background: "#2463eb" },
    })
      .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "remove-me" } } })
      .jpeg()
      .toBuffer();

    const first = await processProductImage(source);
    const second = await processProductImage(source);
    const metadata = await sharp(first.buffer).metadata();

    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(second.checksum).toBe(first.checksum);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });
});
