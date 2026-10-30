import { useEffect, useMemo, useState } from "react";

import type { OrgLogoState } from "../host/protocol.js";
import { logoFromWire } from "../labels/logo.js";
import { bitmapPngDataUrl } from "../labels/logo-png.js";

/** The host has already applied customLogo. Never read office/license before sign-in. */
export function useLoginLogo(
  read: (() => Promise<OrgLogoState>) | undefined,
  revision: number | null,
  online: boolean,
): { src: string | null; onError: () => void } {
  const request = useMemo(() => ({ read, revision, online }), [read, revision, online]);
  const [known, setKnown] = useState<{ request: typeof request; src: string | null } | null>(null);
  useEffect(() => {
    const read = request.read;
    if (read === undefined || !request.online) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => read())
      .then((state) => {
        const bitmap = state.logo === null ? null : logoFromWire(state.logo);
        const src =
          bitmap !== null && bitmap.pixels.some((byte) => byte !== 0)
            ? bitmapPngDataUrl(bitmap)
            : null;
        if (!cancelled) setKnown({ request, src });
      })
      .catch(() => {
        // Old hosts, unavailable licenses and damaged images all leave a usable sign-in.
        if (!cancelled) setKnown({ request, src: null });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  return {
    src: known?.request === request ? known.src : null,
    onError: () =>
      setKnown((current) => (current?.request === request ? { request, src: null } : current)),
  };
}
