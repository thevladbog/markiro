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

import { Alert, Button, Input, Spinner } from "@markiro/ui";

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
  type SignInResult,
} from "./sign-in.js";
import { CyrillicKeyboard } from "./kit/CyrillicKeyboard.js";
import { EntryField } from "./kit/EntryField.js";
import { NumericKeypad } from "./kit/NumericKeypad.js";
import { BadgeZone } from "./sign-in/BadgeZone.js";
import {
  afterAttempt,
  canSubmit,
  editEntry,
  fieldStatus,
  selectField,
  type Entry,
  type EntryField as EntryFieldName,
} from "./sign-in/entry.js";
import {
  formatCountdown,
  lockAnnouncement,
  lockFraction,
  lockTotalMs,
  lockViewAfterEdit,
  remainingOf,
  type LockView,
} from "./sign-in/lock-view.js";
import { problemWords, type SignInMessage } from "./sign-in/messages.js";
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
  /**
   * How long an accepted badge scan stays on screen (the tick and the operator's name) before the
   * floor takes over, in ms. A pause of the picture only: the check has answered and nothing waits
   * on it. In tests it is 0 unless a test asks for it (fake timers).
   */
  successHoldMs?: number;
}

/** The accepted scan's tick and name: long enough to see whose badge it was, no longer (kit motion). */
export const SIGN_IN_SUCCESS_HOLD_MS = 400;

type View = "entry" | "search";

/** What the message slot says: a refusal of the last attempt, or a notice. */
type Message = SignInMessage;

const MINUTE_MS = 60_000;
const NAME_FIELD_ID = "sign-in-name";
const START: Entry = { active: "login", login: "", pin: "" };

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

/** The field a refusal of a PIN check is about: the PIN, or (two operators share it) the number. */
function errorFieldOf(
  result: Exclude<SignInResult, { kind: "signed_in" }>,
  via: "pin" | "badge",
): EntryFieldName | null {
  if (via !== "pin" || result.kind !== "refused") return null;
  if (result.reason === "wrong") return "pin";
  return result.reason === "ambiguous" ? "login" : null;
}

function SearchGlyph() {
  return (
    <svg
      className="operator-name-search__glyph"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="14" cy="14" r="8" />
      <path d="m20 20 7 7" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="operator-name-search__chevron"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 7 9 9-9 9" />
    </svg>
  );
}

