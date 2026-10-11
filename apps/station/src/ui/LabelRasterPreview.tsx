import { decodeMonoRaster } from "@markiro/domain";
import { useEffect, useRef } from "react";
/** Shows the saved artifact, never a freshly rendered template. */
export function LabelRasterPreview({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const page = decodeMonoRaster(bytes);
    const node = canvas.current;
    if (!node) return;
    node.width = page.widthDots;
    node.height = page.heightDots;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(page.widthDots, page.heightDots);
    for (let y = 0; y < page.heightDots; y++)
      for (let x = 0; x < page.widthDots; x++) {
        const shade = (page.pixels[y * page.stride + (x >> 3)] ?? 0) & (0x80 >> (x % 8)) ? 0 : 255;
        const i = (y * page.widthDots + x) * 4;
        image.data[i] = shade;
        image.data[i + 1] = shade;
        image.data[i + 2] = shade;
        image.data[i + 3] = 255;
      }
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(image, 0, 0);
  }, [bytes]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      style={{ maxWidth: "100%", imageRendering: "pixelated" }}
    />
  );
}
