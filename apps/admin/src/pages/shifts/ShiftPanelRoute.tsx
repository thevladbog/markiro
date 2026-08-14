import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import type { ProductDto } from "../catalog/api.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import type { LabelTemplateSummaryDto } from "../labels/api.js";
import {
  useCreateShift,
  useUpdateShift,
  type CreateShiftInput,
  type LineDto,
  type ShiftDto,
  type UpdateShiftInput,
} from "./api.js";
import { ShiftForm, type ShiftFormValues } from "./ShiftForm.js";
import { localCalendarDate } from "./date.js";

export interface ShiftsPanelContext {
  shifts: ShiftDto[];
  products: ProductDto[];
  lines: LineDto[];
  counterparties: CounterpartyDto[];
  labelTemplates: LabelTemplateSummaryDto[];
  panelPending: boolean;
  panelError: boolean;
  retryPanelData: () => Promise<void>;
}

export type ShiftsPanelLocationState = { shiftsBackground: true };

export function closeShiftPanel(
  location: ReturnType<typeof useLocation>,
  navigate: ReturnType<typeof useNavigate>,
) {
  if ((location.state as ShiftsPanelLocationState | null)?.shiftsBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/shifts", { replace: true });
  }
}

export function ShiftPanelRoute({ mode }: { mode: "create" | "edit" }) {
  return mode === "create" ? <CreateShiftPanel /> : <EditShiftPanel />;
}

function usePanelContext() {
  const context = useOutletContext<ShiftsPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeShiftPanel(location, navigate), [location, navigate]);
  return { context, close };
}

function PanelState({ mode }: { mode: "create" | "edit" }) {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const title =
    mode === "create" ? t("pages.shifts.form.createTitle") : t("pages.shifts.form.editTitle");
  return (
    <SidePanel open size="complex" title={title} closeLabel={t("common.close")} onClose={close}>
      {context.panelPending ? (
        <div className="mk-shift-panel-skeleton">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <div className="mk-shift-panel-state">
          <Alert tone="error">{t("pages.shifts.form.loadError")}</Alert>
          <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
            {t("pages.shifts.form.retry")}
          </Button>
        </div>
      )}
    </SidePanel>
  );
}

function DiscardDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return open ? (
    <ConfirmDialog
      open
      title={t("pages.shifts.form.discardTitle")}
      description={t("pages.shifts.form.discardBody")}
      cancelLabel={t("pages.shifts.form.continueEditing")}
      confirmLabel={t("pages.shifts.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  ) : null;
}

function CreateShiftPanel() {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateShift();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  if (context.panelPending || context.panelError) return <PanelState mode="create" />;
  return (
    <>
      <ShiftForm
        mode="create"
        products={context.products}
        lines={context.lines}
        counterparties={context.counterparties}
        labelTemplates={context.labelTemplates}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input) => {
          try {
            setError(null);
            await mutation.mutateAsync(input as CreateShiftInput);
            toast("ok", t("pages.shifts.toasts.createSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : t("pages.shifts.toasts.createError"),
            );
          }
        }}
      />
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}

function EditShiftPanel() {
  const { shiftId } = useParams();
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useUpdateShift();
  const [error, setError] = useState<string | null>(null);
  const [criticalInput, setCriticalInput] = useState<UpdateShiftInput | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  const shift = context.shifts.find((item) => item.id === shiftId);
  const initialValues = useMemo<ShiftFormValues | undefined>(
    () =>
      shift
        ? {
            productId: shift.productId,
            mode: shift.mode,
            plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
            plannedDate: shift.plannedDate ?? localCalendarDate(shift.openedAt) ?? "",
            lineId: shift.lineId ?? "",
            counterpartyId: shift.counterpartyId ?? "",
            labelTemplateId: shift.labelTemplateId ?? "",
            ssccIssuerCounterpartyId: shift.ssccIssuerCounterpartyId ?? "",
            boxLabelTemplateId: shift.boxLabelTemplateId ?? "",
            boxCapacity: shift.boxCapacity === null ? "" : String(shift.boxCapacity),
            palletCapacity: shift.palletCapacity === null ? "" : String(shift.palletCapacity),
            palletsEnabled: shift.palletsEnabled,
          }
        : undefined,
    // Primitive dependencies intentionally keep an unrelated list refetch from
    // replacing a dirty form's initial-value object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      shift?.boxCapacity,
      shift?.boxLabelTemplateId,
      shift?.counterpartyId,
      shift?.labelTemplateId,
      shift?.lineId,
      shift?.mode,
      shift?.openedAt,
      shift?.palletCapacity,
      shift?.palletsEnabled,
      shift?.plannedDate,
      shift?.plannedQty,
      shift?.productId,
      shift?.ssccIssuerCounterpartyId,
    ],
  );
  if (context.panelPending || context.panelError) return <PanelState mode="edit" />;
  if (!shift || !initialValues) {
    return (
      <SidePanel
        open
        size="complex"
        title={t("pages.shifts.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="warn">{t("pages.shifts.form.notFound")}</Alert>
      </SidePanel>
    );
  }

  const persist = async (input: UpdateShiftInput) => {
    try {
      setError(null);
      await mutation.mutateAsync({ id: shift.id, input });
      toast(
        "ok",
        t(
          shift.status === "active"
            ? "pages.shifts.toasts.updateActiveSuccess"
            : "pages.shifts.toasts.updateSuccess",
        ),
        shift.status === "active" ? 8_000 : 4_000,
      );
      guard.finish();
    } catch (cause) {
      setCriticalInput(null);
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.shifts.toasts.updateError"),
      );
    }
  };

  return (
    <>
      <ShiftForm
        mode="edit"
        editStatus={shift.status}
        initialValues={initialValues}
        products={context.products}
        lines={context.lines}
        counterparties={context.counterparties}
        labelTemplates={context.labelTemplates}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateShiftInput | UpdateShiftInput) => {
          if (shift.status === "active") {
            setCriticalInput(input);
          } else {
            await persist(input);
          }
        }}
      />
      <ConfirmDialog
        open={criticalInput !== null}
        title={t("pages.shifts.activeEdit.title")}
        description={<Alert tone="warn">{t("pages.shifts.activeEdit.description")}</Alert>}
        cancelLabel={t("pages.shifts.activeEdit.cancel")}
        confirmLabel={t("pages.shifts.activeEdit.confirm")}
        busy={mutation.isPending}
        onCancel={() => {
          if (!mutation.isPending) setCriticalInput(null);
        }}
        onConfirm={() => {
          if (criticalInput) void persist(criticalInput);
        }}
      />
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
