import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";
import { errorProp } from "../lib/form-error.js";
import { useOfficeSession } from "./office-session.js";

/** Characters as the host counts them (Unicode scalar values). */
function characters(text: string): number {
  return [...text].length;
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "office.password.required"),
  newPassword: z
    .string()
    .refine(
      (password) => characters(password) >= 8 && characters(password) <= 128,
      "office.password.length",
    ),
  confirmPassword: z.string(),
});

type PasswordValues = z.infer<typeof passwordSchema>;

const FORM_ID = "office-password-form";

export interface ChangePasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ChangePasswordDialog({ open, onClose, onChanged }: ChangePasswordDialogProps) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    reset();
    setSubmitError(null);
    onClose();
  };

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (values.newPassword !== values.confirmPassword) {
      setError("confirmPassword", { type: "validate", message: "office.password.mismatch" });
      return;
    }
    try {
      await session.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset();
      onChanged();
    } catch (error) {
      if (error instanceof HostError && error.credential === "password") {
        setError("currentPassword", { type: "server", message: "office.password.wrongCurrent" });
        return;
      }
      if (error instanceof HostError && error.field === "newPassword") {
        setError("newPassword", { type: "server", message: "office.password.length" });
        return;
      }
      setSubmitError(errorMessageKey(error));
    }
  });

  return (
    <Modal
      open={open}
      title={t("office.password.title")}
      onClose={close}
      closeLabel={t("office.password.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.password.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={isSubmitting}>
            {t("office.password.submit")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {submitError && <Alert tone="error">{t(submitError)}</Alert>}
        <Input
          type="password"
          autoComplete="current-password"
          label={t("office.password.current")}
          {...fieldError(errors.currentPassword?.message)}
          {...register("currentPassword")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.password.new")}
          hint={t("office.password.hint")}
          {...fieldError(errors.newPassword?.message)}
          {...register("newPassword")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.password.confirm")}
          {...fieldError(errors.confirmPassword?.message)}
          {...register("confirmPassword")}
        />
      </form>
    </Modal>
  );
}
