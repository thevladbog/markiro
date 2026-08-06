import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner } from "@markiro/ui";

import { pairingBarcodeBoxStyle } from "./pairingBarcodeBox.js";

const PairingBarcode = lazy(() => import("./PairingBarcode.js"));
const GROUP_SIZE = 4;

function groupDigits(code: string): string {
  return (code.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g")) ?? [code]).join(" ");
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function useRemainingMs(expiresAt: string): number {
  const expiresAtMs = useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAtMs]);

  return Math.max(0, expiresAtMs - nowMs);
}

export interface PairingCodeRevealProps {
  code: string;
  expiresAt: string;
  regenerating: boolean;
  onRegenerate: () => void;
  onExpired: () => void;
}

export function PairingCodeReveal({
  code,
  expiresAt,
  regenerating,
  onRegenerate,
  onExpired,
}: PairingCodeRevealProps) {
  const { t } = useTranslation();
  const remainingMs = useRemainingMs(expiresAt);
  const expiryReported = useRef(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (remainingMs > 0 || expiryReported.current) return;
    expiryReported.current = true;
    onExpired();
  }, [onExpired, remainingMs]);

  if (remainingMs <= 0) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <div className="mk-kiosk-pairing-reveal">
      <div className="mk-kiosk-pairing-reveal__code-box">
        <div className="mk-kiosk-pairing-reveal__code" role="group" aria-label={code}>
          <span aria-hidden="true">{groupDigits(code)}</span>
        </div>
        <Suspense
          fallback={
            <div style={pairingBarcodeBoxStyle} aria-busy="true">
              <Spinner label={t("pages.kiosks.pairing.barcodeLoading")} />
            </div>
          }
        >
          <PairingBarcode code={code} label={t("pages.kiosks.pairing.barcodeLabel", { code })} />
        </Suspense>
      </div>
      <p className="mk-kiosk-pairing-reveal__countdown">
        {t("pages.kiosks.pairing.expiresIn", { time: formatCountdown(remainingMs) })}
      </p>
      {copyError ? <Alert tone="error">{t("pages.kiosks.pairing.copyError")}</Alert> : null}
      <div className="mk-kiosk-pairing-reveal__actions">
        <Button type="button" variant="secondary" onClick={() => void copy()}>
          {t("pages.kiosks.pairing.copyAction")}
        </Button>
        <Button type="button" variant="secondary" loading={regenerating} onClick={onRegenerate}>
          {t("pages.kiosks.pairing.regenerateAction")}
        </Button>
      </div>
    </div>
  );
}
