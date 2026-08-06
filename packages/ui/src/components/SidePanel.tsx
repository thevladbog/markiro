import { useId, type ReactNode } from "react";

import { cn } from "../cn.js";
import { IconButton } from "./IconButton.js";
import { OverlayLayer } from "./OverlayLayer.js";

export type OverlayDismissReason = "close-button" | "escape" | "backdrop" | "navigation";
export type SidePanelSize = "compact" | "standard" | "complex";

export interface SidePanelProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  status?: ReactNode;
  size?: SidePanelSize;
  busy?: boolean;
  closeLabel: string;
  className?: string;
  onClose: (reason: OverlayDismissReason) => void;
}

export function SidePanel({
  open,
  title,
  description,
  children,
  footer,
  status,
  size = "standard",
  busy = false,
  closeLabel,
  className,
  onClose,
}: SidePanelProps) {
  const titleId = useId();
  const descriptionId = useId();

  if (!open) return null;

  return (
    <OverlayLayer
      open
      kind="panel"
      busy={busy}
      initialFocus="first-editable"
      onEscape={() => onClose("escape")}
    >
      {(surfaceRef) => (
        <div
          className="mk-side-panel__scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) onClose("backdrop");
          }}
        >
          <section
            ref={surfaceRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            aria-busy={busy || undefined}
            tabIndex={-1}
            className={cn("mk-side-panel", `mk-side-panel--${size}`, className)}
          >
            <header className="mk-side-panel__header">
              <div>
                <h2 id={titleId} className="mk-side-panel__title">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="mk-side-panel__description">
                    {description}
                  </p>
                ) : null}
              </div>
              <IconButton
                type="button"
                size="compact"
                variant="secondary"
                aria-label={closeLabel}
                icon={<span aria-hidden="true">×</span>}
                disabled={busy}
                onClick={() => onClose("close-button")}
              />
            </header>
            <div className="mk-side-panel__body">{children}</div>
            {footer || status ? (
              <footer className="mk-side-panel__footer">
                {status ? <div className="mk-side-panel__status">{status}</div> : null}
                {footer ? <div className="mk-side-panel__actions">{footer}</div> : null}
              </footer>
            ) : null}
          </section>
        </div>
      )}
    </OverlayLayer>
  );
}
