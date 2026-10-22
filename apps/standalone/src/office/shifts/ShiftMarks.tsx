import { useTranslation } from "react-i18next";

import { StatusChip } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { closedParticipants, participantsOf } from "./participation.js";

/**
 * What a shift's status cell and the card's status line add for several devices (plan 2b): one
 * quiet line for a shared shift (how many devices, how many closed their part), and the attention
 * tag of a shift its devices closed without the reason the plan's gap needed. Nothing for a shift
 * of one device or of a host before protocol 7.
 */
export function ShiftMarks({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  const total = participantsOf(shift).length;
  return (
    <>
      {total > 1 && (
        <span className="shift-cell__quiet">
          {t("office.shifts.stationsLine", { total, closed: closedParticipants(shift).length })}
        </span>
      )}
      {shift.closeReasonMissing === true && (
        <StatusChip phase="attention" wrap label={t("office.shifts.reasonMissing")} />
      )}
    </>
  );
}
