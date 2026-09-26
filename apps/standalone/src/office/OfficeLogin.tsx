import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Input } from "@markiro/ui";

import type { OfficeLoginNotice } from "../app/shell.js";
import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";

const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required"),
  password: z.string().min(1, "office.login.required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export interface OfficeLoginProps {
  notice: OfficeLoginNotice | null;
  /**
   * Rejects with a `HostError` the form explains. A function-typed property
   * (not a TS method) so it can be passed around unbound without tripping
   * `@typescript-eslint/unbound-method`.
   */
  onLogin: (request: OfficeLoginRequest) => Promise<void>;
  onBack: () => void;
}

const NOTICE_TEXT: Readonly<Record<OfficeLoginNotice, string>> = {
  session_ended: "office.login.sessionEnded",
  already_initialized: "office.login.alreadyInitialized",
};

export function OfficeLogin({ notice, onLogin, onBack }: OfficeLoginProps) {
  const { t } = useTranslation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { login: "", password: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await onLogin({ login: values.login, password: values.password });
    } catch (error) {
      setSubmitError(errorMessageKey(error));
    }
  });

  return (
    <Card className="standalone-card" title={t("office.login.title")} titleAs="h2">
      <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
        {notice && <Alert tone="info">{t(NOTICE_TEXT[notice])}</Alert>}
        {submitError && <Alert tone="error">{t(submitError)}</Alert>}
        <Input
          label={t("office.login.login")}
          autoComplete="username"
          {...fieldError(errors.login?.message)}
          {...register("login")}
        />
        <Input
          type="password"
          autoComplete="current-password"
          label={t("office.login.password")}
          {...fieldError(errors.password?.message)}
          {...register("password")}
        />
        <div className="standalone-form__actions">
          <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
            {t("office.login.back")}
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
