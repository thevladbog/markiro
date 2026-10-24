import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, PageHeader } from "@markiro/ui";

import { useCan } from "./access.js";
import { backupWarnings } from "./backups/backup-warnings.js";
import { useBackupTime } from "./backups/backup-time.js";
import { BackupWarnings } from "./backups/BackupWarnings.js";
import { DemoDataNotice } from "./demo/DemoDataNotice.js";
import { withoutDemo } from "./demo/demo.js";
import { HostAddressNotice } from "./overview/HostAddressNotice.js";
import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";
import { AttentionPanel } from "./overview/AttentionPanel.js";
import {
  attentionItems,
  dayFigures,
  firstSteps,
  formatDuration,
  lineCards,
  recentDays,
  shiftDayRow,
} from "./overview/dashboard-model.js";
import { FirstSteps } from "./overview/FirstSteps.js";
import { KpiStrip } from "./overview/KpiStrip.js";
import { LineCards } from "./overview/LineCards.js";
import {
  deviceSummary,
  reasonMissingShifts,
  silentParticipants,
  waitingOnAbsentDevices,
} from "./overview/overview-model.js";
import { OutputChart } from "./overview/OutputChart.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { civilHeading, zoneClock } from "./overview/overview-time.js";
import { ShiftsPanel } from "./overview/ShiftsPanel.js";
import { SystemPanel } from "./overview/SystemPanel.js";
import { blockState, inOverviewPeriod, useOverviewData } from "./overview/use-overview-data.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";
import { revokedDeviceIds } from "./shifts/participation.js";
import { useViewportWidth } from "./use-viewport-width.js";
import "./overview/overview.css";

/** Below this the menu is collapsed and the offline notice moves into the page header's line. */
const COMPACT_WIDTH = 1366;
const NO_SHIFTS: never[] = [];

/**
 * «Обзор»: how the day is going. The four figures of the day, the output of the last seven days,
 * a card per line, what needs a person, today's and tomorrow's shifts and the state of the system.
 * Every block reads its own query, so one that fails says so in its own place and leaves the rest.
 * It reads again every 30 seconds and says when (`Обновлено …`), without announcing it.
 */
