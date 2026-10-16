import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button, useTheme, type Theme } from "@markiro/ui";

import { OfficeIcon, type OfficeIconName } from "./OfficeIcon.js";

const ICON: Readonly<Record<Theme, OfficeIconName>> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

/** «Системная» is the default, so it leads. */
const ORDER: readonly Theme[] = ["system", "light", "dark"];

/**
 * The theme selector of the office (top bar and sign-in): three icon segments in one track —
 * «Системная» (the default, follows the operating system), «Светлая», «Тёмная» — a radio group.
 * The chosen one is filled and says so to a screen reader (`aria-checked`); the name of each is
 * its `aria-label` and tooltip. One tab stop, on the chosen segment; the arrows, Home and End move
 * and choose. The choice lives in the app's theme provider (`markiro.theme`).
 */
export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);

  const nameOf = (each: Theme) =>
    each === "system"
      ? `${t("office.login.theme.system")} (${t("office.login.theme.default")})`
      : t(`office.login.theme.${each}`);

  const choose = (each: Theme) => {
    setTheme(each);
    // The chosen segment holds the tab stop and the focus.
    queueMicrotask(() =>
      rootRef.current?.querySelector<HTMLElement>(`[data-theme-choice="${each}"]`)?.focus(),
    );
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = ORDER.indexOf(theme);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = at + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ORDER.length - 1;
    if (next === null) return;
    event.preventDefault();
    const each = ORDER[(next + ORDER.length) % ORDER.length];
    if (each !== undefined) choose(each);
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={t("office.login.theme.label")}
      className="theme-switcher"
      onKeyDown={onKey}
    >
      {ORDER.map((each) => {
        const on = each === theme;
        return (
          <Button
            key={each}
            variant="ghost"
            role="radio"
            aria-checked={on}
            aria-label={nameOf(each)}
            title={nameOf(each)}
            data-theme-choice={each}
            tabIndex={on ? 0 : -1}
            className={
              on ? "theme-switcher__option theme-switcher__option--on" : "theme-switcher__option"
            }
            onClick={() => choose(each)}
          >
            <OfficeIcon name={ICON[each]} size={20} />
          </Button>
        );
      })}
    </div>
  );
}