/**
 * The floor with nobody signed in (stage 1 spec §5.6, plans 1f and 1f2, laid out as variant A of
 * the design kit 2026-10): both ways in on one screen. A badge scan at any moment, or a
 * personnel number and a PIN on one flat keypad that edits the field being active (a number
 * found by name fills the first), checked offline against this pairing's copies
 * (`src/floor/sign-in.ts`). Until a sync has begun to fill the copies, and while they hold no
 * operator, the screen says why nobody can sign in and keeps the way into the office. One check
 * runs at a time: a scan during a check is dropped, and so is a second press. An unknown
 * credential asks for a sync, as the cloud station refreshes its roster before refusing. A
 * check's answer that lands after the screen left, or after the pairing or the line changed, is
 * dropped: the shell's reducer does not know which screen asked, so this one must not report it.
 * The lockouts are the policies of `lockout.ts`; what this screen adds is how they are shown.
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
  successHoldMs = import.meta.env.MODE === "test" ? 0 : SIGN_IN_SUCCESS_HOLD_MS,
}: OperatorSignInProps) {
  const { t } = useTranslation();
  const scanner = useScannerIndicator(watchScanners);
  const [readiness, setReadiness] = useState<FloorReadiness | "failed" | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [view, setView] = useState<View>("entry");
  const [entry, setEntry] = useState<Entry>(START);
  const [fieldError, setFieldError] = useState<EntryFieldName | null>(null);
  // The name search: what is typed, the copies it searches (`null` while
  // they are read), and whose name filled the number.
  const [query, setQuery] = useState("");
  const [roster, setRoster] = useState<RosterEntry[] | "not_ready" | "failed" | null>(null);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  // The lockout on screen, and whether its end has been announced as news.
  const [lock, setLock] = useState<LockView | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [, setTick] = useState(0);
  // An accepted badge scan, while its tick and name are on screen before the floor takes over.
  const [accepted, setAccepted] = useState<FloorOperator | null>(null);
  // The leave notice stays until somebody tries to sign in: the first attempt
  // dismisses it for good, so a step change or a later check does not bring
  // it back.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const spoken = useRef<LockView | null>(null);
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
  const searching = view === "search";
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
    view === "search" &&
    readiness !== null &&
    readiness !== "failed" &&
    readiness.kind === "ready" &&
    readiness.operators > 0;
  useLayoutEffect(() => {
    if (!nameFieldShown) return;
    return () => source.setManualTextEntryActive(false);
  }, [nameFieldShown, source]);

  // The lockout's countdown: the screen asks the clock twice a second while one is shown, and
  // speaks of it twice only (`lockAnnouncement`): the message when it starts (it is the polite
  // region's own change) and «Вход снова доступен» when it ends.
  useEffect(() => {
    if (lock === null) return;
    const timer = setInterval(() => setTick((count) => count + 1), 500);
    return () => clearInterval(timer);
  }, [lock]);
  const remaining = lock === null ? 0 : remainingOf(lock, now);
  const over = lock !== null && remaining <= 0;
  useEffect(() => {
    // `over` is what brings the effect back when the time runs out.
    const heard = lockAnnouncement(spoken.current, lock, over ? Number.MAX_SAFE_INTEGER : now());
    if (heard === "started") spoken.current = lock;
    if (heard === "ended") {
      spoken.current = null;
      setLock(null);
      setMessage((shown) => (shown?.kind === "locked" ? null : shown));
      setUnlocked(true);
    }
  }, [lock, over, now]);

  /** One check at a time; the answer either signs in or says why not. */
  const attempt = useCallback(
    async (
      via: "pin" | "badge",
      check: (context: SignInContext) => Promise<SignInResult>,
      login: string | null = null,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setNoticeDismissed(true);
      setUnlocked(false);
      setMessage(null);
      setFieldError(null);
      let result: SignInResult | null;
      try {
        result = await check({ local, pairing: { hostId, deviceId }, now });
      } catch {
        // A failed read or write of the local database: its text may name
        // SQL and is never shown.
        result = null;
      }
      if (!alive.current) {
        inFlight.current = false;
        return;
      }
      // Whatever the check said, the PIN it was given does not stay on screen.
      setBusy(false);
      setEntry((now) => afterAttempt(now, via));
      const where = current.current;
      if (where.hostId !== hostId || where.deviceId !== deviceId || where.lineId !== lineId) {
        // The answer belongs to a pairing or a line this screen no longer has.
        inFlight.current = false;
        return;
      }
      if (result === null) {
        inFlight.current = false;
        setMessage({ kind: "failed" });
        return;
      }
      if (result.kind === "signed_in") {
        const operator = result.operator;
        if (via === "badge" && successHoldMs > 0) {
          // The tick and the name for a moment, then the floor. Scans in the moment are the same
          // badge read twice: the check stays "in flight" so that none signs in a second time.
          setAccepted(operator);
          setTimeout(() => {
            inFlight.current = false;
            if (!alive.current) return;
            const now = current.current;
            if (now.hostId !== hostId || now.deviceId !== deviceId || now.lineId !== lineId) return;
            onSignedIn(operator, lineId);
          }, successHoldMs);
          return;
        }
        inFlight.current = false;
        onSignedIn(operator, lineId);
        return;
      }
      inFlight.current = false;
      const shown = messageOf(result, via);
      setMessage(shown);
      setFieldError(errorFieldOf(result, via));
      if (result.kind === "locked") {
        setLock({
          scope: result.scope,
          login: result.scope === "operator" ? login : null,
          endsAt: now() + result.remainingMs,
        });
      }
      if (
        result.kind === "refused" &&
        (result.reason === "wrong" || result.reason === "not_ready")
      ) {
        onSync();
      }
    },
    [local, hostId, deviceId, lineId, now, onSignedIn, onSync, successHoldMs],
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

  const toView = (next: View) => {
    // The name field gives the keys back itself when it goes (above).
    source.clearPendingInput();
    setMessage(null);
    setFieldError(null);
    setEntry((now) => ({ ...now, pin: "" }));
    if (next === "search") setRoster(null);
    setView(next);
  };

  /** A name from the search: its number fills the first field, the PIN comes next. */
  const choose = (found: RosterEntry) => {
    setChosenName(found.name);
    setEntry({ active: "pin", login: found.login, pin: "" });
    toView("entry");
  };

  /** A key of the shared keypad, for the active field. */
  const press = (key: Parameters<typeof editEntry>[1]) => {
    const next = editEntry(entry, key);
    if (next === entry) return;
    if (next.login !== entry.login) setChosenName(null);
    if (fieldError === entry.active) setFieldError(null);
    const kept = lockViewAfterEdit(lock, next.login);
    if (kept === null && lock !== null) {
      setLock(null);
      spoken.current = null;
      setMessage((shown) => (shown?.kind === "locked" ? null : shown));
    }
    setEntry(next);
  };

  const heldFields: EntryFieldName[] =
    lock === null ? [] : lock.scope === "station" ? ["login", "pin"] : ["pin"];
  const held = busy || accepted !== null;

  const ready = readiness !== null && readiness !== "failed" && readiness.kind === "ready";
  const working = ready && readiness.operators > 0;
  const scannerState = signInScannerState(
    scanner,
    message?.kind === "locked" && message.scope === "station",
  );
  // The scanner's state lives in the header's rail and in the badge's chip. Here, besides, a
  // warning in the message slot while it is not ready (a lockout says its own words there).
  const scannerWarning = working && scannerState.tone !== "ok" && scannerState.key !== "locked";

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

  const matches = Array.isArray(roster) ? searchOperatorsByName(roster, query) : [];

  const searchResults = (): ReactNode => {
    const hint = (text: string) => <p className="operator-name-search__hint">{text}</p>;
    if (roster === null) return hint(t("floor.signIn.loading"));
    if (roster === "failed") return hint(t("floor.signIn.readFailed"));
    if (roster === "not_ready") return hint(t("floor.signIn.problems.notReady.title"));
    if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) return hint(t("floor.signIn.nameHint"));
    if (matches.length === 0) return hint(t("floor.signIn.nameEmpty"));
    return matches.map((found) => (
      <Button
        key={found.id}
        size="floor"
        variant="secondary"
        fullWidth
        className="operator-name-search__row"
        aria-label={t("floor.signIn.nameResult", { name: found.name, login: found.login })}
        disabled={busy}
        onClick={() => choose(found)}
      >
        <span className="operator-name-search__name">{found.name}</span>
        <span className="operator-name-search__number" aria-hidden="true">
          {t("floor.signIn.search.number", { login: found.login })}
        </span>
        <Chevron />
      </Button>
    ));
  };

  const openSearch = () => {
    setQuery("");
    toView("search");
  };

  /** A key of the Cyrillic keyboard writes into the field and gives it the keys, as typing does. */
  const typeName = (next: string) => {
    setQuery(next);
    document.getElementById(NAME_FIELD_ID)?.focus();
  };

  const loginStatus = fieldStatus("login", entry, { error: fieldError, locked: heldFields });
  const pinStatus = fieldStatus("pin", entry, { error: fieldError, locked: heldFields });
  const errorLine = (reason: string) => `${t("floor.signIn.fields.error")} · ${reason}`;

  const fields = () => (
    <div className="operator-login__fields">
      <EntryField
        id="sign-in-login"
        label={t("floor.signIn.fields.loginLabel")}
        shown={entry.login}
        valueLabel={t("floor.signIn.loginReadout")}
        status={loginStatus}
        placeholder={t("floor.signIn.fields.loginHint")}
        hint={
          loginStatus === "error"
            ? errorLine(t("floor.signIn.fields.loginErrorHint"))
            : (chosenName ?? (loginStatus === "active" ? t("floor.signIn.fields.loginHint") : ""))
        }
        onSelect={() => setEntry((now) => selectField(now, "login"))}
      />
      <EntryField
        id="sign-in-pin"
        label={
          pinStatus === "locked"
            ? t("floor.signIn.fields.pinLabelLocked")
            : t("floor.signIn.fields.pinLabel")
        }
        shown={"•".repeat(entry.pin.length)}
        valueLabel={t("floor.signIn.pinReadout")}
        status={pinStatus}
        placeholder={
          pinStatus === "error"
            ? t("floor.signIn.fields.pinRetype")
            : t("floor.signIn.fields.pinHint")
        }
        lockedText={t("floor.signIn.fields.pinLocked")}
        hint={
          pinStatus === "error"
            ? errorLine(t("floor.signIn.fields.pinCleared"))
            : pinStatus === "active"
              ? t("floor.signIn.fields.pinHint")
              : ""
        }
        onSelect={() => setEntry((now) => selectField(now, "pin"))}
      />
      {lock !== null && (
        <div className="operator-login__countdown" data-scope={lock.scope}>
          <p className="operator-login__countdown-time" role="timer">
            {formatCountdown(remaining)}
          </p>
          <p className="operator-login__countdown-label">
            {t(
              lock.scope === "station"
                ? "floor.signIn.lock.untilStation"
                : "floor.signIn.lock.untilOperator",
            )}
          </p>
          <div
            className="operator-login__countdown-bar"
            aria-hidden="true"
            style={
              { "--lock-share": lockFraction(remaining, lockTotalMs(lock.scope)) } as CSSProperties
            }
          />
        </div>
      )}
    </div>
  );

  const zoneState =
    accepted !== null ? "accepted" : scannerState.key === "disconnected" ? "unavailable" : "ready";

  const body = () => {
    if (!working)
      return <div className="operator-login__body operator-login__body--state">{statement()}</div>;
    if (view === "search") {
      return (
        <div className="operator-login__body operator-login__body--search">
          <section className="operator-name-search" aria-label={t("floor.signIn.nameSearchTitle")}>
            <Input
              id={NAME_FIELD_ID}
              size="floor"
              label={t("floor.signIn.nameLabel")}
              value={query}
              maxLength={NAME_QUERY_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              // The product's own keyboard is below: Windows' must not cover the screen.
              inputMode="none"
              disabled={busy}
              suffix={<SearchGlyph />}
              hint={`${t("floor.signIn.search.scannerDeaf")}${
                Array.isArray(roster) && nameQueryLetters(query) >= NAME_SEARCH_MIN_LETTERS
                  ? ` ${t("floor.signIn.search.found", { count: matches.length })}`
                  : ""
              }`}
              onFocus={() => source.setManualTextEntryActive(true)}
              onBlur={() => source.setManualTextEntryActive(false)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </section>
          <div className="operator-name-search__results floor-sign-in__results" aria-live="polite">
            {searchResults()}
          </div>
          <CyrillicKeyboard
            value={query}
            onChange={typeName}
            disabled={busy}
            ariaLabel={t("floor.signIn.search.keyboard")}
            eraseLabel={t("floor.signIn.backspace")}
            spaceLabel={t("floor.signIn.search.space")}
          />
        </div>
      );
    }
    return (
      <div className="operator-login__body operator-login__body--entry">
        <BadgeZone
          state={zoneState}
          title={t(
            zoneState === "unavailable"
              ? "floor.signIn.badge.unavailableTitle"
              : "floor.signIn.badge.title",
          )}
          text={t(
            zoneState === "unavailable"
              ? "floor.signIn.badge.unavailableText"
              : "floor.signIn.badge.text",
          )}
          chip={{ tone: scannerState.tone, text: t(`floor.signIn.scanner.${scannerState.key}`) }}
          checking={busy ? t("floor.signIn.checking") : null}
          name={accepted?.name ?? null}
          enteringText={t("floor.signIn.badge.entering")}
        />
        <div className="operator-login__entry">
          {fields()}
          <NumericKeypad
            ariaLabel={t("floor.signIn.fields.keypad")}
            backspaceLabel={t("floor.signIn.backspace")}
            clearLabel={t("floor.signIn.clear")}
            disabled={held || heldFields.includes(entry.active)}
            onKey={press}
          />
        </div>
      </div>
    );
  };

  /** The screen's actions, one row of equal columns under it. */
  const actions = (): ReactNode[] => {
    if (!working) {
      return readiness !== null && readiness !== "failed" && readiness.kind === "not_ready"
        ? [
            <Button key="sync" size="floor" onClick={onSync}>
              {t("floor.signIn.syncRetry")}
            </Button>,
          ]
        : [];
    }
    if (view === "search") {
      return [
        <Button
          key="back"
          size="floor"
          variant="secondary"
          disabled={busy}
          onClick={() => toView("entry")}
        >
          {t("floor.signIn.back")}
        </Button>,
      ];
    }
    const settings =
      scannerWarning && onScannerSettings !== undefined
        ? [
            <Button key="scanner" size="floor" variant="secondary" onClick={onScannerSettings}>
              {t("floor.signIn.scannerSettings")}
            </Button>,
          ]
        : [];
    return [
      ...settings,
      <Button key="name" size="floor" variant="secondary" disabled={held} onClick={openSearch}>
        {t("floor.signIn.useName")}
      </Button>,
      <Button
        key="submit"
        size="floor"
        className="floor-primary"
        loading={busy}
        disabled={accepted !== null || !canSubmit(entry) || heldFields.includes("pin")}
        onClick={() =>
          void attempt(
            "pin",
            (context) => signInWithPin(context, entry.login, entry.pin),
            entry.login,
          )
        }
      >
        {t("floor.signIn.submit")}
      </Button>,
    ];
  };

  /** What the message slot holds: the last answer, else a notice, else the scanner's warning. */
  const banner = (): ReactNode => {
    if (message !== null) {
      const words = problemWords(message);
      return (
        <Alert tone={words.tone} role="presentation" title={t(`${words.base}.title`, words.params)}>
          {t(`${words.base}.hint`, words.params)}
        </Alert>
      );
    }
    if (unlocked) {
      return (
        <Alert tone="info" role="presentation" title={t("floor.signIn.problems.unlocked.title")}>
          {t("floor.signIn.problems.unlocked.hint")}
        </Alert>
      );
    }
    if (notice !== null && !noticeDismissed) {
      return (
        <Alert tone="info" role="presentation" title={t(`${NOTICE_KEY[notice]}.title`)}>
          {t(`${NOTICE_KEY[notice]}.hint`)}
        </Alert>
      );
    }
    if (scannerWarning && view === "entry") {
      const key = scannerState.key as "partial" | "disconnected" | "unknown";
      return (
        <Alert
          tone="warn"
          role="presentation"
          data-testid="scanner-state"
          data-tone={scannerState.tone}
          title={t(`floor.signIn.scannerWarning.${key}.title`)}
        >
          {t(`floor.signIn.scannerWarning.${key}.hint`)}
        </Alert>
      );
    }
    return null;
  };

  const stepActions = actions();
  return (
    <section
      className="operator-login"
      aria-labelledby="floor-sign-in-title"
      data-view={view}
      data-accepted={accepted !== null ? "true" : undefined}
    >
      <header className="operator-login__header">
        <StationBrand label={t("floor.signIn.brand")} />
        <div className="operator-login__prompt">
          <h1 id="floor-sign-in-title">{t("floor.signIn.title")}</h1>
          {working && view === "search" && <p>{t("floor.signIn.namePrompt")}</p>}
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
        {banner()}
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
