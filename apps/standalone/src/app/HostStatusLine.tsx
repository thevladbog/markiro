import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { StatusChip, type TagPhase } from "@markiro/ui";

import type { HostStatus } from "../host/protocol.js";
import type { SyncState } from "./shell.js";

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

export interface HostStatusLineProps {
  /** The link as the shell reports it; `null` before the first status. */
  status: HostStatus | null;
  /** The reference sync; `null` where the shell's sync is unknown, as in office tests. */
  sync: SyncState | null;
}

/**
 * The link to the host and the health of the local copies, on the floor,
 * on the line screen and in the office header: a tag that says it in words,
 * since when the host is silent and why the last attempt failed; while the
 * host answers, a failed sync the shell retries on its own, and why; and
 * how many feed records the copies did not accept. The live region itself
 * renders from the first paint, empty until the shell's first status, so a
 * screen reader already watches it and announces that first status too,
 * instead of only ones after it.
 */
export function HostStatusLine({ status, sync }: HostStatusLineProps) {
  const { t } = useTranslation();
  let link: ReactNode = null;
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
    link = (
      <span className="host-status__line">
        <StatusChip phase={PHASE[status.state]} label={label} />
        {status.state !== "online" && status.lastError !== null && (
          <span className="host-status__reason">{t(`errors.link.${status.lastError}`)}</span>
        )}
      </span>
    );
  }
  // Without the host the link's own words say why, and the retry waits for it.
  const failure = status?.state === "online" ? (sync?.failure ?? null) : null;
  const quarantined = sync?.quarantined ?? 0;
  return (
    <div className="host-status" role="status" aria-live="polite">
      {link}
      {failure !== null && (
        <span className="host-status__line">
          <StatusChip phase="attention" label={t("link.syncFailed")} wrap />
          <span className="host-status__reason">{t(`errors.sync.${failure}`)}</span>
        </span>
      )}
      {quarantined > 0 && (
        <span className="host-status__line">
          <StatusChip phase="attention" label={t("link.quarantined", { n: quarantined })} wrap />
        </span>
      )}
    </div>
  );
}
