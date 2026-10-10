import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Card, PageHeader } from "@markiro/ui";

import { backupWarnings } from "./backups/backup-warnings.js";
import { useBackupTime } from "./backups/backup-time.js";
import { BackupWarnings } from "./backups/BackupWarnings.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";
import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  return (
    <>
      <PageHeader title={t("office.overview.title")} />
      <OverviewBackups />
      <Card>
        <p>{t("office.overview.greeting", { name: user.name })}</p>
        <p>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</p>
      </Card>
    </>
  );
}

/**
 * The backup warnings where the office opens (plan РК: a failed copy is
 * visible, not a line in a log). Nothing while the state loads or when it
 * does not: «Резервные копии» explains a host that does not answer. The
 * region that announces them is on the screen from the start, empty. The
 * organization's profile is read only when a warning has a time to write
 * (a restore that holds the facts).
 */
function OverviewBackups() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime(backups.isSuccess && backups.data.restoreHold !== null);
  const state = backups.isSuccess && time.ready ? backups.data : null;
  const warned = state !== null && backupWarnings(state).length > 0;
  return (
    <div className="backup-alerts" aria-live="polite">
      {warned && (
        <>
          <BackupWarnings state={state} format={time.format} />
          <Link to="/backups">{t("office.backups.overviewLink")}</Link>
        </>
      )}
    </div>
  );
}
