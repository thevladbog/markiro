import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { operatorEditSchema, type OperatorEditValues } from "./operator-forms.js";

const EDIT_FIELDS = { name: "name", role: "role" } as const;

export interface EditOperatorDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * An operator's name and role, with the loaded revision. The personnel
 * number is shown and never changes; turning the operator off or on is its
 * own action on the page.
 */
export function EditOperatorDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: EditOperatorDialogProps) {
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
    formState: { errors, isDirty },
  } = useForm<OperatorEditValues>({
    resolver: zodResolver(operatorEditSchema),
    defaultValues: { name: operator.name, role: operator.role ?? "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      saved = await update.mutateAsync(
        operatorUpdate(operator, { name: values.name, role: toOptionalText(values.role) }),
      );
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
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
      errorCount={Object.keys(errors).length}
      title={t("office.operators.editTitle", { name: operator.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.operators.loginFixed", { login: operator.login })}</p>
      <Input
        label={t("office.operators.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.operators.fields.role")}
        hint={t("office.operators.fields.roleHint")}
        {...fieldError(errors.role?.message)}
        {...register("role")}
      />
    </FormDialog>
  );
}
