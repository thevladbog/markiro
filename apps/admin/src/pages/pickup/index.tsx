import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DatePicker,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import {
  useExportCodes,
  usePickupOrders,
  type PickupOrderReason,
  type PickupOrderRowDto,
  type PickupOrderStatus,
} from "./api.js";
import { useOpenRejectionSummary } from "./rejections-api.js";

type StatusFilter = "all" | PickupOrderStatus;
type ReasonFilter = "all" | PickupOrderReason;

const STATUS_TO_CHIP: Record<PickupOrderStatus, StatusChipStatus> = {
  pending: "warn",
  punched: "ok",
  writtenoff: "neutral",
  cancelled: "error",
};

const VISUALLY_HIDDEN_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

interface PickupPageContentProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (value: StatusFilter) => void;
  reasonFilter: ReasonFilter;
  onReasonFilterChange: (value: ReasonFilter) => void;
  fromDate: string;
  onFromDateChange: (value: string) => void;
  toDate: string;
  onToDateChange: (value: string) => void;
  items: PickupOrderRowDto[];
  isPending: boolean;
  isError: boolean;
  rejections: { openCount: number; kioskNames: string[] };
}

interface PickupWriteControls {
  bulkMode: boolean;
  selectedIds: Set<string>;
  exporting: boolean;
  onToggleBulkMode: () => void;
  onToggleSelected: (id: string) => void;
  onExport: () => void;
}

function AuthorizedPickupContent(props: PickupPageContentProps) {
  const { t } = useTranslation();
  const exportMutation = useExportCodes();
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  return (
    <PickupPageContent
      {...props}
      write={{
        bulkMode,
        selectedIds,
        exporting: exportMutation.isPending,
        onToggleBulkMode: handleToggleBulkMode,
        onToggleSelected: toggleSelected,
        onExport: () => void handleExport(),
      }}
    />
  );
}

function PickupPageContent({
  statusFilter,
  onStatusFilterChange,
  reasonFilter,
  onReasonFilterChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  items,
  isPending,
  isError,
  rejections,
  write,
}: PickupPageContentProps & { write?: PickupWriteControls }) {
  const { t, i18n } = useTranslation();
  const shownKiosks = rejections.kioskNames.slice(0, 3);
  const hiddenKioskCount = rejections.kioskNames.length - shownKiosks.length;

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
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <StatusChip
            status={STATUS_TO_CHIP[row.status]}
            label={t(`pages.pickup.status.${row.status}`)}
          />
          {row.conflictCount > 0 && (
            <Badge tone="warn">
              {t("pages.pickup.conflicts.badge", { count: row.conflictCount })}
            </Badge>
          )}
        </div>
      ),
    },
  ];

  const columns: TableColumn<PickupOrderRowDto>[] =
    write?.bulkMode === true
      ? [
          {
            key: "select",
            title: "",
            width: 32,
            render: (row) => (
              <Checkbox
                label={
                  <span style={VISUALLY_HIDDEN_STYLE}>
                    {t("pages.pickup.bulkExport.selectRow", { orderNo: row.orderNo })}
                  </span>
                }
                aria-label={t("pages.pickup.bulkExport.selectRow", { orderNo: row.orderNo })}
                checked={write.selectedIds.has(row.id)}
                onCheckedChange={() => write.onToggleSelected(row.id)}
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
          write ? (
            <Button
              type="button"
              variant={write.bulkMode ? "secondary" : "primary"}
              onClick={write.onToggleBulkMode}
            >
              {write.bulkMode
                ? t("pages.pickup.cancel")
                : t("pages.pickup.bulkExport.toggleAction")}
            </Button>
          ) : null
        }
      />

      {rejections.openCount > 0 && (
        <Alert
          tone="warn"
          title={t("pages.pickup.rejections.bannerTitle", { count: rejections.openCount })}
          action={
            <Link to="/pickup/rejections" style={{ color: "inherit" }}>
              {t("pages.pickup.rejections.bannerAction")}
            </Link>
          }
        >
          {shownKiosks.length > 0 &&
            t("pages.pickup.rejections.bannerKiosks", { kiosks: shownKiosks.join(", ") })}
          {hiddenKioskCount > 0 &&
            ` ${t("pages.pickup.rejections.bannerMore", { count: hiddenKioskCount })}`}
        </Alert>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.filters.statusLabel")}
            options={statusOptions}
            value={statusFilter}
            onValueChange={(value) => onStatusFilterChange(value as StatusFilter)}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.filters.reasonLabel")}
            options={reasonOptions}
            value={reasonFilter}
            onValueChange={(value) => onReasonFilterChange(value as ReasonFilter)}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.pickup.filters.fromLabel")}
            {...(fromDate ? { value: fromDate } : {})}
            onValueChange={(value) => onFromDateChange(value ?? "")}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.pickup.filters.toLabel")}
            {...(toDate ? { value: toDate } : {})}
            onValueChange={(value) => onToDateChange(value ?? "")}
          />
        </div>
      </div>

      {write?.bulkMode === true ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.pickup.bulkExport.selectedCount", { count: write.selectedIds.size })}
          </span>
          <Button
            type="button"
            size="compact"
            disabled={write.selectedIds.size === 0}
            loading={write.exporting}
            onClick={write.onExport}
          >
            {t("pages.pickup.bulkExport.exportAction")}
          </Button>
        </div>
      ) : null}

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

/**
 * Admin «Для себя» (self-pickup) orders list -- Plan A Task 14. Filterable
 * summary table of every self-pickup order (status/reason/date-range),
 * mirroring `pages/catalog/index.tsx`'s list pattern, plus a bulk-export
 * mode that reveals a per-row selection checkbox and posts the checked
 * order ids to `POST /pickup-orders/export` (Task 4/9's `useExportCodes`).
 * Row `orderNo` links to `/pickup/:id`, the order-detail route Task 15 adds.
 */
export function PickupPage() {
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data, isPending, isError } = usePickupOrders({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(reasonFilter !== "all" ? { reason: reasonFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const rejections = useOpenRejectionSummary();
  const props: PickupPageContentProps = {
    statusFilter,
    onStatusFilterChange: setStatusFilter,
    reasonFilter,
    onReasonFilterChange: setReasonFilter,
    fromDate,
    onFromDateChange: setFromDate,
    toDate,
    onToDateChange: setToDate,
    items: data ?? [],
    isPending,
    isError,
    rejections,
  };

  return canWrite ? <AuthorizedPickupContent {...props} /> : <PickupPageContent {...props} />;
}
