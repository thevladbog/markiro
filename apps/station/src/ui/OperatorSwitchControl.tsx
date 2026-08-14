import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";

export interface OperatorSwitchControlProps {
  activeShift: boolean;
  pending: boolean;
  error: boolean;
  onSwitch: () => Promise<void>;
  onDismissError: () => void;
}

export function OperatorSwitchControl({
  activeShift,
  pending,
  error,
  onSwitch,
  onDismissError,
}: OperatorSwitchControlProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);
  const switchPending = pending || inFlight;

  async function runSwitch(): Promise<void> {
    if (pending || inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    setConfirming(false);
    try {
      await onSwitch();
    } catch {
      // App owns the retryable, translated failure state.
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  function requestSwitch(): void {
    if (switchPending || error) return;
    if (activeShift) setConfirming(true);
    else void runSwitch();
  }

  return (
    <div className="operator-switch-control">
      <Button
        type="button"
        size="floor"
        variant="secondary"
        disabled={switchPending || error}
        aria-label={t(switchPending ? "operatorSwitch.pending" : "operatorSwitch.action")}
        onClick={requestSwitch}
      >
        {t(switchPending ? "operatorSwitch.pending" : "operatorSwitch.action")}
      </Button>

      {error ? (
        <div className="operator-switch-control__error" role="alert">
          <span>{t("operatorSwitch.error")}</span>
          <Button
            type="button"
            size="floor"
            variant="secondary"
            disabled={switchPending}
            aria-label={t("operatorSwitch.retryLabel")}
            onClick={() => {
              onDismissError();
              void runSwitch();
            }}
          >
            {t("operatorSwitch.retry")}
          </Button>
        </div>
      ) : null}

      <FullScreenDialog
        open={confirming}
        title={t("operatorSwitch.confirmTitle")}
        backLabel={t("operatorSwitch.stay")}
        onClose={() => setConfirming(false)}
        footer={
          <Button size="floor" disabled={switchPending} onClick={() => void runSwitch()}>
            {t("operatorSwitch.confirm")}
          </Button>
        }
      >
        <p className="operator-switch-control__confirmation">{t("operatorSwitch.confirmDetail")}</p>
      </FullScreenDialog>
    </div>
  );
}
