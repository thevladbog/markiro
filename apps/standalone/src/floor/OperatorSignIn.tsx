import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, PinPad, Spinner } from "@markiro/ui";

import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HardwareApi } from "../hardware/hardware.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import {
  NAME_QUERY_MAX_LENGTH,
  NAME_SEARCH_MIN_LETTERS,
  nameQueryLetters,
  searchOperatorsByName,
  type RosterEntry,
} from "./operator-search.js";
import type { ScanSource } from "./scan-source.js";
import { signInScannerState, useScannerIndicator } from "./scanner-indicator.js";
import {
  readFloorReadiness,
  readOperatorRoster,
  signInWithBadge,
  signInWithPin,
  type FloorOperator,
  type FloorReadiness,
  type SignInContext,
  type SignInRefusal,
  type SignInResult,
} from "./sign-in.js";
import { BadgeScanIllustration } from "./sign-in/BadgeScanIllustration.js";
import { StationBrand } from "./sign-in/StationBrand.js";
import "./sign-in/operator-sign-in.css";

export interface OperatorSignInProps {
  local: LocalExecutor;
  /** The pairing whose copies the sign-in reads. */
  pairing: Pairing;
  /**
   * The line the station works on (`null` before it has one). A check that
   * started under another line (or pairing) is dropped when it answers.
   */
  lineId: string | null;
  sync: SyncState;
  /** Why the last operator was signed out, if they were not the one who left. */
  notice: FloorNotice | null;
  /** Where badge scans come from: the keyboard wedge in the app. */
  source: ScanSource;
  /** This computer's clock, for the lockouts; tests pin it. */
  now?: () => number;
  /** `lineId` is the line this check began on, not the one the screen has when it answers. */
  onSignedIn: (operator: FloorOperator, lineId: string | null) => void;
  /**
   * Asks for a reference sync now: after an unknown credential or copies
   * that are not ready, a record the office has just added may be on its
   * way (spec §5.6). The next attempt reads whatever the sync brought.
   */
  onSync: () => void;
  onOffice: () => void;
  /**
   * The shell's COM scanners (`HardwareApi.watchScanners`), for the scanner
   * chip; without it the keyboard wedge alone is assumed (it always scans).
   */
  watchScanners?: HardwareApi["watchScanners"];
  /**
   * «Настройки сканера»: the way from the sign-in's scanner warning to the scanner's settings.
   * Without it the warning has no button.
   */
  onScannerSettings?: () => void;
}

type Stage = "badge" | "login" | "search" | "pin";

/** What the message slot says: a refusal of the last attempt, or a notice. */
type Message =
  | { kind: "refused"; reason: SignInRefusal; via: "pin" | "badge" }
  | { kind: "locked"; scope: "station" | "operator"; minutes: number }
  | { kind: "failed" };

const LOGIN = /^[0-9]{3,12}$/;
const PIN = /^[0-9]{4,6}$/;
const MINUTE_MS = 60_000;

const REFUSAL_KEY = {
  wrong: "floor.signIn.errors.wrongPin",
  ambiguous: "floor.signIn.errors.ambiguousLogin",
  not_ready: "floor.signIn.errors.notReady",
  product_code: "floor.signIn.errors.productCode",
  layout: "floor.signIn.errors.layout",
  not_badge: "floor.signIn.errors.notBadge",
} as const satisfies Record<SignInRefusal, string>;

const BADGE_REFUSAL_KEY = {
  ...REFUSAL_KEY,
  wrong: "floor.signIn.errors.wrongBadge",
  ambiguous: "floor.signIn.errors.ambiguousBadge",
} as const satisfies Record<SignInRefusal, string>;

const NOTICE_KEY = {
  idle: "floor.signIn.notice.idle",
  removed: "floor.signIn.notice.removed",
  line_changed: "floor.signIn.notice.lineChanged",
} as const satisfies Record<FloorNotice, string>;

function messageOf(result: Exclude<SignInResult, { kind: "signed_in" }>, via: "pin" | "badge") {
  if (result.kind === "locked") {
    const minutes = Math.max(1, Math.ceil(result.remainingMs / MINUTE_MS));
    return { kind: "locked", scope: result.scope, minutes } satisfies Message;
  }
  return { kind: "refused", reason: result.reason, via } satisfies Message;
}

/**
 * The floor with nobody signed in (stage 1 spec §5.6, plans 1f and 1f2): a
 * badge scan at any moment, or a personnel number (typed on the keypad or
 * found by name) and a PIN on the keypad, checked
 * offline against this pairing's copies (`src/floor/sign-in.ts`). Until a
 * sync has begun to fill the copies, and while they hold no operator, the screen says why
 * nobody can sign in and keeps the way into the office. One check runs at a
 * time: a scan during a check is dropped, and so is a second press. An
 * unknown credential asks for a sync, as the cloud station refreshes its
 * roster before refusing. A check's answer that lands after the screen left,
 * or after the pairing or the line changed, is dropped: the shell's reducer
 * does not know which screen asked, so this one must not report it.
 */
