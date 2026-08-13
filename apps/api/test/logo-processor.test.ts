import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processLogo } from "../src/modules/org-profile/logo-processor";

describe("processLogo", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "normalizes a %s logo to metadata-free bounded WebP without enlarging it",
    async (format) => {
      let image = sharp({
        create: { width: 700, height: 300, channels: 3, background: "#2463eb" },
      }).withMetadata({ exif: { IFD0: { Artist: "remove-me" } } });
      image = format === "jpeg" ? image.jpeg() : format === "png" ? image.png() : image.webp();

      const result = await processLogo(await image.toBuffer());
      const metadata = await sharp(result.buffer).metadata();
      expect(result).toMatchObject({
        contentType: "image/webp",
        width: 700,
        height: 300,
      });
      expect(metadata).toMatchObject({ format: "webp", width: 700, height: 300 });
      expect(metadata.exif).toBeUndefined();
    },
  );

  it("fits a large logo inside 1024 by 512", async () => {
    const source = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();

    const result = await processLogo(source);

    expect(result).toMatchObject({ width: 1024, height: 512, contentType: "image/webp" });
  });

  it("rejects source bodies over 5 MiB before decode", async () => {
    await expect(processLogo(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow(/5 MiB/);
  });

  it("rejects SVG and malformed content", async () => {
    await expect(processLogo(Buffer.from("<svg><script>alert(1)</script></svg>"))).rejects.toThrow(
      /JPEG, PNG, or WebP/,
    );
  });

  it("rejects dimensions above 8192 before normalization", async () => {
    const oversized = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    await expect(processLogo(oversized)).rejects.toThrow(/8192/);
  });

  it("rejects more than 25 million source pixels", async () => {
    const oversized = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    await expect(processLogo(oversized)).rejects.toThrow(/25 million/);
  });

  it("rejects animated sources before worker processing", async () => {
    const frameSize = 64 * 64 * 3;
    const frames = Buffer.concat([Buffer.alloc(frameSize, 0), Buffer.alloc(frameSize, 255)]);
    const animated = await sharp(frames, {
      raw: { width: 64, height: 128, pageHeight: 64, channels: 3 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();

    await expect(processLogo(animated)).rejects.toThrow("Animated logos are not supported");
  });
});
