import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Checkbox, Input, Select, useTheme } from "@markiro/ui";
import i18next from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { createUsBrowserClient, UsClientError, type UsBrowserClient } from "./client.js";

const copy = {
  "en-US": {
    translation: {
      brandTitle: "Lot records, from receipt to shipment.",
      brandBody: "Traceability built for daily operations.",
      signIn: "Sign in",
      signInBody: "Use the account provided by your organization.",
      email: "Email",
      password: "Password",
      language: "Language",
      english: "English",
      spanish: "Español",
      theme: "Change theme",
      deploymentBlocked: "This interface could not verify the U.S. deployment.",
      retry: "Try again",
      genericError: "The request could not be completed. Try again.",
      stale: "Your password session is no longer MFA-verified. Sign in again.",
      enrollTitle: "Set up multi-factor authentication",
      enrollBody: "A fresh authenticator is required before organization access.",
      confirmPassword: "Confirm password",
      setupAuthenticator: "Set up authenticator",
      manualKey: "Manual authenticator setup key",
      backupCodes: "Backup codes",
      savedCodes: "I saved these backup codes",
      totpCode: "6-digit authenticator code",
      verify: "Verify",
      conflictEnrollment:
        "An authenticator is already enrolled. Verify with the key you already saved. Lost-key replacement is unavailable.",
      challengeTitle: "Verify your identity",
      backupInstead: "Use a backup code",
      totpInstead: "Use an authenticator code",
      backupCode: "Backup code",
      organizationsTitle: "Select an organization",
      organizationsBody: "Choose the organization you want to access.",
      noOrganizations:
        "No organization is available for this account. Organization creation is unavailable.",
      signOut: "Sign out",
      logoutFailed: "Server sign-out failed. Your session may still be active.",
      profileSetup: "Set up traceability profile",
      profileSetupBody:
        "Choose the initial U.S. traceability configuration. It cannot be silently replaced.",
      profile: "Regulatory profile",
      processor: "FSMA 204 processor",
      generic: "Generic lot traceability",
      timeZone: "Time zone",
      retention: "Retention (calendar years)",
      saveProfile: "Save profile",
      profileTitle: "Traceability profile",
      baseline: "Regulatory baseline",
      effective: "Effective",
      unfinished:
        "Receiving, transformation, shipping, plan, request, and export workflows are not yet implemented.",
      profileConflict:
        "A different profile already exists. Reload the server profile instead of overwriting it.",
      reload: "Reload server profile",
      denied: "You do not have permission to view or configure this profile.",
      unavailable: "The profile service is unavailable. Setup has not been opened.",
      pending: "Working…",
      sessionExpired: "Your session expired. Sign in again.",
      accessUnavailable: "Account access is unavailable. Try again.",
      organization: "Organization",
      staleLogoutFailed:
        "Your password session is no longer MFA-verified. Sign in again. Server sign-out failed. Your session may still be active.",
    },
  },
  "es-US": {
    translation: {
      brandTitle: "Registros de lotes, desde la recepción hasta el envío.",
      brandBody: "Trazabilidad creada para las operaciones diarias.",
      signIn: "Iniciar sesión",
      signInBody: "Use la cuenta proporcionada por su organización.",
      email: "Correo electrónico",
      password: "Contraseña",
      language: "Idioma",
      english: "English",
      spanish: "Español",
      theme: "Cambiar tema",
      deploymentBlocked: "Esta interfaz no pudo verificar la implementación de EE. UU.",
      retry: "Intentar de nuevo",
      genericError: "No se pudo completar la solicitud. Inténtelo de nuevo.",
      stale: "Su sesión de contraseña ya no está verificada con MFA. Inicie sesión de nuevo.",
      enrollTitle: "Configurar autenticación multifactor",
      enrollBody: "Se requiere un autenticador nuevo antes de acceder a la organización.",
      confirmPassword: "Confirmar contraseña",
      setupAuthenticator: "Configurar autenticador",
      manualKey: "Clave de configuración manual del autenticador",
      backupCodes: "Códigos de respaldo",
      savedCodes: "Guardé estos códigos de respaldo",
      totpCode: "Código de autenticador de 6 dígitos",
      verify: "Verificar",
      conflictEnrollment:
        "Ya existe un autenticador. Verifique con la clave que guardó. El reemplazo de una clave perdida no está disponible.",
      challengeTitle: "Verifique su identidad",
      backupInstead: "Usar un código de respaldo",
      totpInstead: "Usar un código del autenticador",
      backupCode: "Código de respaldo",
      organizationsTitle: "Seleccione una organización",
      organizationsBody: "Elija la organización a la que desea acceder.",
      noOrganizations:
        "No hay ninguna organización disponible para esta cuenta. La creación de organizaciones no está disponible.",
      signOut: "Cerrar sesión",
      logoutFailed: "El cierre de sesión del servidor falló. Su sesión puede seguir activa.",
      profileSetup: "Configurar perfil de trazabilidad",
      profileSetupBody:
        "Elija la configuración inicial de trazabilidad de EE. UU. No se puede reemplazar silenciosamente.",
      profile: "Perfil regulatorio",
      processor: "Procesador FSMA 204",
      generic: "Trazabilidad genérica de lotes",
      timeZone: "Zona horaria",
      retention: "Retención (años calendario)",
      saveProfile: "Guardar perfil",
      profileTitle: "Perfil de trazabilidad",
      baseline: "Base regulatoria",
      effective: "Vigente desde",
      unfinished:
        "Los flujos de recepción, transformación, envío, plan, solicitud y exportación aún no están implementados.",
      profileConflict:
        "Ya existe un perfil diferente. Recargue el perfil del servidor en lugar de sobrescribirlo.",
      reload: "Recargar perfil del servidor",
      denied: "No tiene permiso para ver o configurar este perfil.",
      unavailable: "El servicio de perfiles no está disponible. No se abrió la configuración.",
      pending: "Procesando…",
      sessionExpired: "Su sesión venció. Inicie sesión de nuevo.",
      accessUnavailable: "El acceso a la cuenta no está disponible. Inténtelo de nuevo.",
      organization: "Organización",
      staleLogoutFailed:
        "Su sesión de contraseña ya no está verificada con MFA. Inicie sesión de nuevo. El cierre de sesión del servidor falló. Su sesión puede seguir activa.",
    },
  },
} as const;

