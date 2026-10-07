import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, PinPad, Spinner } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
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

export interface OperatorSignInProps {
  local: LocalExecutor;
  /** The pairing whose copies the sign-in reads. */
  pairing: Pairing;
  /**
   * The line the station works on (`null` before it has one). A check that
   * started under another line (or pairing) is dropped when it answers.
   */
  lineId: string | null;
  link: HostStatus | null;
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
  link,
  sync,
  notice,
  source,
  now = Date.now,
  onSignedIn,
  onSync,
  onOffice,
}: OperatorSignInProps) {
  const { t } = useTranslation();
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

  // A field that held the keys when the screen went (no blur comes then)
  // must not keep the scanner deaf on the next screen.
  useEffect(() => () => source.setManualTextEntryActive(false), [source]);

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
    // Also drops the keys typed so far, as `clearPendingInput` does.
    source.setManualTextEntryActive(false);
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

  const body = () => {
    if (readiness === null) {
      return (
        <div className="standalone-probing" role="status">
          <Spinner size={32} />
          <p>{t("floor.signIn.loading")}</p>
        </div>
      );
    }
    if (readiness === "failed") {
      return (
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
      );
    }
    if (readiness.kind === "not_ready") return <p>{t("floor.signIn.notSynced")}</p>;
    if (readiness.operators === 0) return <p>{t("floor.signIn.noOperators")}</p>;
    if (stage === "badge") {
      return (
        <div className="floor-sign-in">
          <p className="floor-sign-in__prompt">{t("floor.signIn.badgePrompt")}</p>
          <div className="standalone-form__actions">
            <Button size="floor" disabled={busy} onClick={() => toStage("login")}>
              {t("floor.signIn.useLogin")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setQuery("");
                toStage("search");
              }}
            >
              {t("floor.signIn.useName")}
            </Button>
          </div>
        </div>
      );
    }
    if (stage === "search") {
      const matches = Array.isArray(roster) ? searchOperatorsByName(roster, query) : [];
      let results: ReactNode;
      if (roster === null) results = <p>{t("floor.signIn.loading")}</p>;
      else if (roster === "failed") results = <p>{t("floor.signIn.readFailed")}</p>;
      else if (roster === "not_ready") results = <p>{t("floor.signIn.errors.notReady")}</p>;
      else if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) {
        results = <p>{t("floor.signIn.nameHint")}</p>;
      } else if (matches.length === 0) results = <p>{t("floor.signIn.nameEmpty")}</p>;
      else {
        results = matches.map((entry) => (
          <Button
            key={entry.id}
            size="floor"
            variant="secondary"
            fullWidth
            disabled={busy}
            onClick={() => choose(entry)}
          >
            {t("floor.signIn.nameResult", { name: entry.name, login: entry.login })}
          </Button>
        ));
      }
      return (
        <div className="floor-sign-in">
          <p className="floor-sign-in__prompt">{t("floor.signIn.namePrompt")}</p>
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
          <div className="floor-sign-in__results" aria-live="polite">
            {results}
          </div>
          <div className="standalone-form__actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => toStage("badge")}
            >
              {t("floor.signIn.back")}
            </Button>
          </div>
        </div>
      );
    }
    const entering = stage === "login" ? login : pin;
    return (
      <div className="floor-sign-in">
        <p className="floor-sign-in__prompt">
          {stage === "login"
            ? t("floor.signIn.loginPrompt")
            : chosenName !== null
              ? t("floor.signIn.pinPromptNamed", { name: chosenName, login })
              : t("floor.signIn.pinPrompt", { login })}
        </p>
        <output className="floor-sign-in__readout" aria-label={t(`floor.signIn.${stage}Readout`)}>
          {stage === "login" ? login : "•".repeat(pin.length)}
        </output>
        <PinPad
          value={entering}
          onChange={stage === "login" ? setLogin : setPin}
          maxLength={stage === "login" ? 12 : 6}
          size="floor"
          disabled={busy}
          ariaLabel={t(stage === "login" ? "floor.signIn.loginKeypad" : "floor.signIn.pinKeypad")}
          backspaceLabel={t("floor.signIn.backspace")}
          clearLabel={t("floor.signIn.clear")}
        />
        <div className="standalone-form__actions">
          <Button
            size="floor"
            variant="secondary"
            disabled={busy}
            onClick={() => toStage(stage === "pin" ? pinFrom : "badge")}
          >
            {t("floor.signIn.back")}
          </Button>
          {stage === "login" ? (
            <Button
              size="floor"
              disabled={busy || !LOGIN.test(login)}
              onClick={() => {
                setPinFrom("login");
                setChosenName(null);
                toStage("pin");
              }}
            >
              {t("floor.signIn.next")}
            </Button>
          ) : (
            <Button
              size="floor"
              loading={busy}
              disabled={!PIN.test(pin)}
              onClick={() => void attempt("pin", (context) => signInWithPin(context, login, pin))}
            >
              {t("floor.signIn.submit")}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <div className="floor-sign-in__message" aria-live="polite">
          {message !== null ? (
            <Alert
              tone={message.kind === "refused" && message.reason === "not_ready" ? "warn" : "error"}
            >
              {messageText(message)}
            </Alert>
          ) : notice !== null && !noticeDismissed ? (
            <Alert tone="info">{t(NOTICE_KEY[notice])}</Alert>
          ) : null}
          {busy && <p>{t("floor.signIn.checking")}</p>}
        </div>
        {body()}
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          {/* Never held by a check: one that never settles must not trap the station here. */}
          <Button variant="secondary" size="floor" onClick={onOffice}>
            {t("floor.office")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
