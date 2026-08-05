import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { Alert, Button, PageHeader } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useProducts, type ProductDto } from "../catalog/api.js";
import { useConflicts } from "../conflicts/api.js";
import { useLines, useShifts, type LineDto, type ShiftDto } from "../shifts/api.js";

import "./dashboard.css";

export function DashboardPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const productsQuery = useProducts();
  const shiftsQuery = useShifts();
  const linesQuery = useLines();
  const conflictsQuery = useConflicts({ reviewed: false });

  const queries = [productsQuery, shiftsQuery, linesQuery, conflictsQuery];

  if (queries.some((query) => query.isPending)) {
    return <DashboardSkeleton />;
  }

  if (queries.some((query) => query.isError)) {
    const retry = () => {
      void Promise.all(queries.map((query) => query.refetch()));
    };

    return (
      <div className="mk-dashboard-page">
        <PageHeader title={t("pages.dashboard.title")} />
        <Alert
          tone="error"
          title={t("pages.dashboard.error.title")}
          action={
            <Button type="button" size="compact" variant="secondary" onClick={retry}>
              {t("pages.dashboard.error.retry")}
            </Button>
          }
        >
          {t("pages.dashboard.error.hint")}
        </Alert>
      </div>
    );
  }

  const products = productsQuery.data ?? [];
  const shifts = shiftsQuery.data ?? [];
  const lines = linesQuery.data ?? [];
  const conflicts = conflictsQuery.data ?? [];
  const hasRunShift = shifts.some(
    (shift) => shift.status === "active" || shift.status === "closed",
  );

  return (
    <div className="mk-dashboard-page">
      <PageHeader title={t("pages.dashboard.title")} />
      {!hasRunShift ? (
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
            hasProducts={products.length > 0}
            hasShifts={shifts.length > 0}
          />
        </section>
      ) : (
        <OperationalDashboard
          products={products}
          shifts={shifts}
          lines={lines}
          conflictCount={conflicts.length}
        />
      )}
    </div>
  );
}

