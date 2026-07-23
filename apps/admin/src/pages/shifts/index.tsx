import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusChip,
  Table,
  toast,
} from "@markiro/ui";
import type { BadgeTone, SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useProducts } from "../catalog/api.js";
import { useCounterparties } from "../counterparties/api.js";
import { ShiftForm, type ShiftFormValues } from "./ShiftForm.js";
import {
  useCloseShift,
  useCreateShift,
  useDeleteShift,
  useLines,
  useShifts,
  useUpdateShift,
  type CreateShiftInput,
  type ShiftDto,
  type ShiftStatus,
  type UpdateShiftInput,
} from "./api.js";

type FormModalState = { mode: "create" } | { mode: "edit"; shift: ShiftDto } | null;
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

/** Admin shift-planning screen -- Plan 03 Task 13 (list/create/edit/delete/close). */
export function ShiftsPage() {
  const { t } = useTranslation();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data } = useShifts({
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  });
  const { data: productsData } = useProducts();
  const { data: linesData } = useLines();
  const { data: counterpartiesData } = useCounterparties();

  const createMutation = useCreateShift();
  const updateMutation = useUpdateShift();
  const deleteMutation = useDeleteShift();
  const closeMutation = useCloseShift();

  const [formState, setFormState] = useState<FormModalState>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShiftDto | null>(null);
  const [closeTarget, setCloseTarget] = useState<ShiftDto | null>(null);
  const [closeReason, setCloseReason] = useState("");

  const items = data ?? [];
  const products = productsData ?? [];
  const lines = linesData ?? [];
  const counterparties = counterpartiesData ?? [];

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
          </div>
        ),
      },
      {
        key: "actions",
        title: t("pages.shifts.table.actions"),
        align: "right",
        render: (row) => (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {row.status === "planned" && (
              <>
                <Button
                  type="button"
                  size="compact"
                  variant="secondary"
                  onClick={() => setFormState({ mode: "edit", shift: row })}
                >
                  {t("pages.shifts.edit")}
                </Button>
                <Button
                  type="button"
                  size="compact"
                  variant="destructive"
                  onClick={() => setDeleteTarget(row)}
                >
                  {t("pages.shifts.delete")}
                </Button>
              </>
            )}
            {row.status === "active" && (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => {
                  setCloseReason("");
                  setCloseTarget(row);
                }}
              >
                {t("pages.shifts.close")}
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t],
  );

  const editingShift = formState?.mode === "edit" ? formState.shift : undefined;
  const initialValues: ShiftFormValues | undefined = editingShift
    ? {
        productId: editingShift.productId,
        mode: editingShift.mode,
        plannedQty: editingShift.plannedQty !== null ? String(editingShift.plannedQty) : "",
        plannedDate: editingShift.plannedDate ?? "",
        lineId: editingShift.lineId ?? "",
        counterpartyId: editingShift.counterpartyId ?? "",
        boxCapacity: editingShift.boxCapacity !== null ? String(editingShift.boxCapacity) : "",
        palletCapacity:
          editingShift.palletCapacity !== null ? String(editingShift.palletCapacity) : "",
        palletsEnabled: editingShift.palletsEnabled,
      }
    : undefined;

  const handleSubmit = async (input: CreateShiftInput | UpdateShiftInput) => {
    const isEdit = formState?.mode === "edit";
    try {
      if (formState?.mode === "edit") {
        await updateMutation.mutateAsync({ id: formState.shift.id, input });
        toast("ok", t("pages.shifts.toasts.updateSuccess"));
      } else {
        await createMutation.mutateAsync(input as CreateShiftInput);
        toast("ok", t("pages.shifts.toasts.createSuccess"));
      }
      setFormState(null);
    } catch (error) {
      const fallback = isEdit
        ? t("pages.shifts.toasts.updateError")
        : t("pages.shifts.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast("ok", t("pages.shifts.toasts.deleteSuccess"));
      setDeleteTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.deleteError"),
      );
    }
  };

  const handleCloseShift = async () => {
    if (!closeTarget) return;
    try {
      await closeMutation.mutateAsync({ id: closeTarget.id, reason: closeReason.trim() });
      toast("ok", t("pages.shifts.toasts.closeSuccess"));
      setCloseTarget(null);
      setCloseReason("");
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.shifts.toasts.closeError"),
      );
    }
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.shifts.title")}
        actions={
          <Button type="button" onClick={() => setFormState({ mode: "create" })}>
            {t("pages.shifts.addAction")}
          </Button>
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

      {items.length === 0 ? (
        <EmptyState
          title={t("pages.shifts.emptyTitle")}
          hint={t("pages.shifts.emptyHint")}
          action={
            <Button type="button" onClick={() => setFormState({ mode: "create" })}>
              {t("pages.shifts.addAction")}
            </Button>
          }
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}

      <ShiftForm
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        {...(initialValues ? { initialValues } : {})}
        products={products}
        lines={lines}
        counterparties={counterparties}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
        onClose={() => setFormState(null)}
      />

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("pages.shifts.deleteConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
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
        {deleteTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.shifts.deleteConfirmBody", { name: deleteTarget.productName ?? "" })}
          </p>
        )}
      </Modal>

      <Modal
        open={closeTarget !== null}
        onClose={() => setCloseTarget(null)}
        title={t("pages.shifts.closeModal.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setCloseTarget(null)}>
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
    </div>
  );
}
