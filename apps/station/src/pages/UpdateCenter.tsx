import { useState } from "react";
import { Alert, Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { StationUpdaterController } from "../lib/use-station-updater.js";
import { StationScreen } from "../ui/StationScreen.js";
import { FloorFooter } from "../ui/FloorFooter.js";

export interface UpdateCenterProps {
  controller: StationUpdaterController;
  activeShift: boolean;
  pendingOutbox: number;
  onBack: () => void;
}

export function UpdateCenter({
  controller,
  activeShift,
  pendingOutbox,
  onBack,
}: UpdateCenterProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const available = controller.persisted?.available ?? null;
  const busy = controller.phase !== "idle";
  const installDisabled = activeShift || busy || !available;
  const errorText = controller.error ? t(`updates.errors.${controller.error}`) : null;

  return (
    <StationScreen
      title={t("updates.title")}
      header={
        <p className="station-update-center__status" aria-live="polite">
          {busy ? t(`updates.phases.${controller.phase}`) : t("updates.manualOnly")}
        </p>
      }
      actions={
        <FloorFooter ariaLabel={t("updates.actions")}>
          <Button type="button" size="floor" variant="secondary" onClick={onBack}>
            {t("updates.back")}
          </Button>
          <Button
            type="button"
            size="floor"
            variant="secondary"
            onClick={() => void controller.checkNow()}
            disabled={busy}
          >
            {t("updates.check")}
          </Button>
          <Button
            type="button"
            size="floor"
            onClick={() => setConfirming(true)}
            disabled={installDisabled}
          >
            {t("updates.downloadInstall")}
          </Button>
        </FloorFooter>
      }
    >
      <div className="station-update-center" data-update-severity={controller.severity}>
        {available ? (
          <>
            <p className="station-update-center__version">
              <span>{t("updates.available")}</span>
              <strong>{available.version}</strong>
            </p>
            <p>{t(`updates.age.${controller.severity}`)}</p>
          </>
        ) : (
          <p>{t("updates.current")}</p>
        )}
        {activeShift ? <Alert tone="warn">{t("updates.activeShift")}</Alert> : null}
        {pendingOutbox > 0 ? (
          <Alert tone="info">{t("updates.pending", { count: pendingOutbox })}</Alert>
        ) : null}
        {errorText ? <Alert tone="error">{errorText}</Alert> : null}
        {controller.phase === "downloading" ? (
          <progress
            className="station-update-center__progress"
            max={controller.totalBytes ?? undefined}
            value={controller.totalBytes ? controller.downloadedBytes : undefined}
            aria-label={t("updates.progress")}
          />
        ) : null}
        {confirming ? (
          <div className="station-update-center__confirm" role="dialog" aria-modal="true">
            <h2>{t("updates.confirmTitle")}</h2>
            <p>{t("updates.confirmBody", { version: available?.version ?? "" })}</p>
            <div className="station-update-center__confirm-actions">
              <Button
                type="button"
                size="floor"
                variant="secondary"
                onClick={() => setConfirming(false)}
              >
                {t("updates.cancel")}
              </Button>
              <Button
                type="button"
                size="floor"
                onClick={() => {
                  setConfirming(false);
                  void controller.install().catch(() => undefined);
                }}
              >
                {t("updates.confirm")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </StationScreen>
  );
}
