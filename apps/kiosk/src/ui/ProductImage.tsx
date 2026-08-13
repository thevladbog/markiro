import { useEffect, useState } from "react";
import type { ProductImageDescriptor } from "../api/types.js";
import {
  readProductImageBlob,
  readPublishedProductImagePointer,
} from "../store/product-images.js";
import { productMonogram } from "../screens/product-monogram.js";

export interface ProductImageProps {
  productId: string | null;
  name: string;
  image?: ProductImageDescriptor | null;
  size?: number;
}

/**
 * Displays only a locally published product image. The kiosk never turns a
 * server descriptor into a URL: sync validates and publishes the immutable
 * blob first, then this component reads the pointer. Missing, legacy, deleted,
 * or failed media always has the same useful fallback — the product monogram.
 */
export function ProductImage({ productId, name, image, size = 56 }: ProductImageProps): React.JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setObjectUrl(null);
    if (productId === null || image === undefined || image === null) {
      return () => {
        alive = false;
      };
    }
    void (async () => {
      try {
        const pointer = await readPublishedProductImagePointer(productId);
        if (!alive || pointer?.checksum !== image.checksum) return;
        const blob = await readProductImageBlob(pointer.checksum);
        if (!alive || !blob || blob.type !== image.contentType || blob.size !== image.byteSize) return;
        url = URL.createObjectURL(blob);
        if (alive) setObjectUrl(url);
        else URL.revokeObjectURL(url);
      } catch {
        // Offline media is best effort; the monogram remains a valid product
        // identity when IndexedDB or object URL creation is unavailable.
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [productId, image]);

  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="kiosk-product-monogram"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      {productMonogram(name)}
    </span>
  );
}
