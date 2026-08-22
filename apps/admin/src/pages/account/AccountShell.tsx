import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, type Theme, useTheme } from "@markiro/ui";

import logoOnDark from "../../assets/markiro-logo-on-dark.svg";
import logoOnLight from "../../assets/markiro-logo-on-light.svg";
import "./account.css";

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

export interface AccountShellProps {
  eyebrow: string;
  title: string;
  description: string;
  accountLabel: string;
  backLabel: string;
  onBack: () => void | Promise<void>;
  children: ReactNode;
}

export function AccountShell({
  eyebrow,
  title,
  description,
  accountLabel,
  backLabel,
  onBack,
  children,
}: AccountShellProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = i18n.resolvedLanguage === "en" ? "en" : "ru";
  const nextLanguage = language === "ru" ? "en" : "ru";
  const themeLabel = t(THEME_KEY[theme]);

  return (
    <div className="mk-account-page">
      <div className="mk-account-page__texture" aria-hidden="true" />
      <header className="mk-account-page__header">
        <picture className="mk-account-page__logo" role="img" aria-label={t("auth.login.logoAlt")}>
          <img className="mk-account-page__logo-on-light" src={logoOnLight} alt="" />
          <img className="mk-account-page__logo-on-dark" src={logoOnDark} alt="" />
        </picture>
        <div className="mk-account-page__header-actions">
          <Button
            className="mk-account-page__utility"
            size="compact"
            variant="secondary"
            onClick={() => void i18n.changeLanguage(nextLanguage)}
            aria-label={t("auth.login.toggleLanguage")}
          >
            {language.toUpperCase()}
          </Button>
          <Button
            className="mk-account-page__utility"
            size="compact"
            variant="secondary"
            onClick={() => setTheme(NEXT_THEME[theme])}
            aria-label={t("auth.login.toggleTheme", { theme: themeLabel })}
          >
            {themeLabel}
          </Button>
        </div>
      </header>

      <main className="mk-account-page__main">
        <section className="mk-account-page__intro" aria-labelledby="account-page-title">
          <Button
            className="mk-account-page__back"
            size="compact"
            variant="secondary"
            icon={
              <span className="mk-account-page__back-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" focusable="false">
                  <path d="M12.5 4.5 7 10l5.5 5.5M7.5 10H16" />
                </svg>
              </span>
            }
            onClick={() => void onBack()}
          >
            {backLabel}
          </Button>
          <div className="mk-account-page__heading">
            <span className="mk-account-page__eyebrow">{eyebrow}</span>
            <h1 id="account-page-title">{title}</h1>
            <p>{description}</p>
          </div>
          <div className="mk-account-page__identity">
            <span>{t("account.signedInAs")}</span>
            <strong>{accountLabel}</strong>
          </div>
        </section>

        <section className="mk-account-page__workspace">{children}</section>
      </main>
    </div>
  );
}
