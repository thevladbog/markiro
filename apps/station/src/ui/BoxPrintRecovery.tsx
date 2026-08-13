import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type { BoxPrintErrorCode } from "../lib/boxes.js";

export interface BoxPrintRecoveryProps {
  sscc: string;
  errorCode: BoxPrintErrorCode;
  pending: boolean;
  onRetry: () => void;
  onSetup: () => void;
  onSkip: () => void;
}

const ERROR_KEYS: Record<BoxPrintErrorCode, string> = {
  template_missing: "box.printRecovery.errors.templateMissing",
  printer_unconfigured: "box.printRecovery.errors.printerUnconfigured",
  render_failed: "box.printRecovery.errors.renderFailed",
  transport_failed: "box.printRecovery.errors.transportFailed",
};

export function BoxPrintRecovery({
  sscc,
  errorCode,
  pending,
  onRetry,
  onSetup,
  onSkip,
}: BoxPrintRecoveryProps) {
  const { t } = useTranslation();
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const canOpenSetup = errorCode === "printer_unconfigured" || errorCode === "transport_failed";

  if (confirmingSkip) {
    return (
      <FullScreenDialog
        open
        title={t("box.printRecovery.confirmTitle")}
        backLabel={t("box.printRecovery.cancel")}
        backDisabled={pending}
        onClose={() => setConfirmingSkip(false)}
        initialFocus="dialog"
        footer={
          <Button size="floor" disabled={pending} onClick={onSkip}>
            {t(pending ? "box.printRecovery.pending" : "box.printRecovery.confirmContinue")}
          </Button>
        }
      >
        <div className="box-print-recovery">
          <p>{t("box.printRecovery.confirmDetail")}</p>
          <p className="box-print-recovery__sscc">
            <span>{t("box.printRecovery.sscc")}</span>
            <strong>{sscc}</strong>
          </p>
        </div>
      </FullScreenDialog>
    );
  }

  return (
    <FullScreenDialog
      open
      title={t("box.printRecovery.title")}
      backLabel={t(pending ? "box.printRecovery.pending" : "box.printRecovery.retry")}
      backDisabled={pending}
      onClose={onRetry}
      initialFocus="dialog"
      footer={
        <>
          {canOpenSetup ? (
            <Button size="floor" variant="secondary" disabled={pending} onClick={onSetup}>
              {t("box.printRecovery.setup")}
            </Button>
          ) : null}
          <Button
            size="floor"
            variant="secondary"
            disabled={pending}
            onClick={() => setConfirmingSkip(true)}
          >
            {t("box.printRecovery.continueWithoutLabel")}
          </Button>
        </>
      }
    >
      <div className="box-print-recovery">
        <p role="alert">{t(ERROR_KEYS[errorCode])}</p>
        <p className="box-print-recovery__sscc">
          <span>{t("box.printRecovery.sscc")}</span>
          <strong>{sscc}</strong>
        </p>
      </div>
    </FullScreenDialog>
  );
}
