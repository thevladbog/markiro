import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";

import { Alert, Button, cn, IconButton, Sidebar, useTheme, type SidebarItem } from "@markiro/ui";

import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { OFFICE_NAV } from "./nav.js";
import { useOfficeSession } from "./office-session.js";

/** Office layout after `apps/admin/src/layout/AppShell.tsx`: sidebar, header, page. */
export function OfficeShell() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const [passwordOpen, setPasswordOpen] = useState(false);
  const location = useLocation();
  // The navigation entry the password was changed on; the notice goes away
  // with the next navigation.
  const [passwordChangedAt, setPasswordChangedAt] = useState<string | null>(null);
  const items = useMemo<SidebarItem[]>(
    () =>
      OFFICE_NAV.filter((item) => item.roles.includes(session.user.role)).map((item) => ({
        to: item.to,
        labelKey: t(item.labelKey),
        section: t(item.sectionKey),
      })),
    [session.user.role, t],
  );

  return (
    <div className="office-shell">
      <Sidebar
        items={items}
        navLabel={t("office.nav.label")}
        renderLink={(item, content) => (
          <NavLink
            to={item.to}
            end
            className={({ isActive }) =>
              cn("mk-sidebar__link", isActive && "mk-sidebar__link--active")
            }
          >
            {content}
          </NavLink>
        )}
      />
      <div className="office-shell__main">
        <header className="office-header">
          <div className="office-header__user">
            <span className="office-header__name">{session.user.name}</span>
            <span className="office-header__role">{t(`office.roles.${session.user.role}`)}</span>
          </div>
          <div className="office-header__actions">
            <IconButton
              variant="secondary"
              icon={<span aria-hidden="true">{dark ? "☀" : "☾"}</span>}
              aria-label={t(dark ? "office.header.lightTheme" : "office.header.darkTheme")}
              onClick={() => setTheme(dark ? "light" : "dark")}
            />
            <Button
              variant="secondary"
              onClick={() => {
                setPasswordChangedAt(null);
                setPasswordOpen(true);
              }}
            >
              {t("office.password.open")}
            </Button>
            <Button variant="secondary" onClick={session.logout}>
              {t("office.header.logout")}
            </Button>
          </div>
        </header>
        <main className="office-shell__content">
          {passwordChangedAt === location.key && (
            <Alert tone="ok">{t("office.password.done")}</Alert>
          )}
          <Outlet />
        </main>
      </div>
      <ChangePasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onChanged={() => {
          setPasswordOpen(false);
          setPasswordChangedAt(location.key);
        }}
      />
    </div>
  );
}
