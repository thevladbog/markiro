import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox } from "@markiro/ui";
import { bridge } from "../lib/bridge.js";

export function AutostartControl(): ReactElement {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<"readFailed" | "saveFailed" | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);

  const read = useCallback(async (): Promise<void> => {
    const request = ++sequence.current;
    const isCurrent = () => mounted.current && sequence.current === request;
    setBusy(true);
    setError(null);
    try {
      const actual = await bridge.autostartEnabled();
      if (isCurrent()) setEnabled(actual);
    } catch {
      if (isCurrent()) {
        setEnabled(null);
        setError("readFailed");
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
    };
  }, [read]);

  const save = async (next: boolean): Promise<void> => {
    if (busy || enabled === null) return;
    const request = ++sequence.current;
    const isCurrent = () => mounted.current && sequence.current === request;
    setBusy(true);
    setError(null);
    try {
      await bridge.setAutostartEnabled(next);
      const actual = await bridge.autostartEnabled();
      if (isCurrent()) setEnabled(actual);
    } catch {
      // A native write may have partially succeeded. Re-read instead of
      // presenting a guessed state after an OS error.
      try {
        const actual = await bridge.autostartEnabled();
        if (isCurrent()) setEnabled(actual);
      } catch {
        if (isCurrent()) setEnabled(null);
      }
      if (isCurrent()) setError("saveFailed");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <div className="signer-autostart">
      <Checkbox
        label={t("autostart.label")}
        hint={t("autostart.hint")}
        checked={enabled === true}
        disabled={busy || enabled === null}
        onCheckedChange={(next) => void save(next)}
      />
      {error ? (
        <>
          <Alert tone="error">{t(`autostart.${error}`)}</Alert>
          <Button size="compact" variant="secondary" disabled={busy} onClick={() => void read()}>
            {t("autostart.retry")}
          </Button>
        </>
      ) : null}
    </div>
  );
}
