import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseScannedSscc } from "@markiro/domain";
import { Alert, Button } from "@markiro/ui";
import type { ScanSource } from "../lib/scan-source.js";

export interface PrintVerificationProps {
  /** The bare 18-digit SSCC the operator should scan off the printed label. */
  expected: string;
  /** Fires the instant a scan matches `expected`. */
  onVerified: () => void;
  /** The label did not match, or was unreadable -- print the same bytes again. */
  onReprint: () => void;
  /** The scanner is disconnected, or the label is ruined -- move on without verifying. */
  onSkip: () => void;
  /** The physical scan source, same seam `WorkScreen` reads from. */
  scanSource: ScanSource;
}

export type PrintVerificationMessage = "waiting" | "mismatch" | "notSscc";

/**
 * The one deliberate exception to "nothing competes with a scan verdict"
 * (design brief 06c): a box has just closed, the operator is physically at
 * the printer, and the flow is already interrupted for taping. This panel
 * takes over the scan source entirely -- `WorkScreen` stops feeding its own
 * queue while this is mounted -- so a box-label scan is never misjudged as
 * an ordinary product code.
 *
 * It must always have an exit: a mismatched or unreadable scan offers
 * reprint; a disconnected scanner or a ruined label offers skip. Neither
 * button is ever disabled or hidden, whatever the last scan's outcome was.
 */
export function PrintVerification({
  expected,
  onVerified,
  onReprint,
  onSkip,
  scanSource,
}: PrintVerificationProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [feedback, setFeedback] = useState<{
    expected: string;
    message: PrintVerificationMessage;
  }>({ expected, message: "waiting" });
  const message = feedback.expected === expected ? feedback.message : "waiting";

  useEffect(() => {
    let active = true;
    const stop = scanSource.start((raw) => {
      if (!active) return;
      const parsed = parseScannedSscc(raw);
      if (parsed === null) {
        setFeedback({ expected, message: "notSscc" });
        return;
      }
      if (parsed !== expected) {
        setFeedback({ expected, message: "mismatch" });
        return;
      }
      setFeedback({ expected, message: "waiting" });
      onVerified();
    });
    return () => {
      active = false;
      stop();
    };
  }, [scanSource, expected, onVerified]);

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: 32,
        background: "var(--surface-page, #fff)",
      }}
    >
      <h1 id={titleId} style={{ fontSize: "2rem" }}>
        {t("box.printExpected")}
      </h1>
      <p style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "0.05em" }}>{expected}</p>

      {message === "mismatch" && <Alert tone="error" title={t("box.printMismatch")} />}
      {message === "notSscc" && <Alert tone="error" title={t("box.printNotSscc")} />}

      <div style={{ display: "flex", gap: 12, marginTop: "auto" }}>
        <Button type="button" size="floor" onClick={onReprint}>
          {t("box.printReprint")}
        </Button>
        <Button type="button" size="floor" variant="secondary" onClick={onSkip}>
          {t("box.printSkip")}
        </Button>
      </div>
    </section>
  );
}
