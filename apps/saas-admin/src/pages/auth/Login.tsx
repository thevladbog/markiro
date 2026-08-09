import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { AuthFrame } from "./AuthFrame.js";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
type LoginValues = z.infer<typeof loginSchema>;

export function Login() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const session = auth.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const submit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const result = await auth.signIn.email(values);
    if (result.error) {
      setSubmitError(result.error.message ?? t("auth.login.error"));
      return;
    }
    if (result.data?.twoFactorRedirect) {
      void navigate("/two-factor?mode=challenge", { replace: true });
      return;
    }
    await session.refetch?.();
    const requested = (location.state as { from?: unknown } | null)?.from;
    void navigate(typeof requested === "string" ? requested : "/catalog", { replace: true });
  });

  return (
    <AuthFrame eyebrow={t("auth.login.eyebrow")}>
      <div className="auth-copy">
        <h1>{t("auth.login.title")}</h1>
        <p>{t("auth.login.subtitle")}</p>
      </div>
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}
      <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
        <Input
          label={t("auth.email")}
          type="email"
          autoComplete="username"
          {...(form.formState.errors.email ? { error: t("auth.validation.email") } : {})}
          {...form.register("email")}
        />
        <Input
          label={t("auth.password")}
          type="password"
          autoComplete="current-password"
          {...(form.formState.errors.password ? { error: t("auth.validation.required") } : {})}
          {...form.register("password")}
        />
        <Button type="submit" fullWidth loading={form.formState.isSubmitting}>
          {t("auth.login.submit")}
        </Button>
      </form>
      <Link className="auth-link" to="/recovery">
        {t("auth.login.recovery")}
      </Link>
    </AuthFrame>
  );
}
