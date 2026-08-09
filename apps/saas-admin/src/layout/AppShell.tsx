import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate } from "react-router";

import { Button, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../auth/PlatformAuthBoundary.js";
import { useAuthClient } from "../auth/client.js";
import i18n from "../i18n/index.js";

export function AppShell() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const auth = useAuthClient();
  const navigate = useNavigate();

  const signOut = async () => {
    await auth.signOut();
    void navigate("/login", { replace: true });
  };

  return (
    <div className="saas-admin">
      <a className="skip-link" href="#main-content">
        {t("shell.skip")}
      </a>
      <header className="app-header">
        <div className="app-brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <span className="app-brand__name">MARKIRO</span>
            <span className="app-brand__scope">PLATFORM OPERATIONS</span>
          </div>
        </div>
        <nav className="app-nav" aria-label={t("shell.navigation")}>
          <NavLink to="/catalog" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index">01</span>
            {t("shell.catalog")}
          </NavLink>
        </nav>
        <div className="app-tools">
          <span className="role-tag">{t(`roles.${principal.role}`)}</span>
          <div className="language-switch" aria-label={t("shell.language")}>
            <button
              type="button"
              aria-pressed={i18n.language.startsWith("ru")}
              onClick={() => void i18n.changeLanguage("ru")}
            >
              RU
            </button>
            <button
              type="button"
              aria-pressed={i18n.language.startsWith("en")}
              onClick={() => void i18n.changeLanguage("en")}
            >
              EN
            </button>
          </div>
          <Button variant="secondary" onClick={() => void signOut()}>
            {t("auth.signOut")}
          </Button>
        </div>
      </header>
      <main className="app-main" id="main-content">
        <Outlet />
      </main>
      <footer className="status-rail" role="status" aria-label={t("shell.statusLabel")}>
        <span>SAAS CONSOLE · 01</span>
        <span className="status-rail__separator" aria-hidden="true" />
        <StatusChip status="ok" label={t("shell.apiAvailable")} />
        <span className="status-rail__spacer" />
        <span>{t("shell.secureSession")}</span>
        <span className="rail-coordinate">MOW · UTC+3</span>
      </footer>
    </div>
  );
}
