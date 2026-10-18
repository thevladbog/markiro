import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { EntryField } from "./kit/EntryField.js";
import { NumericKeypad } from "./kit/NumericKeypad.js";
import type { ScanSource } from "./scan-source.js";
import {
  signInWithBadge,
  signInWithPin,
  type FloorOperator,
  type SignInContext,
  type SignInResult,
} from "./sign-in.js";
import {
  afterAttempt,
  canSubmit,
  editEntry,
  fieldStatus,
  selectField,
  type Entry,
  type EntryField as EntryFieldName,
} from "./sign-in/entry.js";
import { BadgeIcon } from "./sign-in/operator-icons.js";
import { problemWords, type SignInMessage } from "./sign-in/messages.js";
import "./reconfirm.css";

export interface ReconfirmProps {
  open: boolean;
  /** What is about to happen, in the dialog's own words. */
  title: string;
  detail: string;
  confirmLabel: string;
  local: LocalExecutor;
  pairing: Pairing;
  /** The unmuted source: a badge scan is read here while the floor's screens are muted. */
  source: ScanSource;
  /** Mutes the floor's screens while the dialog is open (`createGatedScanSource`). */
  onMute: (muted: boolean) => void;
  /**
   * The operator signed in: only their own badge, or their own number and PIN,
   * confirms. `null` (nobody signed in): any operator's does.
   */
  expectedOperatorId: string | null;
  /** The operator's identity was proven again. */
  onConfirmed: () => void;
  onCancel: () => void;
  /** This computer's clock, for the lockouts; tests pin it. */
  now?: () => number;
}

type Stage = "badge" | "entry";

type Message = SignInMessage | { kind: "other" };

const MINUTE_MS = 60_000;
const FRESH: Entry = { active: "login", login: "", pin: "" };

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * «Подтвердите, что это вы» (beta 3): a fresh proof of identity before a step
 * that must not happen by accident — leaving the full-screen mode, unpairing
 * the station. The proof is the sign-in's own: a badge scan, or a personnel
 * number and a PIN (two labelled fields and the one flat keypad, as on the
 * sign-in screen, variant A of the design kit; a badge is read on both steps), checked offline against this pairing's
 * copies (`signInWithBadge`, `signInWithPin`), so a wrong attempt counts
 * against the same lockouts as one on the sign-in screen and a locked
 * operator or station is refused here as well. It signs nobody in and changes
 * nothing else; the PIN and the badge stay in this component's state until
 * the check answers, and the PIN is cleared whatever the answer.
 */