export function OperatorSignIn({
  local,
  pairing,
  lineId,
  sync,
  notice,
  source,
  now = Date.now,
  onSignedIn,
  onSync,
  onOffice,
  watchScanners,
  onScannerSettings,
}: OperatorSignInProps) {
  const { t } = useTranslation();
  const scanner = useScannerIndicator(watchScanners);
  const [readiness, setReadiness] = useState<FloorReadiness | "failed" | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>("badge");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  // The name search: what is typed, the copies it searches (`null` while
  // they are read), and where «Назад» on the PIN goes with whose name.
  const [query, setQuery] = useState("");
  const [roster, setRoster] = useState<RosterEntry[] | "not_ready" | "failed" | null>(null);
  const [pinFrom, setPinFrom] = useState<"login" | "search">("login");
  const [chosenName, setChosenName] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  // The leave notice stays until somebody tries to sign in: the first attempt
  // dismisses it for good, so a step change or a later check does not bring
  // it back.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const { hostId, deviceId } = pairing;
  const current = useRef({ hostId, deviceId, lineId });

  // Layout effects, so that both are right the moment a commit lands, before
  // any answer that was waiting for it can be read against them.
  useLayoutEffect(() => {
    current.current = { hostId, deviceId, lineId };
  }, [hostId, deviceId, lineId]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    readFloorReadiness({ local, pairing: { hostId, deviceId }, now }).then(
      (next) => {
        if (!cancelled) setReadiness(next);
      },
      () => {
        if (!cancelled) setReadiness("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, now, sync.synced, readAttempt]);

  // The copies the name search offers, read when it opens and after every sync.
  const searching = stage === "search";
  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    readOperatorRoster({ local, pairing: { hostId, deviceId }, now }).then(
      (next) => {
        if (!cancelled) setRoster(next ?? "not_ready");
      },
      () => {
        if (!cancelled) setRoster("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [searching, local, hostId, deviceId, now, sync.synced]);

  // The name field is on screen only on the search step with copies to
  // search. When it goes (a sync turned the search into a notice, or the
  // screen itself left) while it held the keys, no blur comes: giving the
  // keys back here keeps the scanner from staying deaf. A layout effect, so
  // that it is done in the commit that removed the field, before a scan.
  const nameFieldShown =
    stage === "search" &&
    readiness !== null &&
    readiness !== "failed" &&
    readiness.kind === "ready" &&
    readiness.operators > 0;
  useLayoutEffect(() => {
    if (!nameFieldShown) return;
    return () => source.setManualTextEntryActive(false);
  }, [nameFieldShown, source]);

  /** One check at a time; the answer either signs in or says why not. */
  const attempt = useCallback(
    async (via: "pin" | "badge", check: (context: SignInContext) => Promise<SignInResult>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setNoticeDismissed(true);
      setMessage(null);
      let result: SignInResult | null;
      try {
        result = await check({ local, pairing: { hostId, deviceId }, now });
      } catch {
        // A failed read or write of the local database: its text may name
        // SQL and is never shown.
        result = null;
      }
      inFlight.current = false;
      if (!alive.current) return;
      // Whatever the check said, the PIN it was given does not stay on screen.
      setBusy(false);
      setPin("");
      const where = current.current;
      if (where.hostId !== hostId || where.deviceId !== deviceId || where.lineId !== lineId) {
        // The answer belongs to a pairing or a line this screen no longer has.
        return;
      }
      if (result === null) {
        setMessage({ kind: "failed" });
        return;
      }
      if (result.kind === "signed_in") {
        onSignedIn(result.operator, lineId);
        return;
      }
      setMessage(messageOf(result, via));
      if (
        result.kind === "refused" &&
        (result.reason === "wrong" || result.reason === "not_ready")
      ) {
        onSync();
      }
    },
    [local, hostId, deviceId, lineId, now, onSignedIn, onSync],
  );

  const scan = useRef(attempt);
  useLayoutEffect(() => {
    scan.current = attempt;
  }, [attempt]);

  useEffect(
    () =>
      source.start((raw) => {
        void scan.current("badge", (context) => signInWithBadge(context, raw));
      }),
    [source],
  );

  const toStage = (next: Stage) => {
    // The name field gives the keys back itself when it goes (above).
    source.clearPendingInput();
    setMessage(null);
    setPin("");
    if (next === "login") setLogin("");
    if (next === "search") setRoster(null);
    setStage(next);
  };

  /** A name from the search: the PIN for that operator's number comes next. */
  const choose = (entry: RosterEntry) => {
    setLogin(entry.login);
    setChosenName(entry.name);
    setPinFrom("search");
    toStage("pin");
  };

  const messageText = (shown: Message) => {
    if (shown.kind === "failed") return t("floor.signIn.errors.failed");
    if (shown.kind === "locked") {
      return t(
        shown.scope === "station"
          ? "floor.signIn.errors.lockedStation"
          : "floor.signIn.errors.lockedOperator",
        { minutes: shown.minutes },
      );
    }
    return t((shown.via === "badge" ? BADGE_REFUSAL_KEY : REFUSAL_KEY)[shown.reason]);
  };

  const ready = readiness !== null && readiness !== "failed" && readiness.kind === "ready";
  const working = ready && readiness.operators > 0;
  const scannerState = signInScannerState(
    scanner,
    message?.kind === "locked" && message.scope === "station",
  );
  // The scanner's state lives in the header's rail. Here only a quiet warning while the scanner
  // is not ready (a lockout says its own words in the message).
  const scannerWarning = working && scannerState.tone !== "ok" && scannerState.key !== "locked";

  /** What the header says under «Вход оператора»: the step, or nothing while the screen says why not. */
  const prompt = () => {
    if (!working) return null;
    if (stage === "badge") return t("floor.signIn.badgePrompt");
    if (stage === "search") return t("floor.signIn.namePrompt");
    if (stage === "login") return t("floor.signIn.loginPrompt");
    return chosenName !== null
      ? t("floor.signIn.pinPromptNamed", { name: chosenName, login })
      : t("floor.signIn.pinPrompt", { login });
  };

  /** Loading, an unreadable copy, no copies yet, no operators: one centred statement. */
  const statement = () => {
    if (readiness === null) {
      return (
        <div className="operator-login__state standalone-probing" role="status">
          <Spinner size={32} />
          <p>{t("floor.signIn.loading")}</p>
        </div>
      );
    }
    if (readiness === "failed") {
      return (
        <div className="operator-login__state">
          <Alert
            tone="error"
            action={
              <Button
                variant="secondary"
                size="floor"
                onClick={() => {
                  setReadiness(null);
                  setReadAttempt((count) => count + 1);
                }}
              >
                {t("floor.signIn.retry")}
              </Button>
            }
          >
            {t("floor.signIn.readFailed")}
          </Alert>
        </div>
      );
    }
    return (
      <div className="operator-login__state">
        <p>
          {readiness.kind === "not_ready"
            ? t("floor.signIn.notSynced")
            : t("floor.signIn.noOperators")}
        </p>
      </div>
    );
  };

  const searchResults = (): ReactNode => {
    const matches = Array.isArray(roster) ? searchOperatorsByName(roster, query) : [];
    const hint = (text: string) => <p className="operator-name-search__hint">{text}</p>;
    if (roster === null) return hint(t("floor.signIn.loading"));
    if (roster === "failed") return hint(t("floor.signIn.readFailed"));
    if (roster === "not_ready") return hint(t("floor.signIn.errors.notReady"));
    if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) return hint(t("floor.signIn.nameHint"));
    if (matches.length === 0) return hint(t("floor.signIn.nameEmpty"));
    return matches.map((entry) => (
      <Button
        key={entry.id}
        size="floor"
        variant="secondary"
        fullWidth
        disabled={busy}
        onClick={() => choose(entry)}
      >
        <span className="operator-name-search__result-label">
          {t("floor.signIn.nameResult", { name: entry.name, login: entry.login })}
        </span>
      </Button>
    ));
  };

  const openSearch = () => {
    setQuery("");
    toStage("search");
  };

  const body = () => {
    if (!working)
      return <div className="operator-login__body operator-login__body--state">{statement()}</div>;
    if (stage === "badge") {
      return (
        <div className="operator-login__body operator-login__body--badge">
          <div className="operator-login__keypad-zone">
            <div
              className="operator-login__badge-panel"
              data-scanner={scannerState.tone === "error" ? "error" : "ready"}
            >
              <BadgeScanIllustration />
              <div className="operator-login__badge-copy">
                <h2>{t("floor.signIn.badgeInstruction")}</h2>
                <p>{t("floor.signIn.badgeExplanation")}</p>
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (stage === "search") {
      return (
        <div className="operator-login__body operator-login__body--search">
          <section className="operator-name-search" aria-label={t("floor.signIn.nameSearchTitle")}>
            <Input
              size="floor"
              label={t("floor.signIn.nameLabel")}
              value={query}
              maxLength={NAME_QUERY_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              onFocus={() => source.setManualTextEntryActive(true)}
              onBlur={() => source.setManualTextEntryActive(false)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <div
              className="operator-name-search__results floor-sign-in__results"
              aria-live="polite"
            >
              {searchResults()}
            </div>
          </section>
        </div>
      );
    }
    return (
      <div className="operator-login__body operator-login__body--pad">
        <output
          className="operator-login__readout floor-sign-in__readout"
          aria-label={t(`floor.signIn.${stage}Readout`)}
        >
          {stage === "login" ? login : "•".repeat(pin.length)}
        </output>
        <div className="operator-login__keypad-zone">
          <PinPad
            value={stage === "login" ? login : pin}
            onChange={stage === "login" ? setLogin : setPin}
            maxLength={stage === "login" ? 12 : 6}
            size="floor"
            disabled={busy}
            ariaLabel={t(stage === "login" ? "floor.signIn.loginKeypad" : "floor.signIn.pinKeypad")}
            backspaceLabel={t("floor.signIn.backspace")}
            clearLabel={t("floor.signIn.clear")}
          />
        </div>
      </div>
    );
  };

  /** The step's actions, one row of equal columns under the screen (the cloud's order). */
  const actions = (): ReactNode[] => {
    if (!working) return [];
    const back = (
      <Button
        key="back"
        size="floor"
        variant="secondary"
        disabled={busy}
        onClick={() => toStage(stage === "pin" ? pinFrom : "badge")}
      >
        {t("floor.signIn.back")}
      </Button>
    );
    const byName = (
      <Button key="name" size="floor" variant="secondary" disabled={busy} onClick={openSearch}>
        {t("floor.signIn.useName")}
      </Button>
    );
    const byLogin = (primary: boolean) => (
      <Button
        key="login"
        size="floor"
        {...(primary ? {} : { variant: "secondary" as const })}
        disabled={busy}
        onClick={() => toStage("login")}
      >
        {t("floor.signIn.useLogin")}
      </Button>
    );
    if (stage === "badge") {
      return scannerWarning && onScannerSettings !== undefined
        ? [
            <Button key="scanner" size="floor" variant="secondary" onClick={onScannerSettings}>
              {t("floor.signIn.scannerSettings")}
            </Button>,
            byName,
            byLogin(true),
          ]
        : [byName, byLogin(true)];
    }
    if (stage === "search") return [back, byLogin(true)];
    if (stage === "login") {
      return [
        back,
        byName,
        <Button
          key="next"
          size="floor"
          disabled={busy || !LOGIN.test(login)}
          onClick={() => {
            setPinFrom("login");
            setChosenName(null);
            toStage("pin");
          }}
        >
          {t("floor.signIn.next")}
        </Button>,
      ];
    }
    return [
      back,
      <Button
        key="submit"
        size="floor"
        loading={busy}
        disabled={!PIN.test(pin)}
        onClick={() => void attempt("pin", (context) => signInWithPin(context, login, pin))}
      >
        {t("floor.signIn.submit")}
      </Button>,
    ];
  };

  const stepActions = actions();
  const promptText = prompt();
  return (
    <section className="operator-login" aria-labelledby="floor-sign-in-title">
      <header className="operator-login__header">
        <StationBrand label={t("floor.signIn.brand")} />
        <div className="operator-login__prompt">
          <h1 id="floor-sign-in-title">{t("floor.signIn.title")}</h1>
          {promptText !== null && <p>{promptText}</p>}
          {scannerWarning && (
            <p
              className="operator-login__scanner-warning"
              role="status"
              data-testid="scanner-state"
              data-tone={scannerState.tone}
            >
              {t(`floor.signIn.scanner.${scannerState.key}`)}
            </p>
          )}
        </div>
        <div className="operator-login__aside">
          {/* Never held by a check: one that never settles must not trap the station here. */}
          <Button variant="secondary" size="floor" onClick={onOffice}>
            {t("floor.office")}
          </Button>
        </div>
      </header>
      {/* Heard once, by this region: its messages are not alerts of their own (`role="presentation"`). */}
      <div className="operator-login__message floor-sign-in__message" aria-live="polite">
        {message !== null ? (
          <Alert
            tone={message.kind === "refused" && message.reason === "not_ready" ? "warn" : "error"}
            role="presentation"
          >
            {messageText(message)}
          </Alert>
        ) : notice !== null && !noticeDismissed ? (
          <Alert tone="info" role="presentation">
            {t(NOTICE_KEY[notice])}
          </Alert>
        ) : null}
        {busy && <p>{t("floor.signIn.checking")}</p>}
      </div>
      {body()}
      <div
        className="operator-login__actions"
        style={{ "--operator-login-action-columns": stepActions.length } as CSSProperties}
      >
        {stepActions}
      </div>
    </section>
  );
}
