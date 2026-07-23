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

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  password: z.string().min(8),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const { error } = await authClient.signUp.email(values);
    if (error) {
      setSubmitError(error.message ?? t("auth.register.genericError"));
      return;
    }
    // Better Auth signs the user in automatically after sign-up (autoSignIn
    // defaults to true); the guarded "/" route decides where a fresh
    // session without an active organization lands (-> /org/select).
    void navigate("/", { replace: true });
  });

  return (
    <AuthLayout title={t("auth.register.title")}>
      <form
        onSubmit={(event) => void onSubmit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <Input
          autoComplete="name"
          label={t("auth.register.nameLabel")}
          {...errorProp(errors.name?.message)}
          {...register("name")}
        />
        <Input
          type="email"
          autoComplete="email"
          label={t("auth.register.emailLabel")}
          {...errorProp(errors.email?.message)}
          {...register("email")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("auth.register.passwordLabel")}
          {...errorProp(errors.password?.message)}
          {...register("password")}
        />
        <Button type="submit" loading={isSubmitting} fullWidth>
          {t("auth.register.submit")}
        </Button>
        <p style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          {t("auth.register.haveAccount")} <Link to="/login">{t("auth.register.loginLink")}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
