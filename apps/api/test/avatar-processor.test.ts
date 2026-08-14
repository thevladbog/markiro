import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processAvatar } from "../src/modules/profile/avatar-processor";

describe("processAvatar", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "normalizes %s to metadata-free 512px WebP",
    async (format) => {
      let image = sharp({
        create: { width: 700, height: 300, channels: 3, background: "#2463eb" },
      }).withMetadata({ orientation: 6, exif: { IFD0: { Artist: "remove-me" } } });
      image = format === "jpeg" ? image.jpeg() : format === "png" ? image.png() : image.webp();

      const result = await processAvatar(await image.toBuffer());
      const metadata = await sharp(result.buffer).metadata();
      expect(result).toMatchObject({
        contentType: "image/webp",
        width: 512,
        height: 512,
        byteSize: result.buffer.byteLength,
      });
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata).toMatchObject({ format: "webp", width: 512, height: 512 });
      expect(metadata.exif).toBeUndefined();
    },
  );

  it("rejects source bodies over 5 MiB before decode", async () => {
    await expect(processAvatar(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow(/5 MiB/);
  });

  it("rejects unsupported content even when the MIME claim would say image", async () => {
    await expect(
      processAvatar(Buffer.from("<svg><script>alert(1)</script></svg>")),
    ).rejects.toThrow(/JPEG, PNG, or WebP/);
  });

  it("rejects dimensions above 8192 before normalization", async () => {
    const oversized = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    await expect(processAvatar(oversized)).rejects.toThrow(/8192/);
  });

  it("rejects more than 25 million source pixels", async () => {
    const oversized = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    await expect(processAvatar(oversized)).rejects.toThrow(/25 million/);
  });

  it("rejects animated sources before worker processing", async () => {
    const frameSize = 64 * 64 * 3;
    const frames = Buffer.concat([Buffer.alloc(frameSize, 0), Buffer.alloc(frameSize, 255)]);
    const animated = await sharp(frames, {
      raw: { width: 64, height: 128, pageHeight: 64, channels: 3 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();

    await expect(processAvatar(animated)).rejects.toThrow("Animated avatars are not supported");
  });
});