function OperationalDashboard({
  products,
  shifts,
  lines,
  conflictCount,
}: {
  products: ProductDto[];
  shifts: ShiftDto[];
  lines: LineDto[];
  conflictCount: number;
}) {
  const { t, i18n } = useTranslation();
  const activeShifts = shifts.filter((shift) => shift.status === "active");
  const plannedShifts = shifts
    .filter((shift) => shift.status === "planned")
    .sort(comparePlannedShifts);
  const visibleActiveShifts = activeShifts.slice(0, 5);
  const visiblePlannedShifts = plannedShifts.slice(0, 5);
  const draftCount = products.filter((product) => product.status === "draft").length;
  const readyCount = products.length - draftCount;
  const lineNames = new Map(lines.map((line) => [line.id, line.name]));
  const number = new Intl.NumberFormat(i18n.language);
  const date = new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "long" });
  const dateTime = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const summary = [
    { label: t("pages.dashboard.summary.active"), value: activeShifts.length },
    { label: t("pages.dashboard.summary.planned"), value: plannedShifts.length },
    { label: t("pages.dashboard.summary.products"), value: readyCount },
    { label: t("pages.dashboard.summary.conflicts"), value: conflictCount },
  ];

  return (
    <>
      <section className="mk-dashboard-summary" aria-label={t("pages.dashboard.summary.label")}>
        {summary.map((item) => (
          <div
            key={item.label}
            className="mk-dashboard-summary__item"
            aria-label={`${item.label}: ${number.format(item.value)}`}
          >
            <span className="mk-dashboard-summary__label">{item.label}</span>
            <strong className="mk-dashboard-summary__value">{number.format(item.value)}</strong>
          </div>
        ))}
      </section>

      {draftCount > 0 || conflictCount > 0 ? (
        <section aria-labelledby="dashboard-attention-title" className="mk-dashboard-section">
          <SectionHeader
            id="dashboard-attention-title"
            title={t("pages.dashboard.attention.title")}
          />
          <div className="mk-dashboard-attention">
            {conflictCount > 0 ? (
              <AttentionLink
                to="/conflicts"
                tone="error"
                label={t("pages.dashboard.attention.conflicts", { count: conflictCount })}
                hint={t("pages.dashboard.attention.conflictsHint")}
              />
            ) : null}
            {draftCount > 0 ? (
              <AttentionLink
                to="/catalog"
                tone="warn"
                label={t("pages.dashboard.attention.drafts", { count: draftCount })}
                hint={t("pages.dashboard.attention.draftsHint")}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="dashboard-active-title" className="mk-dashboard-section">
        <SectionHeader
          id="dashboard-active-title"
          title={t("pages.dashboard.active.title")}
          action={{ to: "/shifts", label: t("pages.dashboard.viewAll") }}
        />
        {visibleActiveShifts.length > 0 ? (
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
                {visibleActiveShifts.map((shift) => (
                  <tr key={shift.id}>
                    <td>{shift.productName ?? t("pages.dashboard.notSpecified")}</td>
                    <td>{lineNameOf(shift, lineNames, t("pages.dashboard.notSpecified"))}</td>
                    <td>{t(`pages.dashboard.mode.${shift.mode}`)}</td>
                    <td className="mk-dashboard-table__number">
                      {shift.plannedQty === null
                        ? t("pages.dashboard.notSpecified")
                        : number.format(shift.plannedQty)}
                    </td>
                    <td>
                      {shift.openedAt
                        ? dateTime.format(new Date(shift.openedAt))
                        : t("pages.dashboard.notSpecified")}
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

      <section aria-labelledby="dashboard-planned-title" className="mk-dashboard-section">
        <SectionHeader
          id="dashboard-planned-title"
          title={t("pages.dashboard.planned.title")}
          action={{ to: "/shifts", label: t("pages.dashboard.viewAll") }}
        />
        {visiblePlannedShifts.length > 0 ? (
          <ol className="mk-dashboard-planned">
            {visiblePlannedShifts.map((shift) => (
              <li key={shift.id} className="mk-dashboard-planned__item">
                <div className="mk-dashboard-planned__main">
                  <strong>{shift.productName ?? t("pages.dashboard.notSpecified")}</strong>
                  <span>
                    {lineNameOf(shift, lineNames, t("pages.dashboard.notSpecified"))}
                    {" · "}
                    {t(`pages.dashboard.mode.${shift.mode}`)}
                  </span>
                </div>
                <div className="mk-dashboard-planned__meta">
                  <strong>
                    {shift.plannedQty === null
                      ? t("pages.dashboard.notSpecified")
                      : number.format(shift.plannedQty)}
                  </strong>
                  <span>
                    {shift.plannedDate
                      ? date.format(new Date(`${shift.plannedDate}T12:00:00`))
                      : t("pages.dashboard.planned.noDate")}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <InlineEmptyState
            text={t("pages.dashboard.planned.empty")}
            to="/shifts"
            action={t("pages.dashboard.planned.plan")}
          />
        )}
      </section>
    </>
  );
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

function AttentionLink({
  to,
  tone,
  label,
  hint,
}: {
  to: string;
  tone: "error" | "warn";
  label: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      className={`mk-dashboard-attention__item mk-dashboard-attention__item--${tone}`}
    >
      <strong>{label}</strong>
      <span>{hint}</span>
    </Link>
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

function comparePlannedShifts(left: ShiftDto, right: ShiftDto): number {
  const leftDate = left.plannedDate ?? "9999-12-31";
  const rightDate = right.plannedDate ?? "9999-12-31";
  return leftDate.localeCompare(rightDate) || left.createdAt.localeCompare(right.createdAt);
}

function lineNameOf(
  shift: ShiftDto,
  lineNames: ReadonlyMap<string, string>,
  fallback: string,
): string {
  return shift.lineName ?? (shift.lineId ? lineNames.get(shift.lineId) : undefined) ?? fallback;
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