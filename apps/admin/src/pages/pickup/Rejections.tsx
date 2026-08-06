import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Button,
  DatePicker,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { useKiosks } from "../kiosks/api.js";
import {
  useAcknowledgeRejection,
  usePickupRejections,
  type PickupScanRejectionRowDto,
  type RejectionState,
} from "./rejections-api.js";

/**
 * «Для себя» → отклонённые сканы. The durable home for codes the server
 * refused: partial refusals (which also live on the order) and, crucially,
 * whole sessions that produced no order at all — those have nowhere else to
 * be seen. Reached from the warn banner on the свод.
 */
export function RejectionsPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [kioskId, setKioskId] = useState("all");
  const [stateFilter, setStateFilter] = useState<RejectionState>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: kiosks } = useKiosks();

  const { data, isPending, isError } = usePickupRejections({
    state: stateFilter,
    ...(kioskId !== "all" ? { kioskId } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const items = data?.items ?? [];

  const kioskOptions: SelectOption[] = [
    { value: "all", label: t("pages.pickup.rejections.filters.kioskAll") },
    ...(kiosks ?? []).map((kiosk) => ({ value: kiosk.id, label: kiosk.name })),
  ];

  const stateOptions: SelectOption<RejectionState>[] = [
    { value: "all", label: t("pages.pickup.rejections.filters.state.all") },
    { value: "open", label: t("pages.pickup.rejections.filters.state.open") },
    { value: "acknowledged", label: t("pages.pickup.rejections.filters.state.acknowledged") },
  ];

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const baseColumns: TableColumn<PickupScanRejectionRowDto>[] = [
    {
      key: "syncedAt",
      title: t("pages.pickup.rejections.table.syncedAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.syncedAt, i18n.language),
    },
    {
      key: "scannedAt",
      title: t("pages.pickup.rejections.table.scannedAt"),
      mono: true,
      render: (row) => formatCreatedAt(row.scannedAt, i18n.language),
    },
    { key: "kioskName", title: t("pages.pickup.rejections.table.kioskName") },
    {
      key: "employeeName",
      title: t("pages.pickup.rejections.table.employeeName"),
      render: (row) =>
        row.kind === "unknown_badge" ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{t("pages.pickup.rejections.unknownBadge")}</span>
            <span style={{ font: "var(--text-code)", color: "var(--fg-2)" }}>
              {t("pages.pickup.rejections.badgeCodeLabel", { code: row.badgeCode ?? "" })}
            </span>
          </div>
        ) : (
          (row.employeeName ?? "—")
        ),
    },
    {
      key: "codeCount",
      title: t("pages.pickup.rejections.table.codeCount"),
      align: "right",
      mono: true,
      render: (row) => (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          <span>{row.codes.length}</span>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => toggleExpanded(row.id)}
          >
            {expanded.has(row.id)
              ? t("pages.pickup.rejections.hideCodes")
              : t("pages.pickup.rejections.showCodes")}
          </Button>
        </div>
      ),
    },
    {
      key: "order",
      title: t("pages.pickup.rejections.table.order"),
      mono: true,
      render: (row) =>
        row.orderId ? (
          <Link to={`/pickup/${row.orderId}`} style={{ color: "inherit" }}>
            {row.orderNo}
          </Link>
        ) : (
          <span style={{ color: "var(--fg-2)" }}>{t("pages.pickup.rejections.noOrder")}</span>
        ),
    },
    {
      key: "state",
      title: t("pages.pickup.rejections.table.state"),
      render: (row) => (
        <StatusChip
          status={row.acknowledgedAt ? "ok" : "warn"}
          label={
            row.acknowledgedAt
              ? t("pages.pickup.rejections.state.acknowledged")
              : t("pages.pickup.rejections.state.open")
          }
        />
      ),
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.pickup.rejections.title")}
        actions={
          <Link to="/pickup" style={{ color: "inherit" }}>
            {t("pages.pickup.rejections.backAction")}
          </Link>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.rejections.filters.kioskLabel")}
            options={kioskOptions}
            value={kioskId}
            onValueChange={setKioskId}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pickup.rejections.filters.stateLabel")}
            options={stateOptions}
            value={stateFilter}
            onValueChange={setStateFilter}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.pickup.rejections.filters.fromLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(fromDate ? { value: fromDate } : {})}
            onValueChange={(value) => setFromDate(value ?? "")}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.pickup.rejections.filters.toLabel")}
            placeholder={t("common.datePicker.placeholder")}
            clearLabel={t("common.datePicker.clear")}
            calendarLabel={t("common.datePicker.calendar")}
            previousMonthLabel={t("common.datePicker.previousMonth")}
            nextMonthLabel={t("common.datePicker.nextMonth")}
            locale={i18n.language}
            {...(toDate ? { value: toDate } : {})}
            onValueChange={(value) => setToDate(value ?? "")}
          />
        </div>
      </div>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.pickup.rejections.emptyTitle")}
          hint={t("pages.pickup.rejections.emptyHint")}
        />
      ) : (
        <>
          {canWrite ? (
            <AuthorizedRejectionsTable baseColumns={baseColumns} rows={items} />
          ) : (
            <RejectionsTable baseColumns={baseColumns} rows={items} />
          )}
          {items
            .filter((row) => expanded.has(row.id))
            .map((row) => (
              <Alert
                key={row.id}
                tone="warn"
                title={`${row.kioskName} · ${row.employeeName ?? row.badgeCode} · ${t("pages.pickup.conflicts.title", { count: row.codes.length })}`}
              >
                <ul style={{ margin: 0, paddingInlineStart: "var(--sp-5)" }}>
                  {row.codes.map((code, index) => (
                    <li key={`${code.rawKm}:${index}`} style={{ font: "var(--text-code)" }}>
                      {code.rawKm} — {t(`pages.pickup.conflicts.reason.${code.reason}`)}
                    </li>
                  ))}
                </ul>
              </Alert>
            ))}
        </>
      )}
    </div>
  );
}

