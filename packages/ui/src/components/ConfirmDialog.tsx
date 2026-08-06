import { useId, type ReactNode } from "react";

import { Button } from "./Button.js";
import { OverlayLayer } from "./OverlayLayer.js";

export type ConfirmDialogTone = "default" | "destructive";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  entity?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmDialogTone;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  entity,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  if (!open) return null;

  return (
    <OverlayLayer open kind="dialog" busy={busy} initialFocus="cancel" onEscape={onCancel}>
      {(surfaceRef) => (
        <div
          className="mk-confirm-dialog__scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          }}
        >
          <section
            ref={surfaceRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            aria-busy={busy || undefined}
            tabIndex={-1}
            className="mk-confirm-dialog"
          >
            <h2 id={titleId} className="mk-confirm-dialog__title">
              {title}
            </h2>
            <div id={descriptionId} className="mk-confirm-dialog__description">
              {description}
            </div>
            {entity ? <div className="mk-confirm-dialog__entity">{entity}</div> : null}
            <footer className="mk-confirm-dialog__actions">
              <Button data-overlay-cancel variant="secondary" disabled={busy} onClick={onCancel}>
                {cancelLabel}
              </Button>
              <Button
                variant={tone === "destructive" ? "destructive" : "primary"}
                disabled={busy}
                loading={busy}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </footer>
          </section>
        </div>
      )}
    </OverlayLayer>
  );
}
