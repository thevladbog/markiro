import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseScannedSscc } from "@markiro/domain";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type { BoxPrintErrorCode } from "../lib/boxes.js";
import type { ScanSource } from "../lib/scan-source.js";

export interface PrintVerificationProps {
  /** The bare 18-digit SSCC the operator should scan off the printed label. */
  expected: string;
  /** Fires the instant a scan matches `expected`. */
  onVerified: () => void | boolean | Promise<void | boolean>;
  /** The label did not match, or was unreadable -- print the same bytes again. */
  onReprint: () => void | BoxPrintErrorCode | Promise<void | BoxPrintErrorCode>;
  /** The scanner is disconnected, or the label is ruined -- move on without verifying. */
  onSkip: () => void | boolean | Promise<void | boolean>;
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
 * action is hidden after scan feedback. Both are disabled only while a
 * resolution is in flight, so a second input cannot resolve the next queued
 * label by mistake.
 */
export function PrintVerification({
  expected,
  onVerified,
  onReprint,
  onSkip,
  scanSource,
}: PrintVerificationProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<{
    expected: string;
    message: PrintVerificationMessage;
  }>({ expected, message: "waiting" });
  const [resolvingExpected, setResolvingExpected] = useState<string | null>(null);
  const [reprinting, setReprinting] = useState(false);
  const [reprintError, setReprintError] = useState<BoxPrintErrorCode | null>(null);
  const resolutionStartedFor = useRef<string | null>(null);
  const resolving = resolvingExpected === expected;
  const message = feedback.expected === expected ? feedback.message : "waiting";

  const beginResolution = useCallback(
    (action: () => void | boolean | Promise<void | boolean>): void => {
      if (resolutionStartedFor.current === expected) return;
      const startedFor = expected;
      resolutionStartedFor.current = startedFor;
      setResolvingExpected(startedFor);
      const release = (): void => {
        if (resolutionStartedFor.current !== startedFor) return;
        resolutionStartedFor.current = null;
        setResolvingExpected((current) => (current === startedFor ? null : current));
      };
      try {
        void Promise.resolve(action()).then((won) => {
          if (won === false) release();
        }, release);
      } catch {
        release();
      }
    },
    [expected],
  );

  async function reprint(): Promise<void> {
    if (reprinting || resolutionStartedFor.current === expected) return;
    setReprinting(true);
    setReprintError(null);
    try {
      const result = await onReprint();
      if (result) setReprintError(result);
    } catch {
      setReprintError("transport_failed");
    } finally {
      setReprinting(false);
    }
  }

  useEffect(() => {
    let active = true;
    const stop = scanSource.start((raw) => {
      if (!active || resolutionStartedFor.current === expected) return;
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
      beginResolution(onVerified);
    });
    return () => {
      active = false;
      stop();
    };
  }, [beginResolution, scanSource, expected, onVerified]);

  return (
    <FullScreenDialog
      open
      title={t("box.printExpected")}
      backLabel={t("box.printSkip")}
      backDisabled={resolving}
      onClose={() => beginResolution(onSkip)}
      initialFocus="dialog"
      footer={
        <Button
          type="button"
          size="floor"
          disabled={resolving || reprinting}
          onClick={() => void reprint()}
        >
          {t("box.printReprint")}
        </Button>
      }
    >
      <div
        style={{
          height: "100%",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <p style={{ margin: 0, fontSize: "2rem", fontWeight: 800, letterSpacing: "0.05em" }}>
          {expected}
        </p>

        {message === "mismatch" && <Alert tone="error" title={t("box.printMismatch")} />}
        {message === "notSscc" && <Alert tone="error" title={t("box.printNotSscc")} />}
        {reprintError ? (
          <Alert
            tone="error"
            title={t(
              reprintError === "template_missing"
                ? "box.printRecovery.errors.templateMissing"
                : reprintError === "printer_unconfigured"
                  ? "box.printRecovery.errors.printerUnconfigured"
                  : reprintError === "render_failed"
                    ? "box.printRecovery.errors.renderFailed"
                    : "box.printRecovery.errors.transportFailed",
            )}
          />
        ) : null}
      </div>
    </FullScreenDialog>
  );
}
