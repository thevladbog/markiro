import { ValidationReprocessingHistory } from "./ValidationReprocessingHistory.js";
import { ProductLabelHistory } from "./ProductLabelHistory.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Input,
  SidePanel,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";
import { CABINET_CAPABILITY, formatSsccHri } from "@markiro/domain";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

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
import { usePallets, type PalletDto } from "./pallets-api.js";
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
  const duplicate = shift.validationPrint?.mode === "duplicate_dm";
  const repeatEnabled =
    shift.validationPrint?.mode === "duplicate_dm" &&
    shift.validationPrint.allowPreviouslyAcceptedCodes === true;
  const validationCounts =
    output.mode === "validation"
      ? {
          processed: output.acceptedUnits,
          first: output.firstAcceptedUnits ?? (repeatEnabled ? null : output.acceptedUnits),
          repeated: output.reprocessedUnits ?? (repeatEnabled ? null : 0),
        }
      : null;
  return (
    <>
      <div className="mk-shift-details__metrics">
        {output.mode === "validation" ? (
          duplicate && validationCounts ? (
            (["processed", "first", "repeated"] as const).map((key) => (
              <div className="mk-shift-details__metric" key={key}>
                <strong>
                  {validationCounts[key] === null
                    ? "—"
                    : formatNumber(validationCounts[key], i18n.language)}
                </strong>
                <span>{t(`pages.shifts.reprocessing.${key}`)}</span>
              </div>
            ))
          ) : (
            <div className="mk-shift-details__metric">
              <strong>{formatNumber(output.acceptedUnits, i18n.language)}</strong>
              <span>{t("pages.shifts.details.acceptedUnits")}</span>
            </div>
          )
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
          <strong>
            {shift.plannedQty === null ? "—" : formatNumber(shift.plannedQty, i18n.language)}
          </strong>
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

/**
 * The shift's pallets, beside the box registry rather than inside it: a
 * pallet is the second aggregation level, not a box attribute, and only a
 * shift that switched pallets on has any.
 *
 * Rendered only when `shift.palletsEnabled` -- see `usePallets`'s own note on
 * why a known-empty query is not worth a request per panel open. The error
 * branch says so out loud instead of falling back to the empty state:
 * `GET /pallets` 404s for a shift it cannot see, so "no rows" and "could not
 * ask" are different answers and a manager must be able to tell them apart.
 */
function ShiftPallets({ shift }: { shift: ShiftDto }) {
  const { t, i18n } = useTranslation();
  const pallets = usePallets(shift.palletsEnabled ? shift.id : undefined);

  const columns: TableColumn<PalletDto>[] = [
    {
      key: "sscc",
      title: t("pages.shifts.pallets.table.sscc"),
      mono: true,
      // The pallet card is the natural way into this stack's box list, so the
      // SSCC is the link -- same contract as the box table's own SSCC.
      render: (row) => (
        <Link to={`/codes/pallet/${row.id}`}>
          {row.sscc ? formatSsccHri(row.sscc) : t("pages.shifts.pallets.noSscc")}
        </Link>
      ),
    },
    {
      key: "lineName",
      title: t("pages.shifts.pallets.table.line"),
      render: (row) => row.lineName ?? "—",
    },
    {
      key: "boxCount",
      title: t("pages.shifts.pallets.table.boxCount"),
      align: "right",
      mono: true,
      render: (row) => formatNumber(row.boxCount, i18n.language),
    },
    {
      key: "unitCount",
      title: t("pages.shifts.pallets.table.unitCount"),
      align: "right",
      mono: true,
      render: (row) => formatNumber(row.unitCount, i18n.language),
    },
    {
      key: "closedAt",
      title: t("pages.shifts.pallets.table.closedAt"),
      render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
    },
    {
      key: "status",
      title: t("pages.shifts.pallets.table.status"),
      wrap: true,
      // Two independent facts, both non-colour-only: a pallet can have been
      // taken apart AND have lost a box before that.
      render: (row) => (
        <>
          {row.disassembledAt ? (
            <Badge tone="neutral">{t("pages.shifts.pallets.disassembled")}</Badge>
          ) : null}
          {row.contentsChangedAfterClose ? (
            <Badge tone="warn">{t("pages.shifts.pallets.contentsChangedAfterClose")}</Badge>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <section className="mk-shift-details__section" aria-label={t("pages.shifts.pallets.title")}>
      <h3>{t("pages.shifts.pallets.title")}</h3>
      {pallets.isPending ? (
        <Spinner label={t("common.loading")} />
      ) : pallets.isError ? (
        <Alert tone="error">
          <div className="mk-shift-details__load-error">
            <span>{t("pages.shifts.pallets.loadError")}</span>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => void pallets.refetch()}
            >
              {t("pages.shifts.form.retry")}
            </Button>
          </div>
        </Alert>
      ) : (
        <Table
          columns={columns}
          rows={pallets.data}
          empty={t("pages.shifts.pallets.empty")}
          scrollLabel={t("pages.shifts.pallets.title")}
        />
      )}
    </section>
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
          onCancel={() => {
            setDialog(null);
            setError(null);
          }}
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
        {shift.validationPrint?.mode === "duplicate_dm" ? (
          <section className="mk-shift-details__section">
            <h3>{t("pages.shifts.duplicate.title")}</h3>
            <dl className="mk-shift-details__properties">
              <div>
                <dt>{t("pages.shifts.duplicate.template")}</dt>
                <dd>{shift.validationPrint.snapshot.name}</dd>
              </div>
              <div>
                <dt>{t("pages.shifts.reprocessing.allow")}</dt>
                <dd>
                  {t(
                    shift.validationPrint.allowPreviouslyAcceptedCodes
                      ? "pages.shifts.reprocessing.allowed"
                      : "pages.shifts.reprocessing.disallowed",
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("pages.shifts.duplicate.verification")}</dt>
                <dd>
                  {t(
                    shift.validationPrint.verification === "required"
                      ? "pages.shifts.duplicate.requiredHint"
                      : "pages.shifts.duplicate.noneHint",
                  )}
                </dd>
              </div>
            </dl>
            {shift.status !== "planned" ? (
              <p className="mk-shift-details__empty">{t("pages.shifts.duplicate.frozen")}</p>
            ) : null}
          </section>
        ) : null}
        {shift.validationPrint?.mode === "duplicate_dm" && shift.status !== "planned" ? (
          <ProductLabelHistory key={shift.id} shiftId={shift.id} />
        ) : null}
        {shift.validationPrint?.mode === "duplicate_dm" &&
        shift.validationPrint.allowPreviouslyAcceptedCodes &&
        shift.status !== "planned" ? (
          <ValidationReprocessingHistory key={shift.id} shiftId={shift.id} />
        ) : null}
        {shift.palletsEnabled ? <ShiftPallets shift={shift} /> : null}
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
            {shift.palletsEnabled ? (
              <div>
                <dt>{t("pages.shifts.form.palletBoxCapacityLabel")}</dt>
                <dd>
                  {shift.palletBoxCapacity === null
                    ? "—"
                    : formatNumber(shift.palletBoxCapacity, i18n.language)}
                </dd>
              </div>
            ) : null}
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
