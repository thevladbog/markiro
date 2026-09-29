import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { passwordSetFormSchema, type PasswordSetValues } from "./user-forms.js";

const PASSWORD_FIELDS = { password: "password" } as const;

export interface SetPasswordDialogProps {
  user: OfficeUserRecord;
  onClose: () => void;
  onChanged: () => void;
}

/** An administrator sets someone else's password; the host ends that user's sessions. */
export function SetPasswordDialog({ user, onClose, onChanged }: SetPasswordDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const set = useOfficeMutation((api, token, password: string) =>
    api.setUserPassword(token, user.id, { password }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<PasswordSetValues>({
    resolver: zodResolver(passwordSetFormSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await set.mutateAsync(values.password);
      onChanged();
    } catch (error) {
      const outcome = writeFailure(error, PASSWORD_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.users.passwordTitle", { login: user.login })}
      submitLabel={t("office.users.passwordSubmit")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.users.passwordNote")}</p>
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.password")}
        hint={t("office.users.fields.passwordHint")}
        {...fieldError(errors.password?.message)}
        {...register("password")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.confirm")}
        {...fieldError(errors.confirm?.message)}
        {...register("confirm")}
      />
    </FormDialog>
  );
}
