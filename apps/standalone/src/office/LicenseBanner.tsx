import { useState } from "react";

import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";
import type { LicenseNoticeKind } from "./info/license/license-view.js";

/**
 * The band above the office's pages (extension point T3 of the license spec,
 * §9.5): the license's warnings on every page, in a polite region that is on
 * the screen from the start. It never blocks a page: it is a notice, not a
 * dialog. A dismissible warning hides for the rest of the session (`Office`
 * lives as long as one session, and the shell with this band as long as
 * `Office`); a new kind of warning — the trial's last four days after its
 * first ten — shows again. The serious ones never hide.
 */
export function LicenseBanner() {
  const shown = useLicenseNotices();
  const [dismissed, setDismissed] = useState<ReadonlySet<LicenseNoticeKind>>(() => new Set());
  const visible =
    shown === null
      ? []
      : shown.notices.filter((notice) => !(notice.dismissible && dismissed.has(notice.kind)));
  return (
    <div className="office-banner" aria-live="polite">
      {shown !== null && visible.length > 0 && (
        <LicenseNotices
          license={shown.license}
          notices={visible}
          zone={shown.zone}
          onDismiss={(notice) => setDismissed((previous) => new Set([...previous, notice.kind]))}
        />
      )}
    </div>
  );
}
