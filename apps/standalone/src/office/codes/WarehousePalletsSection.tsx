import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

import { Card, EmptyState, type TableColumn } from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import type { OfficeWarehousePallet } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { instantFormat } from "./CodeCard.js";

const COUNT = new Intl.NumberFormat("ru");

/**
 * «Складские палеты» under the pallets of shifts (plan ТСД-Х, decision В-6): what handhelds built
 * outside shifts from closed boxes, and the pallets built in the office. Open ones
 * first, as the host sends them.
 */
export function WarehousePalletsSection({ zone }: { zone: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const format = instantFormat(zone);
  const list = useOfficeQuery(officeKeys.warehousePallets, (api, token) =>
    api.listWarehousePallets(token),
  );
  const columns: TableColumn<OfficeWarehousePallet>[] = [
    {
      key: "sscc",
      title: t("office.warehousePallets.table.sscc"),
      mono: true,
      render: (pallet) => (
        <Link
          to={`/codes/warehouse-pallet/${pallet.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          {pallet.sscc === null ? t("office.warehousePallets.open") : `(00)${pallet.sscc}`}
        </Link>
      ),
    },
    {
      key: "productName",
      title: t("office.warehousePallets.table.product"),
      wrap: true,
      minWidth: 120,
    },
    {
      key: "deviceName",
      title: t("office.warehousePallets.table.device"),
      wrap: true,
      minWidth: 90,
    },
    {
      key: "boxes",
      title: t("office.warehousePallets.table.boxes"),
      mono: true,
      align: "right",
      render: (pallet) => COUNT.format(pallet.boxes),
    },
    {
      key: "openedAt",
      title: t("office.warehousePallets.table.openedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) => format(pallet.openedAt),
    },
    {
      key: "closedAt",
      title: t("office.warehousePallets.table.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) =>
        pallet.closedAt === null ? t("office.common.none") : format(pallet.closedAt),
    },
  ];
  const content = () => {
    if (list.isPending) return <PageLoading />;
    if (list.isError) return <LoadError error={list.error} onRetry={() => void list.refetch()} />;
    if (list.data.pallets.length === 0)
      return <EmptyState title={t("office.warehousePallets.empty")} />;
    return (
      <Card>
        <PagedTable
          tableId="warehouse-pallets"
          columns={columns}
          rows={list.data.pallets}
          getRowKey={(pallet) => pallet.id}
          onRowClick={(pallet) => void navigate(`/codes/warehouse-pallet/${pallet.id}`)}
          scrollLabel={t("office.warehousePallets.table.label")}
        />
      </Card>
    );
  };
  return (
    <section aria-label={t("office.warehousePallets.title")} className="office-stack">
      <h2>{t("office.warehousePallets.title")}</h2>
      <p>{t("office.warehousePallets.hint")}</p>
      {content()}
    </section>
  );
}
