import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { FloorChip } from "./FloorChip.js";
import { chipForm, linkChip, type CollapseLevel } from "./header-chips.js";

const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

export interface LinkDotProps {
  /** The link as the shell reports it; `null` before the first status. */
  status: HostStatus | null;
  sync: SyncState | null;
  /** How far the header has collapsed (`header-chips`): a healthy link is its glyph alone from level 1. */
  level?: CollapseLevel;
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
 * The link to the host as the first chip of the station's bar (kit header:
 * a glyph and a word, not a bare dot; collapsed to the glyph while the row is
 * tight). The button's name says the link in full; a tap opens the details beside it (since when,
 * why, the sync's health: `HostStatusLine`), a second tap, Escape or a tap
 * elsewhere closes them. A hidden polite line keeps announcing a change of the
 * link, as the chip's live region did.
 */
export function LinkDot({ status, sync, level = 0 }: LinkDotProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const chip = linkChip(status, sync);
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
        // The kit paints a button inline: the target round the chip is no box of its own.
        style={{ background: "transparent", borderColor: "transparent", boxShadow: "none" }}
        aria-label={`${t("floor.status.link")}: ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {/*
          The same chip as the others beside it (a glyph and a word on a tone); the button around
          it is the 64 px target. Its name says the link in full, the chip its short word.
        */}
        <FloorChip
          kind="link"
          tone={chip.tone}
          icon={chip.icon}
          text={t(`floor.chips.link.${chip.text}`)}
          form={chipForm(level, chip.tone)}
          title={label}
          className="floor-link__chip"
        />
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
