import * as RadixPopover from "@radix-ui/react-popover";
import { useRef, useState, type KeyboardEvent } from "react";

import { Button } from "./Button.js";
import { useOverlayPortalContainer } from "./OverlayLayer.js";

export interface RowActionItem {
  key: string;
  /** The text of the item. */
  label: string;
  /** The item's accessible name when it must say more than `label` (for example which record). */
  ariaLabel?: string;
  onSelect: () => void;
  /** An action that takes something out of use or away: set apart, in the error tone. */
  destructive?: boolean;
  disabled?: boolean;
}

export interface RowActionMenuProps {
  /** The accessible name of the «⋯» button, naming the record: «Действия: Иван». */
  label: string;
  items: readonly RowActionItem[];
  /** Disables the button (for example while a write is on its way). */
  disabled?: boolean;
}

/**
 * The compact menu of a table row's less used actions: one «⋯» button that opens
 * a list. Next to one primary button it keeps a row of many actions one line
 * tall. Keyboard: Enter or Space opens it, the arrows, Home and End move,
 * Enter or Space chooses, Escape closes and returns to the button.
 */
export function RowActionMenu({ label, items, disabled = false }: RowActionMenuProps) {
  const overlayPortalContainer = useOverlayPortalContainer();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = useRef(false);

  const enabled = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = enabled();
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = current <= 0 ? buttons.length - 1 : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <Button
          variant="secondary"
          size="compact"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          className="mk-row-action-menu__trigger"
          style={{ minWidth: "var(--control-sm)", padding: "0 10px" }}
        >
          <span aria-hidden="true">⋯</span>
        </Button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal
        {...(overlayPortalContainer === undefined ? {} : { container: overlayPortalContainer })}
      >
        <RadixPopover.Content
          data-mk-nested-overlay=""
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="mk-row-action-menu__content"
          style={{
            zIndex: "var(--z-overlay-popover)",
            minWidth: 180,
            padding: 4,
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--r-2)",
            background: "var(--surface-card)",
            color: "var(--fg-1)",
            boxShadow: "0 12px 32px color-mix(in srgb, var(--fg-1) 18%, transparent)",
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            enabled()[0]?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // After a choice the opened dialog takes the focus; after Escape the button does.
            if (chosen.current) event.preventDefault();
            chosen.current = false;
          }}
        >
          <div ref={listRef} role="menu" aria-label={label} onKeyDown={move}>
            {items.map((item, index) => (
              <div key={item.key}>
                {item.destructive && index > 0 && !items[index - 1]?.destructive ? (
                  <div
                    role="separator"
                    style={{ height: 1, margin: "4px 0", background: "var(--line)" }}
                  />
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={item.ariaLabel}
                  disabled={item.disabled}
                  data-destructive={item.destructive ? "true" : undefined}
                  className="mk-row-action-menu__item"
                  onClick={() => {
                    chosen.current = true;
                    setOpen(false);
                    item.onSelect();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    width: "100%",
                    minHeight: "var(--control-md)",
                    padding: "0 12px",
                    border: "none",
                    borderRadius: "calc(var(--r-2) - 2px)",
                    background: "transparent",
                    color: item.destructive ? "var(--err-fg)" : "var(--fg-1)",
                    font: "var(--text-body)",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    cursor: item.disabled ? "not-allowed" : "pointer",
                    opacity: item.disabled ? 0.45 : 1,
                  }}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
