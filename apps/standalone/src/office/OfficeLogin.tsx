import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Input } from "@markiro/ui";

import { HostAddressDialog } from "../app/HostAddressDialog.js";
import type { OfficeLoginNotice } from "../app/shell.js";
import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";
import { isTransferable } from "../lib/rules.js";

// An unpaired surrogate (pasted half of an emoji) cannot reach the host: the
// IPC call would fail as a lost connection, so the form refuses it first.
const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required").refine(isTransferable, "rules.login"),
  password: z
    .string()
    .min(1, "office.login.required")
    .refine(isTransferable, "rules.passwordCharacter"),
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
  /** Back to the floor; `null` on an office PC, which has no floor (plan УСТ). */
  onBack: (() => void) | null;
  /**
   * The paired host's address when it is another computer's, with
   * «Сменить адрес хоста» (plan УСТ); `null` (the default) shows neither.
   */
  hostAddress?: string | null;
  /** Moves the pairing to a new address; rejects with a `DeviceError`. */
  onChangeAddress?: (address: string) => Promise<void>;
}

const NOTICE_TEXT: Readonly<Record<OfficeLoginNotice, string>> = {
  session_ended: "office.login.sessionEnded",
  already_initialized: "office.login.alreadyInitialized",
};

export function OfficeLogin({
  notice,
  onLogin,
  onBack,
  hostAddress = null,
  onChangeAddress,
}: OfficeLoginProps) {
  const { t } = useTranslation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressChanged, setAddressChanged] = useState<string | null>(null);
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
          {onBack && (
            <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
              {t("office.login.back")}
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
          </Button>
        </div>
      </form>
      {hostAddress !== null && onChangeAddress && (
        <div className="standalone-form">
          <div aria-live="polite">
            {addressChanged && (
              <Alert tone="ok" role="presentation">
                {t("office.login.address.done", { address: addressChanged })}
              </Alert>
            )}
          </div>
          <p>{t("office.login.address.current", { address: hostAddress })}</p>
          <div className="standalone-form__actions">
            <Button variant="secondary" onClick={() => setAddressOpen(true)}>
              {t("office.login.address.open")}
            </Button>
          </div>
        </div>
      )}
      {addressOpen && onChangeAddress && (
        <HostAddressDialog
          onChange={async (address) => {
            await onChangeAddress(address);
            setAddressOpen(false);
            setAddressChanged(address);
          }}
          onClose={() => setAddressOpen(false)}
        />
      )}
    </Card>
  );
}
