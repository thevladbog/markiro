import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import type { OfficeShift, ShiftUpdate } from "../../host/protocol.js";
import { shiftUpdate } from "../../host/requests.js";
import { plannedQtyRule, toCount } from "../../lib/rules.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert, WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";

const planSchema = z.object({ plannedQty: plannedQtyRule });
type PlanValues = z.input<typeof planSchema>;

export interface ShiftPlanDialogProps {
  /** An active shift: only its plan changes, which neither its label nor its snapshot shows. */
  shift: OfficeShift;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/** Changes the plan of an active shift (`PUT` with `plannedQty` alone; blank clears it). */
export function ShiftPlanDialog({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
}: ShiftPlanDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says the shift was closed or deleted meanwhile: a resend would
  // be refused the same way, so «Сохранить» stays off and the alert offers to load the list.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const save = useOfficeMutation((api, token, update: ShiftUpdate) =>
    api.updateShift(token, shift.id, update),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<PlanValues>({
    resolver: zodResolver(planSchema),
    defaultValues: { plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty) },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const update = shiftUpdate(shift, { plannedQty: toCount(values.plannedQty) });
    // The plan is typed again as it was (blanks around it): nothing to send, nothing saved.
    if (Object.keys(update).length === 1) {
      onClose();
      return;
    }
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(update);
    } catch (error) {
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        plannedQty: "plannedQty",
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

  return (
    <FormDialog
      title={t("office.shifts.planTitle", { number: shift.number })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty || outdatedMessage !== null}
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
      <p>{t("office.shifts.planIntro")}</p>
      <Input
        label={t("office.shifts.fields.plannedQty")}
        hint={t("office.shifts.fields.planHint")}
        inputMode="numeric"
        mono
        // Read-only, not disabled, while the write is on its way: a disabled field would
        // lose the focus the refused value is given back.
        readOnly={isSubmitting}
        {...fieldError(errors.plannedQty?.message)}
        {...register("plannedQty")}
      />
    </FormDialog>
  );
}
