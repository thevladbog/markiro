import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AdminPage,
  Alert,
  Button,
  Card,
  DefinitionGrid,
  EmptyState,
  MetricStrip,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { DefinitionGridItem, MetricStripItem, TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { useChzProductGroups } from "../catalog/api.js";
import { kmIssueFileUrl, kmIssuePrintPath, useKmOrder, useRetryKmOrder } from "./api.js";
import { IssueKmCodesDialog } from "./IssueKmCodesDialog.js";
import {
  KM_ORDER_STATES,
  type KmIssue,
  type KmIssueKind,
  type KmOrder,
  type KmOrderState,
} from "./schemas.js";
import { kmOrderStateChipProps } from "./state.js";
import "./km-orders.css";

/**
 * The states an order walks through, in order. `rejected` and `failed` are
 * deliberately absent: they end the walk from wherever it had got to, and the
 * DTO carries no per-state timestamps to say where that was.
 */
const PIPELINE: readonly KmOrderState[] = KM_ORDER_STATES.filter(
  (state) => state !== "rejected" && state !== "failed",
);

type StepStatus = "done" | "current" | "pending";

interface TimelineStep {
  state: KmOrderState;
  status: StepStatus;
  at: string | null;
}

/**
 * «Ход заказа» from the two timestamps the DTO actually has: `createdAt` for
 * the first step and `updatedAt` for the one the order is in. A failed or
 * rejected order shows its creation and its ending, because nothing in the
 * response says which intermediate steps it managed to pass.
 */
export function kmOrderTimeline(order: KmOrder): TimelineStep[] {
  const index = PIPELINE.indexOf(order.state);
  if (index === -1) {
    return [
      { state: "created", status: "done", at: order.createdAt },
      { state: order.state, status: "current", at: order.updatedAt },
    ];
  }
  return PIPELINE.map((state, position) => ({
    state,
    status: position < index ? "done" : position === index ? "current" : "pending",
    at: position === 0 ? order.createdAt : position === index ? order.updatedAt : null,
  }));
}

const STEP_GLYPH: Record<StepStatus, string> = { done: "✓", current: "●", pending: "◌" };

/** Exhaustive over `StepStatus`: a missing key throws in the test build. */
const STEP_STATUS_KEY: Record<StepStatus, string> = {
  done: "pages.kmOrders.card.stepDone",
  current: "pages.kmOrders.card.stepCurrent",
  pending: "pages.kmOrders.card.stepPending",
};

export function KmOrderPage() {
  const { orderId = "" } = useParams();
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useKmOrder(orderId);
  const retry = useRetryKmOrder();
  const groups = useChzProductGroups();
  const [issueMode, setIssueMode] = useState<KmIssueKind | null>(null);
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const order = query.data;

  const counters = useMemo<MetricStripItem[]>(
    () =>
      order === undefined
        ? []
        : [
            {
              id: "ordered",
              label: t("pages.kmOrders.card.counterOrdered"),
              value: number.format(order.quantity),
            },
            {
              id: "fetched",
              label: t("pages.kmOrders.card.counterFetched"),
              value: number.format(order.fetchedCount),
            },
            {
              id: "issued",
              label: t("pages.kmOrders.card.counterIssued"),
              value: number.format(order.issuedCount),
            },
            {
              id: "available",
              label: t("pages.kmOrders.card.counterAvailable"),
              value: number.format(order.availableForIssue),
            },
          ],
    [number, order, t],
  );

  const issueColumns = useMemo<TableColumn<KmIssue>[]>(() => {
    const columns: TableColumn<KmIssue>[] = [
      {
        key: "range",
        title: t("pages.kmOrders.card.issuesRange"),
        width: 200,
        mono: true,
        render: (issue) =>
          t("pages.kmOrders.range", {
            from: number.format(issue.fromSeq),
            to: number.format(issue.toSeq),
          }),
      },
      {
        key: "count",
        title: t("pages.kmOrders.card.issuesCount"),
        width: 110,
        align: "right",
        mono: true,
        render: (issue) => number.format(issue.count),
      },
      {
        key: "kind",
        title: t("pages.kmOrders.card.issuesKind"),
        width: 140,
        render: (issue) =>
          issue.kind === "export"
            ? t("pages.kmOrders.card.issuesExportKind", {
                format: (issue.format ?? "").toUpperCase(),
              })
            : t("pages.kmOrders.card.issuesPrintKind"),
      },
      {
        key: "createdAt",
        title: t("pages.kmOrders.card.issuesCreated"),
        width: 180,
        wrap: true,
        render: (issue) => (
          <span className="mk-km-orders__stack">
            <time dateTime={issue.createdAt}>
              {formatCreatedAt(issue.createdAt, i18n.language)}
            </time>
            <small>{issue.createdBy.name}</small>
          </span>
        ),
      },
    ];
    // Repeating an issue hands the same codes to the floor again, so it is the
    // same product action as issuing them: hidden, not disabled, without the
    // write capability -- exactly like the order and issue actions above.
    if (!canWrite || order === undefined) return columns;
    columns.push({
      key: "actions",
      title: t("pages.kmOrders.card.issuesActions"),
      width: 180,
      render: (issue) =>
        issue.kind === "export" ? (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => window.location.assign(kmIssueFileUrl(order.id, issue.id))}
          >
            {t("pages.kmOrders.card.repeatDownload")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => window.open(kmIssuePrintPath(order.id, issue.id), "_blank")}
          >
            {t("pages.kmOrders.card.repeatPrint")}
          </Button>
        ),
    });
    return columns;
  }, [canWrite, i18n.language, number, order, t]);

  if (query.isPending) {
    return (
      <AdminPage className="mk-km-order-page">
        <Spinner label={t("common.loading")} />
      </AdminPage>
    );
  }
  if (query.isError || order === undefined) {
    return (
      <AdminPage className="mk-km-order-page">
        <EmptyState
          title={t("pages.kmOrders.card.loadError")}
          hint={t("pages.kmOrders.card.loadErrorHint")}
          action={
            <Button type="button" onClick={() => void query.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
        <Link className="mk-km-order-page__back" to="/km-orders">
          {t("pages.kmOrders.card.back")}
        </Link>
      </AdminPage>
    );
  }

  const groupName =
    groups.data?.find((group) => group.alias === order.productGroupAlias)?.name ??
    order.productGroupAlias;
  const reason = order.rejectionReason ?? order.errorMessage ?? order.errorCode;
  const canIssue = canWrite && order.state === "completed" && order.availableForIssue > 0;
  const issuedPercent =
    order.fetchedCount === 0 ? 0 : Math.round((order.issuedCount / order.fetchedCount) * 100);
  const progressText = t("pages.kmOrders.card.progress", {
    issued: number.format(order.issuedCount),
    fetched: number.format(order.fetchedCount),
  });

  const details: DefinitionGridItem[] = [
    {
      id: "oms",
      term: t("pages.kmOrders.card.detailsOms"),
      description: order.omsOrderId ?? t("pages.kmOrders.card.detailsEmpty"),
      mono: true,
    },
    {
      id: "buffer",
      term: t("pages.kmOrders.card.detailsBuffer"),
      description: order.bufferStatus ?? t("pages.kmOrders.card.detailsEmpty"),
    },
    { id: "group", term: t("pages.kmOrders.card.detailsGroup"), description: groupName },
    {
      id: "template",
      term: t("pages.kmOrders.card.detailsTemplate"),
      description: String(order.templateId),
      mono: true,
    },
    // Both are constants of the order body this cabinet signs and sends (see
    // `buildChzKmOrderBody` in `@markiro/domain`), not fields of the response.
    {
      id: "serial",
      term: t("pages.kmOrders.card.detailsSerial"),
      description: t("pages.kmOrders.card.detailsSerialValue"),
    },
    {
      id: "release",
      term: t("pages.kmOrders.card.detailsRelease"),
      description: t("pages.kmOrders.card.detailsReleaseValue"),
    },
    {
      id: "createdBy",
      term: t("pages.kmOrders.card.detailsCreatedBy"),
      description: order.createdBy.name,
    },
  ];

  return (
    <AdminPage className="mk-km-order-page">
      <Link className="mk-km-order-page__back" to="/km-orders">
        {t("pages.kmOrders.card.back")}
      </Link>
      <PageHeader
        title={order.productName}
        actions={
          canIssue ? (
            <>
              <Button type="button" variant="secondary" onClick={() => setIssueMode("export")}>
                {t("pages.kmOrders.card.exportAction")}
              </Button>
              <Button type="button" onClick={() => setIssueMode("print")}>
                {t("pages.kmOrders.card.printAction")}
              </Button>
            </>
          ) : null
        }
      />
      <p className="mk-km-order-page__meta">
        <StatusChip
          {...kmOrderStateChipProps(order.state)}
          label={t(`pages.kmOrders.state.${order.state}`)}
        />
        <span className="font-mono">
          {t("pages.kmOrders.card.metaGtin", { gtin: order.gtin14 })}
        </span>
        <span>{t("pages.kmOrders.card.metaGroup", { group: groupName })}</span>
        <span>{t("pages.kmOrders.card.metaTemplate", { template: order.templateId })}</span>
      </p>

      {order.state === "rejected" || order.state === "failed" ? (
        <Alert
          tone="error"
          role="alert"
          title={t(
            order.state === "rejected"
              ? "pages.kmOrders.card.rejectedTitle"
              : "pages.kmOrders.card.failedTitle",
          )}
          {...(order.state === "failed" && canWrite
            ? {
                action: (
                  <Button
                    type="button"
                    variant="secondary"
                    loading={retry.isPending}
                    onClick={() => retry.mutate(order.id)}
                  >
                    {t("pages.kmOrders.card.retryAction")}
                  </Button>
                ),
              }
            : {})}
        >
          {reason ?? t("pages.kmOrders.card.reasonUnknown")}
        </Alert>
      ) : null}
      {retry.isError ? (
        <Alert tone="error" role="alert">
          {t("pages.kmOrders.card.retryError")}
        </Alert>
      ) : null}
      {order.bufferExpiresAt !== null ? (
        <Alert tone="warn">
          {t("pages.kmOrders.card.expiry", {
            date: formatCreatedAt(order.bufferExpiresAt, i18n.language),
          })}
        </Alert>
      ) : null}

      <MetricStrip items={counters} label={t("pages.kmOrders.card.countersLabel")} />
      <div className="mk-km-order-progress">
        <span className="mk-km-order-progress__text">{progressText}</span>
        <span
          className="mk-km-order-progress__track"
          role="progressbar"
          aria-label={t("pages.kmOrders.card.progressLabel")}
          aria-valuemin={0}
          aria-valuemax={order.fetchedCount}
          aria-valuenow={order.issuedCount}
          aria-valuetext={progressText}
        >
          <span className="mk-km-order-progress__fill" style={{ width: `${issuedPercent}%` }} />
        </span>
      </div>

      <Card title={t("pages.kmOrders.card.timelineTitle")} titleAs="h2">
        <ol className="mk-km-order-timeline">
          {kmOrderTimeline(order).map((step) => (
            <li
              className={`mk-km-order-timeline__step mk-km-order-timeline__step--${step.status}`}
              key={step.state}
              {...(step.status === "current" ? { "aria-current": "step" as const } : {})}
            >
              <span aria-hidden="true" className="mk-km-order-timeline__glyph">
                {STEP_GLYPH[step.status]}
              </span>
              <span className="mk-km-order-timeline__label">
                {t(`pages.kmOrders.state.${step.state}`)}
              </span>
              {/* Status in words, never colour or a glyph alone. */}
              <span className="mk-km-order-timeline__status">
                {t(STEP_STATUS_KEY[step.status])}
              </span>
              {step.at === null ? null : (
                <time className="mk-km-order-timeline__time" dateTime={step.at}>
                  {formatCreatedAt(step.at, i18n.language)}
                </time>
              )}
            </li>
          ))}
        </ol>
        <p className="mk-km-order-timeline__author">
          {t("pages.kmOrders.card.stepAuthor", { name: order.createdBy.name })}
        </p>
      </Card>

      <Card title={t("pages.kmOrders.card.detailsTitle")} titleAs="h2">
        <DefinitionGrid items={details} />
      </Card>

      <Card title={t("pages.kmOrders.card.issuesTitle")} titleAs="h2">
        {order.issues.length === 0 ? (
          <p className="mk-km-orders-summary">{t("pages.kmOrders.card.issuesEmpty")}</p>
        ) : (
          <Table
            className="mk-km-order-issues"
            columns={issueColumns}
            rows={order.issues}
            scrollLabel={t("pages.kmOrders.card.issuesScrollLabel")}
          />
        )}
      </Card>

      {issueMode !== null ? (
        <IssueKmCodesDialog
          open
          mode={issueMode}
          order={order}
          onClose={() => setIssueMode(null)}
        />
      ) : null}
    </AdminPage>
  );
}
