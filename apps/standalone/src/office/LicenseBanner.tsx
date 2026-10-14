import { useLocation } from "react-router";

import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";

/**
 * The band above the office's pages (extension point T3 of the license spec,
 * §9.5): the license's warnings on every page, in a polite region that is on
 * the screen from the start. It never blocks a page: it is a notice, not a
 * dialog. A dismissible warning hides for the rest of the session (the
 * office's `LicenseDismissalsProvider`, shared with «Обзор»); a new kind of
 * warning — the trial's last four days after its first ten — shows again.
 * The serious ones never hide. On «Обзор» (`/`) the band stays empty: that
 * page carries the same warnings in its own region, and one warning shown
 * (and heard) twice is noise.
 */
export function LicenseBanner() {
  const shown = useLicenseNotices();
  const onOverview = useLocation().pathname === "/";
  return (
    <div className="office-banner" aria-live="polite">
      {shown !== null && !onOverview && <LicenseNotices {...shown} />}
    </div>
  );
}
