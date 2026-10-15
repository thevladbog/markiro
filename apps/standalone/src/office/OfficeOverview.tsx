import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Button, PageHeader } from "@markiro/ui";

import { useCan } from "./access.js";
import {
  BackupsCard,
  ConflictsCard,
  DevicesCard,
  LicenseCard,
  ShiftsCards,
  WarningsCard,
} from "./overview/OverviewCards.js";

import { backupWarnings } from "./backups/backup-warnings.js";
import { useBackupTime } from "./backups/backup-time.js";
import { BackupWarnings } from "./backups/BackupWarnings.js";
import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";
import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const navigate = useNavigate();
  const canPlan = useCan("planShifts");
  const admin = user.role === "admin";
  return (
    <>
      <PageHeader
        title={t("office.overview.title")}
        actions={
          <>
            {canPlan && (
              <Button onClick={() => void navigate("/shifts")}>
                {t("office.overview.actions.planShift")}
              </Button>
            )}
            {admin && (
              <Button variant="secondary" onClick={() => void navigate("/devices")}>
                {t("office.overview.actions.connectDevice")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void navigate("/codes")}>
              {t("office.overview.actions.searchCodes")}
            </Button>
          </>
        }
      />
      <div className="office-note overview-who">
        <span>{t("office.overview.greeting", { name: user.name })}</span>
        <span>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</span>
      </div>
      {/*
        One polite region for every warning of «Обзор» (extension point T4 of
        the license spec): the license's, then the copies'. It is on the
        screen from the start, empty, so each warning is heard once.
      */}
      <div className="backup-alerts" aria-live="polite">
        <OverviewLicense />
        <OverviewBackups />
      </div>
      <div className="overview-grid">
        <ShiftsCards />
        <ConflictsCard />
        {admin && <DevicesCard />}
        <BackupsCard />
        <LicenseCard />
      </div>
      <WarningsCard />
    </>
  );
}

/**
 * The license's warnings where the office opens (spec §9.5: «Обзор» repeats
 * the band's warnings, and the band is empty here); «Скрыть» hides a light
 * one for the session on both.
 */
function OverviewLicense() {
  const shown = useLicenseNotices();
  if (shown === null) return null;
  return <LicenseNotices {...shown} />;
}

/**
 * The backup warnings where the office opens (plan РК: a failed copy is
 * visible, not a line in a log). Nothing while the state loads or when it
 * does not: «Резервные копии» explains a host that does not answer. The
 * region that announces them is `OfficeOverview`'s, on the screen from the
 * start. The organization's profile is read only when a warning has a time
 * to write (a restore that holds the facts).
 */
function OverviewBackups() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime(backups.isSuccess && backups.data.restoreHold !== null);
  const state = backups.isSuccess && time.ready ? backups.data : null;
  if (state === null || backupWarnings(state).length === 0) return null;
  return (
    <>
      <BackupWarnings state={state} format={time.format} />
      <Link to="/backups">{t("office.backups.overviewLink")}</Link>
    </>
  );
}
