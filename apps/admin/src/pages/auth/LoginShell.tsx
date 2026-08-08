import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type Theme, useTheme } from "@markiro/ui";

import logoOnDark from "../../assets/markiro-logo-on-dark.svg";
import logoOnLight from "../../assets/markiro-logo-on-light.svg";
import "./login.css";

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_KEY: Record<Theme, string> = {
  system: "auth.login.themeSystem",
  light: "auth.login.themeLight",
  dark: "auth.login.themeDark",
};

const DECORATIVE_CODE = "01 04607012345678 21 KQ4D8N7X2 91 EE06 92 F8C3B7A1D9";

export function LoginShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = i18n.resolvedLanguage === "en" ? "en" : "ru";
  const nextLanguage = language === "ru" ? "en" : "ru";
  const now = new Date();
  const dateTime = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const formattedDate = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now);
  const themeLabel = t(THEME_KEY[theme]);

  return (
    <div className="mk-login-page">
      <section className="mk-login-page__brand" aria-labelledby="login-brand-heading">
        <div className="mk-login-page__grid" aria-hidden="true" />
        <div className="mk-login-page__code" aria-hidden="true">
          {DECORATIVE_CODE}
        </div>
        <picture
          className="mk-login-page__brand-logo"
          role="img"
          aria-label={t("auth.login.logoAlt")}
        >
          <img
            className="mk-login-page__logo-on-light"
            src={logoOnLight}
            alt=""
            aria-hidden="true"
          />
          <img className="mk-login-page__logo-on-dark" src={logoOnDark} alt="" aria-hidden="true" />
        </picture>
        <div className="mk-login-page__brand-copy">
          <h2 id="login-brand-heading">{t("auth.login.brandHeading")}</h2>
          <p>{t("auth.login.brandBody")}</p>
        </div>
        <div className="mk-login-page__brand-meta">
          <span>MARKIRO / TENANT ADMIN</span>
          <time dateTime={dateTime}>{formattedDate}</time>
        </div>
      </section>

      <section className="mk-login-page__login">
        <header className="mk-login-page__header">
          <picture className="mk-login-page__mobile-logo" aria-hidden="true">
            <img className="mk-login-page__logo-on-light" src={logoOnLight} alt="" />
            <img className="mk-login-page__logo-on-dark" src={logoOnDark} alt="" />
          </picture>
          <button
            type="button"
            onClick={() => void i18n.changeLanguage(nextLanguage)}
            aria-label={t("auth.login.toggleLanguage")}
          >
            {language.toUpperCase()}
          </button>
          <button
            type="button"
            onClick={() => setTheme(NEXT_THEME[theme])}
            aria-label={t("auth.login.toggleTheme", { theme: themeLabel })}
          >
            {themeLabel}
          </button>
        </header>
        <main className="mk-login-page__main">{children}</main>
        <footer className="mk-login-page__footer">{t("auth.login.protectedCabinet")}</footer>
      </section>
    </div>
  );
}
