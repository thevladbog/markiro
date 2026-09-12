import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type { BoxPrintErrorCode } from "../lib/boxes.js";

/**
 * The pallet label's print outcome, as this screen presents it:
 *
 * - `printing`: an attempt is in flight right now.
 * - `printed`: it printed; the operator dismisses to resume work.
 * - `failed`: a known category (missing template, unconfigured printer,
 *   render or transport failure) -- retryable, with the same escape hatches
 *   `BoxPrintRecovery` already offers a box.
 * - `unknown`: this device cannot tell whether the label reached the
 *   printer before an interruption (a restart mid-print). The one rule that
 *   matters here: this state NEVER triggers another print by itself. The
 *   operator must say plainly whether the physical label already exists.
 */
export type PalletPrintState = "printing" | "printed" | "failed" | "unknown";

export interface PalletCloseResult {
  status: "closed";
  sscc: string;
  boxCount: number;
}

export interface PalletCloseProps {
  result: PalletCloseResult;
  print: PalletPrintState;
  /** Only meaningful when `print === "failed"`. */
  errorCode?: BoxPrintErrorCode | null;
  /** An action (retry/skip/confirm/reprint) is in flight; disables every button. */
  pending?: boolean;
  /** `print === "failed"`: try the same bytes again. */
  onRetry?: () => void;
  /** `print === "failed"` with a setup-fixable error: open printer setup. */
  onSetup?: () => void;
  /** `print === "failed"`: give up on this label and move on. */
  onSkip?: () => void;
  /** `print === "unknown"`: the physical label already exists -- do not print again. */
  onConfirmPrinted?: () => void;
  /** `print === "unknown"` or `"failed"`: deliberately print again. */
  onReprint?: () => void;
  /** `print === "printed"`: dismiss and resume work. */
  onContinue?: () => void;
}

const ERROR_KEYS: Record<BoxPrintErrorCode, string> = {
  template_missing: "box.printRecovery.errors.templateMissing",
  printer_unconfigured: "box.printRecovery.errors.printerUnconfigured",
  render_failed: "box.printRecovery.errors.renderFailed",
  transport_failed: "box.printRecovery.errors.transportFailed",
};

/**
 * The full-screen announcement a closed pallet gets -- unlike a routine box
 * close, which is silent unless something goes wrong. A pallet is the
 * bigger, rarer event: the operator needs to be told plainly that one just
 * closed, its SSCC, and -- until the label is resolved one way or another --
 * this screen stays up. Mirrors `BoxPrintRecovery`'s error handling and
 * actions, plus the two extra states a box screen never needed: `printing`
 * (shown immediately, not only on failure) and `unknown` (never resends by
 * itself).
 */
export function PalletClose({
  result,
  print,
  errorCode = null,
  pending = false,
  onRetry,
  onSetup,
  onSkip,
  onConfirmPrinted,
  onReprint,
  onContinue,
}: PalletCloseProps) {
  const { t } = useTranslation();
  const canOpenSetup = errorCode === "printer_unconfigured" || errorCode === "transport_failed";

  const header =
    print === "failed"
      ? { label: t(pending ? "box.printRecovery.pending" : "pallet.retry"), onClose: onRetry }
      : print === "unknown"
        ? {
            label: t(pending ? "box.printRecovery.pending" : "pallet.confirmPrinted"),
            onClose: onConfirmPrinted,
          }
        : print === "printed"
          ? { label: t("work.continue"), onClose: onContinue }
          : { label: t("box.printRecovery.pending"), onClose: undefined };

  const footer =
    print === "failed" ? (
      <>
        {canOpenSetup ? (
          <Button size="floor" variant="secondary" disabled={pending} onClick={onSetup}>
            {t("box.printRecovery.setup")}
          </Button>
        ) : null}
        <Button size="floor" variant="secondary" disabled={pending} onClick={onSkip}>
          {t("box.printRecovery.continueWithoutLabel")}
        </Button>
      </>
    ) : print === "unknown" ? (
      <Button size="floor" variant="secondary" disabled={pending} onClick={onReprint}>
        {t("pallet.reprint")}
      </Button>
    ) : null;

  return (
    <FullScreenDialog
      open
      title={t("pallet.closed")}
      backLabel={header.label}
      backDisabled={print === "printing" || pending}
      onClose={() => header.onClose?.()}
      initialFocus="dialog"
      footer={footer}
    >
      <div className="pallet-close">
        <p className="pallet-close__boxes">{t("pallet.boxCount", { count: result.boxCount })}</p>
        <p className="pallet-close__sscc">
          <span>{t("pallet.sscc")}</span>
          <strong>{result.sscc}</strong>
        </p>
        {print === "printing" ? (
          <p className="pallet-close__status" role="status">
            {t("pallet.printing")}
          </p>
        ) : null}
        {print === "printed" ? <Alert tone="ok" title={t("pallet.printed")} /> : null}
        {print === "failed" ? (
          <Alert tone="error" title={t(ERROR_KEYS[errorCode ?? "transport_failed"])} />
        ) : null}
        {print === "unknown" ? <Alert tone="warn" title={t("pallet.printUnknown")} /> : null}
      </div>
    </FullScreenDialog>
  );
}
