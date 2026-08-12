import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type { LockdownSnapshot } from "../lib/lockdown.js";

export interface WindowModeControlProps {
  snapshot: LockdownSnapshot;
  activeShift: boolean;
  onEnter: () => void | Promise<void>;
  onExit: () => void | Promise<void>;
  onDismissError: () => void;
}

export function WindowModeControl({
  snapshot,
  activeShift,
  onEnter,
  onExit,
  onDismissError,
}: WindowModeControlProps) {
  const { t } = useTranslation();
  const [confirmExit, setConfirmExit] = useState(false);
  const actionLabel = snapshot.pending
    ? t("windowMode.pending")
    : t(snapshot.mode === "locked" ? "windowMode.exit" : "windowMode.enter");

  function handleAction(): void {
    if (snapshot.pending) return;
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
        disabled={snapshot.pending}
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
            size="compact"
            variant="secondary"
            aria-label={t("windowMode.dismissError")}
            onClick={onDismissError}
          >
            {t("windowMode.dismiss")}
          </Button>
        </div>
      ) : null}

      <FullScreenDialog
        open={confirmExit}
        title={t("windowMode.confirmTitle")}
        backLabel={t("windowMode.cancel")}
        onClose={() => setConfirmExit(false)}
        footer={
          <Button
            size="floor"
            onClick={() => {
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
