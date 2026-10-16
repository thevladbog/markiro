import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FullScreenDialog, PinPad } from "@markiro/ui";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import type { ScanSource } from "./scan-source.js";
import {
  signInWithBadge,
  signInWithPin,
  type FloorOperator,
  type SignInContext,
  type SignInResult,
} from "./sign-in.js";
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

type Stage = "badge" | "login" | "pin";

type Message = SignInMessage | { kind: "other" };

const LOGIN = /^[0-9]{3,12}$/;
const PIN = /^[0-9]{4,6}$/;
const MINUTE_MS = 60_000;

/**
 * «Подтвердите, что это вы» (beta 3): a fresh proof of identity before a step
 * that must not happen by accident — leaving the full-screen mode, unpairing
 * the station. The proof is the sign-in's own: a badge scan, or a personnel
 * number and a PIN on the keypad, checked offline against this pairing's
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
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
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
    setLogin("");
    setPin("");
    setMessage(null);
    return () => onMute(false);
  }, [open, onMute]);

  const attempt = useCallback(
    async (via: "pin" | "badge", check: (context: SignInContext) => Promise<SignInResult>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
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
      setPin("");
      if (result === null) {
        setMessage({ kind: "failed" });
        return;
      }
      if (result.kind === "locked") {
        const minutes = Math.max(1, Math.ceil(result.remainingMs / MINUTE_MS));
        setMessage({ kind: "locked", scope: result.scope, minutes });
        return;
      }
      if (result.kind === "refused") {
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

  const scan = useRef(attempt);
  useEffect(() => {
    scan.current = attempt;
  }, [attempt]);
  useEffect(() => {
    if (!open || stage !== "badge") return;
    return source.start((raw) => {
      void scan.current("badge", (context) => signInWithBadge(context, raw));
    });
  }, [open, stage, source]);

  const toStage = (next: Stage) => {
    source.clearPendingInput();
    setMessage(null);
    setPin("");
    if (next === "login") setLogin("");
    setStage(next);
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

  const footer = (() => {
    if (stage === "badge") {
      return (
        <Button size="floor" variant="secondary" disabled={busy} onClick={() => toStage("login")}>
          {t("floor.signIn.useLogin")}
        </Button>
      );
    }
    if (stage === "login") {
      return (
        <>
          <Button size="floor" variant="secondary" disabled={busy} onClick={() => toStage("badge")}>
            {t("floor.signIn.back")}
          </Button>
          <Button size="floor" disabled={busy || !LOGIN.test(login)} onClick={() => toStage("pin")}>
            {t("floor.signIn.next")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button size="floor" variant="secondary" disabled={busy} onClick={() => toStage("login")}>
          {t("floor.signIn.back")}
        </Button>
        <Button
          size="floor"
          loading={busy}
          disabled={!PIN.test(pin)}
          onClick={() => void attempt("pin", (context) => signInWithPin(context, login, pin))}
        >
          {confirmLabel}
        </Button>
      </>
    );
  })();

  return (
    <FullScreenDialog
      open={open}
      title={title}
      backLabel={t("floor.reconfirm.cancel")}
      onClose={onCancel}
      footer={<div className="reconfirm__footer">{footer}</div>}
    >
      <div className="reconfirm" data-stage={stage}>
        <p className="reconfirm__detail">{detail}</p>
        <div className="reconfirm__message" aria-live="polite">
          {message !== null && messageAlert(message)}
        </div>
        {stage === "badge" && (
          <div className="reconfirm__badge">
            <h3>{t("floor.reconfirm.badgeInstruction")}</h3>
            <p>{t("floor.reconfirm.badgeExplanation")}</p>
          </div>
        )}
        {stage !== "badge" && (
          <div className="reconfirm__pad">
            <p className="reconfirm__prompt">
              {t(stage === "login" ? "floor.signIn.loginPrompt" : "floor.signIn.pinPrompt", {
                login,
              })}
            </p>
            <output className="reconfirm__readout" aria-label={t(`floor.signIn.${stage}Readout`)}>
              {stage === "login" ? login : "•".repeat(pin.length)}
            </output>
            <PinPad
              value={stage === "login" ? login : pin}
              onChange={stage === "login" ? setLogin : setPin}
              maxLength={stage === "login" ? 12 : 6}
              size="floor"
              disabled={busy}
              ariaLabel={t(
                stage === "login" ? "floor.signIn.loginKeypad" : "floor.signIn.pinKeypad",
              )}
              backspaceLabel={t("floor.signIn.backspace")}
              clearLabel={t("floor.signIn.clear")}
            />
          </div>
        )}
      </div>
    </FullScreenDialog>
  );
}
