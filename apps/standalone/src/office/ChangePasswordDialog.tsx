import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { HostError } from "../host/client.js";
import type { PasswordChange } from "../host/protocol.js";
import { isTransferable, passwordRule } from "../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { WriteFailureAlert } from "./page-state.js";
import { PasswordInput } from "./PasswordInput.js";

const passwordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, "office.password.required")
    .refine(isTransferable, "rules.passwordCharacter"),
  newPassword: passwordRule,
  confirmPassword: z.string(),
});

type PasswordValues = z.infer<typeof passwordSchema>;

/** The host names the new password when it refuses it; the form says why in its own words. */
const PASSWORD_FIELDS = {
  newPassword: { field: "newPassword", message: "rules.password" },
} as const;

export interface ChangePasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ChangePasswordDialog({ open, onClose, onChanged }: ChangePasswordDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const change = useOfficeMutation((api, token, request: PasswordChange) =>
    api.officeChangePassword(token, request),
  );
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  // The dialog stays mounted between openings: closing starts it afresh.
  const close = () => {
    reset();
    setFailure(null);
    onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    if (values.newPassword !== values.confirmPassword) {
      setError("confirmPassword", { type: "validate", message: "rules.passwordConfirm" });
      return;
    }
    try {
      await change.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    } catch (error) {
      if (error instanceof HostError && error.credential === "password") {
        setError("currentPassword", { type: "server", message: "office.password.wrongCurrent" });
        return;
      }
      const outcome = writeFailure(error, PASSWORD_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    reset();
    onChanged();
  });

  return (
    <FormDialog
      open={open}
      title={t("office.password.title")}
      submitLabel={t("office.password.submit")}
      onSubmit={submit}
      onClose={close}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <PasswordInput
        autoComplete="current-password"
        label={t("office.password.current")}
        {...fieldError(errors.currentPassword?.message)}
        {...register("currentPassword")}
      />
      <PasswordInput
        autoComplete="new-password"
        label={t("office.password.new")}
        hint={t("office.password.hint")}
        {...fieldError(errors.newPassword?.message)}
        {...register("newPassword")}
      />
      <PasswordInput
        autoComplete="new-password"
        label={t("office.password.confirm")}
        {...fieldError(errors.confirmPassword?.message)}
        {...register("confirmPassword")}
      />
      <p className="office-note">{t("office.password.note")}</p>
    </FormDialog>
  );
}
