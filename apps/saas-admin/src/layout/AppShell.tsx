import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { Button, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../auth/PlatformAuthBoundary.js";
import { useAuthClient } from "../auth/client.js";
import { MarkiroLogo } from "../components/MarkiroLogo.js";
import i18n from "../i18n/index.js";
import { NavigationGuardProvider, useNavigationGuard } from "./NavigationGuard.js";

function AppShellContent() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const auth = useAuthClient();
  const location = useLocation();
  const navigate = useNavigate();
  const guard = useNavigationGuard(false, false);

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
          <MarkiroLogo className="app-brand__logo" />
          <span className="app-brand__scope">PLATFORM OPERATIONS</span>
        </div>
        <nav className="app-nav" aria-label={t("shell.navigation")}>
          <NavLink to="/tenants" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index" aria-hidden="true">
              01
            </span>
            {t("shell.tenants")}
          </NavLink>
          <NavLink to="/catalog" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index" aria-hidden="true">
              02
            </span>
            {t("shell.catalog")}
          </NavLink>
          <NavLink to="/offers" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index" aria-hidden="true">
              03
            </span>
            {t("shell.offers")}
          </NavLink>
          <NavLink
            to="/billing"
            className={({ isActive }) =>
              isActive || location.pathname.startsWith("/payments") ? "active" : undefined
            }
          >
            <span className="nav-index" aria-hidden="true">
              04
            </span>
            {t("shell.billing")}
          </NavLink>
          <NavLink to="/team" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index" aria-hidden="true">
              05
            </span>
            {t("shell.team")}
          </NavLink>
          <NavLink to="/audit" className={({ isActive }) => (isActive ? "active" : undefined)}>
            <span className="nav-index" aria-hidden="true">
              06
            </span>
            {t("shell.audit")}
          </NavLink>
          {principal.capabilities.includes("billing.read") ? (
            <NavLink
              to="/settings/organization"
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <span className="nav-index" aria-hidden="true">
                07
              </span>
              {t("shell.settings")}
            </NavLink>
          ) : null}
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
          <Button
            variant="secondary"
            onClick={() => guard.requestProtectedAction(() => void signOut())}
          >
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
        <StatusChip status="ok" label={t("shell.sessionConfirmed")} />
        <span className="status-rail__spacer" />
        <span>{t("shell.secureSession")}</span>
        <span className="rail-coordinate">MOW · UTC+3</span>
      </footer>
    </div>
  );
}

export function AppShell() {
  return (
    <NavigationGuardProvider>
      <AppShellContent />
    </NavigationGuardProvider>
  );
}
