import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Input,
  SidePanel,
  Spinner,
  StatusChip,
} from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import {
  useCloseShift,
  useDeleteShift,
  useShiftSummary,
  type ShiftDto,
  type ShiftParticipantDto,
} from "./api.js";
import { ShiftExportsContent } from "./ShiftExportsDialog.js";
import type { ShiftsPanelLocationState } from "./ShiftPanelRoute.js";

const STATUS_TO_CHIP: Record<ShiftDto["status"], StatusChipStatus> = {
  planned: "info",
  active: "ok",
  closed: "neutral",
};

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value);
}

function Participant({ participant }: { participant: ShiftParticipantDto }) {
  const { t, i18n } = useTranslation();
  return (
    <article className="mk-shift-details__participant">
      <div>
        <strong>{participant.fullName}</strong>
        <p>{participant.role ?? t("pages.shifts.details.roleMissing")}</p>
        <p>
          {t("pages.shifts.details.activityRange", {
            first: formatCreatedAt(participant.firstActivityAt, i18n.language),
            last: formatCreatedAt(participant.lastActivityAt, i18n.language),
          })}
        </p>
      </div>
      <div className="mk-shift-details__participant-stats">
        <span>
          {t("pages.shifts.details.acceptedScans")}
          <strong>{formatNumber(participant.acceptedScans, i18n.language)}</strong>
        </span>
        <span>
          {t("pages.shifts.details.closedBoxes")}
          <strong>{formatNumber(participant.closedBoxes, i18n.language)}</strong>
        </span>
      </div>
    </article>
  );
}

