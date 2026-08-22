import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { Button, OperationalRail, type OperationalRailGroup } from "@markiro/ui";
import type { PlatformCapability } from "@markiro/platform-contracts";

import { usePlatformPrincipal } from "../auth/PlatformAuthBoundary.js";
import { useAuthClient } from "../auth/client.js";
import { MarkiroLogo } from "../components/MarkiroLogo.js";
import i18n from "../i18n/index.js";
import { NavigationGuardProvider, useNavigationGuard } from "./NavigationGuard.js";

function RailIndex({ children }: { children: string }) {
  return <span className="app-rail__index">{children}</span>;
}

function AppShellContent() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const auth = useAuthClient();
  const location = useLocation();
  const navigate = useNavigate();
  const guard = useNavigationGuard(false, false);
  const [railOpen, setRailOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const wasRailOpenRef = useRef(false);

  const hasCapability = (capability: PlatformCapability) =>
    principal.capabilities.includes(capability);
  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);
  const item = (id: string, label: string, to: string, index: string) => ({
    id,
    label,
    to,
    active: isActive(to),
    icon: <RailIndex>{index}</RailIndex>,
  });

  const groups: OperationalRailGroup[] = [
    {
      id: "operations",
      label: t("shell.groups.operations"),
      items: [
        item("overview", t("shell.overview"), "/", "01"),
        item("tenants", t("shell.tenants"), "/tenants", "02"),
      ],
    },
    {
      id: "commerce",
      label: t("shell.groups.commerce"),
      items: [
        ...(hasCapability("catalog.read")
          ? [item("catalog", t("shell.catalog"), "/catalog", "03")]
          : []),
        ...(hasCapability("billing.read")
          ? [
              item("offers", t("shell.offers"), "/offers", "04"),
              item("invoices", t("shell.invoices"), "/invoices", "05"),
              item("payments", t("shell.payments"), "/payments", "06"),
            ]
          : []),
      ],
    },
    {
      id: "platform",
      label: t("shell.groups.platform"),
      items: [
        ...(hasCapability("diagnostics.read")
          ? [item("monitoring", t("shell.monitoring"), "/monitoring", "07")]
          : []),
        ...(hasCapability("platformTeam.write")
          ? [item("team", t("shell.team"), "/team", "08")]
          : []),
        ...(hasCapability("audit.read") ? [item("audit", t("shell.audit"), "/audit", "09")] : []),
      ],
    },
    ...(hasCapability("billing.read")
      ? [
          {
            id: "settings",
            label: t("shell.groups.settings"),
            items: [item("organization", t("shell.organization"), "/settings/organization", "10")],
          },
        ]
      : []),
  ].filter((group) => group.items.length > 0);

  useEffect(() => {
    if (!railOpen) return;
    railRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRailOpen(false);
        return;
      }
      if (event.key === "Tab") {
        const links = Array.from(railRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
        const first = links.at(0);
        const last = links.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [railOpen]);

  useEffect(() => {
    if (wasRailOpenRef.current && !railOpen) {
      menuButtonRef.current?.focus();
    }
    wasRailOpenRef.current = railOpen;
  }, [railOpen]);

  const signOut = async () => {
    await auth.signOut();
    void navigate("/login", { replace: true });
  };

  return (
    <div className="saas-admin">
      <a className="skip-link" href="#main-content">
        {t("shell.skip")}
      </a>
      <div
        ref={railRef}
        className={railOpen ? "app-rail app-rail--open" : "app-rail"}
        id="platform-navigation"
      >
        <OperationalRail
          brand={
            <div className="app-rail__brand">
              <MarkiroLogo className="app-rail__logo" variant="on-dark" />
              <span>{t("shell.scope")}</span>
            </div>
          }
          groups={groups}
          navLabel={t("shell.navigation")}
          renderLink={(railItem, content, linkProps) => (
            <NavLink
              to={railItem.to}
              className={linkProps.className}
              aria-current={linkProps["aria-current"]}
              onClick={() => setRailOpen(false)}
            >
              {content}
            </NavLink>
          )}
          footer={
            <div className="app-rail__footer">
              <span>{t(`roles.${principal.role}`)}</span>
              <strong>{t("shell.sessionConfirmed")}</strong>
            </div>
          }
        />
      </div>
      {railOpen ? (
        <button
          className="app-rail__backdrop"
          type="button"
          aria-label={t("shell.closeNavigation")}
          tabIndex={-1}
          onClick={() => {
            setRailOpen(false);
          }}
        />
      ) : null}
      <div className="app-workspace" inert={railOpen ? true : undefined}>
        <div className="workspace-header">
          <button
            ref={menuButtonRef}
            className="workspace-header__menu"
            type="button"
            aria-expanded={railOpen}
            aria-controls="platform-navigation"
            onClick={() => setRailOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
            {t("shell.openNavigation")}
          </button>
          <div className="workspace-header__context">
            <span>{t("shell.workspace")}</span>
            <strong>{t(`roles.${principal.role}`)}</strong>
          </div>
          <div className="workspace-header__tools">
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
        </div>
        <main className="app-main" id="main-content">
          <Outlet />
        </main>
      </div>
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
