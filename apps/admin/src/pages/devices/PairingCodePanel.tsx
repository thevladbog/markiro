import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner } from "@markiro/ui";

import { pairingBarcodeBoxStyle } from "../kiosks/pairingBarcodeBox.js";
import { PairingInstructions } from "./PairingInstructions.js";
import type { DeviceType, PairingCode } from "./api.js";

const PairingBarcode = lazy(() => import("./PairingBarcode.js"));

function groupDigits(code: string): string {
  return code.replace(/(\d{4})(\d{4})/, "$1 $2");
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function useRemainingMs(expiresAt: string): number {
  const expiry = useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiry]);
  return Number.isNaN(expiry) ? 0 : Math.max(0, expiry - now);
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
}

export interface PairingCodePanelProps {
  pairing: PairingCode;
  issuedAt: string;
  deviceName: string;
  deviceType: DeviceType;
  placeName: string | null;
  organizationName: string | null;
  regenerating: boolean;
  onRegenerate: () => void;
}

/** Active-drawer-only one-time code reveal. It never reads or writes browser storage. */
export function PairingCodePanel({
  pairing,
  issuedAt,
  deviceName,
  deviceType,
  placeName,
  organizationName,
  regenerating,
  onRegenerate,
}: PairingCodePanelProps) {
  const { t } = useTranslation();
  const remainingMs = useRemainingMs(pairing.expiresAt);
  const expired = remainingMs === 0;

  return (
    <div
      aria-live="polite"
      style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}
    >
      <style>{`
        .mk-pairing-print { display: none; }
        @media print {
          body * { visibility: hidden !important; }
          .mk-pairing-print, .mk-pairing-print * { visibility: visible !important; }
          .mk-pairing-print { display: block !important; position: fixed; inset: 0; padding: 14mm; color: #000; background: #fff; font: 12pt/1.45 var(--font-ui); }
          .mk-pairing-print h1 { font-size: 20pt; margin: 0 0 8mm; }
          .mk-pairing-print dl { display: grid; grid-template-columns: max-content 1fr; gap: 2mm 6mm; margin: 0 0 8mm; }
          .mk-pairing-print dl div { display: contents; }
          .mk-pairing-print dt { font-weight: 600; }
          .mk-pairing-print dd { margin: 0; }
          .mk-pairing-print__digits { border: 1px solid #000; margin: 8mm 0 2mm; padding: 5mm; font: 700 24pt/1 var(--font-mono); letter-spacing: .12em; text-align: center; }
          .mk-pairing-print__raw { font: 10pt/1.4 var(--font-mono); text-align: center; }
          .mk-pairing-print__barcode { display: flex; justify-content: center; margin: 5mm 0; }
          .mk-pairing-print ol { margin: 8mm 0 0; padding-left: 6mm; }
          .mk-pairing-barcode { filter: grayscale(1) contrast(2); padding: 5mm; background: #fff; }
        }
      `}</style>
      {expired ? (
        <Alert tone="warn">{t("pages.devices.pairing.expired")}</Alert>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--sp-3)",
              padding: "var(--sp-5)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              background: "var(--surface-panel)",
            }}
          >
            <span
              style={{
                font: "var(--text-h1)",
                letterSpacing: "0.12em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {groupDigits(pairing.code)}
            </span>
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clipPath: "inset(50%)",
              }}
            >
              {pairing.code}
            </span>
            <Suspense
              fallback={
                <div style={pairingBarcodeBoxStyle} aria-busy="true">
                  <Spinner label={t("pages.kiosks.pairing.barcodeLoading")} />
                </div>
              }
            >
              <PairingBarcode
                code={pairing.code}
                label={t("pages.devices.pairing.barcodeLabel", { code: pairing.code })}
              />
            </Suspense>
          </div>
          <p
            style={{
              margin: 0,
              font: "var(--text-body-sm)",
              color: "var(--fg-3)",
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {t("pages.devices.pairing.expiresIn", { time: formatCountdown(remainingMs) })}
          </p>
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
            {t("pages.devices.pairing.expiresAt", { time: dateTime(pairing.expiresAt) })}
          </p>
          <Button type="button" variant="secondary" onClick={() => window.print()}>
            {t("pages.devices.pairing.print")}
          </Button>
        </>
      )}
      <Button type="button" variant="secondary" loading={regenerating} onClick={onRegenerate}>
        {t("pages.devices.pairing.regenerate")}
      </Button>
      {!expired ? (
        <PairingInstructions
          code={pairing.code}
          deviceName={deviceName}
          deviceType={deviceType}
          placeName={placeName}
          organizationName={organizationName}
          issuedAt={issuedAt}
          expiresAt={pairing.expiresAt}
          barcode={
            <Suspense fallback={null}>
              <PairingBarcode
                code={pairing.code}
                label={t("pages.devices.pairing.barcodeLabel", { code: pairing.code })}
              />
            </Suspense>
          }
        />
      ) : null}
    </div>
  );
}