interface RejectionsTableProps {
  baseColumns: TableColumn<PickupScanRejectionRowDto>[];
  rows: PickupScanRejectionRowDto[];
  onAcknowledge?: (id: string) => Promise<void>;
  pendingAcknowledgementId?: string;
}

function RejectionsTable({
  baseColumns,
  rows,
  onAcknowledge,
  pendingAcknowledgementId,
}: RejectionsTableProps) {
  const { t } = useTranslation();

  const columns: TableColumn<PickupScanRejectionRowDto>[] = [
    ...baseColumns,
    {
      key: "actions",
      title: t("pages.pickup.rejections.table.actions"),
      render: (row) =>
        row.acknowledgedAt || !onAcknowledge ? null : (
          <Button
            type="button"
            size="compact"
            disabled={pendingAcknowledgementId !== undefined}
            loading={pendingAcknowledgementId === row.id}
            onClick={() => void onAcknowledge(row.id)}
          >
            {t("pages.pickup.rejections.acknowledgeAction")}
          </Button>
        ),
    },
  ];

  return <Table columns={columns} rows={rows} />;
}

function AuthorizedRejectionsTable({
  baseColumns,
  rows,
}: Pick<RejectionsTableProps, "baseColumns" | "rows">) {
  const { t } = useTranslation();
  const acknowledge = useAcknowledgeRejection();

  const handleAcknowledge = async (id: string) => {
    try {
      await acknowledge.mutateAsync(id);
      toast("ok", t("pages.pickup.rejections.toasts.acknowledged"));
    } catch {
      toast("error", t("pages.pickup.rejections.toasts.acknowledgeError"));
    }
  };

  return (
    <RejectionsTable
      baseColumns={baseColumns}
      rows={rows}
      onAcknowledge={handleAcknowledge}
      {...(acknowledge.isPending ? { pendingAcknowledgementId: acknowledge.variables } : {})}
    />
  );
}
