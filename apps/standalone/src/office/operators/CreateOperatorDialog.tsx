import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorCreate } from "../../host/protocol.js";
import { operatorCreate } from "../../host/requests.js";
import { hashPin } from "../../lib/credentials.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { newOperatorSchema, similarLogin, type NewOperatorValues } from "./operator-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", pinPhc: "pin" } as const;
/** Personnel numbers are unique on the host (`operators.login UNIQUE`). */
const CREATE_CONFLICTS = {
  login: { field: "login", message: "office.operators.errors.loginTaken" },
} as const;

export interface CreateOperatorDialogProps {
  onClose: () => void;
  onCreated: (operator: OfficeOperator) => void;
}

/**
 * A new operator with a PIN. The PIN is hashed here (`hashPin`) before the
 * request is built, so neither the request nor the mutation's variables
 * ever hold it; it lives in the form until the dialog closes.
 */
export function CreateOperatorDialog({ onClose, onCreated }: CreateOperatorDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The number in the way when the host refused one that differs only by leading zeros.
  const [similar, setSimilar] = useState<string | null>(null);
  const create = useOfficeMutation((api, token, body: OperatorCreate) =>
    api.createOperator(token, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<NewOperatorValues>({
    resolver: zodResolver(newOperatorSchema),
    defaultValues: {
      login: "",
      name: "",
      role: "",
      pin: "",
      pinConfirm: "",
    },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let created: OfficeOperator;
    try {
      const pinPhc = await hashPin(values.pin);
      created = await create.mutateAsync(
        operatorCreate({
          login: values.login,
          name: values.name,
          role: toOptionalText(values.role),
          pinPhc,
        }),
      );
    } catch (error) {
      const near = similarLogin(error, values.login);
      if (near !== null) {
        setSimilar(near);
        setError(
          "login",
          { type: "server", message: "office.operators.errors.loginSimilar" },
          { shouldFocus: true },
        );
        return;
      }
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(
          outcome.field,
          { type: "server", message: outcome.message },
          { shouldFocus: true },
        );
      } else {
        setFailure(outcome);
      }
      return;
    }
    onCreated(created);
  });

  return (
    <FormDialog
      errorCount={Object.keys(errors).length}
      title={t("office.operators.createTitle")}
      submitLabel={t("office.operators.create")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.operators.fields.login")}
        hint={t("office.operators.fields.loginHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.login?.message, similar === null ? undefined : { similar })}
        {...register("login")}
      />
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
