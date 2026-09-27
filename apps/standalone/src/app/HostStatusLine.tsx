import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { StatusChip, type TagPhase } from "@markiro/ui";

import type { HostStatus } from "../host/protocol.js";

const PHASE: Readonly<Record<HostStatus["state"], TagPhase>> = {
  online: "active",
  connecting: "running",
  offline: "attention",
};

/** Hours and minutes on this computer's clock. */
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
/** Day and month on this computer's clock, for a contact not made today. */
const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

/** Whether two instants fall on the same day on this computer's calendar. */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The link to the host, on the floor and in the office header: a tag that
 * says it in words, since when the host is silent, and why the last attempt
 * failed. The live region itself renders from the first paint, empty until
 * the shell's first status, so a screen reader already watches it and
 * announces that first status too, instead of only ones after it.
 */
export function HostStatusLine({ status }: { status: HostStatus | null }) {
  const { t } = useTranslation();
  let content: ReactNode = null;
  if (status !== null) {
    let label = t("link.online");
    if (status.state === "connecting") label = t("link.connecting");
    if (status.state === "offline") {
      if (status.lastContactAt === null) {
        label = t("link.offline");
      } else {
        const contact = new Date(status.lastContactAt);
        // A contact from an earlier day reads as if it happened today
        // otherwise: name the day too, not just the hour and minute.
        label = sameLocalDay(contact, new Date())
          ? t("link.offlineSince", { time: CLOCK.format(contact) })
          : t("link.offlineSinceDate", {
              date: DATE.format(contact),
              time: CLOCK.format(contact),
            });
      }
    }
    content = (
      <>
        <StatusChip phase={PHASE[status.state]} label={label} />
        {status.state !== "online" && status.lastError !== null && (
          <span className="host-status__reason">{t(`errors.link.${status.lastError}`)}</span>
        )}
      </>
    );
  }
  return (
    <div className="host-status" role="status" aria-live="polite">
      {content}
    </div>
  );
}
