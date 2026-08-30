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
import type { TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import { useInventories } from "./api.js";
import type { Inventory } from "./schemas.js";
import { inventoryStatusChipProps } from "./status.js";
import "./inventory.css";

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
        width: 160,
        mono: true,
        render: (row) => <Link to={row.id}>{row.number}</Link>,
      },
      {
        key: "status",
        title: t("pages.inventory.list.status"),
        width: 190,
        render: (row) => (
          <StatusChip
            {...inventoryStatusChipProps(row.status)}
            label={t(`pages.inventory.status.${row.status}`)}
          />
        ),
      },
      {
        key: "product",
        title: t("pages.inventory.list.productDates"),
        wrap: true,
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
        wrap: true,
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
        width: 180,
        render: (row) => (
          <time dateTime={row.updatedAt}>{formatCreatedAt(row.updatedAt, i18n.language)}</time>
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
        <Table className="mk-inventory-list" columns={columns} rows={query.data} />
      )}
    </AdminPage>
  );
}
