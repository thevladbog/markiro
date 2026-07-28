import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal } from "@markiro/ui";

import { toast } from "../../lib/toast.js";

/**
 * Lazily loaded so bwip-js (reached through `@markiro/domain`'s Code 128
 * renderer) stays out of the main admin bundle and is fetched only when a
 * pairing code is actually issued. See `./PairingBarcode.tsx`.
 */
const PairingBarcode = lazy(() => import("./PairingBarcode.js"));

/** Digits per readability group in the reveal -- 8 digits render as `1234 5678`. */
const GROUP_SIZE = 4;

/** `12345678` -> `1234 5678`. Presentation only; the copy action uses the raw digits. */
function groupDigits(code: string): string {
  return (code.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g")) ?? [code]).join(" ");
}

/**
 * `ms` -> `mm:ss`, rounding up so a code with the full 15 minutes left reads
 * `15:00` rather than `14:59`.
 */
function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Milliseconds left until `expiresAt`, re-read once a second. Recomputed from
 * the wall clock on every tick rather than decremented, so a suspended or
 * throttled tab resumes with the true remaining time instead of a drifted one.
 */
function useRemainingMs(expiresAt: string): number {
  const expiresAtMs = useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);

  return Math.max(0, expiresAtMs - now);
}

export interface PairingCodeModalProps {
  kioskName: string;
  /** Plaintext pairing code. Held in the parent's state only, never refetchable. */
  code: string;
  /** ISO-8601 expiry from the server. */
  expiresAt: string;
  regenerating: boolean;
  onRegenerate: () => void;
  onClose: () => void;
}

/**
 * One-time reveal of a kiosk pairing code -- design brief 07 §2
 * ("Generated-code state"): the grouped numeric PIN, the same code as a
 * scannable barcode, a live TTL countdown, and copy/regenerate actions.
 *
 * The plaintext exists only in the parent's component state (the server keeps
 * just a hash), so closing this modal destroys it for good; the only way back
 * to a usable code is regenerating, which retires the previous one server-side.
 * Mounted conditionally by the parent rather than toggled through an `open`
 * prop, so the countdown interval exists exactly as long as a live code does.
 */
export function PairingCodeModal({
  kioskName,
  code,
  expiresAt,
  regenerating,
  onRegenerate,
  onClose,
}: PairingCodeModalProps) {
  const { t } = useTranslation();
  const remainingMs = useRemainingMs(expiresAt);
  const expired = remainingMs <= 0;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      toast("error", t("pages.kiosks.pairing.copyError"));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t("common.close")}
      title={t("pages.kiosks.pairing.modalTitle")}
      footer={
        <>
          <Button type="button" variant="secondary" loading={regenerating} onClick={onRegenerate}>
            {t("pages.kiosks.pairing.regenerateAction")}
          </Button>
          <Button type="button" onClick={onClose}>
            {t("pages.kiosks.pairing.doneAction")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.kiosks.pairing.hint", { name: kioskName })}
        </p>

        {expired ? (
          <Alert tone="warn">{t("pages.kiosks.pairing.expired")}</Alert>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "16px 12px",
                background: "var(--surface-panel)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
              }}
            >
              <span
                style={{
                  font: "var(--text-h1)",
                  color: "var(--fg-1)",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "0.12em",
                }}
              >
                {groupDigits(code)}
              </span>
              <Suspense fallback={null}>
                <PairingBarcode
                  code={code}
                  label={t("pages.kiosks.pairing.barcodeLabel", { code })}
                />
              </Suspense>
            </div>
            <p
              style={{
                font: "var(--text-body-sm)",
                color: "var(--fg-3)",
                fontVariantNumeric: "tabular-nums",
                textAlign: "center",
              }}
            >
              {t("pages.kiosks.pairing.expiresIn", { time: formatCountdown(remainingMs) })}
            </p>
            <Button type="button" variant="secondary" onClick={() => void handleCopy()}>
              {t("pages.kiosks.pairing.copyAction")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
