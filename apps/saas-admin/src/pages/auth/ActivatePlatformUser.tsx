import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { platformApiFetch } from "../../api/client.js";
import { AuthFrame } from "./AuthFrame.js";

interface ActivationResponse {
  twoFactorEnrollmentRequired: true;
}

const activationSchema = z
  .object({
    password: z.string().min(8),
    confirmation: z.string().min(8),
  })
  .refine((value) => value.password === value.confirmation, { path: ["confirmation"] });

type ActivationValues = z.infer<typeof activationSchema>;

export function ActivatePlatformUser() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tokenRef = useRef(searchParams.get("token"));
  const exchangedRef = useRef(false);
  const [complete, setComplete] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<ActivationValues>({
    resolver: zodResolver(activationSchema),
    defaultValues: { password: "", confirmation: "" },
  });

  useEffect(() => {
    void navigate("/activate", { replace: true });
    if (window.location.search.includes("token=")) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, [navigate]);

  const submit = form.handleSubmit(async ({ password }) => {
    const token = tokenRef.current;
    if (!token || exchangedRef.current) {
      setSubmitError(t("auth.activation.unavailable"));
      return;
    }
    exchangedRef.current = true;
    tokenRef.current = null;
    setSubmitError(null);
    try {
      await platformApiFetch<ActivationResponse>("/activation/complete", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      form.reset();
      setComplete(true);
    } catch {
      setSubmitError(t("auth.activation.unavailable"));
    }
  });

  return (
    <AuthFrame eyebrow={t("auth.activation.eyebrow")}>
      {complete ? (
        <div className="auth-success" aria-live="polite">
          <span className="auth-success__glyph" aria-hidden="true">
            ✓
          </span>
          <h1>{t("auth.activation.successTitle")}</h1>
          <p>{t("auth.activation.successBody")}</p>
          <Link className="auth-primary-link" to="/login">
            {t("auth.activation.toLogin")}
          </Link>
        </div>
      ) : (
        <>
          <div className="auth-copy">
            <h1>{t("auth.activation.title")}</h1>
            <p>{t("auth.activation.subtitle")}</p>
          </div>
          {!tokenRef.current ? <Alert tone="warn">{t("auth.activation.noToken")}</Alert> : null}
          {submitError ? <Alert tone="error">{submitError}</Alert> : null}
          <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
            <Input
              label={t("auth.activation.password")}
              type="password"
              autoComplete="new-password"
              {...(form.formState.errors.password ? { error: t("auth.validation.password") } : {})}
              {...form.register("password")}
            />
            <Input
              label={t("auth.activation.confirmation")}
              type="password"
              autoComplete="new-password"
              {...(form.formState.errors.confirmation
                ? { error: t("auth.validation.confirmation") }
                : {})}
              {...form.register("confirmation")}
            />
            <Button
              type="submit"
              fullWidth
              disabled={!tokenRef.current}
              loading={form.formState.isSubmitting}
            >
              {t("auth.activation.submit")}
            </Button>
          </form>
        </>
      )}
    </AuthFrame>
  );
}
