import { useEffect, useState } from "react";
import type { ProductImageDescriptor } from "../api/types.js";
import {
  clearPublishedProductImage,
  deleteProductImageBlob,
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
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setObjectUrl(null);
    setFailed(false);
    if (productId === null || image === null) {
      return () => {
        alive = false;
      };
    }
    void (async () => {
      try {
        const pointer = await readPublishedProductImagePointer(productId);
        if (!alive || !pointer) return;
        const blob = await readProductImageBlob(pointer.checksum);
        if (!alive || !blob || blob.type !== "image/webp") return;
        if (image && (blob.type !== image.contentType || blob.size !== image.byteSize)) return;
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (!alive) return;
        if (digest !== pointer.checksum || (image && digest !== image.checksum)) {
          await clearPublishedProductImage(productId);
          await deleteProductImageBlob(pointer.checksum);
          return;
        }
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

  if (objectUrl && !failed) {
    return (
      <img
        src={objectUrl}
        alt={name}
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }}
        onError={() => {
          setFailed(true);
          const stale = objectUrl;
          setObjectUrl(null);
          URL.revokeObjectURL(stale);
          if (productId) void clearPublishedProductImage(productId);
          if (image) void deleteProductImageBlob(image.checksum);
        }}
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