export function OfficeOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canPlan = useCan("planShifts");
  const data = useOverviewData();
  const width = useViewportWidth();
  const compact = width < COMPACT_WIDTH;
  const settings = useOfficeQuery(officeKeys.exportSettings, (api, token) =>
    api.getExportSettings(token),
  );
  const { admin, zone, today, nowMs } = data;

  const answer = data.shifts.data ?? NO_SHIFTS;
  // The host adds every shift closed without its reason whatever its date (spec §12.9): only the
  // attention row reads those; every other block reads the overview's own days.
  const allShifts = useMemo(
    () => answer.filter((shift) => inOverviewPeriod(shift, today)),
    [answer, today],
  );
  // The demo shifts (spec 2026-10-21) are no production: the day's figures, the chart, the line
  // cards and the first steps leave them out; the shifts panel lists them, marked.
  const shifts = useMemo(
    () => withoutDemo(allShifts, data.products.data),
    [allShifts, data.products.data],
  );
  const owingReason = useMemo(
    () => reasonMissingShifts(withoutDemo(answer, data.products.data)),
    [answer, data.products.data],
  );
  const shiftsState = blockState(data.shifts);
  const linesState = blockState(data.shifts, data.lines);
  const days = useMemo(() => recentDays(shifts, today, 7), [shifts, today]);
  const todayFigures = dayFigures(shifts, today);
  const yesterdayFigures = dayFigures(shifts, data.yesterday);
  // The host frees a revoked device's slot: the devices list (an administrator's) says which.
  const revoked = useMemo(
    () => revokedDeviceIds(admin ? data.devices.data : undefined),
    [admin, data.devices.data],
  );
  const cards = useMemo(
    () => lineCards(shifts, data.lines.data ?? [], data.products.data ?? [], nowMs, today, revoked),
    [shifts, data.lines.data, data.products.data, nowMs, today, revoked],
  );

  const sources = [data.conflicts, data.backups, data.license, ...(admin ? [data.devices] : [])];
  const failed = sources.filter((query) => query.isError && query.data === undefined);
  const attentionState = sources.some((query) => query.isPending)
    ? "loading"
    : failed.length === sources.length
      ? "error"
      : "ready";
  const conflictsPage = data.conflicts.data;
  const items = attentionItems({
    conflicts:
      conflictsPage === undefined
        ? null
        : {
            total: conflictsPage.total,
            oldestDetectedAt:
              conflictsPage.pageCount === 1 && conflictsPage.items.length > 0
                ? (conflictsPage.items
                    .map((conflict) => conflict.detectedAt)
                    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null)
                : null,
          },
    devices: admin ? (data.devices.data ?? null) : null,
    backups: data.backups.data ?? null,
    license: data.license.data ?? null,
    settings: settings.data ?? null,
    idleLines: cards.all
      .filter((card) => card.status === "idle" && card.shift !== null)
      .map((card) => ({
        lineName: card.line.name,
        shiftId: card.shift?.id ?? "",
        minutes: card.idleMinutes ?? 0,
      })),
    silentParticipants: silentParticipants(shifts, data.lines.data ?? [], nowMs, revoked),
    waitingShifts: waitingOnAbsentDevices(shifts, revoked),
    reasonMissing: owingReason,
    nowMs,
    pcNowMs: Date.now(),
    format: (instant) => zoneClock(new Date(instant), zone).hm,
  });

  const nonArchivedLines = (data.lines.data ?? []).filter((line) => !line.archived);
  const empty =
    shiftsState === "ready" &&
    data.lines.isSuccess &&
    nonArchivedLines.length === 0 &&
    shifts.length === 0;
  const quiet =
    shiftsState === "ready" &&
    !empty &&
    todayFigures.shifts === 0 &&
    !shifts.some((shift) => shift.status === "active");

  const retry = () => data.refetchAll();
  const clock = zoneClock(new Date(), zone);
  const asOf =
    data.hostDown && data.updatedAt > 0 ? zoneClock(new Date(data.updatedAt), zone) : clock;
  const staleAt = data.hostDown && data.updatedAt > 0 ? asOf.hm : null;
  const sinceUpdate = formatDuration(Math.max(0, Date.now() - data.updatedAt));
  const sinceText = t(`office.overview.duration.${sinceUpdate.unit}`, { count: sinceUpdate.count });

  const basis = data.hostDown
    ? staleAt === null
      ? null
      : t("office.overview.description.offline", { time: staleAt })
    : shiftsState === "error"
      ? null
      : empty
        ? t("office.overview.description.empty")
        : shiftsState === "loading"
          ? t("office.overview.description.loading")
          : quiet
            ? t("office.overview.description.quiet")
            : t("office.overview.description.normal");
  const dateLine = [
    civilHeading(today),
    `${clock.hm} (${clock.offset})`,
    ...(basis === null || (data.hostDown && compact) ? [] : [basis]),
  ].join(" · ");
  const updated = (
    <span className="ov-updated" aria-live="off">
      <OfficeIcon name="sync" size={14} />
      {data.updatedAt > 0 &&
        t("office.overview.updated", { time: zoneClock(new Date(data.updatedAt), zone).hms })}
    </span>
  );
  const description =
    data.hostDown && compact ? (
      <>
        <span className="ov-offline-line" role="status">
          <OfficeIcon name="wifiSlash" size={16} />
          {staleAt === null
            ? t("office.overview.offline.lineNoTime")
            : t("office.overview.offline.line", { time: staleAt })}
        </span>
        {updated}
      </>
    ) : (
      <>
        {dateLine}
        {updated}
      </>
    );

  const summary =
    admin && !data.hostDown && data.devices.data !== undefined
      ? deviceSummary(data.devices.data, nowMs)
      : null;
  const calm =
    summary === null
      ? t("office.overview.attention.calm")
      : t("office.overview.attention.calmDevices", {
          online:
            summary.byKind.station.online +
            summary.byKind.handheld.online +
            summary.byKind.office.online,
          total:
            summary.byKind.station.total +
            summary.byKind.handheld.total +
            summary.byKind.office.total,
        });

  const steps = firstSteps({
    org: data.org.data ?? null,
    lines: data.lines.data ?? [],
    devices: admin ? (data.devices.data ?? null) : null,
    products: (data.products.data ?? []).filter((product) => product.demo !== true),
    shifts,
  });

  return (
    <>
      <PageHeader
        className="ov-header"
        title={t("office.overview.title")}
        description={description}
        actions={
          <>
            {data.hostDown && compact && (
              <Button variant="secondary" icon={<OfficeIcon name="reset" />} onClick={retry}>
                {t("office.overview.offline.retry")}
              </Button>
            )}
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
      {/*
        One polite region for the page's warnings (extension point T4 of the license spec): the
        license's and the host address's in the open, the copies' for the ear only (their list
        row is in «Требует внимания»). It is on the screen from the start, empty, so each
        warning is heard once.
      */}
      <div className="backup-alerts" aria-live="polite">
        <OverviewLicense />
        <DemoDataNotice />
        <OverviewBackups />
        {admin && <HostAddressNotice />}
      </div>
      {data.hostDown && !compact && (
        <Alert
          tone="warn"
          role="status"
          title={t("office.overview.offline.title")}
          action={
            <Button variant="secondary" size="compact" onClick={retry}>
              {t("office.overview.offline.retry")}
            </Button>
          }
        >
          {staleAt === null
            ? t("office.overview.offline.textNoTime")
            : t("office.overview.offline.text", { time: staleAt, duration: sinceText })}
        </Alert>
      )}
      <div className="ov-page">
        <div className="ov-main">
          <KpiStrip
            state={shiftsState}
            error={data.shifts.error}
            onRetry={retry}
            today={todayFigures}
            yesterday={yesterdayFigures}
            conflicts={{
              state: blockState(data.conflicts),
              total: conflictsPage?.total ?? 0,
            }}
            staleAt={staleAt}
            empty={empty}
          />
          <OutputChart
            state={shiftsState}
            error={data.shifts.error}
            onRetry={retry}
            days={days}
            asOf={asOf.hm}
            empty={empty}
          />
          <LineCards
            state={linesState}
            error={data.lines.error ?? data.shifts.error}
            onRetry={retry}
            cards={cards.cards}
            hidden={cards.hidden}
            products={data.products.data ?? []}
            zone={zone}
            today={today}
            empty={
              empty ||
              (linesState === "ready" && nonArchivedLines.length === 0 && cards.all.length === 0)
            }
          />
        </div>
        <div className="ov-side">
          {empty ? (
            <FirstSteps steps={steps} />
          ) : (
            <AttentionPanel
              state={attentionState}
              error={failed[0]?.error}
              onRetry={retry}
              items={items}
              calm={calm}
              partial={failed.length > 0 && failed.length < sources.length}
            />
          )}
          <ShiftsPanel
            state={shiftsState}
            error={data.shifts.error}
            onRetry={retry}
            today={shiftDayRow(allShifts, today, true)}
            tomorrow={shiftDayRow(allShifts, data.tomorrow, false)}
          />
          {!empty && <SystemPanel data={data} />}
        </div>
      </div>
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
 * The backup warnings in the page's polite region, for the ear only: the copies' row of
 * «Требует внимания» is what the eye reads, and the polite region keeps a failed copy announced
 * once (plan РК: a failed copy is visible, not a line in a log). Nothing while the state loads or
 * when it does not warn. The organization's profile is read only when a warning has a time to
 * write (a restore that holds the facts).
 */
function OverviewBackups() {
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime(backups.isSuccess && backups.data.restoreHold !== null);
  const state = backups.isSuccess && time.ready ? backups.data : null;
  if (state === null || backupWarnings(state).length === 0) return null;
  return (
    <div className="ov-visually-hidden">
      <BackupWarnings state={state} format={time.format} />
    </div>
  );
}
