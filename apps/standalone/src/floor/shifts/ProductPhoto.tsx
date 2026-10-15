import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import {
  onProductPhotosChanged,
  readProductPhoto,
  type StoredPhoto,
} from "../../local/product-photos.js";
import { accentOfPhoto, type PhotoAccent } from "./photo-accent.js";
import { hueFromGtin } from "./product-accent.js";

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
 * The panel's colour variables: the hue from the photo's dominant colour when
 * the picture has one, the GTIN's hue otherwise (and until the sample is
 * done). `--product-sat` is set only with a photo accent; the stylesheets
 * default it to their own saturation.
 */
export function useProductAccent(photo: StoredPhoto | null, gtin: string): CSSProperties {
  const [accent, setAccent] = useState<{ checksum: string; accent: PhotoAccent | null } | null>(
    null,
  );
  const src = photo?.src ?? null;
  const checksum = photo?.checksum ?? null;
  useEffect(() => {
    if (src === null || checksum === null) return undefined;
    let cancelled = false;
    void accentOfPhoto(src, checksum).then((found) => {
      if (!cancelled) setAccent({ checksum, accent: found });
    });
    return () => {
      cancelled = true;
    };
  }, [src, checksum]);
  const fromPhoto = checksum !== null && accent?.checksum === checksum ? accent.accent : null;
  return {
    "--product-hue": String(fromPhoto?.hue ?? hueFromGtin(gtin)),
    ...(fromPhoto === null ? {} : { "--product-sat": `${fromPhoto.saturation}%` }),
  } as CSSProperties;
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
 * A product's colour panel: the photo (or `fallback`) on a gradient whose hue
 * comes from the photo's dominant colour, the GTIN's without one. The one
 * element every card and band of the floor shows a product on.
 */
export function ProductPanel({
  local,
  productId,
  gtin,
  className,
  fallback,
}: {
  local: LocalExecutor | undefined;
  productId: string;
  gtin: string;
  className: string;
  fallback: ReactNode;
}) {
  if (local === undefined) {
    return (
      <div
        className={className}
        data-accent="true"
        style={{ "--product-hue": String(hueFromGtin(gtin)) } as CSSProperties}
      >
        {fallback}
      </div>
    );
  }
  return (
    <PhotoPanel
      local={local}
      productId={productId}
      gtin={gtin}
      className={className}
      fallback={fallback}
    />
  );
}

function PhotoPanel({
  local,
  productId,
  gtin,
  className,
  fallback,
}: {
  local: LocalExecutor;
  productId: string;
  gtin: string;
  className: string;
  fallback: ReactNode;
}) {
  const photo = useStoredProductPhoto(local, productId);
  const style = useProductAccent(photo, gtin);
  return (
    <div className={className} data-accent="true" style={style}>
      <ProductPhotoImage photo={photo} fallback={fallback} />
    </div>
  );
}
