import type { CSSProperties, ReactNode } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import { usePhotoBacking, type PhotoBacking } from "../shifts/photo-backing.js";
import { ProductPhotoImage, useStoredProductPhoto } from "../shifts/ProductPhoto.js";
import "./floor-controls.css";

export interface PhotoSquareProps {
  /** The side of the square in px; the stylesheet sets it from `--floor-photo` when omitted. */
  size?: number;
  /** What stands behind the picture; the brand gradient unless told it is an opaque photo. */
  backing?: PhotoBacking;
  /** An `<img class="product-photo">` or a fallback; the frame sizes and clips it. */
  children: ReactNode;
}

/**
 * The kit's photo square: ONE rounded frame (radius 20, hairline, neutral fill)
 * of a fixed size. The core is `position: relative`; the picture is laid over
 * it absolutely (`inset: 0`, `object-fit: contain`), so its natural size never
 * takes part in the layout: a tall bottle or a wide pack is shown whole inside
 * the square, never grown past it or cropped (the owner's photo bug: the old
 * `max-height: 100%` inside a grid track grew the track to the picture's height).
 */
export function PhotoSquare({ size, backing = "gradient", children }: PhotoSquareProps) {
  const style =
    size === undefined ? undefined : ({ "--floor-photo": `${size}px` } as CSSProperties);
  return (
    <div
      className="floor-photo-square"
      data-photo-backing={backing}
      {...(style === undefined ? {} : { style })}
    >
      {children}
    </div>
  );
}

/** The product's stored photo in a `PhotoSquare`, the monogram (`fallback`) without one. */
export function ProductPhotoSquare({
  local,
  productId,
  fallback,
  size,
}: {
  local: LocalExecutor;
  productId: string;
  fallback: ReactNode;
  size?: number;
}) {
  const photo = useStoredProductPhoto(local, productId);
  const backing = usePhotoBacking(photo);
  return (
    <PhotoSquare backing={backing} {...(size === undefined ? {} : { size })}>
      <ProductPhotoImage photo={photo} fallback={fallback} />
    </PhotoSquare>
  );
}
