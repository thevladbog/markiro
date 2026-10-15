import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { StatusDot, type StatusDotTone } from "./StatusDot.js";

const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

export interface LinkDotProps {
  /** The link as the shell reports it; `null` before the first status. */
  status: HostStatus | null;
  sync: SyncState | null;
}

/** The dot's colour: green while the host answers and the copies are sound, amber while a sync fails or the link is being made, red without the host. */
export function linkTone(
  status: HostStatus | null,
  sync: SyncState | null,
): { tone: StatusDotTone; pulse: boolean } {
  if (status === null) return { tone: "neutral", pulse: true };
  if (status.state === "offline") return { tone: "error", pulse: false };
  if (status.state === "connecting") return { tone: "warn", pulse: true };
  const unwell = (sync?.failure ?? null) !== null || (sync?.quarantined ?? 0) > 0;
  return { tone: unwell ? "warn" : "ok", pulse: false };
}

/** The link in words, as the line beside it has always said it. */
function linkLabel(t: TFunction, status: HostStatus | null): string {
  if (status === null) return t("link.connecting");
  if (status.state === "connecting") return t("link.connecting");
  if (status.state === "online") return t("link.online");
  if (status.lastContactAt === null) return t("link.offline");
  const contact = new Date(status.lastContactAt);
  const now = new Date();
  const today =
    contact.getFullYear() === now.getFullYear() &&
    contact.getMonth() === now.getMonth() &&
    contact.getDate() === now.getDate();
  return today
    ? t("link.offlineSince", { time: CLOCK.format(contact) })
    : t("link.offlineSinceDate", { date: DATE.format(contact), time: CLOCK.format(contact) });
}

/**
 * The link to the host as a small status dot in the station's bar (beta 3.2,
 * owner feedback: the green chip across the header was too loud). The dot's
 * name says the link in words; a tap opens the details beside it (since when,
 * why, the sync's health: `HostStatusLine`), a second tap, Escape or a tap
 * elsewhere closes them. A hidden polite line keeps announcing a change of the
 * link, as the chip's live region did.
 */
export function LinkDot({ status, sync }: LinkDotProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { tone, pulse } = linkTone(status, sync);
  const label = linkLabel(t, status);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="floor-link" ref={root}>
      <Button
        size="floor"
        variant="secondary"
        className="floor-link__button"
        aria-label={`${t("floor.status.link")}: ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <StatusDot tone={tone} label={label} pulse={pulse} decorative />
      </Button>
      <span className="station-visually-hidden" role="status" aria-live="polite">
        {label}
      </span>
      {open && (
        <div className="floor-link__popover" role="dialog" aria-label={t("floor.status.link")}>
          <HostStatusLine status={status} sync={sync} />
        </div>
      )}
    </div>
  );
}
