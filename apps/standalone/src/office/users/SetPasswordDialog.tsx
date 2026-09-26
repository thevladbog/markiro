import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { failureMessage, writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
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
  const formId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const set = useOfficeMutation((api, token, password: string) =>
    api.setUserPassword(token, user.id, { password }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordSetValues>({
    resolver: zodResolver(passwordSetFormSchema),
    defaultValues: { password: "", confirm: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

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
        setFailure(failureMessage(outcome));
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.passwordTitle", { login: user.login })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting}>
            {t("office.users.passwordSubmit")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure && <Alert tone="error">{t(failure)}</Alert>}
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
      </form>
    </Modal>
  );
}
