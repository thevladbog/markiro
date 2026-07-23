import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";

import { Sidebar, cn, type SidebarItem } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";
import { usePendingOrderCount } from "../pages/pickup/api.js";
import { Header } from "./Header.js";

const NAV_ITEMS: ReadonlyArray<{ to: string; key: string }> = [
  { to: "/", key: "nav.dashboard" },
  { to: "/catalog", key: "nav.catalog" },
  { to: "/shifts", key: "nav.shifts" },
  { to: "/counterparties", key: "nav.counterparties" },
  { to: "/employees", key: "nav.employees" },
  { to: "/labels", key: "nav.labels" },
  { to: "/pickup", key: "nav.pickup" },
  { to: "/settings", key: "nav.settings" },
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
  const authClient = useAuthClient();
  const { data: session } = authClient.useSession();
  const pendingOrderCount = usePendingOrderCount();

  const items: SidebarItem[] = NAV_ITEMS.map(({ to, key }) => ({
    to,
    labelKey: t(key),
    ...(to === "/pickup" && pendingOrderCount > 0 ? { badge: pendingOrderCount } : {}),
  }));

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar
        items={items}
        navLabel={t("shell.navLabel")}
        renderLink={(item, content) => (
          <NavLink
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn("mk-sidebar__link", isActive && "mk-sidebar__link--active")
            }
          >
            {content}
          </NavLink>
        )}
        footer={<SidebarFooter name={session?.user.name} email={session?.user.email ?? ""} />}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
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
function SidebarFooter({ name, email }: { name: string | null | undefined; email: string }) {
  const displayName = name && name.trim().length > 0 ? name : email;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderTop: "1px solid var(--line)",
      }}
    >
      <span aria-hidden="true" style={AVATAR_STYLE}>
        {initialsOf(displayName)}
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={NAME_STYLE}>{displayName}</span>
        <span style={EMAIL_STYLE}>{email}</span>
      </span>
    </div>
  );
}

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}
