import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, VisuallyHidden } from "@markiro/ui";

import type { HostStatus } from "../host/protocol.js";
import type { StatusDotTone } from "../lib/StatusDot.js";
import { OfficeIcon, type OfficeIconName } from "../office/OfficeIcon.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { SyncState } from "./shell.js";
import "./host-status-dot.css";

/**
 * The tone of the link: green while the host answers and the copies are
 * healthy; amber while connecting or while the shell retries a sync or holds
 * records the copies did not accept; red when the host is silent; grey before
 * the first status.
 */
export function hostDotTone(status: HostStatus | null, sync: SyncState | null): StatusDotTone {
  if (status === null) return "neutral";
  if (status.state === "offline") return "error";
  if (status.state === "connecting") return "warn";
  if (sync?.failure != null || (sync?.quarantined ?? 0) > 0) return "warn";
  return "ok";
}

/** The chip's icon and short words for the link: a picture and a word, never a colour alone. */
export function hostChipView(
  status: HostStatus | null,
  sync: SyncState | null,
): { tone: StatusDotTone; icon: OfficeIconName; textKey: string } {
  const tone = hostDotTone(status, sync);
  if (status === null) return { tone, icon: "wifi", textKey: "office.header.chip.unknown" };
  if (status.state === "offline") {
    return { tone, icon: "wifiSlash", textKey: "office.header.chip.offline" };
  }
  if (status.state === "connecting") {
    return { tone, icon: "sync", textKey: "office.header.chip.connecting" };
  }
  return {
    tone,
    icon: "wifi",
    textKey: tone === "ok" ? "office.header.chip.online" : "office.header.chip.attention",
  };
}

export interface HostStatusDotProps {
  status: HostStatus | null;
  sync: SyncState | null;
}

/**
 * The link to the host as a small dot beside the user's controls (beta 3.2):
 * the dot's name says the state in a few words, and the button opens a
 * popover with the details (since when the host is silent and why, a failed
 * sync, records not accepted). Escape or a press outside closes it. A hidden
 * live region says a change of state to a screen reader, as the chip did.
 */
export function HostStatusDot({ status, sync }: HostStatusDotProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const tone = hostDotTone(status, sync);
  const state =
    status === null
      ? t("link.unknown")
      : status.state === "online"
        ? t(tone === "ok" ? "link.online" : "link.onlineAttention")
        : status.state === "connecting"
          ? t("link.connecting")
          : t("link.offline");
  const label = t("office.header.link", { state });
  const chip = hostChipView(status, sync);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="host-dot" ref={root}>
      <Button
        variant="plain"
        className="host-dot__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`office-chip office-chip--${chip.tone}`}>
          <OfficeIcon name={chip.icon} size={16} />
          <span>{t(chip.textKey)}</span>
        </span>
      </Button>
      <div aria-live="polite" role="status">
        <VisuallyHidden>{label}</VisuallyHidden>
      </div>
      {open && (
        <div className="host-dot__panel" id={panelId} role="region" aria-label={label}>
          <HostStatusLine status={status} sync={sync} />
        </div>
      )}
    </div>
  );
}
