import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, useTheme, type Theme } from "@markiro/ui";

const ICONS: Readonly<Record<Theme, ReactNode>> = {
  light: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
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

const ORDER: readonly Theme[] = ["light", "system", "dark"];

/**
 * «Светлая / Система / Тёмная»: a pill of three icon buttons over the app's own theme provider,
 * which keeps the choice (`markiro.theme`), so the office header's theme button and this switcher
 * always agree. «Система» follows the operating system.
 */
export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-switcher" role="group" aria-label={t("office.login.theme.label")}>
      {ORDER.map((each) => (
        <Button
          key={each}
          variant="secondary"
          size="compact"
          className={
            each === theme
              ? "theme-switcher__option theme-switcher__option--on"
              : "theme-switcher__option"
          }
          // The button's own inline style carries its padding and colours: these override it.
          style={{
            padding: 0,
            width: 32,
            minWidth: 32,
            borderRadius: 999,
            borderColor: "transparent",
            background: each === theme ? "var(--surface-panel)" : "transparent",
            color: each === theme ? "var(--fg-1)" : "var(--fg-2)",
          }}
          aria-label={t(`office.login.theme.${each}`)}
          aria-pressed={each === theme}
          title={t(`office.login.theme.${each}`)}
          onClick={() => setTheme(each)}
        >
          {ICONS[each]}
        </Button>
      ))}
    </div>
  );
}
