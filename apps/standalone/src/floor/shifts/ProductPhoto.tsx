import { useEffect, useState, type ReactNode } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import { onProductPhotosChanged, readProductPhoto } from "../../local/product-photos.js";

/**
 * The product's photo as the station holds it (beta 3; `ref_product_photos`),
 * or `fallback` while it holds none, while the read fails and when the picture
 * does not decode: the card's monogram on the colour panel is never an empty
 * frame. Read again whenever a photo pass stored or dropped one. The picture
 * is the host's JPEG (at most 640 x 640), shown whole.
 */
export function ProductPhoto({
  local,
  productId,
  fallback,
}: {
  local: LocalExecutor;
  productId: string;
  fallback: ReactNode;
}) {
  const [photo, setPhoto] = useState<{ src: string; checksum: string } | null>(null);
  const [brokenChecksum, setBrokenChecksum] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => onProductPhotosChanged(() => setVersion((count) => count + 1)), []);
  useEffect(() => {
    let cancelled = false;
    readProductPhoto(local, productId).then(
      (next) => {
        if (!cancelled) setPhoto(next);
      },
      () => {
        if (!cancelled) setPhoto(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, productId, version]);
  if (photo === null || brokenChecksum === photo.checksum) return <>{fallback}</>;
  return (
    <img
      className="product-photo"
      src={photo.src}
      alt=""
      draggable={false}
      onError={() => setBrokenChecksum(photo.checksum)}
    />
  );
}
