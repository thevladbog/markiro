import type { QueryClient } from "@tanstack/react-query";

import type { HostApi } from "../host/api.js";
import type { OfficeLicense } from "../host/protocol.js";
import { bitmapPngDataUrl } from "../labels/logo-png.js";
import { logoFromWire } from "../labels/logo.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";

/**
 * Custom branding (the owner's beta 3.2 feedback): the organization's own
 * logo on printed forms and labels is a LICENSE FEATURE, `customLogo`.
 * Without it everything prints the Markiro logo. The host answers the same
 * question for what it freezes into a shift (`license::state::
 * custom_branding_allowed`); this is the office's side of that one rule.
 *
 * The trial and a site with no file have every feature, so the beta shows the
 * organization's logo; a license file that lacks `customLogo` (switched off,
 * or issued before the key existed) does not. A license that could not be read
 * is no license to brand with: the Markiro logo stays, which prints in every
 * state.
 */
export function customBrandingAllowed(
  license: Pick<OfficeLicense, "features"> | null | undefined,
): boolean {
  return license?.features.customLogo === true;
}

/** How long a read of the license is trusted by the previews. */
const LICENSE_STALE_MS = 60_000;

/**
 * Whether the office may brand its previews with the organization's logo:
 * `settled` once the license has been read (or failed to), `allowed` by
 * [`customBrandingAllowed`].
 */
export function useCustomBranding(): { settled: boolean; allowed: boolean } {
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token), {
    staleTime: LICENSE_STALE_MS,
  });
  return {
    settled: !license.isPending,
    allowed: customBrandingAllowed(license.data),
  };
}

/**
 * The organization's print logo as a PNG data URL for a printed form, read
 * afresh at the press: `null` when the license does not allow custom
 * branding, when the organization has no logo, and when either read fails —
 * a logo never stops a form, which then carries the Markiro one.
 */
export async function readFormLogo(
  queryClient: QueryClient,
  api: HostApi,
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>,
): Promise<string | null> {
  try {
    const license = await queryClient.fetchQuery({
      queryKey: officeKeys.license,
      queryFn: () => call((token) => api.getLicense(token)),
      staleTime: 0,
    });
    if (!customBrandingAllowed(license)) return null;
    const state = await queryClient.fetchQuery({
      queryKey: officeKeys.orgLogo,
      queryFn: () => call((token) => api.getOrgLogo(token)),
      staleTime: 0,
    });
    if (state.logo === null) return null;
    const bitmap = logoFromWire(state.logo);
    return bitmap === null ? null : bitmapPngDataUrl(bitmap);
  } catch {
    return null;
  }
}
