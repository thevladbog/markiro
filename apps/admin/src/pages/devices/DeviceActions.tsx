import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Button, Modal } from "@markiro/ui";

import { useRevokeKiosk, useRevokeStation, type DeviceDto } from "./api.js";

export interface DeviceActionsProps {
  device: DeviceDto;
  canReassign: boolean;
  canManageCredentials: boolean;
  onReassign: (device: DeviceDto) => void;
  onPair: (device: DeviceDto) => void;
}

/** Row lifecycle controls. Server success is the only point that changes visible state. */
export function DeviceActions({
  device,
  canReassign,
  canManageCredentials,
  onReassign,
  onPair,
}: DeviceActionsProps) {
  const { t } = useTranslation();
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revokeStation = useRevokeStation();
  const revokeKiosk = useRevokeKiosk();
  const isRevoking = revokeStation.isPending || revokeKiosk.isPending;

  const revoke = async () => {
    setRevokeError(null);
    try {
      if (device.type === "station") await revokeStation.mutateAsync(device.id);
      else await revokeKiosk.mutateAsync(device.id);
      setConfirmingRevoke(false);
    } catch {
      setRevokeError(t("pages.devices.actions.revokeError"));
    }
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: "var(--sp-2)",
          justifyContent: "flex-end",
          flexWrap: "wrap",
        }}
      >
        {device.type === "kiosk" ? (
          <Link to={`/kiosks/${device.id}`} aria-label={t("pages.devices.kioskSettings")}>
            {t("pages.devices.kioskSettings")}
          </Link>
        ) : null}
        {canReassign ? (
          <Button
            type="button"
            size="compact"
            variant="secondary"
            onClick={() => onReassign(device)}
          >
            {t("pages.devices.reassign")}
          </Button>
        ) : null}
        {canManageCredentials ? (
          <>
            <Button type="button" size="compact" variant="secondary" onClick={() => onPair(device)}>
              {t("pages.devices.actions.repair")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="destructive"
              onClick={() => setConfirmingRevoke(true)}
            >
              {t("pages.devices.actions.revoke")}
            </Button>
          </>
        ) : null}
      </div>
      <Modal
        open={confirmingRevoke}
        onClose={() => {
          setConfirmingRevoke(false);
          setRevokeError(null);
        }}
        closeLabel={t("common.close")}
        title={t("pages.devices.actions.revokeTitle")}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirmingRevoke(false);
                setRevokeError(null);
              }}
            >
              {t("pages.devices.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={isRevoking}
              onClick={() => void revoke()}
            >
              {t("pages.devices.actions.revoke")}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.devices.actions.revokeBody", { name: device.name })}
          </p>
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
            {t("pages.devices.actions.revokeOfflineNote")}
          </p>
          {revokeError ? (
            <p
              role="alert"
              style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--err-fg)" }}
            >
              {revokeError}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
