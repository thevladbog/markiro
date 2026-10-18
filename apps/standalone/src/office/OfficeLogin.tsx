import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { HostAddressDialog } from "../app/HostAddressDialog.js";
import type { OfficeLoginNotice } from "../app/shell.js";
import { errorMessageKey } from "../host/errors.js";
import type { HostStatus, OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";
import { isTransferable } from "../lib/rules.js";
import type { StatusDotTone } from "../lib/StatusDot.js";
import { useAbout } from "./info/about-context.js";
import { OfficeBrandMark } from "./OfficeBrand.js";
import { useKitScope } from "./kit-scope.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { PasswordInput } from "./PasswordInput.js";
import { userInitials } from "./user-avatar.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";
import { clearLogins, readRecentLogins, rememberLogin } from "./recent-logins.js";

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
  /** The link to the host, for the chip at the top right; `null` (the default) shows none. */
  link?: HostStatus | null;
}

const LINK_TONE: Readonly<Record<HostStatus["state"], StatusDotTone>> = {
  online: "ok",
  connecting: "warn",
  offline: "error",
};

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
  link = null,
}: OfficeLoginProps) {
  useKitScope();
  const { t } = useTranslation();
  const about = useAbout();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressChanged, setAddressChanged] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecentLogins());
  const [version, setVersion] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { login: "", password: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  useEffect(() => {
    let alive = true;
    // The version is a quiet footer: where the shell cannot tell it, there is none.
    void about
      .appVersion()
      .then((value) => {
        if (alive) setVersion(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [about]);

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await onLogin({ login: values.login, password: values.password });
    } catch (error) {
      setSubmitError(errorMessageKey(error));
      return;
    }
    // Remembered only after the host let the person in; names only, nothing else.
    rememberLogin(values.login);
  });

  const typed = watch("login").trim();
  const pick = (login: string) => {
    setValue("login", login, { shouldValidate: true });
    setFocus("password");
  };

  const failed = submitError !== null;
  const linkChip =
    link === null
      ? null
      : {
          tone: LINK_TONE[link.state],
          icon: link.state === "offline" ? ("wifiSlash" as const) : ("wifi" as const),
          text: t(`office.login.link.${link.state}`),
        };

  return (
    <div className="office-login">
      <header className="office-login__top">
        <div className="office-login__brand">
          <OfficeBrandMark size={40} />
          <span className="office-login__wordmark">{t("office.login.wordmark")}</span>
        </div>
        <div className="office-login__tools">
          {linkChip !== null && (
            <span
              className={`office-chip office-chip--${linkChip.tone}`}
              role="status"
              aria-label={t(`link.${link?.state ?? "online"}`)}
            >
              <OfficeIcon name={linkChip.icon} size={16} />
              <span>{linkChip.text}</span>
            </span>
          )}
          <ThemeSwitcher />
        </div>
      </header>
      <div className="office-login__content">
        <div className="office-login__card">
          <section aria-labelledby="office-login-title" className="office-login__main">
            <p className="office-login__product">
              {version === null
                ? t("office.login.productBare")
                : t("office.login.product", { version })}
            </p>
            <h2 id="office-login-title" className="office-login__title">
              {t("office.login.title")}
            </h2>
            <form
              className="standalone-form office-login__form"
              data-failed={failed ? "" : undefined}
              onSubmit={(event) => void submit(event)}
              noValidate
            >
              {notice && <Alert tone="info">{t(NOTICE_TEXT[notice])}</Alert>}
              {submitError && <Alert tone="error">{t(submitError)}</Alert>}
              <Input
                label={t("office.login.login")}
                autoComplete="username"
                {...(failed ? { "aria-invalid": true } : {})}
                {...fieldError(errors.login?.message)}
                {...register("login")}
              />
              <PasswordInput
                autoComplete="current-password"
                label={t("office.login.password")}
                {...(failed ? { "aria-invalid": true } : {})}
                {...fieldError(errors.password?.message)}
                {...register("password")}
              />
              <Button
                type="submit"
                className="office-login__submit"
                fullWidth
                loading={isSubmitting}
              >
                {t("office.login.submit")}
              </Button>
              {onBack && (
                <Button
                  variant="ghost"
                  className="office-login__ghost"
                  icon={<OfficeIcon name="arrowLeft" size={18} />}
                  onClick={onBack}
                  disabled={isSubmitting}
                >
                  {t("office.login.back")}
                </Button>
              )}
            </form>
          </section>
          <aside className="office-login__recent" aria-labelledby="office-login-recent">
            <h3 id="office-login-recent" className="office-login__recent-title">
              {t("office.login.recent.title")}
            </h3>
            {recent.length === 0 ? (
              <p className="office-note">{t("office.login.recent.empty")}</p>
            ) : (
              <>
                <ul className="office-login__recent-list">
                  {recent.map((login) => (
                    <li key={login}>
                      <Button
                        variant="plain"
                        className={
                          login === typed
                            ? "office-login__recent-pick office-login__recent-pick--selected"
                            : "office-login__recent-pick"
                        }
                        aria-label={t("office.login.recent.pick", { login })}
                        aria-pressed={login === typed}
                        onClick={() => pick(login)}
                      >
                        <span className="office-login__avatar" aria-hidden="true">
                          {userInitials(login)}
                        </span>
                        <span className="office-login__recent-name">{login}</span>
                        {login === typed ? (
                          <OfficeIcon name="check" size={18} className="office-login__check" />
                        ) : (
                          <OfficeIcon name="arrowRight" size={18} className="office-login__go" />
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="plain"
                  className="office-login__clear"
                  onClick={() => {
                    clearLogins();
                    setRecent([]);
                  }}
                >
                  {t("office.login.recent.clear")}
                </Button>
              </>
            )}
            <p className="office-note">{t("office.login.recent.note")}</p>
          </aside>
        </div>
        {hostAddress !== null && onChangeAddress && (
          <div className="office-login__footer">
            <div aria-live="polite">
              {addressChanged && (
                <Alert tone="ok" role="presentation">
                  {t("office.login.address.done", { address: addressChanged })}
                </Alert>
              )}
            </div>
            <p className="office-note office-login__address">
              <span>{t("office.login.address.current", { address: hostAddress })}</span>
              <Button variant="ghost" size="compact" onClick={() => setAddressOpen(true)}>
                {t("office.login.address.open")}
              </Button>
            </p>
          </div>
        )}
      </div>
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
    </div>
  );
}
