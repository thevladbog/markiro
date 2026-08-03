import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { BadgeTone, SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useProducts, type ProductDto } from "../catalog/api.js";
import { useCounterparties, type CounterpartyDto } from "../counterparties/api.js";
import { useLabelTemplates, type LabelTemplateSummaryDto } from "../labels/api.js";
import { ShiftForm, type ShiftFormValues } from "./ShiftForm.js";
import {
  useCloseShift,
  useCreateShift,
  useDeleteShift,
  useLines,
  useShifts,
  useUpdateShift,
  type CreateShiftInput,
  type LineDto,
  type ShiftDto,
  type ShiftStatus,
  type UpdateShiftInput,
} from "./api.js";

type StatusFilter = "all" | ShiftStatus;

const STATUS_TO_CHIP: Record<ShiftStatus, StatusChipStatus> = {
  planned: "info",
  active: "ok",
  closed: "neutral",
};

const MODE_TO_BADGE_TONE: Record<ShiftDto["mode"], BadgeTone> = {
  validation: "neutral",
  aggregation: "accent",
};

interface ShiftFormOptions {
  products: ProductDto[];
  lines: LineDto[];
  counterparties: CounterpartyDto[];
  labelTemplates: LabelTemplateSummaryDto[];
}

function AuthorizedCreateShiftAction(props: ShiftFormOptions) {
  const { t } = useTranslation();
  const createMutation = useCreateShift();
  const [open, setOpen] = useState(false);

  const handleSubmit = async (input: CreateShiftInput | UpdateShiftInput) => {
    try {
      await createMutation.mutateAsync(input as CreateShiftInput);
      toast("ok", t("pages.shifts.toasts.createSuccess"));
      setOpen(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.createError"),
      );
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t("pages.shifts.addAction")}
      </Button>
      {open ? (
        <ShiftForm
          open
          mode="create"
          {...props}
          submitting={createMutation.isPending}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AuthorizedPlannedShiftActions({
  shift,
  ...options
}: ShiftFormOptions & { shift: ShiftDto }) {
  const { t } = useTranslation();
  const updateMutation = useUpdateShift();
  const deleteMutation = useDeleteShift();
  const [editingShift, setEditingShift] = useState<ShiftDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const initialValues: ShiftFormValues | undefined = editingShift
    ? {
        productId: editingShift.productId,
        mode: editingShift.mode,
        plannedQty: editingShift.plannedQty !== null ? String(editingShift.plannedQty) : "",
        plannedDate: editingShift.plannedDate ?? "",
        lineId: editingShift.lineId ?? "",
        counterpartyId: editingShift.counterpartyId ?? "",
        labelTemplateId: editingShift.labelTemplateId ?? "",
        ssccIssuerCounterpartyId: editingShift.ssccIssuerCounterpartyId ?? "",
        boxLabelTemplateId: editingShift.boxLabelTemplateId ?? "",
        boxCapacity: editingShift.boxCapacity !== null ? String(editingShift.boxCapacity) : "",
        palletCapacity:
          editingShift.palletCapacity !== null ? String(editingShift.palletCapacity) : "",
        palletsEnabled: editingShift.palletsEnabled,
      }
    : undefined;

  const handleUpdate = async (input: CreateShiftInput | UpdateShiftInput) => {
    if (!editingShift) return;
    try {
      await updateMutation.mutateAsync({ id: editingShift.id, input });
      toast("ok", t("pages.shifts.toasts.updateSuccess"));
      setEditingShift(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.updateError"),
      );
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(shift.id);
      toast("ok", t("pages.shifts.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.deleteError"),
      );
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() => setEditingShift(shift)}
        >
          {t("pages.shifts.edit")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => setDeleting(true)}
        >
          {t("pages.shifts.delete")}
        </Button>
      </div>
      {editingShift && initialValues ? (
        <ShiftForm
          open
          mode="edit"
          initialValues={initialValues}
          {...options}
          submitting={updateMutation.isPending}
          onSubmit={handleUpdate}
          onClose={() => setEditingShift(null)}
        />
      ) : null}
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        closeLabel={t("common.close")}
        title={t("pages.shifts.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>
              {t("pages.shifts.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => void handleDelete()}
            >
              {t("pages.shifts.deleteConfirmAction")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.shifts.deleteConfirmBody", { name: shift.productName ?? "" })}
        </p>
      </Modal>
    </>
  );
}

function AuthorizedCloseShiftAction({ shift }: { shift: ShiftDto }) {
  const { t } = useTranslation();
  const closeMutation = useCloseShift();
  const [open, setOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");

  const handleCloseShift = async () => {
    try {
      await closeMutation.mutateAsync({ id: shift.id, reason: closeReason.trim() });
      toast("ok", t("pages.shifts.toasts.closeSuccess"));
      setOpen(false);
      setCloseReason("");
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.closeError"),
      );
    }
  };

  return (
    <>
      <Button type="button" size="compact" variant="secondary" onClick={() => setOpen(true)}>
        {t("pages.shifts.close")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        closeLabel={t("common.close")}
        title={t("pages.shifts.closeModal.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("pages.shifts.closeModal.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={closeMutation.isPending}
              disabled={closeReason.trim().length < 3}
              onClick={() => void handleCloseShift()}
            >
              {t("pages.shifts.closeModal.submit")}
            </Button>
          </>
        }
      >
        <Input
          label={t("pages.shifts.closeModal.reasonLabel")}
          value={closeReason}
          onChange={(event) => setCloseReason(event.target.value)}
        />
      </Modal>
    </>
  );
}

/** Admin shift-planning screen -- Plan 03 Task 13 (list/create/edit/delete/close). */
export function ShiftsPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data, isPending, isError } = useShifts({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const { data: productsData } = useProducts();
  const { data: linesData } = useLines();
  const { data: counterpartiesData } = useCounterparties();
  const { data: labelTemplatesData } = useLabelTemplates();

  const items = data ?? [];
  const products = useMemo(() => productsData ?? [], [productsData]);
  const lines = useMemo(() => linesData ?? [], [linesData]);
  const counterparties = useMemo(() => counterpartiesData ?? [], [counterpartiesData]);
  const labelTemplates = useMemo(() => labelTemplatesData ?? [], [labelTemplatesData]);

  const statusFilterOptions: SelectOption[] = [
    { value: "all", label: t("pages.shifts.filters.status.all") },
    { value: "planned", label: t("pages.shifts.filters.status.planned") },
    { value: "active", label: t("pages.shifts.filters.status.active") },
    { value: "closed", label: t("pages.shifts.filters.status.closed") },
  ];

  const columns: TableColumn<ShiftDto>[] = useMemo(
    () => [
      {
        key: "plannedDate",
        title: t("pages.shifts.table.plannedDate"),
        render: (row) => row.plannedDate ?? "—",
      },
      {
        key: "productName",
        title: t("pages.shifts.table.product"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.productName ?? "—"}</span>
            {row.counterpartyName && (
              <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                {t("pages.shifts.forCounterparty", { name: row.counterpartyName })}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "lineName",
        title: t("pages.shifts.table.line"),
        render: (row) => row.lineName ?? "—",
      },
      {
        key: "mode",
        title: t("pages.shifts.table.mode"),
        render: (row) => (
          <Badge tone={MODE_TO_BADGE_TONE[row.mode]}>{t(`pages.shifts.mode.${row.mode}`)}</Badge>
        ),
      },
      {
        key: "plannedQty",
        title: t("pages.shifts.table.plannedQty"),
        align: "right",
        mono: true,
        render: (row) => row.plannedQty ?? "—",
      },
      {
        key: "status",
        title: t("pages.shifts.table.status"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <StatusChip
              status={STATUS_TO_CHIP[row.status]}
              label={t(`pages.shifts.status.${row.status}`)}
              {...(row.status === "closed" && row.closeReason ? { title: row.closeReason } : {})}
            />
            {row.status === "closed" && row.closeReason && (
              <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                {row.closeReason}
              </span>
            )}
            {row.lateDataAt && <Badge tone="warn">{t("pages.shifts.table.lateData")}</Badge>}
          </div>
        ),
      },
      {
        key: "actions",
        title: t("pages.shifts.table.actions"),
        align: "right",
        render: (row) =>
          canWrite ? (
            row.status === "planned" ? (
              <AuthorizedPlannedShiftActions
                shift={row}
                products={products}
                lines={lines}
                counterparties={counterparties}
                labelTemplates={labelTemplates}
              />
            ) : row.status === "active" ? (
              <AuthorizedCloseShiftAction shift={row} />
            ) : null
          ) : null,
      },
    ],
    [t, canWrite, products, lines, counterparties, labelTemplates],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.shifts.title")}
        actions={
          canWrite ? (
            <AuthorizedCreateShiftAction
              products={products}
              lines={lines}
              counterparties={counterparties}
              labelTemplates={labelTemplates}
            />
          ) : null
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.shifts.filters.statusLabel")}
            options={statusFilterOptions}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.shifts.filters.fromLabel")}
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Input
            label={t("pages.shifts.filters.toLabel")}
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
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
          title={t("pages.shifts.emptyTitle")}
          hint={t("pages.shifts.emptyHint")}
          action={
            canWrite ? (
              <AuthorizedCreateShiftAction
                products={products}
                lines={lines}
                counterparties={counterparties}
                labelTemplates={labelTemplates}
              />
            ) : null
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </div>
  );
}
