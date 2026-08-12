import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";
import type { SqlExecutor } from "../lib/mirror.js";
import { readOperatorsMirror } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import { padShortOperatorLogin, verifyOperatorBadge, verifyOperatorPin } from "../lib/auth.js";
import type { OperatorSearchResult } from "../lib/operator-search.js";
import type { OperatorRosterSyncResult } from "../lib/roster-sync.js";
import { BadgeScanIllustration } from "../ui/BadgeScanIllustration.js";
import { OperatorNameSearch } from "../ui/OperatorNameSearch.js";
import { StationBrand } from "../ui/StationBrand.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  source: ScanSource;
  online: boolean;
  refreshRoster?: () => Promise<OperatorRosterSyncResult>;
  onAuthed: (operator: OperatorMirrorRecord) => void;
  notice?: ReactNode;
}

export type LoginStage = "badge" | "login" | "pin" | "search";
type AuthMessage = { tone: "info" | "error"; text: string } | null;
type RefreshedLocalResult<T> =
  { kind: "matched"; value: T } | { kind: "miss" } | { kind: "unavailable" };

/** Badge-first fixed-viewport operator sign-in with bounded offline fallbacks. */
export function OperatorLogin({
  exec,
  source,
  online,
  refreshRoster,
  onAuthed,
  notice,
}: OperatorLoginProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<LoginStage>("badge");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [pinOrigin, setPinOrigin] = useState<"login" | "search">("login");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [roster, setRoster] = useState<OperatorMirrorRecord[]>([]);
  const [message, setMessage] = useState<AuthMessage>(null);
  const [busy, setBusy] = useState(false);
  const authInFlight = useRef(false);
  const admitted = useRef(false);
  const mounted = useRef(true);
  const live = useRef({ exec, online, refreshRoster, onAuthed, stage, t });
  live.current = { exec, online, refreshRoster, onAuthed, stage, t };

  async function refreshAfterMiss<T>(
    verifyLocal: () => Promise<T | null>,
  ): Promise<RefreshedLocalResult<T>> {
    const current = live.current;
    if (!current.online || !current.refreshRoster) return { kind: "miss" };
    if (mounted.current) {
      setMessage({ tone: "info", text: current.t("login.refreshingRoster") });
    }
    const result = await current.refreshRoster();
    if (result === "unavailable") {
      if (mounted.current) {
        setMessage({ tone: "error", text: current.t("login.rosterRefreshUnavailable") });
      }
      return { kind: "unavailable" };
    }
    const value = await verifyLocal();
    return value ? { kind: "matched", value } : { kind: "miss" };
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      source.setManualTextEntryActive?.(false);
    },
    [source],
  );

  useEffect(() => {
    let currentSource = true;
    const stop = source.start((raw) => {
      if (!mounted.current || !currentSource || admitted.current || authInFlight.current) return;
      authInFlight.current = true;
      setMessage(null);
      setBusy(true);
      void (async () => {
        try {
          let operator = await verifyOperatorBadge(live.current.exec, raw);
          if (!mounted.current || !currentSource) return;
          if (!operator) {
            const refreshed = await refreshAfterMiss(() =>
              verifyOperatorBadge(live.current.exec, raw),
            );
            if (!mounted.current || !currentSource) return;
            if (refreshed.kind === "unavailable") return;
            if (refreshed.kind === "miss") {
              setMessage({ tone: "error", text: live.current.t("login.badgeWrong") });
              return;
            }
            operator = refreshed.value;
          }
          admitted.current = true;
          live.current.onAuthed(operator);
        } catch (err) {
          console.error("station: verifyOperatorBadge failed", err);
          if (mounted.current && currentSource) {
            setMessage({ tone: "error", text: live.current.t("login.badgeWrong") });
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
    setMessage(null);
    setBusy(true);
    setStage("search");
    try {
      const operators = await readOperatorsMirror(exec);
      if (!mounted.current) return;
      setRoster(operators);
      if (online && refreshRoster) {
        setMessage({ tone: "info", text: t("login.refreshingRoster") });
        void refreshRoster().then(async (result) => {
          if (!mounted.current || live.current.stage !== "search") return;
          if (result === "unavailable") {
            setMessage({ tone: "error", text: live.current.t("login.rosterRefreshUnavailable") });
            return;
          }
          const refreshed = await readOperatorsMirror(live.current.exec);
          if (!mounted.current || live.current.stage !== "search") return;
          setRoster(refreshed);
          setMessage(null);
        });
      }
    } catch (err) {
      console.error("station: readOperatorsMirror failed", err);
      if (mounted.current) {
        setMessage({ tone: "error", text: t("login.searchUnavailable") });
      }
    } finally {
      authInFlight.current = false;
      if (mounted.current && !admitted.current) setBusy(false);
    }
  }

  async function submit() {
    if (admitted.current || authInFlight.current) return;
    authInFlight.current = true;
    setMessage(null);
    setBusy(true);
    try {
      const verifyLocal = async () => {
        try {
          return await verifyOperatorPin(live.current.exec, login, pin);
        } catch (err) {
          // A failed boot migration is presented in the same reserved slot as
          // any other failed credential check, never as an unhandled rejection.
          console.error("station: verifyOperatorPin failed", err);
          return null;
        }
      };
      const operator = await verifyLocal();
      if (operator) {
        if (!mounted.current) return;
        admitted.current = true;
        live.current.onAuthed(operator);
        return;
      }
      if (!mounted.current) return;
      const refreshed = await refreshAfterMiss(verifyLocal);
      if (!mounted.current) return;
      if (refreshed.kind === "matched") {
        admitted.current = true;
        live.current.onAuthed(refreshed.value);
        return;
      }
      if (refreshed.kind === "miss") {
        setMessage({ tone: "error", text: live.current.t("login.wrong") });
      }
      setPin("");
    } finally {
      authInFlight.current = false;
      if (mounted.current && !admitted.current) setBusy(false);
    }
  }

  function moveToPin(exactLogin: string, origin: "login" | "search", name: string | null) {
    setMessage(null);
    setPin("");
    setLogin(exactLogin);
    setPinOrigin(origin);
    setSelectedName(name);
    setStage("pin");
  }

  function advanceLogin() {
    const exactLogin = padShortOperatorLogin(login);
    if (!exactLogin) {
      setMessage({ tone: "error", text: t("login.loginInvalid") });
      return;
    }
    moveToPin(exactLogin, "login", null);
  }

  function selectName(operator: OperatorSearchResult) {
    source.setManualTextEntryActive?.(false);
    source.clearPendingInput?.();
    moveToPin(operator.login, "search", operator.name);
  }

  function back() {
    if (busy) return;
    source.setManualTextEntryActive?.(false);
    source.clearPendingInput?.();
    setMessage(null);
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
      <header className="operator-login__header">
        <StationBrand
          compact
          className="operator-login__brand"
          descriptor={t("app.stationDescriptor")}
        />
        <div className="operator-login__prompt">
          <h1 id="operator-login-title">{t("login.title")}</h1>
          <p>{prompt}</p>
        </div>
      </header>

      <div
        className="operator-login__message"
        aria-live="polite"
        style={{ minHeight: 64, overflow: "hidden" }}
      >
        {message ? (
          <Alert tone={message.tone}>
            <span
              className="operator-login__auth-message"
              style={{ font: "var(--floor-body)", fontSize: 18 }}
            >
              {message.text}
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
            onTextEntryActiveChange={(active) => source.setManualTextEntryActive?.(active)}
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
                <div className="operator-login__badge-panel">
                  <BadgeScanIllustration />
                  <div className="operator-login__badge-copy">
                    <h2>{t("login.badgeInstruction")}</h2>
                    <p>{t("login.badgeExplanation")}</p>
                  </div>
                </div>
              ) : (
                <PinPad
                  value={stage === "login" ? login : pin}
                  onChange={stage === "login" ? setLogin : setPin}
                  maxLength={stage === "login" ? 12 : 6}
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

      <div
        className="operator-login__actions"
        style={
          {
            "--operator-login-action-columns": stage === "login" ? 3 : 2,
          } as CSSProperties
        }
      >
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
            <Button
              size="floor"
              disabled={busy || !/^\d{4,6}$/.test(pin)}
              onClick={() => void submit()}
            >
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
                source.setManualTextEntryActive?.(false);
                source.clearPendingInput?.();
                setMessage(null);
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
