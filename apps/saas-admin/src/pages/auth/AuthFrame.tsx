import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type Theme, useTheme } from "@markiro/ui";

import { MarkiroLogo } from "../../components/MarkiroLogo.js";

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_KEY: Record<Theme, string> = {
  system: "auth.frame.themeSystem",
  light: "auth.frame.themeLight",
  dark: "auth.frame.themeDark",
};

export function AuthFrame({
  eyebrow,
  children,
  wide = false,
}: {
  eyebrow: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = i18n.resolvedLanguage === "en" ? "en" : "ru";
  const nextLanguage = language === "ru" ? "en" : "ru";

  return (
    <div className="auth-page">
      <a className="skip-link" href="#main-content">
        {t("shell.skip")}
      </a>
      <aside className="auth-brand" aria-label={t("auth.frame.brandRegion")}>
        <MarkiroLogo className="auth-brand__logo" variant="on-dark" />
        <div className="auth-brand__statement">
          <p className="auth-brand__product">MARKIRO / PLATFORM OPERATIONS</p>
          <h2>{t("auth.frame.headline")}</h2>
          <p className="auth-brand__description">{t("auth.frame.description")}</p>
          <dl className="auth-brand__facts">
            <div>
              <dt>{t("auth.frame.contour")}</dt>
              <dd>{t("auth.frame.internal")}</dd>
            </div>
            <div>
              <dt>{t("auth.frame.access")}</dt>
              <dd>2FA</dd>
            </div>
            <div>
              <dt>{t("auth.frame.region")}</dt>
              <dd>MOW · UTC+3</dd>
            </div>
          </dl>
        </div>
        <footer className="auth-brand__footer" aria-hidden="true">
          <span>SAAS CONSOLE · 01</span>
          <span>SECURE ACCESS</span>
        </footer>
      </aside>

      <section className="auth-workspace" aria-label={eyebrow}>
        <header className="auth-workspace__header">
          <MarkiroLogo className="auth-workspace__logo" />
          <button
            type="button"
            className="auth-workspace__control"
            onClick={() => void i18n.changeLanguage(nextLanguage)}
            aria-label={t("auth.frame.toggleLanguage")}
          >
            {language.toUpperCase()} / {nextLanguage.toUpperCase()}
          </button>
          <button
            type="button"
            className="auth-workspace__control"
            onClick={() => setTheme(NEXT_THEME[theme])}
            aria-label={t("auth.frame.toggleTheme", { theme: t(THEME_KEY[theme]) })}
          >
            {t(THEME_KEY[theme])}
          </button>
        </header>
        <main className="auth-workspace__main" id="main-content">
          <div className={wide ? "auth-panel__body auth-panel__body--wide" : "auth-panel__body"}>
            <p className="auth-panel__eyebrow">{eyebrow}</p>
            {children}
          </div>
        </main>
        <footer className="auth-workspace__footer" aria-hidden="true">
          <span>{t("auth.frame.staffOnly")}</span>
          <span>{t("auth.frame.twoFactorRequired")}</span>
        </footer>
      </section>
    </div>
  );
}
