import { useEffect, useMemo, useState } from "react";

import type { MonoBitmap } from "@markiro/domain";

import { loadBundledMarkiroLogo, logoFromWire } from "../labels/logo.js";
import { useCustomBranding } from "./branding.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";

/**
 * The logo a label's `organization_logo` box shows in the office (#703): the
 * organization's print logo when the license allows custom branding, else the
 * bundled Markiro logo — what a new shift will print. `null` while either loads, or when neither is there (the
 * box stays white, as a print without a logo leaves it).
 */
export function useLabelLogo(): MonoBitmap | null {
  const state = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token), {
    staleTime: 60_000,
  });
  const branding = useCustomBranding();
  const own = useMemo(() => {
    const logo = state.data?.logo ?? null;
    return logo === null || !branding.allowed ? null : logoFromWire(logo);
  }, [state.data, branding.allowed]);
  const [markiro, setMarkiro] = useState<MonoBitmap | null>(null);
  const needsMarkiro = state.data !== undefined && branding.settled && own === null;
  useEffect(() => {
    if (!needsMarkiro) return undefined;
    let cancelled = false;
    loadBundledMarkiroLogo().then(
      (bitmap) => {
        if (!cancelled) setMarkiro(bitmap);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [needsMarkiro]);
  return own ?? (needsMarkiro ? markiro : null);
}
