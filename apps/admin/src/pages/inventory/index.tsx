import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AdminPage,
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { formatDate } from "../../lib/datetime.js";
import { useInventories } from "./api.js";
import type { Inventory } from "./schemas.js";
import "./inventory.css";

const STATUS_TONE: Record<Inventory["status"], StatusChipStatus> = {
  draft: "neutral",
  preparing: "warn",
  ready: "info",
  running: "ok",
  closed: "info",
  completed: "neutral",
};

export function InventoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useInventories();
  const columns = useMemo<TableColumn<Inventory>[]>(
    () => [
      {
        key: "number",
        title: t("pages.inventory.list.number"),
        mono: true,
        render: (row) => (
          <div className="mk-inventory-list__identity">
            <Link to={row.id}>{row.number}</Link>
            <StatusChip
              status={STATUS_TONE[row.status]}
              label={t(`pages.inventory.status.${row.status}`)}
            />
          </div>
        ),
      },
      {
        key: "product",
        title: t("pages.inventory.list.productDates"),
        render: (row) => (
          <span className="mk-inventory-list__stack">
            <strong>{row.productName}</strong>
            <small>
              {formatDate(row.productionDateFrom, i18n.language)} —{" "}
              {formatDate(row.productionDateTo, i18n.language)}
            </small>
          </span>
        ),
      },
      {
        key: "line",
        title: t("pages.inventory.list.lineMode"),
        render: (row) => (
          <span className="mk-inventory-list__stack">
            <strong>{row.lineName}</strong>
            <small>{t(`pages.inventory.mode.${row.mode}`)}</small>
          </span>
        ),
      },
      {
        key: "updatedAt",
        title: t("pages.inventory.list.updated"),
        render: (row) => (
          <time dateTime={row.updatedAt}>{formatDate(row.updatedAt, i18n.language)}</time>
        ),
      },
    ],
    [i18n.language, t],
  );

  return (
    <AdminPage className="mk-inventory-page">
      <PageHeader
        title={t("pages.inventory.title")}
        actions={
          canWrite ? (
            <Button type="button" onClick={() => void navigate("new")}>
              {t("pages.inventory.createAction")}
            </Button>
          ) : null
        }
      />
      <p className="mk-inventory-page__description">{t("pages.inventory.description")}</p>
      {query.isPending ? (
        <Spinner label={t("common.loading")} />
      ) : query.isError ? (
        <Alert tone="error" role="alert">
          {t("pages.inventory.loadError")}
        </Alert>
      ) : query.data.length === 0 ? (
        <EmptyState
          title={t("pages.inventory.emptyTitle")}
          hint={t("pages.inventory.emptyHint")}
          action={
            canWrite ? (
              <Button type="button" onClick={() => void navigate("new")}>
                {t("pages.inventory.createAction")}
              </Button>
            ) : null
          }
        />
      ) : (
        <Table columns={columns} rows={query.data} />
      )}
    </AdminPage>
  );
}
