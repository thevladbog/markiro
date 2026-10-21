import { isShiftCloseReasonCode } from "@markiro/domain";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Card, StatusChip, type TableColumn } from "@markiro/ui";

import type { OfficeShift, ShiftParticipant } from "../../host/protocol.js";
import { PagedTable } from "../paging/PagedTable.js";
import {
  closedParticipants,
  LOOK_PHASE,
  participantLook,
  participantsOf,
} from "./participation.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

export interface ShiftStationsProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—» (the card's own). */
  at: (instant: string | null) => string;
}

/**
 * «Станции смены» (plan 2b, spec §7): the devices that entered the shift, each with its kind, its
 * entry, its state and its part of the totals; above them the shift-wide figures against the plan
 * and how many parts are closed. A participant the host has not heard for more than ten minutes is
 * marked, in a word and a glyph. Read from the shift the card already holds: no request of its own.
 */
export function ShiftStations({ shift, at }: ShiftStationsProps) {
  const { t } = useTranslation();
  const titleId = useId();
  // One reading of the clock for the whole table.
  const nowMs = Date.now();
  const participants = participantsOf(shift);
  const parts = new Map((shift.byDevice ?? []).map((part) => [part.deviceId, part]));
  const figure = (value: number | undefined) =>
    value === undefined ? t("office.common.none") : UNITS.format(value);
  const validation = shift.mode === "validation";

  const columns: TableColumn<ShiftParticipant>[] = [
    {
      key: "device",
      title: t("office.shiftCard.participants.device"),
      wrap: true,
      minWidth: 150,
      render: (each) => (
        <span className="shift-cell">
          <span className="shift-cell__name">
            {each.deviceName === ""
              ? t("office.shifts.totals.unknownDevice", { id: each.deviceId.slice(0, 8) })
              : each.deviceName}
          </span>
          <span className="shift-cell__quiet">{t(`office.devices.kinds.${each.deviceKind}`)}</span>
        </span>
      ),
    },
    {
      key: "joined",
      title: t("office.shiftCard.participants.joined"),
      wrap: true,
      minWidth: 130,
      render: (each) => at(each.joinedAt),
    },
    {
      key: "state",
      title: t("office.shiftCard.participants.state"),
      wrap: true,
      minWidth: 190,
      render: (each) => <ParticipantState participant={each} nowMs={nowMs} at={at} />,
    },
    {
      key: "accepted",
      title: t("office.shiftCard.participants.accepted"),
      mono: true,
      align: "right",
      render: (each) => figure(parts.get(each.deviceId)?.accepted),
    },
    // A validation shift puts its codes in no box and on no pallet (plan РЕЖ, Р11).
    ...(validation
      ? []
      : [
          {
            key: "boxes",
            title: t("office.shiftCard.participants.boxes"),
            mono: true,
            align: "right" as const,
            render: (each: ShiftParticipant) => figure(parts.get(each.deviceId)?.boxesClosed),
          },
        ]),
    ...(validation || !shift.palletsEnabled
      ? []
      : [
          {
            key: "pallets",
            title: t("office.shiftCard.participants.pallets"),
            mono: true,
            align: "right" as const,
            render: (each: ShiftParticipant) => figure(parts.get(each.deviceId)?.pallets),
          },
        ]),
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.participants.title")}</h2>
      <Card>
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.participants.summary", {
            accepted: UNITS.format(shift.totals.acceptedUnits),
            plan:
              shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
            closed: closedParticipants(shift).length,
            total: participants.length,
          })}
        </p>
        <PagedTable
          tableId="shift-participants"
          pagerLabel={t("office.shiftCard.participants.pager")}
          columns={columns}
          rows={[...participants]}
          getRowKey={(each) => each.deviceId}
          empty={t("office.common.none")}
          scrollLabel={t("office.shiftCard.participants.table")}
        />
      </Card>
    </section>
  );
}

/** A participant's state: the phase tag with its word, and under it what the host knows of the close. */
function ParticipantState({
  participant,
  nowMs,
  at,
}: {
  participant: ShiftParticipant;
  nowMs: number;
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  const look = participantLook(participant, nowMs);
  const reason = participant.closedReasonCode;
  return (
    <span className="shift-cell">
      <StatusChip
        phase={LOOK_PHASE[look]}
        label={t(`office.shiftCard.participants.states.${look}`)}
      />
      {participant.closedAt !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.closedAt", { at: at(participant.closedAt) })}
        </span>
      )}
      {participant.closedActualQty !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.closedQty", {
            units: UNITS.format(participant.closedActualQty),
          })}
        </span>
      )}
      {reason !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closeReason", {
            // A code a newer host adds is shown as it is.
            reason: isShiftCloseReasonCode(reason)
              ? t(`office.shifts.closeReasons.${reason}`)
              : reason,
          })}
        </span>
      )}
      {look === "silent" && participant.lastSeenAt !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.lastSeen", { at: at(participant.lastSeenAt) })}
        </span>
      )}
      {participant.lateDataAt !== null && (
        <StatusChip phase="attention" label={t("office.shifts.lateData")} />
      )}
    </span>
  );
}
