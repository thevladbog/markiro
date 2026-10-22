import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DeviceRecord } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface RevokeDeviceDialogProps {
  device: DeviceRecord;
  /**
   * The device this office runs on: revoking it disconnects the app here,
   * which then has to be paired again. Nothing stops it; the dialog says so.
   */
  own: boolean;
  /** The active shifts in which the device has an open part; empty claims nothing. */
  openShifts?: readonly string[];
  onClose: () => void;
  onRevoked: (device: DeviceRecord) => void;
}

/**
 * Asks before a device is revoked: its key stops working at once and its
 * office sessions end. There is no way back; the device pairs again as a
 * new one.
 */
export function RevokeDeviceDialog({
  device,
  own,
  openShifts = [],
  onClose,
  onRevoked,
}: RevokeDeviceDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
    api.revokeDevice(token, device.id),
  );

  const submit = async () => {
    setFailure(null);
    let revoked: DeviceRecord;
    try {
      revoked = await revoke.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onRevoked(revoked);
  };

  return (
    <FormDialog
      title={t(own ? "office.devices.revokeOwnTitle" : "office.devices.revokeTitle")}
      submitLabel={t("office.devices.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>
        {t(own ? "office.devices.revokeOwnBody" : "office.devices.revokeBody", {
          name: device.name,
        })}
      </p>
      {openShifts.length > 0 && (
        <p>{t("office.devices.revokeOpenShifts", { shifts: openShifts.join(", ") })}</p>
      )}
    </FormDialog>
  );
}
