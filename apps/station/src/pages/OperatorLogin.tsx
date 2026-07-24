import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SqlExecutor } from "../lib/mirror.js";
import { verifyOperatorPin } from "../lib/auth.js";
import { PinPad } from "../ui/PinPad.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  onAuthed: (operator: OperatorMirrorRecord) => void;
}

export function OperatorLogin({ exec, onAuthed }: OperatorLoginProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let operator: OperatorMirrorRecord | null;
    try {
      operator = await verifyOperatorPin(exec, pin);
    } catch (err) {
      // If boot migrations failed (App.tsx logs and continues rather than
      // strand the device), `operators_mirror` may not exist yet and this
      // query throws — surface the same wrong-PIN slot instead of an
      // unhandled rejection, so the operator gets a legible error either way.
      console.error("station: verifyOperatorPin failed", err);
      operator = null;
    }
    if (operator) {
      onAuthed(operator);
    } else {
      setError(t("login.wrong"));
      setPin("");
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("login.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>{t("login.pinPrompt")}</p>
      <div aria-label="pin" style={{ fontSize: "3rem", letterSpacing: "0.5rem" }}>
        {"•".repeat(pin.length)}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinPad value={pin} onChange={setPin} />
      <div style={{ display: "flex", gap: 12 }}>
        <Button variant="secondary" style={{ minHeight: 64 }} onClick={() => setPin("")}>
          {t("login.clear")}
        </Button>
        <Button style={{ minHeight: 64 }} onClick={() => void submit()}>
          {t("login.submit")}
        </Button>
      </div>
    </main>
  );
}
