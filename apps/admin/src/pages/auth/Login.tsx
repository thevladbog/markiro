import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { errorProp } from "../../lib/form-error.js";
import { AuthLayout } from "./AuthLayout.js";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const { error } = await authClient.signIn.email(values);
    if (error) {
      setSubmitError(error.message ?? t("auth.login.genericError"));
      return;
    }
    void navigate("/", { replace: true });
  });

  return (
    <AuthLayout title={t("auth.login.title")}>
      <form
        onSubmit={(event) => void onSubmit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <Input
          type="email"
          autoComplete="email"
          label={t("auth.login.emailLabel")}
          {...errorProp(errors.email?.message)}
          {...register("email")}
        />
        <Input
          type="password"
          autoComplete="current-password"
          label={t("auth.login.passwordLabel")}
          {...errorProp(errors.password?.message)}
          {...register("password")}
        />
        <Button type="submit" loading={isSubmitting} fullWidth>
          {t("auth.login.submit")}
        </Button>
        <p style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          {t("auth.login.noAccount")} <Link to="/register">{t("auth.login.registerLink")}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
