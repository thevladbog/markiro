import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { Alert, Button, PageHeader } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useDashboardOverview, type DashboardOverviewDto } from "./api.js";

import "./dashboard.css";

const DEFAULT_PERIOD = "7d";

export function DashboardPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const overviewQuery = useDashboardOverview(DEFAULT_PERIOD);

  if (overviewQuery.isPending) {
    return <DashboardSkeleton />;
  }

  if (overviewQuery.isError || !overviewQuery.data) {
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

  const overview = overviewQuery.data;

  return (
    <div className="mk-dashboard-page">
      <PageHeader title={t("pages.dashboard.title")} />
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
        <OperationalDashboard overview={overview} />
      )}
    </div>
  );
}

function OperationalDashboard({ overview }: { overview: DashboardOverviewDto }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <section aria-labelledby="dashboard-active-title" className="mk-dashboard-section">
      <SectionHeader
        id="dashboard-active-title"
        title={t("pages.dashboard.active.title")}
        action={{ to: "/shifts", label: t("pages.dashboard.viewAll") }}
      />
      {overview.activeShifts.length > 0 ? (
        <div className="mk-dashboard-table-scroll">
          <table className="mk-dashboard-table">
            <thead>
              <tr>
                <th scope="col">{t("pages.dashboard.active.product")}</th>
                <th scope="col">{t("pages.dashboard.active.line")}</th>
                <th scope="col">{t("pages.dashboard.active.mode")}</th>
                <th scope="col" className="mk-dashboard-table__number">
                  {t("pages.dashboard.active.plan")}
                </th>
                <th scope="col">{t("pages.dashboard.active.started")}</th>
              </tr>
            </thead>
            <tbody>
              {overview.activeShifts.map((shift) => (
                <tr key={shift.id}>
                  <td>{shift.productName ?? t("pages.dashboard.notSpecified")}</td>
                  <td>{shift.lineName ?? t("pages.dashboard.notSpecified")}</td>
                  <td>{t(`pages.dashboard.mode.${shift.output.mode}`)}</td>
                  <td className="mk-dashboard-table__number">
                    {formatShiftOutput(shift.output, number)}
                  </td>
                  <td>{dateTime.format(new Date(shift.openedAt))}</td>
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
): string {
  if (output.mode === "validation") {
    return number.format(output.acceptedUnits);
  }
  return `${number.format(output.closedBoxes)} · ${number.format(output.containedUnits)}`;
}

function SectionHeader({
  id,
  title,
  action,
}: {
  id: string;
  title: string;
  action?: { to: string; label: string };
}) {
  return (
    <div className="mk-dashboard-section__header">
      <h2 id={id}>{title}</h2>
      {action ? <Link to={action.to}>{action.label}</Link> : null}
    </div>
  );
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
