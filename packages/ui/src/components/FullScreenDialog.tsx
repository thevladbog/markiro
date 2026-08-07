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
  /**
   * Focus the inert dialog container when opening flows where the first
   * action must not be triggerable by the key event that opened the dialog.
   */
  initialFocus?: "first" | "dialog";
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

interface OpenDialogEntry {
  dialog: HTMLElement;
  returnFocus: HTMLElement | null;
  rootReturnFocus: HTMLElement | null;
}

const OPEN_DIALOGS: OpenDialogEntry[] = [];

function connectedDialogs(): OpenDialogEntry[] {
  return OPEN_DIALOGS.filter((entry) => entry.dialog.isConnected);
}

function topmostDialog(): OpenDialogEntry | undefined {
  const connected = connectedDialogs();
  for (let index = connected.length - 1; index >= 0; index -= 1) {
    const candidate = connected[index];
    if (
      candidate &&
      !connected.some((other) => other !== candidate && candidate.dialog.contains(other.dialog))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function registerDialog(
  dialog: HTMLElement,
  returnFocus: HTMLElement | null,
): { entry: OpenDialogEntry; unregister: () => void } {
  const connected = connectedDialogs();
  const ancestor = connected.find((candidate) => candidate.dialog.contains(dialog));
  const descendant = connected.find((candidate) => dialog.contains(candidate.dialog));
  const entry: OpenDialogEntry = {
    dialog,
    returnFocus,
    rootReturnFocus: ancestor?.rootReturnFocus ?? descendant?.rootReturnFocus ?? returnFocus,
  };
  OPEN_DIALOGS.push(entry);
  return {
    entry,
    unregister: () => {
      const index = OPEN_DIALOGS.lastIndexOf(entry);
      if (index !== -1) OPEN_DIALOGS.splice(index, 1);
    },
  };
}

function focusFirst(dialog: HTMLElement): void {
  (getFocusable(dialog)[0] ?? dialog).focus();
}

function restoreFocusAfterClose(entry: OpenDialogEntry): void {
  const topmost = topmostDialog();
  if (topmost) {
    if (entry.returnFocus?.isConnected && topmost.dialog.contains(entry.returnFocus)) {
      entry.returnFocus.focus();
    } else {
      focusFirst(topmost.dialog);
    }
    return;
  }

  if (entry.rootReturnFocus?.isConnected) {
    entry.rootReturnFocus.focus();
  } else if (entry.returnFocus?.isConnected) {
    entry.returnFocus.focus();
  }
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  return topmostDialog()?.dialog === dialog;
}

export function FullScreenDialog({
  open,
  title,
  children,
  footer,
  onClose,
  backLabel = "Back",
  initialFocus = "first",
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
    const { entry, unregister } = registerDialog(dialog, previouslyFocused);
    if (isTopmostDialog(dialog)) {
      if (initialFocus === "dialog") dialog.focus();
      else focusFirst(dialog);
    }

    return () => {
      unregister();
      restoreFocusAfterClose(entry);
    };
  }, [initialFocus, open]);

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
    if (document.activeElement === dialog) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
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
