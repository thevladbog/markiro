import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SqlExecutor } from "../lib/mirror.js";
import { verifyOperatorPin } from "../lib/auth.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  onAuthed: (operator: OperatorMirrorRecord) => void;
}

/**
 * Floor sign-in: personnel number, then PIN. Deliberately NOT a picker of every
 * operator — the roster is org-wide and can be large, and a PIN-only entry
 * cannot identify a person (PINs collide).
 */
export function OperatorLogin({ exec, onAuthed }: OperatorLoginProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<"login" | "pin">("login");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      let operator: OperatorMirrorRecord | null;
      try {
        operator = await verifyOperatorPin(exec, login, pin);
      } catch (err) {
        // If boot migrations failed (App.tsx logs and continues rather than
        // strand the device), `operators_mirror` may not exist yet and this
        // query throws — surface the same wrong-credentials slot instead of an
        // unhandled rejection.
        console.error("station: verifyOperatorPin failed", err);
        operator = null;
      }
      if (operator) {
        onAuthed(operator);
        return;
      }
      // Never say WHICH half was wrong — that would enumerate personnel numbers.
      setError(t("login.wrong"));
      setPin("");
      setStage("login");
      setLogin("");
    } finally {
      setBusy(false);
    }
  }

  const value = stage === "login" ? login : pin;
  const setValue = stage === "login" ? setLogin : setPin;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("login.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>
        {stage === "login" ? t("login.loginPrompt") : t("login.pinPrompt")}
      </p>
      <div
        aria-label={stage === "login" ? "login" : "pin"}
        style={{ fontSize: "3rem", letterSpacing: "0.5rem" }}
      >
        {stage === "login" ? login : "•".repeat(pin.length)}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinPad value={value} onChange={setValue} />
      <div style={{ display: "flex", gap: 12 }}>
        <Button
          variant="secondary"
          style={{ minHeight: 64 }}
          disabled={busy}
          onClick={() => {
            if (stage === "pin") {
              setPin("");
              setStage("login");
            } else {
              setLogin("");
            }
          }}
        >
          {stage === "pin" ? t("login.back") : t("login.clear")}
        </Button>
        <Button
          style={{ minHeight: 64 }}
          disabled={value.length === 0 || busy}
          onClick={() => {
            if (stage === "login") {
              setError(null);
              setStage("pin");
            } else {
              void submit();
            }
          }}
        >
          {stage === "login" ? t("login.next") : t("login.submit")}
        </Button>
      </div>
    </main>
  );
}
