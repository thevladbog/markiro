import { zodResolver } from "@hookform/resolvers/zod";
import { isShiftCloseReasonCode, SHIFT_CLOSE_REASON_CODES } from "@markiro/domain";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Select } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import { shiftCloseReasonSet } from "../../host/requests.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert, WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

const reasonSchema = z.object({
  reasonCode: z.string().refine(isShiftCloseReasonCode, "office.shifts.errors.reasonRequired"),
});
type ReasonValues = z.input<typeof reasonSchema>;

export interface CloseReasonDialogProps {
  /** A closed shift whose devices closed it without the reason (`closeReasonMissing`). */
  shift: OfficeShift;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was given its reason or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * The reason of a shared shift its last device closed without one (plan 2b, spec §12.9): one of
 * the six codes a station would have given, over the revision the dialog was opened on. A shift
 * that already has its reason (`close_reason_not_missing`: another PC, or a race) is an alert in
 * words of its own that follows with a read of the list, as every shift dialog treats a shift that
 * moved.
 */
export function CloseReasonDialog({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
}: CloseReasonDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says the shift moved: a resend would be refused the same way, so
  // «Сохранить причину» stays off and the alert offers to load the list.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const save = useOfficeMutation((api, token, reasonCode: string) =>
    api.setShiftCloseReason(token, shift.id, shiftCloseReasonSet(reasonCode, shift.rev)),
  );
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ReasonValues>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reasonCode: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(values.reasonCode);
    } catch (error) {
      if (
        error instanceof HostError &&
        error.code === "conflict" &&
        error.details.constraint === "close_reason_not_missing"
      ) {
        setOutdatedMessage("office.shifts.errors.reasonAlreadySet");
        onOutdated();
        return;
      }
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        reasonCode: "reasonCode",
      });
      if (outcome.kind === "field") {
        setError(
          outcome.field,
          { type: "server", message: outcome.message },
          { shouldFocus: true },
        );
      } else if (outdated && outcome.kind === "alert") {
        setOutdatedMessage(outcome.message);
      } else {
        setFailure(outcome);
        rereadIfLost(error);
      }
      if (outdated) onOutdated();
      return;
    }
    onSaved(saved);
  });

  const options = SHIFT_CLOSE_REASON_CODES.map((code) => ({
    value: code,
    label: t(`office.shifts.closeReasons.${code}`),
  }));

  return (
    <FormDialog
      errorCount={Object.keys(errors).length}
      title={t("office.shifts.reasonTitle", { number: shift.number })}
      submitLabel={t("office.shifts.reasonSubmit")}
      submitDisabled={outdatedMessage !== null}
      onSubmit={submit}
      onClose={onClose}
      alert={
        outdatedMessage !== null ? (
          <StaleAlert onReload={onReload} message={outdatedMessage} />
        ) : (
          <WriteFailureAlert failure={failure} onReload={onReload} />
        )
      }
    >
      <p>
        {t("office.shifts.reasonIntro", {
          plan:
            shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
          accepted: UNITS.format(shift.totals.acceptedUnits),
        })}
      </p>
      <Controller
        control={control}
        name="reasonCode"
        render={({ field }) => (
          <Select
            label={t("office.shifts.fields.reasonCode")}
            placeholder={t("office.shifts.fields.reasonCodePlaceholder")}
            options={options}
            value={field.value}
            onValueChange={field.onChange}
            {...fieldError(errors.reasonCode?.message)}
          />
        )}
      />
    </FormDialog>
  );
}