export function Reconfirm({
  open,
  title,
  detail,
  confirmLabel,
  local,
  pairing,
  source,
  onMute,
  expectedOperatorId,
  onConfirmed,
  onCancel,
  now = Date.now,
}: ReconfirmProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("badge");
  const [entry, setEntry] = useState<Entry>(FRESH);
  const [fieldError, setFieldError] = useState<EntryFieldName | null>(null);
  const [heldFields, setHeldFields] = useState<EntryFieldName[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The floor's screens hear no scan while the dialog is open; a closed
  // dialog starts over from the badge.
  useEffect(() => {
    if (!open) return;
    onMute(true);
    setStage("badge");
    setEntry(FRESH);
    setFieldError(null);
    setHeldFields([]);
    setMessage(null);
    return () => onMute(false);
  }, [open, onMute]);

  // Focus goes to the dialog itself, not to a button: the closing Enter of a
  // scan must not press one. It comes back to where it was when the dialog goes.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [open]);

  const attempt = useCallback(
    async (via: "pin" | "badge", check: (context: SignInContext) => Promise<SignInResult>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      setFieldError(null);
      let result: SignInResult | null;
      try {
        result = await check({ local, pairing: { hostId, deviceId }, now });
      } catch {
        // A failed read or write of the local database: its text may name SQL.
        result = null;
      }
      inFlight.current = false;
      if (!alive.current) return;
      setBusy(false);
      setEntry((now) => afterAttempt(now, via));
      if (result === null) {
        setMessage({ kind: "failed" });
        return;
      }
      if (result.kind === "locked") {
        const minutes = Math.max(1, Math.ceil(result.remainingMs / MINUTE_MS));
        setHeldFields(result.scope === "station" ? ["login", "pin"] : ["pin"]);
        setMessage({ kind: "locked", scope: result.scope, minutes });
        return;
      }
      if (result.kind === "refused") {
        if (via === "pin") setFieldError("pin");
        setMessage({ kind: "refused", reason: result.reason, via });
        return;
      }
      const operator: FloorOperator = result.operator;
      if (expectedOperatorId !== null && operator.id !== expectedOperatorId) {
        setMessage({ kind: "other" });
        return;
      }
      onConfirmed();
    },
    [local, hostId, deviceId, now, expectedOperatorId, onConfirmed],
  );

  // A badge is read on either step: «Ввести табельный номер» only adds the fields.
  const scan = useRef(attempt);
  useEffect(() => {
    scan.current = attempt;
  }, [attempt]);
  useEffect(() => {
    if (!open) return;
    return source.start((raw) => {
      void scan.current("badge", (context) => signInWithBadge(context, raw));
    });
  }, [open, source]);

  const toEntry = () => {
    source.clearPendingInput();
    setMessage(null);
    setFieldError(null);
    setHeldFields([]);
    setEntry(FRESH);
    setStage("entry");
  };

  const press = (key: Parameters<typeof editEntry>[1]) => {
    const next = editEntry(entry, key);
    if (next === entry) return;
    if (fieldError === entry.active) setFieldError(null);
    if (next.login !== entry.login) {
      // An operator's own lock is that number's; a station's stays.
      setHeldFields((now) => (now.includes("login") ? now : []));
      setMessage((shown) =>
        shown?.kind === "locked" && shown.scope === "operator" ? null : shown,
      );
    }
    setEntry(next);
  };

  /** What the dialog says of the last answer: a title and what to do (the sign-in's own words). */
  const messageAlert = (shown: Message) => {
    if (shown.kind === "other") return <Alert tone="error">{t("floor.reconfirm.notYou")}</Alert>;
    const words = problemWords(shown);
    return (
      <Alert tone={words.tone} title={t(`${words.base}.title`, words.params)}>
        {t(`${words.base}.hint`, words.params)}
      </Alert>
    );
  };

  const submit = () =>
    void attempt("pin", (context) => signInWithPin(context, entry.login, entry.pin));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
    } else if (document.activeElement === dialog) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  const loginStatus = fieldStatus("login", entry, { error: fieldError, locked: heldFields });
  const pinStatus = fieldStatus("pin", entry, { error: fieldError, locked: heldFields });
  const errorLine = (reason: string) => `${t("floor.signIn.fields.error")} · ${reason}`;

  return (
    <div className="reconfirm-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="reconfirm-card"
        data-stage={stage}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="reconfirm__title">
          {title}
        </h2>
        <p className="reconfirm__detail">{detail}</p>
        {stage === "badge" ? (
          <>
            <div className="reconfirm__message" aria-live="polite">
              {message !== null && messageAlert(message)}
            </div>
            <section className="reconfirm__badge">
              <div className="reconfirm__badge-picture">
                <BadgeIcon />
              </div>
              <div className="reconfirm__badge-copy">
                <h3>{t("floor.reconfirm.badgeInstruction")}</h3>
                <p>{t("floor.reconfirm.badgeExplanation")}</p>
              </div>
            </section>
          </>
        ) : (
          <div className="reconfirm__entry">
            <div className="reconfirm__fields">
              <EntryField
                id="reconfirm-login"
                label={t("floor.signIn.fields.loginLabel")}
                shown={entry.login}
                valueLabel={t("floor.signIn.loginReadout")}
                status={loginStatus}
                placeholder={t("floor.signIn.fields.loginHint")}
                hint={
                  loginStatus === "error"
                    ? errorLine(t("floor.signIn.fields.loginErrorHint"))
                    : loginStatus === "active"
                      ? t("floor.signIn.fields.loginHint")
                      : ""
                }
                onSelect={() => setEntry((now) => selectField(now, "login"))}
              />
              <EntryField
                id="reconfirm-pin"
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
              <div className="reconfirm__message" aria-live="polite">
                {message !== null && messageAlert(message)}
              </div>
            </div>
            <NumericKeypad
              ariaLabel={t("floor.signIn.fields.keypad")}
              backspaceLabel={t("floor.signIn.backspace")}
              clearLabel={t("floor.signIn.clear")}
              disabled={busy || heldFields.includes(entry.active)}
              onKey={press}
            />
          </div>
        )}
        <div className="reconfirm__footer" style={{ "--reconfirm-columns": 2 } as CSSProperties}>
          <Button size="floor" variant="secondary" disabled={busy} onClick={onCancel}>
            {t("floor.reconfirm.cancel")}
          </Button>
          {stage === "badge" ? (
            <Button size="floor" className="floor-primary" disabled={busy} onClick={toEntry}>
              {t("floor.signIn.useLogin")}
            </Button>
          ) : (
            <Button
              size="floor"
              className="floor-primary"
              loading={busy}
              disabled={!canSubmit(entry) || heldFields.includes("pin")}
              onClick={submit}
            >
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
