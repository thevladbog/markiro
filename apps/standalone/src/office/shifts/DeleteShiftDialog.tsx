import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert, WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";

export interface DeleteShiftDialogProps {
  /** A planned shift no station has entered. */
  shift: OfficeShift;
  /** How the list names the shift's product. */
  productName: string;
  onClose: () => void;
  onDeleted: () => void;
  /** The list is read again and the dialog closes: the shift is no longer one to delete. */
  onReload: () => void;
  /** The shift was opened or closed meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Deletes a planned shift after asking (`DELETE`, 204). Its number is not
 * drawn again. A shift already gone (`not_found`: deleted on another
 * workstation, or a repeat after a lost answer) is deleted all the same.
 */
export function DeleteShiftDialog({
  shift,
  productName,
  onClose,
  onDeleted,
  onReload,
  onOutdated,
}: DeleteShiftDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says a station opened or someone closed the shift meanwhile:
  // a repeat would be refused the same way, so «Удалить» stays off and the alert offers the list.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const remove = useOfficeMutation((api, token, id: string) => api.deleteShift(token, id));

  const submit = async () => {
    setFailure(null);
    try {
      await remove.mutateAsync(shift.id);
    } catch (error) {
      if (!(error instanceof HostError && error.code === "not_found")) {
        // No field to go under: with none named, every refusal is an alert.
        const { failure: sorted, outdated } = shiftWriteFailure<never>(error, {});
        const outcome = sorted.kind === "field" ? alertFailure(error) : sorted;
        if (outdated && outcome.kind === "alert") {
          setOutdatedMessage(outcome.message);
        } else {
          setFailure(outcome);
          rereadIfLost(error);
        }
        if (outdated) onOutdated();
        return;
      }
    }
    onDeleted();
  };

  return (
    <FormDialog
      title={t("office.shifts.deleteTitle", { number: shift.number })}
      submitLabel={t("office.shifts.deleteSubmit")}
      submitVariant="destructive"
      submitDisabled={outdatedMessage !== null}
      onSubmit={submit}
      onClose={onClose}
      alert={
        outdatedMessage !== null ? (
          <StaleAlert onReload={onReload} message={outdatedMessage} />
        ) : (
          <WriteFailureAlert failure={failure} />
        )
      }
    >
      <p>{t("office.shifts.deleteBody", { number: shift.number, product: productName })}</p>
    </FormDialog>
  );
}
