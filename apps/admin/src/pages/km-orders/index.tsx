import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AdminPage,
  Alert,
  Button,
  EmptyState,
  MetricStrip,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { MetricStripItem, TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { useKmOrders } from "./api.js";
import { CreateKmOrderDialog } from "./CreateKmOrderDialog.js";
import { isTerminalKmOrderState, type KmOrderListItem } from "./schemas.js";
import { kmOrderStatePhase } from "./state.js";
import "./km-orders.css";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the tile's own wording; a buffer this close needs issuing now. */
const EXPIRY_HORIZON_DAYS = 14;
const ISSUED_WINDOW_DAYS = 30;

export interface KmOrderMetrics {
  availableForIssue: number;
  expiringSoon: number;
  activeOrders: number;
  issuedRecently: number;
}

/**
 * The KPI strip is derived from the list the page already has -- there is no
 * separate metrics endpoint, and adding one for four sums would put a second
 * source of truth in front of the same rows.
 *
 * `issuedRecently` is therefore the codes issued **from orders created in the
 * window**, not the codes issued during it: the list DTO carries a cumulative
 * `issuedCount` and no per-issue timestamps (those live on the order card).
 * The tile's label, «Выдано по заказам за 30 дней», attaches «за 30 дней» to
 * the orders rather than to the issuing, which is the honest reading of what
 * this number counts.
 *
 * `expiringSoon` sums `availableCodes`, not `availableForIssue`: the buffer's
 * expiry bounds what is still retrievable from the state system, and
 * `availableForIssue` (`fetchedCount - issuedCount`) is already-downloaded
 * stock that a closing buffer cannot take away.
 */
export function kmOrderMetrics(orders: readonly KmOrderListItem[], now: number): KmOrderMetrics {
  const expiryHorizon = now + EXPIRY_HORIZON_DAYS * DAY_MS;
  const issuedSince = now - ISSUED_WINDOW_DAYS * DAY_MS;
  const metrics: KmOrderMetrics = {
    availableForIssue: 0,
    expiringSoon: 0,
    activeOrders: 0,
    issuedRecently: 0,
  };

  for (const order of orders) {
    metrics.availableForIssue += order.availableForIssue;
    if (!isTerminalKmOrderState(order.state)) metrics.activeOrders += 1;
    // Already-expired buffers stay in the count: they are the most urgent
    // case, and dropping them would make the tile fall silent exactly when
    // the codes became unusable.
    if (order.bufferExpiresAt !== null && Date.parse(order.bufferExpiresAt) <= expiryHorizon) {
      metrics.expiringSoon += order.availableCodes ?? 0;
    }
    if (Date.parse(order.createdAt) >= issuedSince) metrics.issuedRecently += order.issuedCount;
  }

  return metrics;
}

export function KmOrdersPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useKmOrders();
  const [dialogOpen, setDialogOpen] = useState(false);
  const orders = query.data;
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  const metrics = useMemo(() => kmOrderMetrics(orders ?? [], Date.now()), [orders]);
  const tiles = useMemo<MetricStripItem[]>(
    () => [
      {
        id: "available",
        label: t("pages.kmOrders.metrics.available"),
        value: number.format(metrics.availableForIssue),
      },
      {
        id: "expiring",
        label: t("pages.kmOrders.metrics.expiring"),
        value: number.format(metrics.expiringSoon),
        ...(metrics.expiringSoon > 0 ? { tone: "warning" as const } : {}),
      },
      {
        id: "active",
        label: t("pages.kmOrders.metrics.active"),
        value: number.format(metrics.activeOrders),
      },
      {
        id: "issued",
        label: t("pages.kmOrders.metrics.issued"),
        value: number.format(metrics.issuedRecently),
      },
    ],
    [metrics, number, t],
  );

  const columns = useMemo<TableColumn<KmOrderListItem>[]>(
    () => [
      {
        key: "product",
        title: t("pages.kmOrders.list.product"),
        wrap: true,
        render: (row) => <Link to={row.id}>{row.productName}</Link>,
      },
      { key: "gtin14", title: t("pages.kmOrders.list.gtin"), width: 150, mono: true },
      {
        key: "quantity",
        title: t("pages.kmOrders.list.quantity"),
        width: 110,
        align: "right",
        mono: true,
        render: (row) => number.format(row.quantity),
      },
      {
        key: "fetchedCount",
        title: t("pages.kmOrders.list.fetched"),
        width: 110,
        align: "right",
        mono: true,
        render: (row) => number.format(row.fetchedCount),
      },
      {
        key: "issuedCount",
        title: t("pages.kmOrders.list.issued"),
        width: 110,
        align: "right",
        mono: true,
        render: (row) => number.format(row.issuedCount),
      },
      {
        key: "availableForIssue",
        title: t("pages.kmOrders.list.available"),
        width: 110,
        align: "right",
        mono: true,
        render: (row) => number.format(row.availableForIssue),
      },
      {
        key: "bufferExpiresAt",
        title: t("pages.kmOrders.list.expiry"),
        width: 160,
        render: (row) =>
          row.bufferExpiresAt === null ? (
            "—"
          ) : (
            <time dateTime={row.bufferExpiresAt}>
              {formatCreatedAt(row.bufferExpiresAt, i18n.language)}
            </time>
          ),
      },
      {
        key: "state",
        title: t("pages.kmOrders.list.state"),
        width: 200,
        wrap: true,
        render: (row) => {
          // The refusal/failure reason is read, not hovered: a tooltip is
          // neither reachable by keyboard nor announced.
          const reason = row.rejectionReason ?? row.errorMessage;
          return (
            <span className="mk-km-orders__stack">
              <StatusChip
                phase={kmOrderStatePhase(row.state)}
                label={t(`pages.kmOrders.state.${row.state}`)}
              />
              {reason ? <small className="mk-km-orders__reason">{reason}</small> : null}
            </span>
          );
        },
      },
      {
        key: "createdAt",
        title: t("pages.kmOrders.list.created"),
        width: 180,
        wrap: true,
        render: (row) => (
          <span className="mk-km-orders__stack">
            <time dateTime={row.createdAt}>{formatCreatedAt(row.createdAt, i18n.language)}</time>
            <small>{row.createdBy.name}</small>
          </span>
        ),
      },
    ],
    [i18n.language, number, t],
  );

  const orderAction = canWrite ? (
    <Button type="button" onClick={() => setDialogOpen(true)}>
      {t("pages.kmOrders.createAction")}
    </Button>
  ) : null;

  return (
    <AdminPage className="mk-km-orders-page">
      <PageHeader title={t("pages.kmOrders.title")} actions={orderAction} />
      <p className="mk-km-orders-page__description">{t("pages.kmOrders.description")}</p>
      {/* Only once the rows are in hand: four zeros while the list loads (or
          after it failed) would state something about the tenant's codes that
          the page does not know. */}
      {orders === undefined ? null : (
        <MetricStrip items={tiles} label={t("pages.kmOrders.metrics.label")} />
      )}
      {query.isPending ? (
        <Spinner label={t("common.loading")} />
      ) : query.isError ? (
        <Alert tone="error" role="alert">
          {t("pages.kmOrders.loadError")}
        </Alert>
      ) : query.data.length === 0 ? (
        <EmptyState
          title={t("pages.kmOrders.emptyTitle")}
          hint={
            <>
              {t("pages.kmOrders.emptyHint")}{" "}
              <Link to="/integrations/chestny_znak">{t("pages.kmOrders.emptyLink")}</Link>
            </>
          }
          action={orderAction}
        />
      ) : (
        <Table
          className="mk-km-orders-list"
          columns={columns}
          rows={query.data}
          scrollLabel={t("pages.kmOrders.list.scrollLabel")}
        />
      )}
      {dialogOpen ? <CreateKmOrderDialog open onClose={() => setDialogOpen(false)} /> : null}
    </AdminPage>
  );
}
