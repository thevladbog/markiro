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
export function ProductImage({ exec, productId, productName, image, className, refreshKey }: ProductImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setObjectUrl(() => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      return null;
    });
    if (!exec || !image) return;

    void (async () => {
      let blob: Blob | null = await readStationProductImage(exec, productId, image);
      if (!blob) blob = await readCachedStationProductImage(productId, image);
      if (cancelled || !blob || typeof URL.createObjectURL !== "function") return;
      const nextUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      objectUrlRef.current = nextUrl;
      setObjectUrl(nextUrl);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    const retry = retryKey < 2 ? window.setTimeout(() => {
      if (!cancelled) setRetryKey((key) => key + 1);
    }, 350) : undefined;
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [exec, image, productId, refreshKey, retryKey]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const label = productName ?? "Product";
  const classes = ["product-image", className].filter(Boolean).join(" ");
  if (!objectUrl || failed) {
    return <div className={`${classes} product-image--fallback`} aria-label={label}>{label}</div>;
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
