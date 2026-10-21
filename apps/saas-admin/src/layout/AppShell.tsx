import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { Button, OperationalRail, VisuallyHidden, type OperationalRailGroup } from "@markiro/ui";
import type { PlatformCapability } from "@markiro/platform-contracts";

import { usePlatformPrincipal } from "../auth/PlatformAuthBoundary.js";
import { useAuthClient } from "../auth/client.js";
import { MarkiroLogo } from "../components/MarkiroLogo.js";
import { getLeadSummary, leadKeys } from "../pages/leads/api.js";
import { IS_PLATFORM_ONLY } from "../server-profile.js";
import { SUPPORT_CHAT_ENABLED } from "../features.js";
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
  const item = (id: string, label: string, to: string, badge?: ReactNode) => ({
    id,
    label,
    to,
    active: isActive(to),
    ...(badge === undefined ? {} : { badge }),
  });
  const when = (capability: PlatformCapability, ...items: ReturnType<typeof item>[]) =>
    hasCapability(capability) ? items : [];

  // The badge is a hint, not a page: a failed summary simply shows no count.
  const leadSummary = useQuery({
    queryKey: leadKeys.summary(),
    queryFn: getLeadSummary,
    enabled: hasCapability("leads.read"),
    staleTime: 60_000,
  });
  const newLeads = leadSummary.data?.newCount ?? 0;
  const leadsBadge =
    newLeads > 0 ? (
      <>
        <span aria-hidden="true">{newLeads}</span>
        <VisuallyHidden>, {t("shell.leadsNew", { count: newLeads })}</VisuallyHidden>
      </>
    ) : undefined;

  const draftGroups = [
    {
      id: "operations",
      label: t("shell.groups.operations"),
      items: [
        item("overview", t("shell.overview"), "/"),
        item("tenants", t("shell.tenants"), "/tenants"),
        ...when(
          "billing.read",
          item("billing-requests", t("shell.billingRequests"), "/billing-requests"),
        ),
        ...when("leads.read", item("leads", t("shell.leads"), "/leads", leadsBadge)),
        ...(SUPPORT_CHAT_ENABLED || IS_PLATFORM_ONLY
          ? when("billing.read", item("support", t("shell.supportEpisodes"), "/support"))
          : []),
      ],
    },
    {
      id: "commerce",
      label: t("shell.groups.commerce"),
      items: [
        ...when("catalog.read", item("catalog", t("shell.catalog"), "/catalog")),
        ...when(
          "services.read",
          item("service-periods", t("shell.servicePeriods"), "/service-periods"),
        ),
        ...when("agreements.read", item("agreements", t("shell.agreements"), "/agreements")),
        ...when(
          "billing.read",
          item("offers", t("shell.offers"), "/offers"),
          item("invoices", t("shell.invoices"), "/invoices"),
          item("acts", t("shell.acts"), "/billing-acts"),
          item("payments", t("shell.payments"), "/payments"),
        ),
      ],
    },
    {
      id: "platform",
      label: t("shell.groups.platform"),
      items: [
        ...when("diagnostics.read", item("monitoring", t("shell.monitoring"), "/monitoring")),
        ...(!IS_PLATFORM_ONLY
          ? when(
              "catalog.read",
              item("national-catalog", t("shell.nationalCatalog"), "/national-catalog"),
            )
          : []),
        ...when(
          "standaloneReleases.manage",
          item("standalone-releases", t("shell.standaloneReleases"), "/standalone-releases"),
        ),
        ...when("reports.read", item("reports", t("shell.reports"), "/reports")),
        ...when("audit.read", item("audit", t("shell.audit"), "/audit")),
        ...when("platformTeam.write", item("team", t("shell.team"), "/team")),
      ],
    },
    {
      id: "settings",
      label: t("shell.groups.settings"),
      items: [
        ...when(
          "billing.read",
          item("organization", t("shell.organization"), "/settings/organization"),
        ),
      ],
    },
  ].filter((group) => group.items.length > 0);

  // The index follows the visible position, so it is never typed by hand and
  // cannot repeat or skip when a capability hides an entry.
  let position = 0;
  const groups: OperationalRailGroup[] = draftGroups.map((group) => ({
    ...group,
    items: group.items.map((entry) => {
      position += 1;
      return {
        ...entry,
        icon: <RailIndex>{String(position).padStart(2, "0")}</RailIndex>,
      };
    }),
  }));

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
