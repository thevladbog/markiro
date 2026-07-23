import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cn } from "../cn.js";

/**
 * Port of `design-system/components/feedback/Modal.jsx`'s `Modal` export
 * (office mode only — `FullScreenDialog`, the floor-mode counterpart, is out
 * of scope for this package). Adds the a11y behaviour the handoff's plain
 * JSX sketch does not implement: a focus trap that keeps Tab/Shift+Tab
 * cycling inside the dialog, initial focus moved into the dialog on open,
 * focus restored to the previously-focused element on close, and Escape
 * wired to `onClose` (the handoff only closes via overlay click). Rendered
 * inline (no portal) — matching the handoff, which mounts the fixed overlay
 * wherever the component appears in the tree.
 */
export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  children?: ReactNode;
  /** Кнопки внизу справа */
  footer?: ReactNode;
  onClose?: () => void;
  width?: number | string;
  className?: string;
  style?: CSSProperties;
  /** aria-label for the × close button -- this package has no i18n dependency, so a caller in a non-English locale (e.g. `apps/admin`) should pass a translated string. */
  closeLabel?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function Modal({
  open,
  title,
  children,
  footer,
  onClose,
  width = 480,
  className,
  style,
  closeLabel = "Close",
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = dialog ? getFocusable(dialog) : [];
    const target = focusable[0] ?? dialog;
    target?.focus();

    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const handleOverlayClick = () => {
    onClose?.();
  };

  const handleDialogClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      onClose?.();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusable(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
      className="mk-modal-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--surface-overlay)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={handleDialogClick}
        onKeyDown={handleKeyDown}
        className={cn("mk-modal", className)}
        style={{
          width,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--surface-card)",
          borderRadius: "var(--r-3)",
          border: "1px solid var(--line)",
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
          outline: "none",
          ...style,
        }}
      >
        {title || onClose ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span id={titleId} style={{ font: "var(--text-h2)", color: "var(--fg-1)" }}>
              {title}
            </span>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--fg-3)",
                  padding: 6,
                  display: "flex",
                  font: "600 16px/1 var(--font-ui)",
                }}
              >
                ✕
              </button>
            )}
          </div>
        ) : null}
        <div style={{ padding: 20, flex: 1 }}>{children}</div>
        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "14px 20px",
              borderTop: "1px solid var(--line)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
