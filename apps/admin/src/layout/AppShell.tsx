import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import { CABINET_CAPABILITY, type CabinetCapability } from "@markiro/domain";
import { Sidebar, cn, type SidebarItem } from "@markiro/ui";

import { useCan } from "../access/context.js";
import { useAuthClient } from "../auth/client.js";
import { usePendingOrderCount } from "../pages/pickup/api.js";
import { useAvatarUrl, useProfile } from "../pages/profile/api.js";
import { Header } from "./Header.js";
import { SubscriptionBanner } from "../subscription/SubscriptionBanner.js";

const C = CABINET_CAPABILITY;

export const NAV_ITEMS: ReadonlyArray<{
  to: string;
  key: string;
  sectionKey: string;
  capability: CabinetCapability;
}> = [
  {
    to: "/",
    key: "nav.dashboard",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/shifts",
    key: "nav.shifts",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/lines",
    key: "nav.lines",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  // "/boxes" has no sidebar entry of its own: it is reachable as the
  // "Короба" tab inside the code-search section (see
  // pages/code-search/RegistryTabs.tsx).
  {
    to: "/codes",
    key: "nav.codes",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/conflicts",
    key: "nav.conflicts",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/pickup",
    key: "nav.pickup",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/disaggregation",
    key: "nav.disaggregation",
    sectionKey: "shell.sections.production",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/catalog",
    key: "nav.catalog",
    sectionKey: "shell.sections.reference",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/counterparties",
    key: "nav.counterparties",
    sectionKey: "shell.sections.reference",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/employees",
    key: "nav.employees",
    sectionKey: "shell.sections.reference",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/labels",
    key: "nav.labels",
    sectionKey: "shell.sections.reference",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/devices",
    key: "nav.devices",
    sectionKey: "shell.sections.equipment",
    capability: C.OPERATIONS_READ,
  },
  {
    to: "/integrations",
    key: "nav.integrations",
    sectionKey: "shell.sections.equipment",
    capability: C.INTEGRATIONS_READ,
  },
  {
    to: "/team",
    key: "nav.team",
    sectionKey: "shell.sections.organization",
    capability: C.MEMBERS_MANAGE,
  },
  {
    to: "/settings",
    key: "nav.settings",
    sectionKey: "shell.sections.organization",
    capability: C.TENANT_SETTINGS_MANAGE,
  },
];

/**
 * The real app shell -- sidebar navigation, global header, routed content --
 * rendered by `pages/Shell.tsx`'s guard once a session with an active
 * organization is confirmed.
 *
 * Naming note: the plan's file list calls for `src/layout/Shell.tsx`, but
 * `pages/Shell.tsx` (Task 9's guard component, kept as-is here) already owns
 * that name. This component is named `AppShell` instead to keep the guard
 * (`pages/Shell.tsx`, decides *whether* to render the app) and the layout
 * (`layout/AppShell.tsx`, decides *what* the app looks like once rendered)
 * unambiguous as two files with two responsibilities -- see the Task 10
 * report for the full rationale.
 */
export function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const authClient = useAuthClient();
  const { data: session } = authClient.useSession();
  const canReadOperations = useCan(C.OPERATIONS_READ);
  const canReadIntegrations = useCan(C.INTEGRATIONS_READ);
  const canManageSettings = useCan(C.TENANT_SETTINGS_MANAGE);
  const canManageMembers = useCan(C.MEMBERS_MANAGE);
  const pendingOrderCount = usePendingOrderCount(canReadOperations);
  const profile = useProfile();
  const avatar = useAvatarUrl(Boolean(profile.data?.hasAvatar));
  const profileName = profile.data
    ? [profile.data.firstName, profile.data.middleName, profile.data.lastName]
        .filter(Boolean)
        .join(" ")
    : null;

  const items: SidebarItem[] = NAV_ITEMS.filter(({ capability }) => {
    if (capability === C.OPERATIONS_READ) return canReadOperations;
    if (capability === C.INTEGRATIONS_READ) return canReadIntegrations;
    if (capability === C.TENANT_SETTINGS_MANAGE) return canManageSettings;
    if (capability === C.MEMBERS_MANAGE) return canManageMembers;
    return false;
  }).map(({ to, key, sectionKey }) => ({
    to,
    labelKey: t(key),
    section: t(sectionKey),
    ...(to === "/pickup" && pendingOrderCount > 0 ? { badge: pendingOrderCount } : {}),
  }));

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar
        className="mk-app-sidebar"
        // The footer link below carries its own 10px padding on every side;
        // dropping the sidebar's own bottom padding makes the gap under the
        // user card match the 10px above it (link padding over the divider).
        style={{ paddingBottom: 0 }}
        items={items}
        navLabel={t("shell.navLabel")}
        renderLink={(item, content) => (
          <NavLink
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "mk-sidebar__link",
                // /boxes lives under the code-search section as its "Короба"
                // tab, so the "Поиск кодов" item stays lit there too.
                (isActive || (item.to === "/codes" && location.pathname.startsWith("/boxes"))) &&
                  "mk-sidebar__link--active",
              )
            }
          >
            {content}
          </NavLink>
        )}
        footer={
          <SidebarFooter
            name={profileName || session?.user.name}
            email={session?.user.email ?? ""}
            avatarUrl={avatar.data?.url ?? null}
            openLabel={t("profile.openNamed", {
              name: profileName || session?.user.name || session?.user.email || "",
            })}
            returnTo={`${location.pathname}${location.search}`}
          />
        }
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
          <SubscriptionBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const AVATAR_STYLE: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "var(--r-2)",
  background: "var(--surface-inverse)",
  color: "var(--fg-on-inverse)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  font: "600 13px/1 var(--font-ui)",
  flexShrink: 0,
};

const NAME_STYLE: CSSProperties = {
  font: "600 13px/17px var(--font-ui)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const EMAIL_STYLE: CSSProperties = {
  font: "400 12px/15px var(--font-ui)",
  color: "var(--fg-3)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * Sidebar footer: avatar initials + name/email. Per the handoff prototype
 * (`prototypes/admin-panel.dc.html`'s user card), this gets its own
 * `border-top` -- distinct from the sidebar's own outer right border -- to
 * visually separate it from the nav list above.
 *
 * The prototype's second line shows the member's org role ("Администратор"),
 * which isn't available here (`SessionData.user` carries no role field, and
 * fetching org-membership role isn't part of this task's scope) -- the
 * user's email is shown instead, which is always present and avoids
 * fabricating data the session doesn't have.
 */
function SidebarFooter({
  name,
  email,
  avatarUrl,
  openLabel,
  returnTo,
}: {
  name: string | null | undefined;
  email: string;
  avatarUrl: string | null;
  openLabel: string;
  returnTo: string;
}) {
  const displayName = name && name.trim().length > 0 ? name : email;

  return (
    <Link
      to={`/profile?returnTo=${encodeURIComponent(returnTo)}`}
      aria-label={openLabel}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderTop: "1px solid var(--line)",
        textDecoration: "none",
      }}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          aria-hidden="true"
          width={32}
          height={32}
          style={{ ...AVATAR_STYLE, objectFit: "cover" }}
        />
      ) : (
        <span aria-hidden="true" style={AVATAR_STYLE}>
          {initialsOf(displayName)}
        </span>
      )}
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={NAME_STYLE}>{displayName}</span>
        <span style={EMAIL_STYLE}>{email}</span>
      </span>
    </Link>
  );
}

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}
