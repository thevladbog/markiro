import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Drawer, Input, Select } from "@markiro/ui";

import { useLines } from "../shifts/api.js";
import {
  useCreateKiosk,
  useCreateStation,
  useIssueKioskCode,
  useIssueStationCode,
  type DeviceType,
  type PairingCode,
} from "./api.js";

type PairingState = { deviceId: string; type: DeviceType; code: PairingCode };

export interface DeviceDrawerProps {
  open: boolean;
  allowStation: boolean;
  allowKiosk: boolean;
  onClose: () => void;
}

export function DeviceDrawer({ open, allowStation, allowKiosk, onClose }: DeviceDrawerProps) {
  const { t } = useTranslation();
  const initialType = allowStation ? "station" : "kiosk";
  const [type, setType] = useState<DeviceType>(initialType);
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = useLines();
  const createStation = useCreateStation();
  const createKiosk = useCreateKiosk();
  const issueStation = useIssueStationCode();
  const issueKiosk = useIssueKioskCode();

  const types = useMemo(
    () => [
      ...(allowStation ? [{ value: "station", label: t("pages.devices.type.station") }] : []),
      ...(allowKiosk ? [{ value: "kiosk", label: t("pages.devices.type.kiosk") }] : []),
    ],
    [allowKiosk, allowStation, t],
  );

  const reset = () => {
    setType(initialType);
    setName("");
    setPlace("");
    setPairing(null);
    setError(null);
    issueStation.reset();
    issueKiosk.reset();
  };

  useEffect(() => {
    if (!open) reset();
    return () => {
      issueStation.reset();
      issueKiosk.reset();
    };
  }, [open]);

  const issue = async (deviceId: string, deviceType: DeviceType) => {
    setError(null);
    try {
      const code =
        deviceType === "station"
          ? await issueStation.mutateAsync(deviceId)
          : await issueKiosk.mutateAsync(deviceId);
      setPairing({ deviceId, type: deviceType, code });
    } catch {
      setPairing({ deviceId, type: deviceType, code: { code: "", expiresAt: "" } });
      setError(t("pages.devices.drawer.issueError"));
    }
  };

  const submit = async () => {
    setError(null);
    try {
      const created =
        type === "station"
          ? await createStation.mutateAsync({ name, lineId: place || null })
          : await createKiosk.mutateAsync({
              name,
              location: place || null,
              dayLimitPerEmployee: 5,
              showPrices: true,
            });
      await issue(created.id, type);
    } catch {
      setError(t("pages.devices.drawer.createError"));
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  const isPending =
    createStation.isPending ||
    createKiosk.isPending ||
    issueStation.isPending ||
    issueKiosk.isPending;
  const hasCode = pairing?.code.code.length === 8;

  return (
    <Drawer
      open={open}
      title={t(pairing ? "pages.devices.drawer.codeTitle" : "pages.devices.drawer.title")}
      onClose={close}
      closeLabel={t("common.close")}
      footer={
        pairing ? (
          <>
            {!hasCode && (
              <Button
                type="button"
                loading={isPending}
                onClick={() => void issue(pairing.deviceId, pairing.type)}
              >
                {t("pages.devices.drawer.retryIssue")}
              </Button>
            )}
            <Button type="button" onClick={close}>
              {t("pages.devices.done")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={close}>
              {t("pages.devices.cancel")}
            </Button>
            <Button
              type="button"
              loading={isPending}
              disabled={!name.trim()}
              onClick={() => void submit()}
            >
              {t("pages.devices.create")}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      {pairing ? (
        hasCode ? (
          <div aria-live="polite">
            <p style={{ font: "var(--text-code)", color: "var(--fg-1)" }}>{pairing.code.code}</p>
            <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
              {pairing.code.expiresAt}
            </p>
          </div>
        ) : null
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Select
            label={t("pages.devices.typeLabel")}
            value={type}
            onChange={(value) => {
              setType(value as DeviceType);
              setPlace("");
              setError(null);
            }}
            options={types}
          />
          <Input
            label={t("pages.devices.nameLabel")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {type === "station" ? (
            <Select
              label={t("pages.devices.lineLabel")}
              value={place}
              onChange={setPlace}
              options={[
                { value: "", label: t("pages.devices.noLine") },
                ...(lines.data ?? []).map((line) => ({ value: line.id, label: line.name })),
              ]}
            />
          ) : (
            <Input
              label={t("pages.devices.locationLabel")}
              value={place}
              onChange={(event) => setPlace(event.target.value)}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
