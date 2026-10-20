import { useEffect, useState, type ReactNode } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import { usePhotoBacking } from "./photo-backing.js";
import "./photo-backing.css";
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
  onBroken,
}: {
  photo: StoredPhoto | null;
  fallback: ReactNode;
  /** Told the checksum of a picture that did not decode (the frame's backing follows it). */
  onBroken?: (checksum: string) => void;
}) {
  const [brokenChecksum, setBrokenChecksum] = useState<string | null>(null);
  if (photo === null || brokenChecksum === photo.checksum) return <>{fallback}</>;
  return (
    <img
      className="product-photo"
      src={photo.src}
      alt=""
      draggable={false}
      onError={() => {
        setBrokenChecksum(photo.checksum);
        onBroken?.(photo.checksum);
      }}
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
 * the floor shows a product on. Its backing is `data-photo-backing`: the kit's
 * one brand gradient behind a cut-out or the monogram, nothing visible behind
 * a photo with its own background (`photoBacking`), which the frame's styles
 * may let fill the frame (the hub card's panel).
 */
export function ProductPanel({
  local,
  productId,
  className,
  fallback,
  overlay = null,
}: {
  local: LocalExecutor | undefined;
  productId: string;
  className: string;
  fallback: ReactNode;
  /** Laid over the frame's face (the hub card's tags on the gradient or the photo). */
  overlay?: ReactNode;
}) {
  if (local === undefined) {
    return (
      <div className={className} data-photo-backing="gradient">
        {fallback}
        {overlay}
      </div>
    );
  }
  return (
    <PhotoPanel
      local={local}
      productId={productId}
      className={className}
      fallback={fallback}
      overlay={overlay}
    />
  );
}

function PhotoPanel({
  local,
  productId,
  className,
  fallback,
  overlay,
}: {
  local: LocalExecutor;
  productId: string;
  className: string;
  fallback: ReactNode;
  overlay: ReactNode;
}) {
  const stored = useStoredProductPhoto(local, productId);
  // A picture that does not decode leaves the monogram, which stands on the gradient whatever the
  // picture's kind (a JPEG would otherwise leave it on the card's flat face).
  const [brokenChecksum, setBrokenChecksum] = useState<string | null>(null);
  const photo = stored !== null && stored.checksum === brokenChecksum ? null : stored;
  const backing = usePhotoBacking(photo);
  return (
    <div className={className} data-photo-backing={backing}>
      <ProductPhotoImage photo={photo} fallback={fallback} onBroken={setBrokenChecksum} />
      {overlay}
    </div>
  );
}
