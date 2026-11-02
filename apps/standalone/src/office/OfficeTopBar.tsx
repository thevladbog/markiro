import { useTranslation } from "react-i18next";
import { Fragment } from "react";
import { Link } from "react-router";

import { IconButton, VisuallyHidden } from "@markiro/ui";
import { StatusDot } from "../lib/StatusDot.js";

import { hostChipView, hostDotTone, HostStatusDot } from "../app/HostStatusDot.js";
import type { OfficeUser } from "../host/protocol.js";
import { crumbsFor, crumbTrail } from "./nav-groups.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { syncChipModel, useLastSyncTime } from "./sync-chip.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";
import { UserMenu } from "./UserMenu.js";
import { WindowModeButton } from "./WindowModeButton.js";
import { useOfficeLink } from "./office-link.js";
import { useOfficeScanner } from "./scanner/office-scanner-context.js";
import { OfficeHeaderTools } from "./OfficeHeaderTools.js";

export interface OfficeTopBarProps {
  user: OfficeUser;
  pathname: string;
  search?: string;
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
 * The office header keeps breadcrumbs and account/device controls visible.
 * Healthy connection and synchronization states use compact dots.
 */
export function OfficeTopBar({
  user,
  pathname,
  search = "",
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
  const scanner = useOfficeScanner();
  const link = useOfficeLink();
  const doneAt = useLastSyncTime(link.sync);
  const sync = syncChipModel(link.sync, doneAt);
  const hostTone = hostDotTone(link.status, link.sync);
  const syncWarning = hostDotTone(link.status, null) === "ok" && sync?.tone === "warn";
  const crumbs = crumbsFor(pathname);
  const trail = crumbTrail(pathname, search);
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
              {trail.map((crumb, index) => (
                <Fragment key={`${crumb.labelKey}-${index}`}>
                  <li aria-hidden="true" className="office-crumbs__sep">
                    <OfficeIcon name="caretRight" size={14} />
                  </li>
                  {crumb.to === undefined ? (
                    <li aria-current="page" className="office-crumbs__page">
                      {t(crumb.labelKey)}
                    </li>
                  ) : (
                    <li>
                      <Link to={crumb.to}>{t(crumb.labelKey)}</Link>
                    </li>
                  )}
                </Fragment>
              ))}
            </ol>
          </nav>
        )}
      </div>
      <div className="office-header__actions">
        <OfficeHeaderTools
          label={t("office.header.tools")}
          tone={syncWarning ? "warn" : hostTone}
          state={t(syncWarning ? sync.labelKey : hostChipView(link.status, link.sync).textKey)}
        >
          {scanner.canConfigure && (
            <IconButton
              variant="ghost"
              icon={<OfficeIcon name="qrCode" />}
              aria-label={t("office.search.scannerSettings")}
              onClick={scanner.openSettings}
            />
          )}
          <HostStatusDot status={link.status} sync={link.sync} compactWhenHealthy />
          {sync !== null &&
            (sync.tone === "ok" ? (
              <span
                className="office-sync-dot"
                role="status"
                title={t(sync.labelKey, { time: sync.time })}
              >
                <StatusDot tone="ok" label={t(sync.labelKey, { time: sync.time })} decorative />
                <VisuallyHidden>{t(sync.labelKey, { time: sync.time })}</VisuallyHidden>
              </span>
            ) : (
              <span className={`office-chip office-chip--${sync.tone} office-chip--static`}>
                <OfficeIcon name="sync" size={16} />
                <span>{t(sync.labelKey, { time: sync.time })}</span>
              </span>
            ))}
          <ThemeSwitcher />
          <WindowModeButton onLeft={onWindowLeft} />
        </OfficeHeaderTools>
        <UserMenu
          userId={user.id}
          avatarVersion={user.avatarVersion}
          name={user.name}
          login={user.login}
          roleLabel={t(`office.users.roles.${user.role}`)}
          onProfile={onProfile}
          onChangePassword={onChangePassword}
          onSignOut={onSignOut}
          onToFloor={onToFloor}
        />
      </div>
    </header>
  );
}
