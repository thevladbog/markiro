import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { toast } from "../../lib/toast.js";
import {
  useExportCodes,
  usePickupOrders,
  type PickupOrderReason,
  type PickupOrderRowDto,
  type PickupOrderStatus,
} from "./api.js";

type StatusFilter = "all" | PickupOrderStatus;
type ReasonFilter = "all" | PickupOrderReason;

const STATUS_TO_CHIP: Record<PickupOrderStatus, StatusChipStatus> = {
  pending: "warn",
  punched: "ok",
  writtenoff: "neutral",
  cancelled: "error",
};

/**
 * Formats an ISO timestamp for the `createdAt` column using the active
 * i18next language -- "ru"/"en" are the only two languages the app ships
 * (see `src/i18n/index.ts`), so this maps each to its matching
 * `Intl.DateTimeFormat` locale rather than passing `i18n.language` straight
 * through (which for "ru" is a valid BCP-47 tag anyway, but being explicit
 * keeps this independent of exactly how i18next's `lng` is spelled).
 */
function formatCreatedAt(iso: string, language: string): string {
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/**
 * Admin «Для себя» (self-pickup) orders list -- Plan A Task 14. Filterable
 * summary table of every self-pickup order (status/reason/date-range),
 * mirroring `pages/catalog/index.tsx`'s list pattern, plus a bulk-export
 * mode that reveals a per-row selection checkbox and posts the checked
 * order ids to `POST /pickup-orders/export` (Task 4/9's `useExportCodes`).
 * Row `orderNo` links to `/pickup/:id`, the order-detail route Task 15 adds.
 */
export function PickupPage() {
  const { t, i18n } = useTranslation();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isPending, isError } = usePickupOrders({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(reasonFilter !== "all" ? { reason: reasonFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const exportMutation = useExportCodes();

  const items = data ?? [];

  const statusOptions: SelectOption[] = [
    { value: "all", label: t("pages.pickup.filters.status.all") },
    { value: "pending", label: t("pages.pickup.filters.status.pending") },
    { value: "punched", label: t("pages.pickup.filters.status.punched") },
    { value: "writtenoff", label: t("pages.pickup.filters.status.writtenoff") },
    { value: "cancelled", label: t("pages.pickup.filters.status.cancelled") },
  ];

  const reasonOptions: SelectOption[] = [
    { value: "all", label: t("pages.pickup.filters.reason.all") },
    { value: "buy", label: t("pages.pickup.filters.reason.buy") },
    { value: "writeoff", label: t("pages.pickup.filters.reason.writeoff") },
  ];

  const handleToggleBulkMode = () => {
    setBulkMode((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExport = async () => {
    try {
      await exportMutation.mutateAsync([...selectedIds]);
      toast("ok", t("pages.pickup.toasts.exportSuccess"));
      setSelectedIds(new Set());
    } catch {
      toast("error", t("pages.pickup.toasts.exportError"));
    }
  };

  const baseColumns: TableColumn<PickupOrderRowDto>[] = [
    {
      key: "orderNo",
      title: t("pages.pickup.table.orderNo"),
      mono: true,
      render: (row) => (
        <Link to={`/pickup/${row.id}`} style={{ color: "inherit", textDecoration: "none" }}>
          {row.orderNo}
        </Link>
      ),
    },
    { key: "employeeName", title: t("pages.pickup.table.employeeName") },
    { key: "kioskName", title: t("pages.pickup.table.kioskName") },
    {
      key: "createdAt",
      title: t("pages.pickup.table.createdAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.createdAt, i18n.language),
    },
    {
      key: "reason",
      title: t("pages.pickup.table.reason"),
      render: (row) => (
        <span>
          {t(`pages.pickup.reason.${row.reason}`)}
          {row.writeoffReasonName ? ` · ${row.writeoffReasonName}` : ""}
        </span>
      ),
    },
    {
      key: "itemCount",
      title: t("pages.pickup.table.itemCount"),
      align: "right",
      mono: true,
    },
    {
      key: "totalPrice",
      title: t("pages.pickup.table.totalPrice"),
      align: "right",
      mono: true,
      render: (row) => row.totalPrice ?? "—",
    },
    {
      key: "status",
      title: t("pages.pickup.table.status"),
      render: (row) => (
        <StatusChip
          status={STATUS_TO_CHIP[row.status]}
          label={t(`pages.pickup.status.${row.status}`)}
        />
      ),
    },
  ];

  const columns: TableColumn<PickupOrderRowDto>[] = bulkMode
    ? [
        {
          key: "select",
          title: "",
          width: 32,
          render: (row) => (
            <input
              type="checkbox"
              aria-label={t("pages.pickup.bulkExport.selectRow", { orderNo: row.orderNo })}
              checked={selectedIds.has(row.id)}
              onChange={() => toggleSelected(row.id)}
            />
          ),
        },
        ...baseColumns,
      ]
    : baseColumns;

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.pickup.title")}
        actions={
          <Button
            type="button"
            variant={bulkMode ? "secondary" : "primary"}
            onClick={handleToggleBulkMode}
          >
            {bulkMode ? t("pages.pickup.cancel") : t("pages.pickup.bulkExport.toggleAction")}
          </Button>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.filters.statusLabel")}
            options={statusOptions}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.filters.reasonLabel")}
            options={reasonOptions}
            value={reasonFilter}
            onChange={(value) => setReasonFilter(value as ReasonFilter)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.pickup.filters.fromLabel")}
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.pickup.filters.toLabel")}
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </div>
      </div>

      {bulkMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.pickup.bulkExport.selectedCount", { count: selectedIds.size })}
          </span>
          <Button
            type="button"
            size="compact"
            disabled={selectedIds.size === 0}
            loading={exportMutation.isPending}
            onClick={() => void handleExport()}
          >
            {t("pages.pickup.bulkExport.exportAction")}
          </Button>
        </div>
      )}

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("pages.pickup.emptyTitle")} hint={t("pages.pickup.emptyHint")} />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}
