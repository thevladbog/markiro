import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { hashPin } from "../../lib/credentials.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { pinFormSchema, type PinFormValues } from "./operator-forms.js";

const PIN_FIELDS = { pinPhc: "pin" } as const;

export interface OperatorPinDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * A new PIN for an operator. The old one cannot be shown, only replaced: the
 * new PIN is hashed here (`hashPin`) and only its hash goes, with the loaded
 * revision.
 */
export function OperatorPinDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: OperatorPinDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, body: OperatorUpdate) =>
    api.updateOperator(token, operator.id, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<PinFormValues>({
    resolver: zodResolver(pinFormSchema),
    defaultValues: { pin: "", pinConfirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      const pinPhc = await hashPin(values.pin);
      saved = await update.mutateAsync(operatorUpdate(operator, { pinPhc }));
    } catch (error) {
      const outcome = writeFailure(error, PIN_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.operators.pinTitle", { name: operator.name })}
      submitLabel={t("office.operators.pinSubmit")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.operators.pinNote")}</p>
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pin")}
        hint={t("office.operators.fields.pinHint")}
        {...fieldError(errors.pin?.message)}
        {...register("pin")}
      />
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pinConfirm")}
        {...fieldError(errors.pinConfirm?.message)}
        {...register("pinConfirm")}
      />
    </FormDialog>
  );
}
