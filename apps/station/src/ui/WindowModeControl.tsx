import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type { LockdownSnapshot } from "../lib/lockdown.js";

export interface WindowModeControlProps {
  snapshot: LockdownSnapshot;
  activeShift: boolean;
  disabled?: boolean;
  onEnter: () => void | Promise<void>;
  onExit: () => void | Promise<void>;
  onDismissError: () => void;
}

export function WindowModeControl({
  snapshot,
  activeShift,
  disabled = false,
  onEnter,
  onExit,
  onDismissError,
}: WindowModeControlProps) {
  const { t } = useTranslation();
  const [confirmExit, setConfirmExit] = useState(false);
  const actionLabel = snapshot.pending
    ? t("windowMode.pending")
    : t(snapshot.mode === "locked" ? "windowMode.exit" : "windowMode.enter");

  useEffect(() => {
    if (disabled) setConfirmExit(false);
  }, [disabled]);

  function handleAction(): void {
    if (disabled || snapshot.pending) return;
    if (snapshot.mode === "windowed") {
      void onEnter();
    } else if (activeShift) {
      setConfirmExit(true);
    } else {
      void onExit();
    }
  }

  return (
    <div className="window-mode-control">
      <Button
        size="floor"
        variant="secondary"
        className="window-mode-control__action"
        disabled={disabled || snapshot.pending}
        aria-label={actionLabel}
        onClick={handleAction}
        icon={
          <span
            className={`window-mode-control__glyph window-mode-control__glyph--${snapshot.mode}`}
            aria-hidden="true"
          />
        }
      >
        {actionLabel}
      </Button>

      {snapshot.error ? (
        <div className="window-mode-control__error" role="alert">
          <span>
            {t(snapshot.error === "exit" ? "windowMode.exitError" : "windowMode.enterError")}
          </span>
          <Button
            size="floor"
            variant="secondary"
            aria-label={t("windowMode.dismissError")}
            disabled={disabled}
            onClick={() => {
              if (!disabled) onDismissError();
            }}
          >
            {t("windowMode.dismiss")}
          </Button>
        </div>
      ) : null}

      <FullScreenDialog
        open={confirmExit && !disabled}
        title={t("windowMode.confirmTitle")}
        backLabel={t("windowMode.cancel")}
        onClose={() => {
          if (!disabled) setConfirmExit(false);
        }}
        footer={
          <Button
            size="floor"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              setConfirmExit(false);
              void onExit();
            }}
          >
            {t("windowMode.confirmAction")}
          </Button>
        }
      >
        <p className="window-mode-control__confirmation">{t("windowMode.confirmDetail")}</p>
      </FullScreenDialog>
    </div>
  );
}
