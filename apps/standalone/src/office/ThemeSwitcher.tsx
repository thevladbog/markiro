import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, useTheme, type Theme } from "@markiro/ui";

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  "aria-hidden": true,
  focusable: false,
} as const;

const ICONS: Readonly<Record<Theme, ReactNode>> = {
  light: (
    <svg {...ICON_PROPS}>
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  system: (
    <svg {...ICON_PROPS}>
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="8.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M5.5 14h5M8 11v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  dark: (
    <svg {...ICON_PROPS}>
      <path
        d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

/** «Системная» is the default, so it leads. */
const ORDER: readonly Theme[] = ["system", "light", "dark"];

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/**
 * The theme selector of the office (header and sign-in): a trigger showing the current choice
 * opens a menu of «Системная» (the default), «Светлая», «Тёмная» with radio semantics. The choice
 * lives in the app's theme provider (`markiro.theme`); «Системная» follows the operating system.
 */
export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  const menuId = useId();
  // Which item takes the focus when the menu opens; -1: none.
  const focusOnOpen = useRef(-1);

  const close = (toTrigger: boolean) => {
    setOpen(false);
    if (toTrigger) rootRef.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
  };

  const openAt = (index: number) => {
    focusOnOpen.current = index;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const index = focusOnOpen.current >= 0 ? focusOnOpen.current : ORDER.indexOf(theme);
    items()[index]?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
    // Only the opening moves the focus: a later theme change must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(ORDER.indexOf(theme));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(ORDER.length - 1);
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const current = list.findIndex((el) => el === document.activeElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + ORDER.length) % ORDER.length]?.focus();
    };
    if (event.key === "ArrowDown") move(current + 1);
    else if (event.key === "ArrowUp") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(ORDER.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div ref={rootRef} className="theme-switcher" style={{ position: "relative" }}>
      <Button
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("office.login.theme.trigger", { theme: t(`office.login.theme.${theme}`) })}
        title={t("office.login.theme.label")}
        style={{ minHeight: 44, gap: 8 }}
        onClick={() => (open ? close(false) : openAt(-1))}
        onKeyDown={onTriggerKey}
      >
        {ICONS[theme]}
        <span>{t(`office.login.theme.${theme}`)}</span>
      </Button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t("office.login.theme.label")}
          className="theme-switcher__menu"
          onKeyDown={onMenuKey}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: "var(--z-overlay-popover)",
            minWidth: 220,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            background: "var(--surface-panel)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--r-2)",
            boxShadow: "var(--shadow-3)",
          }}
        >
          {ORDER.map((each) => {
            const on = each === theme;
            return (
              <Button
                key={each}
                variant="secondary"
                role="menuitemradio"
                aria-checked={on}
                tabIndex={-1}
                className={
                  on
                    ? "theme-switcher__option theme-switcher__option--on"
                    : "theme-switcher__option"
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 44,
                  padding: "0 12px",
                  border: 0,
                  borderRadius: "var(--r-2)",
                  background: on ? "var(--surface-card)" : "transparent",
                  color: on ? "var(--fg-1)" : "var(--fg-2)",
                  font: "500 14px/1 var(--font-ui)",
                  textAlign: "left",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setTheme(each);
                  close(true);
                }}
              >
                {ICONS[each]}
                <span style={{ flex: 1 }}>
                  {t(`office.login.theme.${each}`)}
                  {each === "system" && (
                    <span style={{ color: "var(--fg-3)" }}>
                      {" "}
                      ({t("office.login.theme.default")})
                    </span>
                  )}
                </span>
                {on && (
                  <>
                    <span aria-hidden="true">✓</span>
                    <span style={VISUALLY_HIDDEN}>{t("office.login.theme.selected")}</span>
                  </>
                )}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
