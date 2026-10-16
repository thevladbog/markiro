import { useTranslation } from "react-i18next";

import { IconButton, Button } from "@markiro/ui";

import { HostStatusDot } from "../app/HostStatusDot.js";
import type { OfficeUser } from "../host/protocol.js";
import { crumbsFor } from "./nav-groups.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { syncChipModel, useLastSyncTime } from "./sync-chip.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";
import { UserMenu } from "./UserMenu.js";
import { WindowModeButton } from "./WindowModeButton.js";
import { useOfficeLink } from "./office-link.js";

export interface OfficeTopBarProps {
  user: OfficeUser;
  pathname: string;
  menuCollapsed: boolean;
  menuId: string;
  onToggleMenu: () => void;
  /** «Выйти в цех»; `null` where the office has no floor to go to. */
  onToFloor: (() => void) | null;
  onProfile: () => void;
  onChangePassword: () => void;
  onSignOut: () => void;
  /** The window left kiosk mode: the focus goes to the page. */
  onWindowLeft: () => void;
}

/**
 * The office's top bar: the menu toggle and the crumbs at the left; at the right the link and sync
 * chips (an icon and a word each), the theme selector, «Оконный режим» (administrator, locked
 * window), «Выйти в цех» (the main way out, always in view) and the user menu.
 */
export function OfficeTopBar({
  user,
  pathname,
  menuCollapsed,
  menuId,
  onToggleMenu,
  onToFloor,
  onProfile,
  onChangePassword,
  onSignOut,
  onWindowLeft,
}: OfficeTopBarProps) {
  const { t } = useTranslation();
  const link = useOfficeLink();
  const doneAt = useLastSyncTime(link.sync);
  const sync = syncChipModel(link.sync, doneAt);
  const crumbs = crumbsFor(pathname);
  return (
    <header className="office-header">
      <div className="office-header__lead">
        <IconButton
          variant="ghost"
          icon={<OfficeIcon name="sidebar" />}
          aria-label={t("office.header.menuToggle")}
          title={menuCollapsed ? t("office.header.menuOpen") : t("office.header.menuClose")}
          aria-expanded={!menuCollapsed}
          aria-controls={menuId}
          onClick={onToggleMenu}
        />
        {crumbs !== null && (
          <nav aria-label={t("office.header.crumbs")} className="office-crumbs">
            <ol>
              <li>{t(crumbs.sectionKey)}</li>
              <li aria-hidden="true" className="office-crumbs__sep">
                <OfficeIcon name="caretRight" size={14} />
              </li>
              <li aria-current="page" className="office-crumbs__page">
                {t(crumbs.labelKey)}
              </li>
            </ol>
          </nav>
        )}
      </div>
      <div className="office-header__actions">
        <HostStatusDot status={link.status} sync={link.sync} />
        {sync !== null && (
          <span className={`office-chip office-chip--${sync.tone} office-chip--static`}>
            <OfficeIcon name="sync" size={16} />
            <span>{t(sync.labelKey, { time: sync.time })}</span>
          </span>
        )}
        <ThemeSwitcher />
        <WindowModeButton onLeft={onWindowLeft} />
        {onToFloor !== null && (
          <Button variant="secondary" icon={<OfficeIcon name="signOut" />} onClick={onToFloor}>
            {t("office.header.logout")}
          </Button>
        )}
        <UserMenu
          userId={user.id}
          avatarVersion={user.avatarVersion}
          name={user.name}
          login={user.login}
          roleLabel={t(`office.users.roles.${user.role}`)}
          onProfile={onProfile}
          onChangePassword={onChangePassword}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
