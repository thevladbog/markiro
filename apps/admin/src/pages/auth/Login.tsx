import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { errorProp } from "../../lib/form-error.js";
import { LoginShell } from "./LoginShell.js";

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
  const [passwordVisible, setPasswordVisible] = useState(false);

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
    <LoginShell>
      <form className="mk-login-page__form" onSubmit={(event) => void onSubmit(event)} noValidate>
        <span className="mk-login-page__eyebrow">{t("auth.login.eyebrow")}</span>
        <h1>{t("auth.login.title")}</h1>
        <p className="mk-login-page__instruction">{t("auth.login.instruction")}</p>
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <Input
          type="email"
          autoComplete="email"
          label={t("auth.login.emailLabel")}
          {...errorProp(errors.email?.message)}
          {...register("email")}
        />
        <Input
          type={passwordVisible ? "text" : "password"}
          autoComplete="current-password"
          label={t("auth.login.passwordLabel")}
          suffix={
            // eslint-disable-next-line no-restricted-syntax -- compact text control belongs inside Input.suffix.
            <button
              className="mk-login-page__password-toggle"
              type="button"
              aria-label={t(
                passwordVisible ? "auth.login.hidePasswordLabel" : "auth.login.showPasswordLabel",
              )}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {t(passwordVisible ? "auth.login.hidePassword" : "auth.login.showPassword")}
            </button>
          }
          {...errorProp(errors.password?.message)}
          {...register("password")}
        />
        <Button type="submit" loading={isSubmitting} fullWidth>
          {isSubmitting ? (
            <span className="mk-visually-hidden">{t("auth.login.submitting")}</span>
          ) : (
            t("auth.login.submit")
          )}
        </Button>
        <p className="mk-login-page__help">
          {t("auth.login.noAccount")} <Link to="/register">{t("auth.login.registerLink")}</Link>
        </p>
      </form>
    </LoginShell>
  );
}
