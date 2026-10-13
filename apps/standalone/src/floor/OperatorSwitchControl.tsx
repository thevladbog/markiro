import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, FullScreenDialog } from "@markiro/ui";

import "./operator-switch.css";

export interface OperatorSwitchControlProps {
  /** The operator works in a shift: the switch asks first, as the cloud station's does. */
  activeShift: boolean;
  onSwitch: () => void;
}

/**
 * «Сменить оператора» in the status bar's rail, after the cloud station's
 * `OperatorSwitchControl` (apps/station/src/ui/OperatorSwitchControl.tsx,
 * compact): a 64 px floor button with its caption; in a shift it asks first,
 * for the shift stays open and the work saved. The leave itself — waiting for
 * the work the screen tracks — is the floor's (`FloorApp`); signing out here
 * cannot fail, so the cloud's error and retry are not ported.
 */
export function OperatorSwitchControl({ activeShift, onSwitch }: OperatorSwitchControlProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="operator-switch-control">
      <Button
        type="button"
        size="floor"
        variant="secondary"
        className="station-rail-button"
        onClick={() => {
          if (activeShift) setConfirming(true);
          else onSwitch();
        }}
      >
        {t("floor.operator.signOut")}
      </Button>
      <FullScreenDialog
        open={confirming}
        title={t("floor.operatorSwitch.confirmTitle")}
        backLabel={t("floor.operatorSwitch.stay")}
        onClose={() => setConfirming(false)}
        footer={
          <Button
            size="floor"
            onClick={() => {
              setConfirming(false);
              onSwitch();
            }}
          >
            {t("floor.operatorSwitch.confirm")}
          </Button>
        }
      >
        <p className="operator-switch-control__confirmation">
          {t("floor.operatorSwitch.confirmDetail")}
        </p>
      </FullScreenDialog>
    </div>
  );
}
