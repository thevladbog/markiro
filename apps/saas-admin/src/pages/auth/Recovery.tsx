import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { AuthFrame } from "./AuthFrame.js";

const recoverySchema = z.object({
  code: z.string().trim().min(1),
  password: z.string().min(8),
});

export function Recovery() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof recoverySchema>>({
    resolver: zodResolver(recoverySchema),
    defaultValues: { code: "", password: "" },
  });

  const submit = form.handleSubmit(async ({ code, password }) => {
    setSubmitError(null);
    const verified = await auth.twoFactor.verifyBackupCode({ code, trustDevice: false });
    if (verified.error) {
      setSubmitError(verified.error.message ?? t("auth.recovery.error"));
      return;
    }
    const disabled = await auth.twoFactor.disable({ password });
    if (disabled.error) {
      setSubmitError(disabled.error.message ?? t("auth.recovery.error"));
      return;
    }
    const revoked = await auth.revokeOtherSessions();
    if (revoked.error) {
      setSubmitError(revoked.error.message ?? t("auth.recovery.error"));
      return;
    }
    form.reset();
    void navigate("/two-factor?mode=enroll", {
      replace: true,
      state: { recoveryComplete: true },
    });
  });

  return (
    <AuthFrame eyebrow={t("auth.recovery.eyebrow")}>
      <div className="auth-copy">
        <h1>{t("auth.recovery.title")}</h1>
        <p>{t("auth.recovery.body")}</p>
      </div>
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}
      <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
        <Input
          label={t("auth.recovery.code")}
          autoComplete="one-time-code"
          mono
          {...(form.formState.errors.code ? { error: t("auth.validation.required") } : {})}
          {...form.register("code")}
        />
        <Input
          label={t("auth.password")}
          type="password"
          autoComplete="current-password"
          {...(form.formState.errors.password ? { error: t("auth.validation.password") } : {})}
          {...form.register("password")}
        />
        <Alert tone="warn">{t("auth.recovery.warning")}</Alert>
        <Button type="submit" fullWidth loading={form.formState.isSubmitting}>
          {t("auth.recovery.submit")}
        </Button>
      </form>
      <Link className="auth-link" to="/login">
        {t("auth.recovery.back")}
      </Link>
    </AuthFrame>
  );
}
