import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { clearPlatformChallenge, isPlatformChallengePending } from "../../auth/challenge.js";
import { AuthFrame } from "./AuthFrame.js";

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const passwordSchema = z.object({ password: z.string().min(8) });

type EnrollmentSecrets = { totpURI: string; backupCodes: string[] };

export function TwoFactor() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const session = auth.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const mode =
    searchParams.get("mode") === "challenge" || isPlatformChallengePending()
      ? "challenge"
      : "enroll";
  const [enrollment, setEnrollment] = useState<EnrollmentSecrets | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const codeForm = useForm<z.infer<typeof codeSchema>>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });
  const passwordForm = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: "" },
  });
  const recoveryNotice = (location.state as { recoveryComplete?: unknown } | null)
    ?.recoveryComplete;

  const beginEnrollment = passwordForm.handleSubmit(async ({ password }) => {
    setSubmitError(null);
    const result = await auth.twoFactor.enable({ password });
    passwordForm.reset();
    if (!result.data || result.error) {
      setSubmitError(result.error?.message ?? t("auth.twoFactor.enrollmentError"));
      return;
    }
    setEnrollment(result.data);
  });

  const verify = codeForm.handleSubmit(async ({ code }) => {
    setSubmitError(null);
    const result = await auth.twoFactor.verifyTotp({ code, trustDevice: false });
    if (result.error) {
      if (result.error.code === "INVALID_TWO_FACTOR_COOKIE") {
        clearPlatformChallenge();
        void navigate("/login", { replace: true });
        return;
      }
      setSubmitError(result.error.message ?? t("auth.twoFactor.codeError"));
      return;
    }
    clearPlatformChallenge();
    codeForm.reset();
    setEnrollment(null);
    await session.refetch?.();
    void navigate("/catalog", { replace: true });
  });

  const title =
    mode === "challenge" ? t("auth.twoFactor.challengeTitle") : t("auth.twoFactor.enrollTitle");

  return (
    <AuthFrame eyebrow={t("auth.twoFactor.eyebrow")}>
      <div className="auth-copy">
        <h1>{title}</h1>
        <p>
          {mode === "challenge"
            ? t("auth.twoFactor.challengeBody")
            : t("auth.twoFactor.enrollBody")}
        </p>
      </div>
      {recoveryNotice ? <Alert tone="info">{t("auth.recovery.completed")}</Alert> : null}
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}
      {mode === "enroll" && !enrollment ? (
        <form className="auth-form" onSubmit={(event) => void beginEnrollment(event)} noValidate>
          <Input
            label={t("auth.password")}
            type="password"
            autoComplete="current-password"
            {...(passwordForm.formState.errors.password
              ? { error: t("auth.validation.password") }
              : {})}
            {...passwordForm.register("password")}
          />
          <Button type="submit" fullWidth loading={passwordForm.formState.isSubmitting}>
            {t("auth.twoFactor.createKey")}
          </Button>
        </form>
      ) : null}
      {enrollment ? (
        <section className="enrollment-secrets" aria-label={t("auth.twoFactor.secretSurface")}>
          <p>{t("auth.twoFactor.secretWarning")}</p>
          <code className="enrollment-uri">{enrollment.totpURI}</code>
          <h2>{t("auth.twoFactor.backupTitle")}</h2>
          <ul className="backup-codes">
            {enrollment.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {mode === "challenge" || enrollment ? (
        <form className="auth-form" onSubmit={(event) => void verify(event)} noValidate>
          <Input
            label={t("auth.twoFactor.code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            mono
            {...(codeForm.formState.errors.code ? { error: t("auth.validation.code") } : {})}
            {...codeForm.register("code")}
          />
          <Button type="submit" fullWidth loading={codeForm.formState.isSubmitting}>
            {t("auth.twoFactor.verify")}
          </Button>
        </form>
      ) : null}
      {mode === "challenge" ? (
        <div className="auth-link-group">
          <Link className="auth-link" to="/recovery">
            {t("auth.twoFactor.useBackup")}
          </Link>
          <Link className="auth-link" to="/login" onClick={clearPlatformChallenge}>
            {t("auth.twoFactor.cancel")}
          </Link>
        </div>
      ) : null}
    </AuthFrame>
  );
}
