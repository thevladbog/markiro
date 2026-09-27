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

/**
 * The link to the host, on the floor and in the office header: a tag that
 * says it in words, since when the host is silent, and why the last attempt
 * failed. Nothing before the shell's first status.
 */
export function HostStatusLine({ status }: { status: HostStatus | null }) {
  const { t } = useTranslation();
  if (status === null) return null;
  let label = t("link.online");
  if (status.state === "connecting") label = t("link.connecting");
  if (status.state === "offline") {
    label =
      status.lastContactAt === null
        ? t("link.offline")
        : t("link.offlineSince", { time: CLOCK.format(status.lastContactAt) });
  }
  return (
    <div className="host-status" role="status" aria-live="polite">
      <StatusChip phase={PHASE[status.state]} label={label} />
      {status.state !== "online" && status.lastError !== null && (
        <span className="host-status__reason">{t(`errors.link.${status.lastError}`)}</span>
      )}
    </div>
  );
}
