import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { Alert, Button, PageHeader, StatusChip } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useDashboardOverview, type DashboardOverviewDto, type DashboardPeriod } from "./api.js";
import { ProductionDynamics } from "./ProductionDynamics.js";

import "./dashboard.css";

const DEFAULT_PERIOD: DashboardPeriod = "7d";

export function DashboardPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const [period, setPeriod] = useState<DashboardPeriod>(DEFAULT_PERIOD);
  const overviewQuery = useDashboardOverview(period);
  const previousOverviewRef = useRef<DashboardOverviewDto | null>(null);

  useEffect(() => {
    if (overviewQuery.data) {
      previousOverviewRef.current = overviewQuery.data;
    }
  }, [overviewQuery.data]);

  if (overviewQuery.isPending && !previousOverviewRef.current) {
    return <DashboardSkeleton />;
  }

  if (overviewQuery.isError) {
    return (
      <div className="mk-dashboard-page">
        <PageHeader title={t("pages.dashboard.title")} />
        <Alert
          tone="error"
          title={t("pages.dashboard.error.title")}
          action={
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => void overviewQuery.refetch()}
            >
              {t("pages.dashboard.error.retry")}
            </Button>
          }
        >
          {t("pages.dashboard.error.hint")}
        </Alert>
      </div>
    );
  }

  const overview = overviewQuery.data ?? previousOverviewRef.current;
  if (!overview) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="mk-dashboard-page">
      <DashboardHeader overview={overview} />
      {!overview.setup.hasRunShift ? (
        <section aria-labelledby="dashboard-setup-title" className="mk-dashboard-setup">
          <h2
            id="dashboard-setup-title"
            style={{ margin: 0, font: "var(--text-h2)", color: "var(--fg-1)" }}
          >
            {t("pages.dashboard.setup.title")}
          </h2>
          <p style={{ margin: "8px 0 20px", font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.dashboard.setup.hint")}
          </p>
          <ol style={{ margin: 0, paddingLeft: 20, color: "var(--fg-1)" }}>
            <li style={{ padding: "8px 0", font: "var(--text-body)" }}>
              {t("pages.dashboard.setup.product")}
            </li>
            <li style={{ padding: "8px 0", font: "var(--text-body)" }}>
              {t("pages.dashboard.setup.shift")}
            </li>
            <li style={{ padding: "8px 0", font: "var(--text-body)" }}>
              {t("pages.dashboard.setup.launch")}
            </li>
          </ol>
          <SetupAction
            canWrite={canWrite}
            hasProducts={overview.setup.productCount > 0}
            hasShifts={overview.setup.shiftCount > 0}
          />
        </section>
      ) : (
        <OperationalDashboard
          overview={overview}
          period={period}
          onPeriodChange={setPeriod}
          canWrite={canWrite}
          refreshing={overview.dynamics.period !== period}
        />
      )}
    </div>
  );
}

function DashboardHeader({ overview }: { overview: DashboardOverviewDto }) {
  const { t, i18n } = useTranslation();
  const localDate = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: overview.timeZone,
  }).format(new Date(overview.generatedAt));
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: overview.timeZone,
  }).format(new Date(overview.generatedAt));

  return (
    <PageHeader
      title={t("pages.dashboard.title")}
      actions={
        <div className="mk-dashboard-header-meta">
          <span>{localDate}</span>
          <span className="mk-dashboard-header-meta__zone">{overview.timeZone}</span>
          <span>
            {t("pages.dashboard.header.generatedAt")}{" "}
            <time dateTime={overview.generatedAt}>{dateTime}</time>
          </span>
        </div>
      }
    />
  );
}

function OperationalDashboard({
  overview,
  period,
  onPeriodChange,
  canWrite,
  refreshing,
}: {
  overview: DashboardOverviewDto;
  period: DashboardPeriod;
  onPeriodChange: (period: DashboardPeriod) => void;
  canWrite: boolean;
  refreshing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <>
      {refreshing ? (
        <div
          className="mk-dashboard-refreshing"
          role="status"
          aria-label={t("pages.dashboard.refreshing.title")}
        >
          <strong>{t("pages.dashboard.refreshing.title")}</strong>
          <span>{t("pages.dashboard.refreshing.hint")}</span>
        </div>
      ) : null}
      <ProductionVerdict verdict={overview.verdict} />
      <HeadlineFacts overview={overview} />
      <div className="mk-dashboard-operational-row">
        <ProductionDynamics overview={overview} period={period} onPeriodChange={onPeriodChange} />
        <ControlSignals overview={overview} />
      </div>
      <ActiveShifts overview={overview} canWrite={canWrite} />
    </>
  );
}

