import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { IconButton } from "@markiro/ui";

import { StatusDot, type StatusDotTone } from "../lib/StatusDot.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { useViewportWidth } from "./use-viewport-width.js";

/** Secondary header controls stay available in a non-modal popover on narrow windows. */
export function OfficeHeaderTools({
  label,
  state,
  tone,
  children,
}: {
  label: string;
  state: string;
  tone: StatusDotTone;
  children: ReactNode;
}) {
  const compact = useViewportWidth() <= 640;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    const resized = () =>
      setOpen(document.querySelector('[role="dialog"][aria-modal="true"]') !== null);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  useEffect(() => {
    if (!compact || !open) return;
    if (!document.querySelector('[role="dialog"][aria-modal="true"]'))
      panel.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (event: PointerEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [compact, open]);

  const description = `${label}. ${state}`;
  return (
    <div
      ref={root}
      className={compact ? "office-header__tools" : "office-header__tools-inline"}
      onBlur={(event) => {
        if (!compact) return;
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        if (!(event.relatedTarget instanceof Node) || !root.current?.contains(event.relatedTarget))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!compact) return;
        if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]'))
          return;
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      {compact && (
        <IconButton
          ref={trigger}
          variant="ghost"
          aria-label={description}
          title={description}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
          icon={
            <span className="office-header__tools-icon">
              <OfficeIcon name="sliders" />
              {tone !== "ok" && <StatusDot tone={tone} label={state} decorative />}
            </span>
          }
        />
      )}
      {compact && !open && (
        <span className="mk-visually-hidden" role="status">
          {state}
        </span>
      )}
      {(!compact || open) && (
        <div
          ref={panel}
          id={panelId}
          role={compact ? "dialog" : undefined}
          aria-label={compact ? label : undefined}
          className={compact ? "office-header__tools-panel" : "office-header__tools-inline"}
        >
          {children}
        </div>
      )}
    </div>
  );
}
