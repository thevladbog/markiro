import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";

import {
  Alert,
  Button,
  ConfirmDialog,
  cn,
  IconButton,
  Sidebar,
  useTheme,
  type SidebarItem,
} from "@markiro/ui";

import { HostStatusDot } from "../app/HostStatusDot.js";
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { DirtyGuardProvider, useDirtyRegistry } from "./dirty-guard.js";
import { UpdateBanner } from "./banners/UpdateBanner.js";
import { LicenseBanner } from "./LicenseBanner.js";
import { isSettingsItem, OFFICE_NAV, type OfficeNavItem } from "./nav.js";
import { useOfficeLink } from "./office-link.js";
import { useOfficeSession } from "./office-session.js";
import { WindowModeButton } from "./WindowModeButton.js";

/** Office layout after `apps/admin/src/layout/AppShell.tsx`: sidebar, header, page. */
export function OfficeShell() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const link = useOfficeLink();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const [passwordOpen, setPasswordOpen] = useState(false);
  // What a drawer holds unsaved: leaving the office asks first.
  const dirtyRegistry = useDirtyRegistry();
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const leave = (action: () => void) => {
    if (dirtyRegistry.anyDirty()) setLeaving(() => action);
    else action();
  };
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const shownPath = useRef(location.pathname);
  useEffect(() => {
    // After a menu navigation, move focus to the new page so a screen
    // reader announces it; the first page keeps the browser's focus. A link
    // to an anchor (the license band's `/about#license`) leaves the focus to
    // the page, which gives it to that section (plan ЛЦ-3).
    if (shownPath.current === location.pathname) return;
    shownPath.current = location.pathname;
    if (location.hash !== "") return;
    mainRef.current?.focus();
  }, [location.pathname, location.hash]);
  // The navigation entry the password was changed on; the notice goes away
  // with the next navigation.
  const [passwordChangedAt, setPasswordChangedAt] = useState<string | null>(null);
  // «Выйти» returns to the office sign-in; a shell without one ends the session as before.
  const signOut = session.signOut ?? session.logout;
  const visible = useMemo(
    () => OFFICE_NAV.filter((item) => item.roles.includes(session.user.role)),
    [session.user.role],
  );
  // Operations on top; Организация, Доступ and Сервис go to the foot of the menu.
  const items = useMemo<SidebarItem[]>(
    () =>
      visible
        .filter((item) => !isSettingsItem(item))
        .map((item) => ({
          to: item.to,
          labelKey: t(item.labelKey),
          section: t(item.sectionKey),
        })),
    [visible, t],
  );
  const settings = useMemo(() => visible.filter(isSettingsItem), [visible]);

  return (
    <DirtyGuardProvider registry={dirtyRegistry}>
      <div className="office-shell">
        <Sidebar
          items={items}
          navLabel={t("office.nav.label")}
          renderLink={(item, content) => <MenuLink to={item.to}>{content}</MenuLink>}
          footer={settings.length > 0 ? <SettingsMenu items={settings} /> : undefined}
        />
        <div className="office-shell__main">
          <header className="office-header">
            <div className="office-header__user">
              <span className="office-header__name">{session.user.name}</span>
              <span className="office-header__role">{t(`office.roles.${session.user.role}`)}</span>
            </div>
            <div className="office-header__actions">
              <HostStatusDot status={link.status} sync={link.sync} />
              <IconButton
                variant="secondary"
                icon={<span aria-hidden="true">{dark ? "☀" : "☾"}</span>}
                aria-label={t(dark ? "office.header.lightTheme" : "office.header.darkTheme")}
                onClick={() => setTheme(dark ? "light" : "dark")}
              />
              <WindowModeButton onLeft={() => mainRef.current?.focus()} />
              <Button
                variant="secondary"
                onClick={() => {
                  setPasswordChangedAt(null);
                  setPasswordOpen(true);
                }}
              >
                {t("office.password.open")}
              </Button>
              {session.exitTo !== "sign_in" && (
                <Button variant="secondary" onClick={() => leave(session.logout)}>
                  {t("office.header.logout")}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => leave(session.exitTo === "sign_in" ? session.logout : signOut)}
              >
                {t("office.header.signOut")}
              </Button>
            </div>
          </header>
          <LicenseBanner />
          <UpdateBanner />
          <main ref={mainRef} tabIndex={-1} className="office-shell__content">
            {passwordChangedAt === location.key && (
              <Alert tone="ok">{t("office.password.done")}</Alert>
            )}
            <Outlet />
          </main>
        </div>
        <ConfirmDialog
          open={leaving !== null}
          title={t("office.header.leaveTitle")}
          description={t("office.header.leaveBody")}
          confirmLabel={t("office.header.leaveConfirm")}
          cancelLabel={t("office.drawer.keepEditing")}
          tone="destructive"
          onConfirm={() => {
            const action = leaving;
            setLeaving(null);
            action?.();
          }}
          onCancel={() => setLeaving(null)}
        />
        <ChangePasswordDialog
          open={passwordOpen}
          onClose={() => setPasswordOpen(false)}
          onChanged={() => {
            setPasswordOpen(false);
            setPasswordChangedAt(location.key);
          }}
        />
      </div>
    </DirtyGuardProvider>
  );
}

/**
 * A menu entry. No `end`: a section stays marked on its own pages («Шаблоны» on `/templates/new`)
 * and not on a path that merely begins like it («Умолчания шаблонов»). «Обзор» (`/`) is marked
 * only on `/` all the same: the router matches `/` by equality.
 */
function MenuLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn("mk-sidebar__link", isActive && "mk-sidebar__link--active")}
    >
      {children}
    </NavLink>
  );
}

/**
 * The settings groups at the foot of the menu, apart from the operations by a rule; their entries
 * are the very style of the ones above (beta feedback: no smaller, lighter second half), and a
 * group's name stands over its entries as in the rest of the menu.
 */
function SettingsMenu({ items }: { items: readonly OfficeNavItem[] }) {
  const { t } = useTranslation();
  return (
    <div className="office-menu-settings">
      <ul>
        {items.map((item, index) => (
          <Fragment key={item.to}>
            {item.sectionKey !== items[index - 1]?.sectionKey && (
              <li className="mk-sidebar__section">{t(item.sectionKey)}</li>
            )}
            <li>
              <MenuLink to={item.to}>
                <span className="mk-sidebar__content">
                  <span>{t(item.labelKey)}</span>
                </span>
              </MenuLink>
            </li>
          </Fragment>
        ))}
      </ul>
    </div>
  );
}
