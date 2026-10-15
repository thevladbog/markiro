import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, type CSSProperties } from "react";
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
import { StatusDot, type StatusDotTone } from "../lib/StatusDot.js";
import { useAbout } from "./info/about-context.js";
import { OfficeBrandMark } from "./OfficeBrand.js";
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
  /** The link to the host, for the footer's dot; `null` (the default) shows none. */
  link?: HostStatus | null;
}

const LINK_TONE: Readonly<Record<HostStatus["state"], StatusDotTone>> = {
  online: "ok",
  connecting: "warn",
  offline: "error",
};

/** Two letters for an avatar: the login's first two, upper case. */
// A button's inline style beats a sheet, so the pill shapes are given as style.
const GHOST_PILL: CSSProperties = {
  borderRadius: 999,
  background: "transparent",
  borderColor: "transparent",
  color: "var(--fg-2)",
};
const SUBMIT_PILL: CSSProperties = { borderRadius: 999, paddingRight: 6, gap: 12 };

function avatarColor(login: string): string {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 45% 38%)`;
}

function initials(login: string): string {
  return Array.from(login).slice(0, 2).join("").toUpperCase();
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
  link = null,
}: OfficeLoginProps) {
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

  return (
    <div className="office-login">
      <header className="office-login__top">
        <div className="office-login__brand">
          <OfficeBrandMark size={32} />
          <span className="office-login__wordmark">{t("office.login.wordmark")}</span>
        </div>
        <ThemeSwitcher />
      </header>
      <div className="office-login__content">
        <div className="office-login__row">
          <section className="office-login__card" aria-labelledby="office-login-title">
            <h2 id="office-login-title" className="office-login__title">
              {t("office.login.title")}
            </h2>
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
              <div className="office-login__actions">
                {onBack && (
                  <Button
                    variant="secondary"
                    className="office-login__ghost"
                    style={GHOST_PILL}
                    onClick={onBack}
                    disabled={isSubmitting}
                  >
                    {t("office.login.back")}
                  </Button>
                )}
                <Button
                  type="submit"
                  className="office-login__submit"
                  style={SUBMIT_PILL}
                  loading={isSubmitting}
                >
                  {t("office.login.submit")}
                  <span className="office-login__arrow" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 14 14" focusable="false">
                      <path
                        d="M3.5 10.5l7-7M4.5 3.5h6v6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
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
                <p className="office-note">
                  {t("office.login.address.current", { address: hostAddress })}
                </p>
                <div className="standalone-form__actions">
                  <Button variant="secondary" size="compact" onClick={() => setAddressOpen(true)}>
                    {t("office.login.address.open")}
                  </Button>
                </div>
              </div>
            )}
          </section>
          <aside
            className="office-login__card office-login__recent"
            aria-labelledby="office-login-recent"
          >
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
                        variant="secondary"
                        className={
                          login === typed
                            ? "office-login__recent-pick office-login__recent-pick--selected"
                            : "office-login__recent-pick"
                        }
                        aria-label={t("office.login.recent.pick", { login })}
                        aria-pressed={login === typed}
                        onClick={() => pick(login)}
                      >
                        <span
                          className="office-login__avatar"
                          style={{ background: avatarColor(login) }}
                          aria-hidden="true"
                        >
                          {initials(login)}
                        </span>
                        <span className="office-login__recent-name">{login}</span>
                        {login === typed && (
                          <svg
                            className="office-login__check"
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              d="M3 8.5l3.2 3.2L13 4.8"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  size="compact"
                  className="office-login__ghost"
                  style={GHOST_PILL}
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
        <p className="office-login__footer">
          <StatusDot
            tone={link === null ? "neutral" : LINK_TONE[link.state]}
            label={t(link === null ? "link.unknown" : `link.${link.state}`)}
          />
          {link?.state === "offline" && (
            <span className="office-login__nolink">{t("office.login.noLink")}</span>
          )}
          <span>
            {version === null
              ? t("office.login.productBare")
              : t("office.login.product", { version })}
          </span>
          <span aria-hidden="true">·</span>
          <span>{t("office.login.office")}</span>
        </p>
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
