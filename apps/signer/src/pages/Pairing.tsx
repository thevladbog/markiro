import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
import type { PairOutcome } from "../lib/bridge.js";

interface PairingProps {
  hostname: string;
  onPair: (code: string) => Promise<PairOutcome>;
  onPaired?: () => void;
}

export function Pairing({ hostname, onPair, onPaired }: PairingProps): ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"rejected" | "unavailable" | null>(null);
  const complete = /^\d{8}$/.test(code);

  async function submit(): Promise<void> {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onPair(code);
      if (outcome.ok) {
        setCode("");
        onPaired?.();
      } else {
        setError(outcome.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("pairing.title")}>
      <p>{t("pairing.hint", { hostname })}</p>
      <Input
        label={t("pairing.codeLabel")}
        value={code}
        inputMode="numeric"
        maxLength={8}
        autoComplete="one-time-code"
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
      />
      {error ? <Alert tone="error">{t(`pairing.error.${error}`)}</Alert> : null}
      <Button onClick={() => void submit()} disabled={!complete} loading={busy}>
        {t("pairing.submit")}
      </Button>
    </Card>
  );
}
