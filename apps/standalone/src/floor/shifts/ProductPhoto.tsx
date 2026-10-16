import { useEffect, useState, type ReactNode } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import {
  onProductPhotosChanged,
  readProductPhoto,
  type StoredPhoto,
} from "../../local/product-photos.js";

/**
 * The product's photo as the station holds it (`ref_product_photos`), read
 * again whenever a photo pass stored or dropped one; `null` while it holds
 * none or the read fails.
 */
export function useStoredProductPhoto(local: LocalExecutor, productId: string): StoredPhoto | null {
  const [photo, setPhoto] = useState<StoredPhoto | null>(null);
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
  return photo;
}

/**
 * The picture itself: `fallback` while the station holds no photo and when
 * the picture does not decode, so the card's monogram on the colour panel is
 * never an empty frame. The picture is the host's JPEG (at most 640 x 640),
 * shown whole.
 */
export function ProductPhotoImage({
  photo,
  fallback,
}: {
  photo: StoredPhoto | null;
  fallback: ReactNode;
}) {
  const [brokenChecksum, setBrokenChecksum] = useState<string | null>(null);
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

export function ProductPhoto({
  local,
  productId,
  fallback,
}: {
  local: LocalExecutor;
  productId: string;
  fallback: ReactNode;
}) {
  return <ProductPhotoImage photo={useStoredProductPhoto(local, productId)} fallback={fallback} />;
}

/**
 * A product's frame: the photo (or `fallback`) in the element every card of
 * the floor shows a product on. The frame's face is the kit's `panel`; no
 * colour is derived from the product any more (kit step C: the one brand
 * gradient paints the work band, the frame is neutral).
 */
export function ProductPanel({
  local,
  productId,
  className,
  fallback,
}: {
  local: LocalExecutor | undefined;
  productId: string;
  className: string;
  fallback: ReactNode;
}) {
  if (local === undefined) return <div className={className}>{fallback}</div>;
  return (
    <PhotoPanel local={local} productId={productId} className={className} fallback={fallback} />
  );
}

function PhotoPanel({
  local,
  productId,
  className,
  fallback,
}: {
  local: LocalExecutor;
  productId: string;
  className: string;
  fallback: ReactNode;
}) {
  const photo = useStoredProductPhoto(local, productId);
  return (
    <div className={className}>
      <ProductPhotoImage photo={photo} fallback={fallback} />
    </div>
  );
}
