import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SqlExecutor } from "../lib/mirror.js";
import { readOperatorsMirror } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import { padShortOperatorLogin, verifyOperatorBadge, verifyOperatorPin } from "../lib/auth.js";
import type { OperatorSearchResult } from "../lib/operator-search.js";
import { OperatorNameSearch } from "../ui/OperatorNameSearch.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  source: ScanSource;
  onAuthed: (operator: OperatorMirrorRecord) => void;
  notice?: ReactNode;
}

type LoginStage = "badge" | "login" | "pin" | "search";

/** Badge-first fixed-viewport operator sign-in with bounded offline fallbacks. */
export function OperatorLogin({ exec, source, onAuthed, notice }: OperatorLoginProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<LoginStage>("badge");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [pinOrigin, setPinOrigin] = useState<"login" | "search">("login");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [roster, setRoster] = useState<OperatorMirrorRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authInFlight = useRef(false);
  const admitted = useRef(false);
  const mounted = useRef(true);
  const live = useRef({ exec, onAuthed, t });
  live.current = { exec, onAuthed, t };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let currentSource = true;
    const stop = source.start((raw) => {
      if (!mounted.current || !currentSource || admitted.current || authInFlight.current) return;
      authInFlight.current = true;
      setError(null);
      setBusy(true);
      void (async () => {
        try {
          const operator = await verifyOperatorBadge(live.current.exec, raw);
          if (!mounted.current || !currentSource) return;
          if (!operator) {
            setError(live.current.t("login.badgeWrong"));
            return;
          }
          admitted.current = true;
          live.current.onAuthed(operator);
        } catch (err) {
          console.error("station: verifyOperatorBadge failed", err);
          if (mounted.current && currentSource) {
            setError(live.current.t("login.badgeWrong"));
          }
        } finally {
          authInFlight.current = false;
          if (mounted.current && !admitted.current) setBusy(false);
        }
      })();
    });
    return () => {
      currentSource = false;
      stop();
    };
  }, [source]);

  async function openNameSearch() {
    if (admitted.current || authInFlight.current) return;
    authInFlight.current = true;
    source.clearPendingInput?.();
    setError(null);
    setBusy(true);
    setStage("search");
    try {
      const operators = await readOperatorsMirror(exec);
      if (mounted.current) setRoster(operators);
    } catch (err) {
      console.error("station: readOperatorsMirror failed", err);
      if (mounted.current) setError(t("login.searchUnavailable"));
    } finally {
      authInFlight.current = false;
      if (mounted.current && !admitted.current) setBusy(false);
    }
  }

  async function submit() {
    if (admitted.current || authInFlight.current) return;
    authInFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      let operator: OperatorMirrorRecord | null;
      try {
        operator = await verifyOperatorPin(exec, login, pin);
      } catch (err) {
        // A failed boot migration is presented in the same reserved slot as
        // any other failed credential check, never as an unhandled rejection.
        console.error("station: verifyOperatorPin failed", err);
        operator = null;
      }
      if (operator) {
        if (!mounted.current) return;
        admitted.current = true;
        live.current.onAuthed(operator);
        return;
      }
      if (!mounted.current) return;
      setError(live.current.t("login.wrong"));
      setPin("");
    } finally {
      authInFlight.current = false;
      if (mounted.current && !admitted.current) setBusy(false);
    }
  }

  function moveToPin(exactLogin: string, origin: "login" | "search", name: string | null) {
    setError(null);
    setPin("");
    setLogin(exactLogin);
    setPinOrigin(origin);
    setSelectedName(name);
    setStage("pin");
  }

  function advanceLogin() {
    const exactLogin = padShortOperatorLogin(login);
    if (!exactLogin) {
      setError(t("login.loginInvalid"));
      return;
    }
    moveToPin(exactLogin, "login", null);
  }

  function selectName(operator: OperatorSearchResult) {
    source.clearPendingInput?.();
    moveToPin(operator.login, "search", operator.name);
  }

  function back() {
    if (busy) return;
    source.clearPendingInput?.();
    setError(null);
    setPin("");
    if (stage === "pin") {
      setStage(pinOrigin);
      return;
    }
    setStage("badge");
  }

  const prompt =
    stage === "badge"
      ? t("login.badgePrimary")
      : stage === "login"
        ? t("login.loginPrompt")
        : stage === "search"
          ? t("login.nameSearchPrompt")
          : selectedName
            ? t("login.pinFor", { name: selectedName })
            : t("login.pinPrompt");

  return (
    <main
      className={`operator-login${notice ? " operator-login--with-notice" : ""}`}
      aria-labelledby="operator-login-title"
    >
      <header className="operator-login__prompt">
        <h1 id="operator-login-title">{t("login.title")}</h1>
        <p>{prompt}</p>
      </header>

      <div className="operator-login__message" aria-live="polite">
        {error ? (
          <Alert tone="error">
            <span
              className="operator-login__auth-message"
              style={{ font: "var(--floor-body)", fontSize: 18 }}
            >
              {error}
            </span>
          </Alert>
        ) : null}
      </div>

      <div className="operator-login__body">
        {stage === "search" ? (
          <OperatorNameSearch
            operators={roster}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onSelect={selectName}
            disabled={busy}
          />
        ) : (
          <>
            <div
              className="operator-login__readout"
              aria-label={stage === "login" ? "login" : stage === "pin" ? "pin" : undefined}
            >
              {stage === "badge"
                ? t("login.badgeReady")
                : stage === "login"
                  ? login
                  : "•".repeat(pin.length)}
            </div>
            <div className="operator-login__keypad-zone">
              {stage === "badge" ? (
                <div className="operator-login__badge-panel" aria-hidden="true">
                  <span>▣</span>
                </div>
              ) : (
                <PinPad
                  value={stage === "login" ? login : pin}
                  onChange={stage === "login" ? setLogin : setPin}
                  {...(stage === "login" ? { maxLength: 12 } : {})}
                  size="floor"
                  disabled={busy}
                  ariaLabel={stage === "login" ? t("login.loginKeypad") : t("login.pinKeypad")}
                  backspaceLabel={t("login.backspace")}
                  clearLabel={t("login.clear")}
                />
              )}
            </div>
          </>
        )}
      </div>

      <div className="operator-login__actions">
        {stage === "badge" ? (
          <>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => void openNameSearch()}
            >
              {t("login.findByName")}
            </Button>
            <Button size="floor" disabled={busy} onClick={() => setStage("login")}>
              {t("login.useLogin")}
            </Button>
          </>
        ) : stage === "login" ? (
          <>
            <Button size="floor" variant="secondary" disabled={busy} onClick={back}>
              {t("login.back")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => void openNameSearch()}
            >
              {t("login.findByName")}
            </Button>
            <Button size="floor" disabled={busy || login.length === 0} onClick={advanceLogin}>
              {t("login.next")}
            </Button>
          </>
        ) : stage === "pin" ? (
          <>
            <Button size="floor" variant="secondary" disabled={busy} onClick={back}>
              {t("login.back")}
            </Button>
            <Button size="floor" disabled={busy || pin.length === 0} onClick={() => void submit()}>
              {t("login.submit")}
            </Button>
          </>
        ) : (
          <>
            <Button size="floor" variant="secondary" disabled={busy} onClick={back}>
              {t("login.back")}
            </Button>
            <Button
              size="floor"
              disabled={busy}
              onClick={() => {
                source.clearPendingInput?.();
                setError(null);
                setStage("login");
              }}
            >
              {t("login.useLogin")}
            </Button>
          </>
        )}
      </div>
      {notice ? <div className="operator-login__notice">{notice}</div> : null}
    </main>
  );
}
