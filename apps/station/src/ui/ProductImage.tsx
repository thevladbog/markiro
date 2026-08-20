import { useEffect, useRef, useState } from "react";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import {
  readCachedStationProductImage,
  readStationProductImage,
} from "../lib/product-image-cache.js";

export interface ProductImageProps {
  exec?: SqlExecutor | undefined;
  productId: string;
  productName: string | null;
  image?: StationProductImageDescriptor | null | undefined;
  className?: string;
  refreshKey?: number | undefined;
}

/** Offline-first product photo. A missing/corrupt photo deliberately degrades to text. */
export function ProductImage({
  exec,
  productId,
  productName,
  image,
  className,
  refreshKey,
}: ProductImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    /**
     * Re-reads the cache shortly, but ONLY while there is still nothing to show.
     *
     * The reason this retry exists is that media sync runs independently of the
     * operational bundle (a dead object store must not block opening a shift),
     * so a product's descriptor can already be mirrored while its bytes are
     * still landing -- and until they do, the read simply answers `null`. Two
     * short re-reads cover that gap without anyone having to notify us.
     *
     * It deliberately does NOT run after a read that produced an image. Bytes
     * come out of the cache checksum-validated, so re-reading can only ever
     * yield the same picture, at the cost of another cache read plus a fresh
     * `createObjectURL` and a `revokeObjectURL` of the URL currently on screen.
     * Nor does it run when a later refresh finds nothing while a photo is
     * already displayed: that photo stays up (see the `previousUrl` handling
     * below), and a refresh is driven by `refreshKey` when new bytes actually
     * arrive.
     */
    const retryWhileNothingToShow = () => {
      if (cancelled || retryKey >= 2 || objectUrlRef.current !== null) return;
      retry = window.setTimeout(() => {
        if (!cancelled) setRetryKey((key) => key + 1);
      }, 350);
    };
    setFailed(false);
    // `undefined` is a legacy/unknown descriptor. The mirror may still have
    // a validated pointer from a newer response, so let the cache reader use
    // that pointer. Only an explicit null is a deletion tombstone.
    if (!exec || image === null) {
      setObjectUrl(() => {
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
        return null;
      });
      return;
    }

    void (async () => {
      let blob: Blob | null = await readStationProductImage(exec, productId, image);
      if (!blob && image) blob = await readCachedStationProductImage(productId, image, exec);
      if (cancelled) return;
      if (!blob) {
        // Nothing cached for this descriptor yet -- the case the retry is for.
        retryWhileNothingToShow();
        return;
      }
      // No object-URL support at all is permanent, so it is not retried.
      if (typeof URL.createObjectURL !== "function") return;
      const nextUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      const previousUrl = objectUrlRef.current;
      objectUrlRef.current = nextUrl;
      setObjectUrl(nextUrl);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    })().catch(() => {
      if (cancelled) return;
      if (objectUrlRef.current === null) setFailed(true);
      // A read that threw is exactly as retryable as one that found nothing.
      retryWhileNothingToShow();
    });
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [exec, image, productId, refreshKey, retryKey]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    },
    [],
  );

  const label = productName ?? "Product";
  const classes = ["product-image", className].filter(Boolean).join(" ");
  if (!objectUrl || failed) {
    return (
      <div className={`${classes} product-image--fallback`} aria-label={label}>
        {label}
      </div>
    );
  }
  return (
    <img
      className={classes}
      src={objectUrl}
      alt={label}
      onError={() => {
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
        setObjectUrl(null);
        setFailed(true);
      }}
    />
  );
}
