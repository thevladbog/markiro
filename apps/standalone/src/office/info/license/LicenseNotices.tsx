import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Button, VisuallyHidden } from "@markiro/ui";

import type { OfficeLicense } from "../../../host/protocol.js";
import { useBackupTime } from "../../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../../office-query.js";
import {
  licenseNotices,
  noticeFreeRenewal,
  noticeNeedsTime,
  noticeText,
  type LicenseNotice,
} from "./license-view.js";

export interface ShownNotices {
  license: OfficeLicense;
  notices: LicenseNotice[];
  /** The organization's zone, or `null` for this PC's. */
  zone: string | null;
}

/**
 * The license's warnings to show now (spec §9.5): none while the license
 * loads, when it never did (the section explains a host that does not
 * answer), or when it warns of nothing. A failed re-read keeps the last
 * answer, so the warnings do not vanish and come back (and are not heard
 * again) with a moment of silence from the host. The organization's profile
 * is read only when a warning writes a date, so an office whose license is
 * well asks nothing more.
 */
export function useLicenseNotices(): ShownNotices | null {
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  const data = license.data;
  const notices = data === undefined ? [] : licenseNotices(data);
  const time = useBackupTime(notices.some(noticeNeedsTime));
  if (data === undefined || !time.ready || notices.length === 0) return null;
  return { license: data, notices, zone: time.zone };
}

export interface LicenseNoticesProps extends ShownNotices {
  /** «Скрыть до конца сеанса» on a dismissible warning; none — no button (on «Обзор»). */
  onDismiss?: (notice: LicenseNotice) => void;
}

/**
 * The warnings, one alert each with a hidden word for its tone (a screen
 * reader does not hear the colour or the glyph), a subscription's free new
 * file after its own words where it applies, and a link to «Лицензия». They
 * live inside a polite region their caller keeps on the screen, so they lose
 * their own `alert` role (`presentation`): each is heard once, quietly.
 */
export function LicenseNotices({ license, notices, zone, onDismiss }: LicenseNoticesProps) {
  const { t } = useTranslation();
  return (
    <>
      {notices.map((notice) => {
        const text = noticeText(notice, license, zone);
        const renewal = noticeFreeRenewal(notice, license);
        return (
          <Alert
            key={notice.kind}
            tone={notice.tone}
            role="presentation"
            action={
              onDismiss !== undefined && notice.dismissible ? (
                <Button variant="secondary" size="compact" onClick={() => onDismiss(notice)}>
                  {t("office.banner.license.dismiss")}
                </Button>
              ) : undefined
            }
          >
            <VisuallyHidden>{t(`office.banner.license.tone.${notice.tone}`)}</VisuallyHidden>{" "}
            {t(text.key, text.values ?? {})}
            {renewal !== null && <> {t(renewal.key, renewal.values ?? {})}</>}{" "}
            <Link to="/about#license">{t("office.banner.license.link")}</Link>
          </Alert>
        );
      })}
    </>
  );
}