const zones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
] as const;
type Stage =
  | "loading"
  | "blocked"
  | "signin"
  | "enroll"
  | "challenge"
  | "organizations"
  | "profile-setup"
  | "profile"
  | "profile-error"
  | "access-error";
type Org = Awaited<ReturnType<UsBrowserClient["organizations"]>>[number];
type Profile = Awaited<ReturnType<UsBrowserClient["profile"]>>;
type Enrollment = Awaited<ReturnType<UsBrowserClient["enroll"]>>;

export function UsApp({ client }: { client?: UsBrowserClient }) {
  const instance = useMemo(() => {
    const i = i18next.createInstance();
    void i.init({
      resources: copy,
      lng: "en-US",
      fallbackLng: "en-US",
      supportedLngs: ["en-US", "es-US"],
      interpolation: { escapeValue: false },
      initAsync: false,
    });
    return i;
  }, []);
  return (
    <I18nextProvider i18n={instance}>
      <UsApplication client={client ?? createUsBrowserClient()} />
    </I18nextProvider>
  );
}

function UsApplication({ client }: { client: UsBrowserClient }) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [stage, setStage] = useState<Stage>("loading");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enrollPassword, setEnrollPassword] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [ack, setAck] = useState(false);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [organizations, setOrganizations] = useState<Org[]>([]);
  const [selectedOrganization, setSelectedOrganization] = useState<Org>();
  const [profile, setProfile] = useState<Profile>();
  const [profileCode, setProfileCode] = useState<
    "" | "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY"
  >("");
  const [timeZone, setTimeZone] = useState<"" | (typeof zones)[number]>("");
  const [retention, setRetention] = useState("5");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const activeOperation = useRef<Promise<void> | null>(null);
  const logoutOperation = useRef<Promise<void> | null>(null);

  function clearAccountState() {
    setEmail("");
    setPassword("");
    setEnrollPassword("");
    setEnrollment(undefined);
    setAck(false);
    setCode("");
    setBackup(false);
    setOrganizations([]);
    setSelectedOrganization(undefined);
    setProfile(undefined);
    setProfileCode("");
    setTimeZone("");
    setRetention("5");
  }
  function sessionLost() {
    generation.current += 1;
    inFlight.current = false;
    clearAccountState();
    setPending(false);
    setNotice("sessionExpired");
    setStage("signin");
  }

  async function establish(run: number) {
    const session = await client.session();
    if (run !== generation.current) return;
    if (!session) {
      setStage("signin");
      return;
    }
    if (!session.user.twoFactorEnabled) {
      setStage("enroll");
      return;
    }
    try {
      const orgs = await client.organizations();
      if (run !== generation.current) return;
      setOrganizations(orgs);
      setSelectedOrganization(orgs.find((org) => org.id === session.activeOrganizationId));
      if (!orgs.length) setStage("organizations");
      else if (session.activeOrganizationId) await readProfile(run);
      else setStage("organizations");
    } catch (error) {
      if (run !== generation.current) return;
      if (
        error instanceof UsClientError &&
        (error.code === "forbidden" || error.code === "session_required")
      ) {
        let logoutFailed = false;
        try {
          await client.signOut();
        } catch {
          logoutFailed = true;
        }
        if (run !== generation.current) return;
        setNotice(logoutFailed ? "staleLogoutFailed" : "stale");
        setStage("signin");
      } else throw error;
    }
  }
  async function boot() {
    const run = ++generation.current;
    setNotice("");
    setStage("loading");
    try {
      await client.deployment();
    } catch {
      if (run === generation.current) setStage("blocked");
      return;
    }
    if (run !== generation.current) return;
    try {
      await establish(run);
    } catch {
      if (run === generation.current) {
        setNotice("accessUnavailable");
        setStage("access-error");
      }
    }
  }
  // Boot once for the injected transport. A generation token makes late responses inert.
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en-US";
  }, [i18n.resolvedLanguage]);
  useEffect(() => {
    void boot();
    return () => {
      generation.current += 1;
    };
    // This effect deliberately owns the one initial attestation/session read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function readProfile(run = generation.current) {
    try {
      const value = await client.profile();
      if (run !== generation.current) return;
      setProfile(value);
      setStage("profile");
    } catch (error) {
      if (run !== generation.current) return;
      if (error instanceof UsClientError && error.code === "profile_not_provisioned")
        setStage("profile-setup");
      else if (error instanceof UsClientError && error.code === "session_required") sessionLost();
      else {
        setNotice(
          error instanceof UsClientError && error.code === "forbidden" ? "denied" : "unavailable",
        );
        setStage("profile-error");
      }
    }
  }
  async function action(work: (run: number) => Promise<void>) {
    if (inFlight.current || logoutOperation.current) return;
    inFlight.current = true;
    const run = generation.current;
    setPending(true);
    setNotice("");
    const operation = (async () => {
      try {
        await work(run);
      } catch (error) {
        if (run !== generation.current) return;
        if (error instanceof UsClientError && error.code === "session_required") {
          sessionLost();
          return;
        }
        setNotice(
          error instanceof UsClientError && error.code === "forbidden" ? "denied" : "genericError",
        );
      } finally {
        if (run === generation.current) {
          inFlight.current = false;
          setPending(false);
        }
      }
    })();
    activeOperation.current = operation;
    await operation;
    if (activeOperation.current === operation) activeOperation.current = null;
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    await action(async (run) => {
      const result = await client.signIn({ email, password });
      if (run !== generation.current) return;
      setPassword("");
      if (result.step === "mfa_required") setStage("challenge");
      else setStage("enroll");
    });
  }
  async function enroll(event: FormEvent) {
    event.preventDefault();
    await action(async (run) => {
      try {
        const value = await client.enroll({ password: enrollPassword });
        if (run !== generation.current) return;
        setEnrollment(value);
        setEnrollPassword("");
      } catch (error) {
        if (run !== generation.current) return;
        if (error instanceof UsClientError && error.code === "conflict") {
          setNotice("conflictEnrollment");
          setEnrollment(undefined);
          setStage("challenge");
        } else throw error;
      }
    });
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    await action(async (run) => {
      if (backup) await client.verifyBackupCode({ code });
      else await client.verifyTotp({ code });
      if (run !== generation.current) return;
      setEnrollment(undefined);
      setCode("");
      setAck(false);
      await establish(generation.current);
    });
  }
  async function choose(org: Org) {
    await action(async (run) => {
      await client.selectOrganization({ organizationId: org.id });
      if (run !== generation.current) return;
      setSelectedOrganization(org);
      setProfile(undefined);
      setProfileCode("");
      setTimeZone("");
      setRetention("5");
      await readProfile(run);
    });
  }
  async function logout() {
    if (logoutOperation.current) {
      await logoutOperation.current;
      return;
    }
    const precedingOperation = activeOperation.current;
    generation.current += 1;
    clearAccountState();
    setNotice("");
    setLogoutPending(true);
    const operation = (async () => {
      if (precedingOperation) await precedingOperation;
      try {
        await client.signOut();
        setStage("signin");
      } catch {
        setNotice("logoutFailed");
        setStage("signin");
      } finally {
        inFlight.current = false;
        setPending(false);
        setLogoutPending(false);
      }
    })();
    logoutOperation.current = operation;
    await operation;
    if (logoutOperation.current === operation) logoutOperation.current = null;
  }
  async function provision(event: FormEvent) {
    event.preventDefault();
    if (!profileCode || !timeZone) return;
    await action(async (run) => {
      try {
        const value = await client.provisionProfile({
          code: profileCode,
          timeZone,
          retentionYears: Number(retention),
        });
        if (run !== generation.current) return;
        setProfile(value);
        setStage("profile");
      } catch (error) {
        if (run !== generation.current) return;
        if (error instanceof UsClientError && error.code === "conflict") {
          setNotice("profileConflict");
        } else throw error;
      }
    });
  }
  async function reloadProfile() {
    await action(async (run) => {
      await readProfile(run);
    });
  }
  const secret = enrollment ? new URL(enrollment.totpURI).searchParams.get("secret") : null;

  return (
    <main className="us-app">
      <aside className="us-brand">
        <div className="us-wordmark" aria-label="Markiro">
          markiro
        </div>
        <div>
          <h2>{t("brandTitle")}</h2>
          <p>{t("brandBody")}</p>
        </div>
        <small>Markiro US</small>
      </aside>
      <section className="us-pane">
        <div className="us-tools">
          <Button
            size="compact"
            variant="secondary"
            aria-label={t("language")}
            onClick={() => void i18n.changeLanguage(i18n.language === "es-US" ? "en-US" : "es-US")}
          >
            {i18n.language === "es-US" ? t("english") : t("spanish")}
          </Button>
          <Button
            size="compact"
            variant="secondary"
            aria-label={t("theme")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀" : "☾"}
          </Button>
        </div>
        <div className="us-card" aria-busy={pending}>
          {notice && (
            <div className="us-notice" role="alert">
              {t(notice)}
            </div>
          )}
          {stage === "loading" && <p>{t("pending")}</p>}
          {stage === "blocked" && (
            <>
              <h1>{t("deploymentBlocked")}</h1>
              <Button onClick={() => void boot()}>{t("retry")}</Button>
            </>
          )}
          {stage === "access-error" && <Button onClick={() => void boot()}>{t("retry")}</Button>}
          {stage === "signin" && (
            <>
              <h1>{t("signIn")}</h1>
              <p>{t("signInBody")}</p>
              <form onSubmit={(event) => void login(event)}>
                <Input
                  label={t("email")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="username"
                  required
                />
                <Input
                  label={t("password")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                  required
                />
                <Button type="submit" fullWidth loading={pending}>
                  {t("signIn")}
                </Button>
              </form>
            </>
          )}
          {stage === "enroll" && (
            <>
              <h1>{t("enrollTitle")}</h1>
              <p>{t("enrollBody")}</p>
              {!enrollment ? (
                <form onSubmit={(event) => void enroll(event)}>
                  <Input
                    label={t("confirmPassword")}
                    value={enrollPassword}
                    onChange={(e) => setEnrollPassword(e.target.value)}
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                  <Button type="submit" fullWidth loading={pending}>
                    {t("setupAuthenticator")}
                  </Button>
                </form>
              ) : (
                <>
                  <dl>
                    <dt>{t("manualKey")}</dt>
                    <dd className="us-secret">{secret}</dd>
                    <dt>{t("backupCodes")}</dt>
                    {enrollment.backupCodes.map((item) => (
                      <dd className="us-secret" key={item}>
                        {item}
                      </dd>
                    ))}
                  </dl>
                  <Checkbox
                    className="us-check"
                    checked={ack}
                    onCheckedChange={setAck}
                    label={t("savedCodes")}
                  />
                  {verificationForm(!ack)}
                </>
              )}
              <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
                {t("signOut")}
              </Button>
            </>
          )}
          {stage === "challenge" && (
            <>
              <h1>{t("challengeTitle")}</h1>
              {verificationForm()}
              <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
                {t("signOut")}
              </Button>
            </>
          )}
          {stage === "organizations" && (
            <>
              <h1>{t("organizationsTitle")}</h1>
              <p>{organizations.length ? t("organizationsBody") : t("noOrganizations")}</p>
              <div className="us-stack">
                {organizations.map((org) => (
                  <Button key={org.id} variant="secondary" onClick={() => void choose(org)}>
                    {org.name}
                  </Button>
                ))}
              </div>
              <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
                {t("signOut")}
              </Button>
            </>
          )}
          {stage === "profile-setup" && (
            <>
              <h1>{t("profileSetup")}</h1>
              {selectedOrganization && (
                <p>
                  {t("organization")}: {selectedOrganization.name}
                </p>
              )}
              <p>{t("profileSetupBody")}</p>
              <form onSubmit={(event) => void provision(event)}>
                <Select
                  native
                  required
                  placeholder={t("profile")}
                  label={t("profile")}
                  value={profileCode}
                  onValueChange={setProfileCode}
                  options={[
                    { value: "US_FSMA204_PROCESSOR", label: t("processor") },
                    { value: "US_GENERIC_LOT_TRACEABILITY", label: t("generic") },
                  ]}
                />
                <Select
                  native
                  required
                  placeholder={t("timeZone")}
                  label={t("timeZone")}
                  value={timeZone}
                  onValueChange={setTimeZone}
                  options={zones.map((value) => ({ value, label: value }))}
                />
                <Input
                  label={t("retention")}
                  type="number"
                  min={2}
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                  required
                />
                <Button type="submit" fullWidth loading={pending}>
                  {t("saveProfile")}
                </Button>
              </form>
              {notice === "profileConflict" && (
                <Button variant="secondary" onClick={() => void reloadProfile()}>
                  {t("reload")}
                </Button>
              )}
              <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
                {t("signOut")}
              </Button>
            </>
          )}
          {stage === "profile" && profile && (
            <>
              <h1>{t("profileTitle")}</h1>
              {selectedOrganization && (
                <p>
                  {t("organization")}: {selectedOrganization.name}
                </p>
              )}
              <dl className="us-summary">
                <dt>{t("profile")}</dt>
                <dd>
                  {t(profile.code === "US_FSMA204_PROCESSOR" ? "processor" : "generic")}{" "}
                  <small>({profile.code})</small>
                </dd>
                <dt>{t("timeZone")}</dt>
                <dd>{profile.timeZone}</dd>
                <dt>{t("retention")}</dt>
                <dd>{profile.retentionYears}</dd>
                <dt>{t("baseline")}</dt>
                <dd>{profile.baselineVersion}</dd>
                <dt>{t("effective")}</dt>
                <dd>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "medium",
                    timeZone: profile.timeZone,
                  }).format(new Date(profile.effectiveAt))}
                </dd>
              </dl>
              <p className="us-notice">{t("unfinished")}</p>
              <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
                {t("signOut")}
              </Button>
            </>
          )}
          {stage === "profile-error" && (
            <Button variant="secondary" disabled={logoutPending} onClick={() => void logout()}>
              {t("signOut")}
            </Button>
          )}
        </div>
      </section>
    </main>
  );

  function verificationForm(disabled = false) {
    return (
      <form onSubmit={(event) => void verify(event)}>
        <Input
          label={t(backup ? "backupCode" : "totpCode")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode={backup ? undefined : "numeric"}
          required
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setBackup(!backup);
            setCode("");
          }}
        >
          {t(backup ? "totpInstead" : "backupInstead")}
        </Button>
        <Button type="submit" fullWidth disabled={disabled || !code} loading={pending}>
          {t("verify")}
        </Button>
      </form>
    );
  }
}
