import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../cn.js";
import { Button } from "./Button.js";

export interface FullScreenDialogProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  backLabel?: string;
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

const OPEN_DIALOGS: HTMLElement[] = [];

function registerDialog(dialog: HTMLElement): () => void {
  OPEN_DIALOGS.push(dialog);
  return () => {
    const index = OPEN_DIALOGS.lastIndexOf(dialog);
    if (index !== -1) OPEN_DIALOGS.splice(index, 1);
  };
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const connectedDialogs = OPEN_DIALOGS.filter((candidate) => candidate.isConnected);
  if (connectedDialogs.some((candidate) => candidate !== dialog && dialog.contains(candidate))) {
    return false;
  }
  if (connectedDialogs.some((candidate) => candidate !== dialog && candidate.contains(dialog))) {
    return true;
  }
  return connectedDialogs.at(-1) === dialog;
}

export function FullScreenDialog({
  open,
  title,
  children,
  footer,
  onClose,
  backLabel = "Back",
  className,
  style,
}: FullScreenDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const unregister = registerDialog(dialog);
    (dialog ? getFocusable(dialog)[0] : undefined)?.focus();

    return () => {
      unregister();
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (event.defaultPrevented || !dialog || !isTopmostDialog(dialog)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    event.stopPropagation();
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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn("mk-full-screen-dialog", className)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        background: "var(--surface-page)",
        outline: "none",
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
          padding: "16px 24px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <h2 id={titleId} style={{ margin: 0, color: "var(--fg-1)", font: "var(--floor-title)" }}>
          {title}
        </h2>
        <Button
          size="floor"
          variant="secondary"
          style={{ width: "auto", minWidth: "var(--control-floor)", flexShrink: 0 }}
          onClick={onClose}
        >
          {backLabel}
        </Button>
      </header>
      <div
        className="mk-full-screen-dialog__body"
        style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", padding: 24 }}
      >
        {children}
      </div>
      {footer ? (
        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 12,
            padding: "12px 24px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
