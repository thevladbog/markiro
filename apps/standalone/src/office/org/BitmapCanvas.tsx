import { useEffect, useRef } from "react";

import type { MonoBitmap } from "@markiro/domain";

import { paintBitmap } from "./logo-canvas.js";

export interface BitmapCanvasProps {
  bitmap: MonoBitmap;
  /** The canvas's accessible name. */
  label: string;
  className?: string;
}

/** A 1-bit logo on a canvas, named for assistive technology. */
export function BitmapCanvas({ bitmap, label, className }: BitmapCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current !== null) paintBitmap(ref.current, bitmap);
  }, [bitmap]);
  return <canvas ref={ref} className={className} role="img" aria-label={label} />;
}