function ProductionVerdict({ verdict }: { verdict: DashboardOverviewDto["verdict"] }) {
  const { t } = useTranslation();

  return (
    <section
      className={`mk-dashboard-verdict mk-dashboard-verdict--${verdict.status}`}
      aria-labelledby="dashboard-verdict-title"
    >
      <div className="mk-dashboard-verdict__status">
        <span className="mk-dashboard-eyebrow">{t("pages.dashboard.verdict.eyebrow")}</span>
        <h2 id="dashboard-verdict-title">
          {t(`pages.dashboard.verdict.status.${verdict.status}`)}
        </h2>
      </div>
      {verdict.reasons.length > 0 ? (
        <ol className="mk-dashboard-verdict__reasons">
          {verdict.reasons.map((reason, index) => {
            const content = t(`pages.dashboard.verdict.reason.${reason.code}`, {
              count: reason.count,
            });
            return (
              <li
                key={`${reason.code}-${index}`}
                className={`mk-dashboard-reason--${reason.severity}`}
              >
                <span className="mk-dashboard-verdict__reason-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {reason.route ? <Link to={reason.route}>{content}</Link> : <span>{content}</span>}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mk-dashboard-verdict__clear">{t("pages.dashboard.verdict.noReasons")}</p>
      )}
    </section>
  );
}

function HeadlineFacts({ overview }: { overview: DashboardOverviewDto }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const facts = [
    {
      label: t("pages.dashboard.headline.validation"),
      value: overview.today.validationAcceptedUnits,
      unit: t("pages.dashboard.headline.units"),
      ariaLabel: t("pages.dashboard.headline.validationAria", {
        count: number.format(overview.today.validationAcceptedUnits),
      }),
    },
    {
      label: t("pages.dashboard.headline.aggregationBoxes"),
      value: overview.today.aggregationClosedBoxes,
      unit: t("pages.dashboard.headline.boxes"),
      ariaLabel: t("pages.dashboard.headline.aggregationBoxesAria", {
        count: number.format(overview.today.aggregationClosedBoxes),
      }),
    },
    {
      label: t("pages.dashboard.headline.aggregationUnits"),
      value: overview.today.aggregationContainedUnits,
      unit: t("pages.dashboard.headline.units"),
      ariaLabel: t("pages.dashboard.headline.aggregationUnitsAria", {
        count: number.format(overview.today.aggregationContainedUnits),
      }),
    },
    {
      label: t("pages.dashboard.headline.active"),
      value: overview.today.activeShiftCount,
      unit: t("pages.dashboard.headline.shiftUnit", {
        count: overview.today.activeShiftCount,
      }),
      ariaLabel: t("pages.dashboard.headline.activeAria", {
        count: overview.today.activeShiftCount,
      }),
    },
  ];

  return (
    <section className="mk-dashboard-headline" aria-label={t("pages.dashboard.headline.scope")}>
      {facts.map((fact) => (
        <div key={fact.label} className="mk-dashboard-headline__item" aria-label={fact.ariaLabel}>
          <span className="mk-dashboard-headline__label">{fact.label}</span>
          <span className="mk-dashboard-headline__measurement">
            <strong>{number.format(fact.value)}</strong>
            <span>{fact.unit}</span>
          </span>
        </div>
      ))}
      <p className="mk-dashboard-headline__scope">
        {t("pages.dashboard.headline.includedClosed", {
          count: overview.today.includedClosedShiftCount,
        })}
      </p>
    </section>
  );
}

function ControlSignals({ overview }: { overview: DashboardOverviewDto }) {
  const { t } = useTranslation();
  const quality = overview.dynamics.quality;
  const status =
    quality.status === "complete" ? "ok" : quality.status === "provisional" ? "info" : "warn";

  return (
    <section className="mk-dashboard-signals" aria-labelledby="dashboard-signals-title">
      <div className="mk-dashboard-panel-header">
        <div>
          <h2 id="dashboard-signals-title">{t("pages.dashboard.signals.title")}</h2>
          <p>{t("pages.dashboard.signals.hint")}</p>
        </div>
        <StatusChip status={status} label={t(`pages.dashboard.signals.status.${quality.status}`)} />
      </div>
      {quality.reasons.length > 0 ? (
        <ul className="mk-dashboard-signals__list">
          {quality.reasons.map((reason) => (
            <li key={reason}>
              <span
                className={`mk-dashboard-signals__mark mk-dashboard-signals__mark--${reason}`}
                aria-hidden="true"
              />
              <span>
                {t(`pages.dashboard.signals.reason.${reason}`, {
                  count:
                    reason === "late_data"
                      ? quality.lateDataShiftCount
                      : reason === "active_shifts"
                        ? quality.activeShiftCount
                        : 1,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mk-dashboard-signals__clear">{t("pages.dashboard.signals.clear")}</p>
      )}
      <dl className="mk-dashboard-signals__meta">
        <div>
          <dt>{t("pages.dashboard.signals.rateBasis")}</dt>
          <dd>{t("pages.dashboard.signals.shiftHour")}</dd>
        </div>
        <div>
          <dt>{t("pages.dashboard.signals.lateData")}</dt>
          <dd>{overview.dynamics.quality.lateDataShiftCount}</dd>
        </div>
      </dl>
    </section>
  );
}

function ActiveShifts({
  overview,
  canWrite,
}: {
  overview: DashboardOverviewDto;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: overview.timeZone,
  });

  return (
    <section aria-labelledby="dashboard-active-title" className="mk-dashboard-section">
      <div className="mk-dashboard-section__header">
        <div className="mk-dashboard-section__title-group">
          <h2 id="dashboard-active-title">{t("pages.dashboard.active.title")}</h2>
          <StatusChip status="info" label={t("pages.dashboard.active.provisional")} />
        </div>
        <Link to="/shifts">{t("pages.dashboard.viewAll")}</Link>
      </div>
      {overview.activeShifts.length > 0 ? (
        <div className="mk-dashboard-table-scroll">
          <table className="mk-dashboard-table">
            <caption className="mk-dashboard-sr-only">
              {t("pages.dashboard.active.tableLabel")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("pages.dashboard.active.number")}</th>
                <th scope="col">{t("pages.dashboard.active.product")}</th>
                <th scope="col">{t("pages.dashboard.active.line")}</th>
                <th scope="col">{t("pages.dashboard.active.mode")}</th>
                <th scope="col" className="mk-dashboard-table__number">
                  {t("pages.dashboard.active.output")}
                </th>
                <th scope="col">{t("pages.dashboard.active.started")}</th>
                <th scope="col">{t("pages.dashboard.active.data")}</th>
              </tr>
            </thead>
            <tbody>
              {overview.activeShifts.map((shift) => (
                <tr key={shift.id}>
                  <td className="mk-dashboard-table__identifier">
                    <Link to={canWrite ? `/shifts/${shift.id}/edit` : "/shifts"}>
                      {shift.number}
                    </Link>
                  </td>
                  <td>{shift.productName ?? t("pages.dashboard.notSpecified")}</td>
                  <td>{shift.lineName ?? t("pages.dashboard.notSpecified")}</td>
                  <td>{t(`pages.dashboard.mode.${shift.output.mode}`)}</td>
                  <td className="mk-dashboard-table__number">
                    {formatShiftOutput(shift.output, number, t)}
                  </td>
                  <td>{dateTime.format(new Date(shift.openedAt))}</td>
                  <td>
                    <StatusChip
                      status={shift.lateDataAt ? "warn" : "info"}
                      label={t(
                        shift.lateDataAt
                          ? "pages.dashboard.active.late"
                          : "pages.dashboard.active.provisional",
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <InlineEmptyState
          text={t("pages.dashboard.active.empty")}
          to="/shifts"
          action={t("pages.dashboard.active.openShifts")}
        />
      )}
    </section>
  );
}

function formatShiftOutput(
  output: DashboardOverviewDto["activeShifts"][number]["output"],
  number: Intl.NumberFormat,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (output.mode === "validation") {
    return t("pages.dashboard.active.validationOutput", {
      count: number.format(output.acceptedUnits),
    });
  }
  return t("pages.dashboard.active.aggregationOutput", {
    boxes: number.format(output.closedBoxes),
    units: number.format(output.containedUnits),
  });
}

function InlineEmptyState({ text, to, action }: { text: string; to: string; action: string }) {
  return (
    <div className="mk-dashboard-inline-empty">
      <span>{text}</span>
      <Link to={to}>{action}</Link>
    </div>
  );
}

function DashboardSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="mk-dashboard-page mk-dashboard-skeleton"
      role="status"
      aria-label={t("pages.dashboard.loading")}
    >
      <span className="mk-dashboard-sr-only">{t("pages.dashboard.loading")}</span>
      <div className="mk-dashboard-skeleton__title" data-testid="dashboard-skeleton-block" />
      <div className="mk-dashboard-skeleton__summary">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="mk-dashboard-skeleton__metric"
            data-testid="dashboard-skeleton-block"
          />
        ))}
      </div>
      <div className="mk-dashboard-skeleton__table" data-testid="dashboard-skeleton-block" />
    </div>
  );
}

function SetupAction({
  canWrite,
  hasProducts,
  hasShifts,
}: {
  canWrite: boolean;
  hasProducts: boolean;
  hasShifts: boolean;
}) {
  const { t } = useTranslation();
  const to = hasProducts ? "/shifts" : "/catalog";
  const actionKey = !hasProducts
    ? canWrite
      ? "pages.dashboard.setup.addProduct"
      : "pages.dashboard.setup.openCatalog"
    : !hasShifts && canWrite
      ? "pages.dashboard.setup.planShift"
      : "pages.dashboard.setup.openShifts";

  return (
    <Link
      to={to}
      className="mk-dashboard-primary-action"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "var(--control-md)",
        marginTop: 20,
        padding: "0 16px",
        borderRadius: "var(--r-2)",
        background: "var(--surface-inverse)",
        color: "var(--fg-on-inverse)",
        font: "600 14px/1 var(--font-ui)",
        textDecoration: "none",
      }}
    >
      {t(actionKey)}
    </Link>
  );
}
