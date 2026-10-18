import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router";

import { Alert, ConfirmDialog } from "@markiro/ui";

import { ProfileDialog } from "./avatar/ProfileDialog.js";
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { DirtyGuardProvider, useDirtyRegistry } from "./dirty-guard.js";
import { UpdateBanner } from "./banners/UpdateBanner.js";
import { LicenseBanner } from "./LicenseBanner.js";
import { useKitScope } from "./kit-scope.js";
import { isMenuCollapsed } from "./menu-collapse.js";
import { navGroups } from "./nav-groups.js";
import { OfficeSidebar } from "./OfficeSidebar.js";
import { OfficeTopBar } from "./OfficeTopBar.js";
import { useOfficeSession } from "./office-session.js";
import { useViewportWidth } from "./use-viewport-width.js";

/** Office layout: the menu, the top bar, the banners, the page. */
export function OfficeShell() {
  useKitScope();
  const { t } = useTranslation();
  const session = useOfficeSession();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
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
  const groups = useMemo(() => navGroups(session.user.role), [session.user.role]);
  // The menu collapses below 1366 px; the user's own toggle wins over the width.
  const width = useViewportWidth();
  const [menuOverride, setMenuOverride] = useState<boolean | null>(null);
  const collapsed = isMenuCollapsed(width, menuOverride);
  const menuId = useId();

  return (
    <DirtyGuardProvider registry={dirtyRegistry}>
      <div className="office-shell">
        <OfficeSidebar groups={groups} collapsed={collapsed} id={menuId} />
        <div className="office-shell__main">
          <OfficeTopBar
            user={session.user}
            pathname={location.pathname}
            search={location.search}
            menuCollapsed={collapsed}
            menuId={menuId}
            onToggleMenu={() => setMenuOverride(!collapsed)}
            onToFloor={session.exitTo !== "sign_in" ? () => leave(session.logout) : null}
            onProfile={() => setProfileOpen(true)}
            onChangePassword={() => {
              setPasswordChangedAt(null);
              setPasswordOpen(true);
            }}
            onSignOut={() => leave(session.exitTo === "sign_in" ? session.logout : signOut)}
            onWindowLeft={() => mainRef.current?.focus()}
          />
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
        <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
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
