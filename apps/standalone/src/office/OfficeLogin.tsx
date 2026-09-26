import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Input } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";

const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required"),
  password: z.string().min(1, "office.login.required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export interface OfficeLoginProps {
  notice: "session_ended" | null;
  /**
   * Rejects with a `HostError` the form explains. A function-typed property
   * (not a TS method) so it can be passed around unbound without tripping
   * `@typescript-eslint/unbound-method`.
   */
  onLogin: (request: OfficeLoginRequest) => Promise<void>;
  onBack: () => void;
}

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
        {notice === "session_ended" && <Alert tone="info">{t("office.login.sessionEnded")}</Alert>}
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
          {/*
           * Hidden rather than merely disabled while submitting: this button's
           * label ("office.login.back") is the same RU string as the office
           * shell's "leave office" button ("office.header.toFloor"), both
           * "В цех". A disabled button still matches `getByRole`, so a test
           * that waits for that role+name right after signing in can grab
           * this (inert) button instead of the shell's, before the async
           * login settles. Removing it from the tree while submitting makes
           * the wait unambiguous.
           */}
          {!isSubmitting && (
            <Button variant="secondary" onClick={onBack}>
              {t("office.login.back")}
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
