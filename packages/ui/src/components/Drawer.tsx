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

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
  style?: CSSProperties;
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

/**
 * A right-edge, modal drawer for office workflows. It deliberately owns the
 * same keyboard contract as Modal while retaining a wider, task-focused form
 * layout. It renders inline to match the rest of the UI package.
 */
export function Drawer({
  open,
  title,
  children,
  footer,
  onClose,
  closeLabel = "Close",
  className,
  style,
}: DrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = dialog ? getFocusable(dialog) : [];
    (focusable[0] ?? dialog)?.focus();

    return () => previouslyFocused?.focus();
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      onClose();
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
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div className="mk-drawer-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn("mk-drawer", className)}
        style={style}
        onClick={stopPropagation}
        onKeyDown={handleKeyDown}
      >
        <header className="mk-drawer__header">
          <h2 id={titleId} className="mk-drawer__title">
            {title}
          </h2>
          <button type="button" className="mk-drawer__close" onClick={onClose} aria-label={closeLabel}>
            ×
          </button>
        </header>
        <div className="mk-drawer__body">{children}</div>
        {footer ? <footer className="mk-drawer__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
