import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftUpdate } from "../../host/requests.js";
import { plannedQtyRule, toCount } from "../../lib/rules.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";

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
  const save = useOfficeMutation((api, token, plannedQty: number | null) =>
    api.updateShift(token, shift.id, shiftUpdate(shift, { plannedQty })),
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
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(toCount(values.plannedQty));
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
      } else {
        setFailure(outcome);
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
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
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
