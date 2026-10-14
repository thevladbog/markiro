import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
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
  type LicenseNoticeKind,
} from "./license-view.js";

interface Dismissals {
  dismissed: ReadonlySet<LicenseNoticeKind>;
  dismiss: (kind: LicenseNoticeKind) => void;
}

const DismissalsContext = createContext<Dismissals | null>(null);

/**
 * The warnings hidden by «Скрыть до конца сеанса», one set for the band and
 * «Обзор»: a warning hidden on one is hidden on the other. `Office` holds it,
 * so it lives exactly as long as the session (`App` keys `Office` by it).
 */
export function LicenseDismissalsProvider({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<LicenseNoticeKind>>(() => new Set());
  const value = useMemo<Dismissals>(
    () => ({
      dismissed,
      dismiss: (kind) => setDismissed((previous) => new Set([...previous, kind])),
    }),
    [dismissed],
  );
  return <DismissalsContext.Provider value={value}>{children}</DismissalsContext.Provider>;
}

export interface ShownNotices {
  license: OfficeLicense;
  /** The warnings to show: the dismissed ones are left out. */
  notices: LicenseNotice[];
  /** The organization's zone, or `null` for this PC's. */
  zone: string | null;
  /** Hides a dismissible warning for the session; absent outside the shell's dismissals. */
  onDismiss?: (notice: LicenseNotice) => void;
}

/**
 * The license's warnings to show now (spec §9.5): none while the license
 * loads, when it never did (the section explains a host that does not
 * answer), or when it warns of nothing. A failed re-read keeps the last
 * answer, so the warnings do not vanish and come back (and are not heard
 * again) with a moment of silence from the host. A warning dismissed for
 * the session is left out. The organization's profile is read only when a
 * shown warning writes a date, so an office whose license is well asks
 * nothing more.
 */
export function useLicenseNotices(): ShownNotices | null {
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  const dismissals = useContext(DismissalsContext);
  const data = license.data;
  const notices = (data === undefined ? [] : licenseNotices(data)).filter(
    (notice) => !(notice.dismissible && dismissals?.dismissed.has(notice.kind) === true),
  );
  const time = useBackupTime(notices.some(noticeNeedsTime));
  if (data === undefined || !time.ready || notices.length === 0) return null;
  const shown: ShownNotices = { license: data, notices, zone: time.zone };
  if (dismissals !== null) shown.onDismiss = (notice) => dismissals.dismiss(notice.kind);
  return shown;
}

export type LicenseNoticesProps = ShownNotices;

/**
 * The warnings, one alert each with a hidden word for its tone (a screen
 * reader does not hear the colour or the glyph), a subscription's free new
 * file after its own words where it applies, and a link to «Лицензия». They
 * live inside a polite region their caller keeps on the screen, so they lose
 * their own `alert` role (`presentation`): each is heard once, quietly.
 * «Скрыть» removes its own button, so the focus moves to the «Скрыть» of the
 * warning that takes its place (the next, else the previous), else to the
 * office's `main` (focusable by code, as after a menu navigation), never to
 * the document's body.
 */
export function LicenseNotices({ license, notices, zone, onDismiss }: LicenseNoticesProps) {
  const { t } = useTranslation();
  const hide = (
    notice: LicenseNotice,
    button: HTMLElement,
    dismiss: (notice: LicenseNotice) => void,
  ) => {
    // Before the button goes: the last warning hidden unmounts these alerts altogether.
    const dismissible = notices.filter((other) => other.dismissible);
    const at = dismissible.findIndex((other) => other.kind === notice.kind);
    const next = dismissible[at + 1] ?? dismissible[at - 1];
    const target =
      next === undefined
        ? null
        : button.ownerDocument.querySelector<HTMLElement>(`[data-license-dismiss="${next.kind}"]`);
    (target ?? button.ownerDocument.querySelector<HTMLElement>("main"))?.focus();
    dismiss(notice);
  };
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
                <Button
                  variant="secondary"
                  size="compact"
                  data-license-dismiss={notice.kind}
                  onClick={(event) => hide(notice, event.currentTarget, onDismiss)}
                >
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
