import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@markiro/ui";

import { OfficeIcon, type OfficeIconName } from "../OfficeIcon.js";
import { menuMove, nextEnabled } from "./menu-model.js";
import { Tooltip } from "./Tooltip.js";

/** An action of a table row, shown as an icon button of its own. */
export interface RowIconAction {
  key: string;
  /** The button's accessible name and its tooltip: it should name the record («Изменить товар «Квас»»). */
  label: string;
  icon: OfficeIconName;
  onSelect: () => void;
  disabled?: boolean;
}

/** An entry of the row's «Ещё» menu. */
export interface RowMenuItem {
  key: string;
  label: string;
  /** The entry's accessible name when it must say more than `label` (which record). */
  ariaLabel?: string;
  icon?: OfficeIconName;
  onSelect: () => void;
  /** An action that takes something out of use: set apart by a rule, in the error tone. */
  destructive?: boolean;
  disabled?: boolean;
}

export interface RowActionBarProps {
  /** The icon buttons, in order. */
  actions?: readonly RowIconAction[];
  /** The «Ещё» menu; absent or without entries it is not drawn. */
  menu?: {
    /** The menu button's accessible name, naming the record: «Действия: Квас». */
    label: string;
    items: readonly RowMenuItem[];
  };
}

/**
 * The actions of a table row: icon buttons of 40 px, each with a tooltip and its own accessible
 * name, and the «Ещё» menu for the less used ones (design 2026-10: icons in the row, never a
 * column of text buttons). Everything a row can do is reachable by the keyboard: Tab to the
 * buttons, Enter or Space to press, and in the menu the arrows, Home and End, Escape to close
 * with the focus back on the button.
 */
export function RowActionBar({ actions = [], menu }: RowActionBarProps) {
  const { t } = useTranslation();
  const items = menu?.items ?? [];
  return (
    <div className="office-row-actions">
      {actions.map((action) => (
        <Tooltip key={action.key} label={action.label}>
          <IconButton
            variant="ghost"
            aria-label={action.label}
            icon={<OfficeIcon name={action.icon} size={20} />}
            disabled={action.disabled ?? false}
            onClick={action.onSelect}
          />
        </Tooltip>
      ))}
      {menu !== undefined && items.length > 0 && (
        <RowMenu label={menu.label} moreLabel={t("office.common.more")} items={items} />
      )}
    </div>
  );
}

interface Position {
  top: number;
  right: number;
}

function RowMenu({
  label,
  moreLabel,
  items,
}: {
  label: string;
  moreLabel: string;
  items: readonly RowMenuItem[];
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  // The button is found through its wrapper: the shared `Button` takes no ref.
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = () => anchor.current?.querySelector("button") ?? null;
  const list = useRef<HTMLDivElement>(null);
  // A chosen entry opens a dialog that takes the focus; Escape and Tab-away give it back.
  const returnFocus = useRef(true);

  const close = (focusButton: boolean) => {
    returnFocus.current = focusButton;
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger()?.getBoundingClientRect();
    if (rect === undefined) return;
    setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);

  // The first enabled entry takes the focus once the menu is drawn.
  useEffect(() => {
    if (!open || position === null) return;
    const entries = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const first = nextEnabled(
      "first",
      -1,
      entries.map((entry) => entry.disabled),
    );
    if (first !== null) entries[first]?.focus();
  }, [open, position]);

  // After it closes, the button gets the focus back unless an entry's dialog took it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && returnFocus.current) trigger()?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (list.current?.contains(target) || anchor.current?.contains(target)) return;
      close(false);
    };
    const leave = () => close(false);
    // Escape closes the menu wherever the focus is (the button, or nowhere after a click).
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", leave);
    window.addEventListener("scroll", leave, true);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", leave);
      window.removeEventListener("scroll", leave, true);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // Tab leaves the menu: it closes and the focus carries on from the button.
      close(true);
      return;
    }
    const move = menuMove(event.key);
    if (move === null) return;
    event.preventDefault();
    const entries = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = nextEnabled(
      move,
      entries.indexOf(document.activeElement as HTMLButtonElement),
      entries.map((entry) => entry.disabled),
    );
    if (next !== null) entries[next]?.focus();
  };

  return (
    <>
      <span ref={anchor} className="office-row-menu__anchor">
        <Tooltip label={moreLabel}>
          <IconButton
            variant="ghost"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            icon={<OfficeIcon name="more" size={20} />}
            onClick={() => {
              returnFocus.current = true;
              setOpen((was) => !was);
            }}
          />
        </Tooltip>
      </span>
      {open &&
        createPortal(
          <div
            ref={list}
            id={menuId}
            role="menu"
            aria-label={label}
            className="office-row-menu"
            style={
              position === null
                ? { visibility: "hidden" }
                : { top: position.top, right: position.right }
            }
            onKeyDown={onKeyDown}
          >
            {items.map((item, index) => (
              <div key={item.key} role="none">
                {item.destructive === true &&
                  index > 0 &&
                  items[index - 1]?.destructive !== true && (
                    <div role="separator" className="office-row-menu__rule" />
                  )}
                <Button
                  variant="ghost"
                  role="menuitem"
                  aria-label={item.ariaLabel}
                  disabled={item.disabled ?? false}
                  className="office-row-menu__item"
                  data-destructive={item.destructive === true ? "true" : undefined}
                  onClick={() => {
                    // The entry opens a dialog (or writes): that is where the focus goes next.
                    close(false);
                    item.onSelect();
                  }}
                >
                  {item.icon !== undefined && <OfficeIcon name={item.icon} size={20} />}
                  <span>{item.label}</span>
                </Button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
