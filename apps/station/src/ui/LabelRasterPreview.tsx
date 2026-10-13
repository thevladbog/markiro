import { decodeMonoRaster, type MonoRaster } from "@markiro/domain";
import { useEffect, useMemo, useRef } from "react";
/** Shows the saved artifact, never a freshly rendered template. */
export function LabelRasterPreview({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const page = useMemo(() => decodeMonoRaster(bytes), [bytes]);
  return <MonoRasterPreview page={page} label={label} />;
}
/** Screen-only sampling; the saved print artifact and its geometry remain intact. */
export function MonoRasterPreview({
  page,
  label,
  maxSide,
}: {
  page: MonoRaster;
  label: string;
  maxSide?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const scale = maxSide ? Math.min(1, maxSide / Math.max(page.widthDots, page.heightDots)) : 1;
    const width = Math.max(1, Math.round(page.widthDots * scale));
    const height = Math.max(1, Math.round(page.heightDots * scale));
    node.width = width;
    node.height = height;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sourceX = Math.floor((x * page.widthDots) / width);
        const sourceY = Math.floor((y * page.heightDots) / height);
        const shade =
          (page.pixels[sourceY * page.stride + (sourceX >> 3)] ?? 0) & (0x80 >> (sourceX % 8))
            ? 0
            : 255;
        const i = (y * width + x) * 4;
        image.data[i] = shade;
        image.data[i + 1] = shade;
        image.data[i + 2] = shade;
        image.data[i + 3] = 255;
      }
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(image, 0, 0);
  }, [page, maxSide]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      style={{ maxWidth: "100%", imageRendering: "pixelated" }}
    />
  );
}
