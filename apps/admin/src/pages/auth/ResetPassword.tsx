import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { errorProp } from "../../lib/form-error.js";
import { AuthLayout } from "./AuthLayout.js";

const passwordSchema = z
  .object({
    newPassword: z.string().min(8),
    confirmation: z.string().min(1),
  })
  .refine((value) => value.newPassword === value.confirmation, {
    path: ["confirmation"],
    message: "passwords_do_not_match",
  });

type PasswordForm = z.infer<typeof passwordSchema>;

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordForm>({ resolver: zodResolver(passwordSchema) });

  if (!token) {
    return (
      <AuthLayout title={t("auth.resetPassword.invalidTitle")}>
        <Alert tone="error">{t("auth.resetPassword.invalidBody")}</Alert>
        <p style={{ marginTop: 16 }}>
          <Link to="/login">{t("auth.resetPassword.toLogin")}</Link>
        </p>
      </AuthLayout>
    );
  }

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    setSubmitError(null);
    const { error } = await authClient.resetPassword({ newPassword, token });
    if (error) {
      setSubmitError(error.message ?? t("auth.resetPassword.genericError"));
      return;
    }
    void navigate("/login", { replace: true });
  });

  return (
    <AuthLayout title={t("auth.resetPassword.title")}>
      <form
        onSubmit={(event) => void onSubmit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <Input
          type="password"
          autoComplete="new-password"
          label={t("auth.resetPassword.passwordLabel")}
          {...errorProp(errors.newPassword ? t("auth.resetPassword.passwordHint") : undefined)}
          {...register("newPassword")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("auth.resetPassword.confirmationLabel")}
          {...errorProp(
            errors.confirmation?.message === "passwords_do_not_match"
              ? t("auth.resetPassword.mismatch")
              : undefined,
          )}
          {...register("confirmation")}
        />
        <Button type="submit" loading={isSubmitting} fullWidth>
          {t("auth.resetPassword.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
