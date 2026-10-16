import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Card } from "@markiro/ui";

import type { DeviceKind } from "../../host/protocol.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { shiftProductTitle } from "../../lib/shift-product.js";
import { useBackupTime } from "../backups/backup-time.js";
import { backupWarnings } from "../backups/backup-warnings.js";
import { useAboutData } from "../info/about-data.js";
import { stateText, stateTone } from "../info/license/license-view.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import {
  CLOCK_SKEW_MS,
  clockSkewMs,
  deviceSummary,
  shiftBuckets,
  shiftProgress,
  storeNearlyFull,
  versionSkew,
} from "./overview-model.js";
import type { OfficeShift } from "../../host/protocol.js";
import { formatWhen } from "../backups/backup-format.js";

const NUMBER = new Intl.NumberFormat("ru-RU");

/** The link to a shift's drawer on «Смены». */
function shiftLink(id: string): string {
  return `/shifts?shift=${encodeURIComponent(id)}`;
}

function ShiftRow({
  shift,
  names,
}: {
  shift: OfficeShift;
  names: { product: string | null; line: string | null };
}) {
  const { t } = useTranslation();
  const progress = shiftProgress(shift);
  const where = [names.product, names.line].filter((part): part is string => part !== null);
  return (
    <li className="overview-shift">
      <Link to={shiftLink(shift.id)}>{shift.number}</Link>
      {where.length > 0 && <span className="overview-shift__what">{where.join(" · ")}</span>}
      {shift.status === "active" && (
        <span className="overview-shift__progress">
          {progress.percent === null ? (
            <span>
              {t("office.overview.shifts.doneNoPlan", { done: NUMBER.format(progress.done) })}
            </span>
          ) : (
            <>
              <span
                className="overview-bar"
                role="progressbar"
                aria-label={t("office.overview.shifts.progressLabel", { number: shift.number })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
              >
                <span className="overview-bar__fill" style={{ width: `${progress.percent}%` }} />
              </span>
              <span>
                {t("office.overview.shifts.done", {
                  done: NUMBER.format(progress.done),
                  planned: NUMBER.format(progress.planned ?? 0),
                  percent: progress.percent,
                })}
              </span>
            </>
          )}
        </span>
      )}
      {shift.status === "planned" && shift.plannedQty !== null && (
        <span className="overview-shift__progress">
          {t("office.overview.shifts.plan", { planned: NUMBER.format(shift.plannedQty) })}
        </span>
      )}
    </li>
  );
}

/** «Смены»: what the stations work now and what is planned for the site's today. */
export function ShiftsCards() {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));

  if (shifts.isPending || org.isPending) {
    return (
      <Card
        title={t("office.overview.shifts.activeTitle")}
        titleAs="h2"
        className="overview-card overview-card--shifts"
      >
        <PageLoading />
      </Card>
    );
  }
  if (shifts.isError) {
    return (
      <Card
        title={t("office.overview.shifts.activeTitle")}
        titleAs="h2"
        className="overview-card overview-card--shifts"
      >
        <LoadError error={shifts.error} onRetry={() => void shifts.refetch()} />
      </Card>
    );
  }
  const zone = org.isSuccess && isKnownTimeZone(org.data.timeZone) ? org.data.timeZone : null;
  const today = civilToday(zone);
  const buckets = shiftBuckets(shifts.data, today);
  const names = (shift: OfficeShift) => ({
    product:
      shiftProductTitle(products.data?.find((product) => product.id === shift.productId)) || null,
    line: lines.data?.find((line) => line.id === shift.lineId)?.name ?? null,
  });
  return (
    <Card
      title={t("office.overview.shifts.activeTitle")}
      titleAs="h2"
      className="overview-card overview-card--shifts"
    >
      {buckets.active.length === 0 ? (
        <p className="office-note">{t("office.overview.shifts.noActive")}</p>
      ) : (
        <ul className="overview-list">
          {buckets.active.map((shift) => (
            <ShiftRow key={shift.id} shift={shift} names={names(shift)} />
          ))}
        </ul>
      )}
      {buckets.closedToday > 0 && (
        <p className="office-note">
          {t("office.overview.shifts.closedToday", { count: buckets.closedToday })}
        </p>
      )}
      {/* The day's plan is a part of the same card, set apart by a hairline (design 2026-10). */}
      <section className="overview-planned" aria-labelledby="overview-planned-title">
        <h3 id="overview-planned-title" className="overview-planned__title">
          {t("office.overview.shifts.plannedTitle")}
        </h3>
        {buckets.plannedToday.length === 0 ? (
          <p className="office-note">{t("office.overview.shifts.noPlanned")}</p>
        ) : (
          <ul className="overview-list">
            {buckets.plannedToday.map((shift) => (
              <ShiftRow key={shift.id} shift={shift} names={names(shift)} />
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

const KINDS: readonly DeviceKind[] = ["station", "handheld", "office"];

/** «Устройства»: on line per kind and the ones silent, with when they were last heard (administrators). */
export function DevicesCard() {
  const { t } = useTranslation();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime();
  return (
    <Card
      title={t("office.overview.devices.title")}
      titleAs="h2"
      className="overview-card overview-card--devices"
    >
      {devices.isPending ? (
        <PageLoading />
      ) : devices.isError ? (
        <LoadError error={devices.error} onRetry={() => void devices.refetch()} />
      ) : (
        (() => {
          // The host's clock, when it has told it: a device's age is measured by it.
          const now = backups.isSuccess ? Date.parse(backups.data.now) : Date.now();
          const summary = deviceSummary(devices.data, now);
          const total = KINDS.reduce((sum, kind) => sum + summary.byKind[kind].total, 0);
          if (total === 0)
            return <p className="office-note">{t("office.overview.devices.none")}</p>;
          return (
            <>
              <ul className="overview-list">
                {KINDS.filter((kind) => summary.byKind[kind].total > 0).map((kind) => (
                  <li key={kind} className="overview-device-kind">
                    <span>{t(`office.devices.kinds.${kind}`)}</span>
                    <span>
                      {t("office.overview.devices.online", {
                        online: summary.byKind[kind].online,
                        total: summary.byKind[kind].total,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {summary.silent.length > 0 && (
                <ul className="overview-list overview-list--quiet">
                  {summary.silent.slice(0, 5).map((device) => (
                    <li key={device.id}>
                      {device.lastSeenAt === null
                        ? t("office.overview.devices.neverSeen", { name: device.name })
                        : t("office.overview.devices.lastSeen", {
                            name: device.name,
                            when: formatWhen(device.lastSeenAt, time.zone),
                          })}
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/devices">{t("office.overview.devices.link")}</Link>
            </>
          );
        })()
      )}
    </Card>
  );
}

/** «Расхождения»: how many conflicts wait for a review, and the way to them. */
export function ConflictsCard() {
  const { t } = useTranslation();
  const conflicts = useOfficeQuery(officeKeys.conflictList({ reviewed: false }), (api, token) =>
    api.listConflicts(token, { reviewed: false }),
  );
  return (
    <Card title={t("office.overview.conflicts.title")} titleAs="h2" className="overview-card">
      {conflicts.isPending ? (
        <PageLoading />
      ) : conflicts.isError ? (
        <LoadError error={conflicts.error} onRetry={() => void conflicts.refetch()} />
      ) : (
        <>
          <p className="overview-figure">{NUMBER.format(conflicts.data.total)}</p>
          <p className="office-note">
            {conflicts.data.total === 0
              ? t("office.overview.conflicts.none")
              : t("office.overview.conflicts.some", { count: conflicts.data.total })}
          </p>
          <Link to="/conflicts">{t("office.overview.conflicts.link")}</Link>
        </>
      )}
    </Card>
  );
}

/** «Резервные копии»: the last copy and its state, and the hint to set the second folder. */
export function BackupsCard() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime();
  return (
    <Card title={t("office.overview.backups.title")} titleAs="h2" className="overview-card">
      {backups.isPending || !time.ready ? (
        <PageLoading />
      ) : backups.isError ? (
        <LoadError error={backups.error} onRetry={() => void backups.refetch()} />
      ) : (
        (() => {
          const state = backups.data;
          const newest = [state.local.copies[0], state.second?.copies[0]]
            .filter((copy) => copy !== undefined)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
          const warned = backupWarnings(state).length > 0;
          return (
            <>
              <p>
                {newest === undefined
                  ? t("office.overview.backups.noCopies")
                  : t("office.overview.backups.last", { when: time.format(newest.createdAt) })}
              </p>
              <p className="office-note">
                {warned
                  ? t("office.overview.backups.needAttention")
                  : t("office.overview.backups.fine")}
              </p>
              {state.second === null && (
                <p className="office-note">{t("office.overview.backups.secondHint")}</p>
              )}
              <Link to="/backups">{t("office.overview.backups.link")}</Link>
            </>
          );
        })()
      )}
    </Card>
  );
}

/** «Лицензия»: the state the host computed, in words, and the way to the section (plan ЛЦ-3). */
export function LicenseCard() {
  const { t } = useTranslation();
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  return (
    <Card title={t("office.about.license.title")} titleAs="h2" className="overview-card">
      {license.isPending ? (
        <PageLoading />
      ) : license.isError ? (
        <LoadError error={license.error} onRetry={() => void license.refetch()} />
      ) : (
        (() => {
          const text = stateText(license.data);
          return (
            <Alert tone={stateTone(license.data.state)} role="presentation">
              {t(text.key, text.values ?? {})}
            </Alert>
          );
        })()
      )}
      <Link to="/about#license">{t("office.overview.license.link")}</Link>
    </Card>
  );
}

/**
 * «Что проверить»: the clock of this PC against the host's, a store of kept
 * files that is nearly full, and devices on another version than the host.
 * Nothing is drawn while all is well or while the reads are pending.
 */
export function WarningsCard() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const admin = user.role === "admin";
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const settings = useOfficeQuery(officeKeys.exportSettings, (api, token) =>
    api.getExportSettings(token),
  );
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    enabled: admin,
  });
  const about = useAboutData();
  const lines: string[] = [];
  if (backups.isSuccess) {
    const skew = clockSkewMs(backups.data.now, Date.now());
    if (Math.abs(skew) > CLOCK_SKEW_MS) {
      lines.push(
        t("office.overview.warnings.clock", { minutes: Math.round(Math.abs(skew) / 60000) }),
      );
    }
  }
  if (settings.isSuccess && storeNearlyFull(settings.data)) {
    lines.push(t("office.overview.warnings.store"));
  }
  if (devices.isSuccess) {
    const skewed = versionSkew(devices.data, about.data?.hello?.version ?? null);
    if (skewed.length > 0) {
      lines.push(
        t("office.overview.warnings.versions", {
          count: skewed.length,
          version: about.data?.hello?.version ?? "",
        }),
      );
    }
  }
  if (lines.length === 0) return null;
  // One layer: the warning is the alert itself (title and the lines), not a card around alerts.
  return (
    <Alert tone="warn" role="presentation" title={t("office.overview.warnings.title")}>
      <ul className="overview-list">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Alert>
  );
}