function ShiftOutput({ shift }: { shift: ShiftDto }) {
  const { t, i18n } = useTranslation();
  const summary = useShiftSummary(shift.id);

  if (summary.isPending) return <Spinner label={t("common.loading")} />;
  if (summary.isError) {
    return (
      <Alert tone="error">
        <div className="mk-shift-details__load-error">
          <span>{t("pages.shifts.details.summaryError")}</span>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            onClick={() => void summary.refetch()}
          >
            {t("pages.shifts.form.retry")}
          </Button>
        </div>
      </Alert>
    );
  }

  const output = summary.data.output;
  return (
    <>
      <div className="mk-shift-details__metrics">
        {output.mode === "validation" ? (
          <div className="mk-shift-details__metric">
            <strong>{formatNumber(output.acceptedUnits, i18n.language)}</strong>
            <span>{t("pages.shifts.details.acceptedUnits")}</span>
          </div>
        ) : (
          <>
            <div className="mk-shift-details__metric">
              <strong>{formatNumber(output.closedBoxes, i18n.language)}</strong>
              <span>{t("pages.shifts.details.closedBoxes")}</span>
            </div>
            <div className="mk-shift-details__metric">
              <strong>{formatNumber(output.containedUnits, i18n.language)}</strong>
              <span>{t("pages.shifts.details.containedUnits")}</span>
            </div>
          </>
        )}
        <div className="mk-shift-details__metric">
          <strong>{formatNumber(shift.plannedQty ?? 0, i18n.language)}</strong>
          <span>{t("pages.shifts.details.plannedUnits")}</span>
        </div>
      </div>
      <section className="mk-shift-details__section">
        <h3>{t("pages.shifts.details.participantsTitle")}</h3>
        {summary.data.unattributed.eventCount > 0 ? (
          <Alert tone="warn">
            {t("pages.shifts.details.unattributed", {
              count: summary.data.unattributed.eventCount,
            })}
          </Alert>
        ) : null}
        {summary.data.participants.length === 0 ? (
          <p className="mk-shift-details__empty">{t("pages.shifts.details.participantsEmpty")}</p>
        ) : (
          <div className="mk-shift-details__participants">
            {summary.data.participants.map((participant) => (
              <Participant key={participant.employeeId} participant={participant} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AuthorizedShiftActions({ shift, onDeleted }: { shift: ShiftDto; onDeleted: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteMutation = useDeleteShift();
  const closeMutation = useCloseShift();
  const [dialog, setDialog] = useState<"delete" | "close" | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const edit = () => {
    void navigate(`/shifts/${shift.id}/edit`, {
      state:
        (location.state as ShiftsPanelLocationState | null) ??
        ({ shiftsBackground: true } satisfies ShiftsPanelLocationState),
    });
  };

  const deleteShift = async () => {
    try {
      setError(null);
      await deleteMutation.mutateAsync(shift.id);
      toast("ok", t("pages.shifts.toasts.deleteSuccess"));
      setDialog(null);
      onDeleted();
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.shifts.toasts.deleteError"),
      );
    }
  };

  const closeShift = async () => {
    try {
      setError(null);
      await closeMutation.mutateAsync({ id: shift.id, reason: closeReason.trim() });
      toast("ok", t("pages.shifts.toasts.closeSuccess"));
      setDialog(null);
      setCloseReason("");
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.shifts.toasts.closeError"),
      );
    }
  };

  return (
    <>
      <div className="mk-shift-details__actions">
        <Button type="button" variant="secondary" onClick={edit}>
          {t("pages.shifts.edit")}
        </Button>
        {shift.status === "planned" ? (
          <Button type="button" variant="destructive" onClick={() => setDialog("delete")}>
            {t("pages.shifts.delete")}
          </Button>
        ) : null}
        {shift.status === "active" ? (
          <Button type="button" variant="secondary" onClick={() => setDialog("close")}>
            {t("pages.shifts.close")}
          </Button>
        ) : null}
      </div>
      {dialog === "delete" ? (
        <ConfirmDialog
          open
          title={t("pages.shifts.deleteConfirmTitle")}
          description={
            <>
              <p>
                {t("pages.shifts.deleteConfirmBody", { name: shift.productName ?? shift.number })}
              </p>
              {error ? <Alert tone="error">{error}</Alert> : null}
            </>
          }
          entity={shift.productName ? `${shift.number} · ${shift.productName}` : shift.number}
          cancelLabel={t("pages.shifts.cancel")}
          confirmLabel={t("pages.shifts.deleteConfirmAction")}
          tone="destructive"
          busy={deleteMutation.isPending}
          onCancel={() => setDialog(null)}
          onConfirm={() => void deleteShift()}
        />
      ) : null}
      {dialog === "close" ? (
        <ConfirmDialog
          open
          title={t("pages.shifts.closeModal.title")}
          description={
            <>
              <Input
                label={t("pages.shifts.closeModal.reasonLabel")}
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
              />
              {error ? <Alert tone="error">{error}</Alert> : null}
            </>
          }
          entity={shift.productName ? `${shift.number} · ${shift.productName}` : shift.number}
          cancelLabel={t("pages.shifts.closeModal.cancel")}
          confirmLabel={t("pages.shifts.closeModal.submit")}
          tone="destructive"
          busy={closeMutation.isPending}
          confirmDisabled={closeReason.trim().length < 3}
          onCancel={() => {
            setDialog(null);
            setCloseReason("");
            setError(null);
          }}
          onConfirm={() => void closeShift()}
        />
      ) : null}
    </>
  );
}

export function ShiftDetailsPanel({ shift, onClose }: { shift: ShiftDto; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const plannedDate = shift.plannedDate ? formatDate(shift.plannedDate, i18n.language) : "—";
  const productionDate = shift.productionDate ?? shift.plannedDate;

  return (
    <SidePanel
      open
      size="complex"
      title={t("pages.shifts.details.title", { number: shift.number })}
      description={shift.productName ?? undefined}
      status={
        <StatusChip
          status={STATUS_TO_CHIP[shift.status]}
          label={t(`pages.shifts.status.${shift.status}`)}
        />
      }
      closeLabel={t("common.close")}
      onClose={onClose}
    >
      <div className="mk-shift-details">
        <section className="mk-shift-details__section">
          <h3>{t("pages.shifts.details.outputTitle")}</h3>
          <ShiftOutput shift={shift} />
        </section>
        <section className="mk-shift-details__section">
          <h3>{t("pages.shifts.details.parametersTitle")}</h3>
          <dl className="mk-shift-details__properties">
            <div>
              <dt>{t("pages.shifts.table.plannedDate")}</dt>
              <dd>{plannedDate}</dd>
            </div>
            <div>
              <dt>{t("pages.shifts.table.productionDate")}</dt>
              <dd>{productionDate ? formatDate(productionDate, i18n.language) : "—"}</dd>
            </div>
            <div>
              <dt>{t("pages.shifts.table.line")}</dt>
              <dd>{shift.lineName ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("pages.shifts.table.mode")}</dt>
              <dd>
                <Badge tone="neutral">{t(`pages.shifts.mode.${shift.mode}`)}</Badge>
              </dd>
            </div>
            <div>
              <dt>{t("pages.shifts.table.plannedQty")}</dt>
              <dd>{shift.plannedQty ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("pages.shifts.details.counterparty")}</dt>
              <dd>{shift.counterpartyName ?? "—"}</dd>
            </div>
          </dl>
        </section>
        <section className="mk-shift-details__section">
          <h3>{t("pages.shifts.exports.title")}</h3>
          {shift.status === "closed" ? (
            <ShiftExportsContent shift={shift} />
          ) : (
            <p className="mk-shift-details__reports-hint">
              {t("pages.shifts.details.reportsAfterClose")}
            </p>
          )}
        </section>
        {canWrite && shift.status !== "closed" ? (
          <section className="mk-shift-details__section">
            <h3>{t("pages.shifts.details.actionsTitle")}</h3>
            <AuthorizedShiftActions shift={shift} onDeleted={onClose} />
          </section>
        ) : null}
      </div>
    </SidePanel>
  );
}
