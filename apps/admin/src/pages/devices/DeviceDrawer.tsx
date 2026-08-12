import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { Alert, Button, Drawer, Input, Select } from "@markiro/ui";

import { useLines } from "../shifts/api.js";
import { PairingCodePanel } from "./PairingCodePanel.js";
import {
  useCreateKiosk,
  useCreateStation,
  useIssueKioskCode,
  useIssueStationCode,
  useUpdateKiosk,
  useUpdateStation,
  clearDevicePairingCodeMutations,
  type DeviceDto,
  type DeviceType,
  type PairingCode,
} from "./api.js";

type DrawerMode = "create" | "pair" | "reassign";
type PairingState = {
  deviceId: string;
  type: DeviceType;
  name: string;
  placeName: string | null;
  code: PairingCode;
  issuedAt: string;
};

export interface DeviceDrawerProps {
  open: boolean;
  allowStation: boolean;
  allowKiosk: boolean;
  canIssueKiosk: boolean;
  organizationName?: string | null;
  device?: DeviceDto;
  mode?: DrawerMode;
  onClose: () => void;
}

/** Create, reassign, and active-only pairing-code drawer. */
export function DeviceDrawer({
  open,
  allowStation,
  allowKiosk,
  canIssueKiosk,
  organizationName = null,
  device,
  mode = device ? "pair" : "create",
  onClose,
}: DeviceDrawerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const initialType = device?.type ?? (allowStation ? "station" : "kiosk");
  const [type, setType] = useState<DeviceType>(initialType);
  const [name, setName] = useState(device?.name ?? "");
  const [place, setPlace] = useState(device?.place.id ?? device?.place.name ?? "");
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = useLines();
  const createStation = useCreateStation();
  const createKiosk = useCreateKiosk();
  const updateStation = useUpdateStation();
  const updateKiosk = useUpdateKiosk();
  const issueStation = useIssueStationCode();
  const issueKiosk = useIssueKioskCode();
  const resetMutationCache = useRef<() => void>(() => {});
  const requestGeneration = useRef(0);
  const mounted = useRef(false);
  resetMutationCache.current = () => {
    issueStation.reset();
    issueKiosk.reset();
  };

  const types = useMemo(
    () => [
      ...(allowStation ? [{ value: "station", label: t("pages.devices.type.station") }] : []),
      ...(allowKiosk ? [{ value: "kiosk", label: t("pages.devices.type.kiosk") }] : []),
    ],
    [allowKiosk, allowStation, t],
  );

  const clearSecret = useCallback(() => {
    requestGeneration.current += 1;
    if (pairing) {
      clearDevicePairingCodeMutations(queryClient, pairing.type, pairing.deviceId);
    }
    setPairing(null);
    resetMutationCache.current();
  }, [pairing, queryClient]);

  const reset = useCallback(() => {
    setType(initialType);
    setName(device?.name ?? "");
    setPlace(device?.place.id ?? device?.place.name ?? "");
    setError(null);
    clearSecret();
  }, [clearSecret, device?.name, device?.place.id, device?.place.name, initialType]);

  // Route changes and conditional drawer teardown must clear mutation data too.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      resetMutationCache.current();
    };
  }, []);

  const issue = useCallback(
    async (target: { id: string; type: DeviceType; name: string; placeName: string | null }) => {
      const generation = ++requestGeneration.current;
      setError(null);
      try {
        const code =
          target.type === "station"
            ? await issueStation.mutateAsync(target.id)
            : await issueKiosk.mutateAsync(target.id);
        if (!mounted.current || generation !== requestGeneration.current) {
          clearDevicePairingCodeMutations(queryClient, target.type, target.id, code);
          return;
        }
        if (!/^\d{8}$/.test(code.code)) throw new Error("Invalid pairing code response");
        setPairing({ deviceId: target.id, ...target, code, issuedAt: new Date().toISOString() });
      } catch {
        if (!mounted.current || generation !== requestGeneration.current) return;
        // Retain a previously visible code after a failed regeneration.
        setError(t("pages.devices.drawer.issueError"));
      }
    },
    [issueKiosk, issueStation, queryClient, t],
  );

  const submit = async () => {
    setError(null);
    try {
      if (mode === "reassign" && device) {
        if (device.type === "station") {
          await updateStation.mutateAsync({ id: device.id, input: { lineId: place || null } });
        } else {
          await updateKiosk.mutateAsync({ id: device.id, input: { location: place || null } });
        }
        onClose();
        return;
      }
      const created =
        type === "station"
          ? await createStation.mutateAsync({ name, lineId: place || null })
          : await createKiosk.mutateAsync({
              name,
              location: place || null,
              dayLimitPerEmployee: 5,
              showPrices: true,
            });
      const placeName =
        type === "station"
          ? (lines.data?.find((line) => line.id === place)?.name ?? null)
          : place || null;
      if (type === "station" || canIssueKiosk)
        await issue({ id: created.id, type, name: created.name, placeName });
      else setError(t("pages.devices.drawer.createdWithoutCode"));
    } catch {
      setError(
        t(
          mode === "reassign"
            ? "pages.devices.drawer.reassignError"
            : "pages.devices.drawer.createError",
        ),
      );
    }
  };

  const target = device
    ? { id: device.id, type: device.type, name: device.name, placeName: device.place.name }
    : null;
  const canIssue = target?.type === "station" || canIssueKiosk;
  const isPending =
    createStation.isPending ||
    createKiosk.isPending ||
    updateStation.isPending ||
    updateKiosk.isPending ||
    issueStation.isPending ||
    issueKiosk.isPending;
  const close = () => {
    reset();
    onClose();
  };
  const title = pairing
    ? t("pages.devices.drawer.codeTitle")
    : mode === "reassign"
      ? t("pages.devices.drawer.reassignTitle")
      : mode === "pair"
        ? t("pages.devices.drawer.codeTitle")
        : t("pages.devices.drawer.title");

  return (
    <Drawer
      open={open}
      title={title}
      onClose={close}
      closeLabel={t("common.close")}
      footer={
        pairing ? (
          <Button type="button" onClick={close}>
            {t("pages.devices.done")}
          </Button>
        ) : mode === "pair" ? (
          <>
            <Button type="button" variant="secondary" onClick={close}>
              {t("pages.devices.cancel")}
            </Button>
            {canIssue ? (
              <Button
                type="button"
                loading={isPending}
                onClick={() => target && void issue(target)}
              >
                {t("pages.devices.pairing.issue")}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={close}>
              {t("pages.devices.cancel")}
            </Button>
            <Button
              type="button"
              loading={isPending}
              disabled={mode === "create" && !name.trim()}
              onClick={() => void submit()}
            >
              {t(mode === "reassign" ? "pages.devices.reassign" : "pages.devices.create")}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      {pairing ? (
        <PairingCodePanel
          pairing={pairing.code}
          issuedAt={pairing.issuedAt}
          deviceName={pairing.name}
          deviceType={pairing.type}
          placeName={pairing.placeName}
          organizationName={organizationName}
          regenerating={isPending}
          onRegenerate={() =>
            void issue({
              id: pairing.deviceId,
              type: pairing.type,
              name: pairing.name,
              placeName: pairing.placeName,
            })
          }
        />
      ) : mode === "pair" ? (
        <p style={{ margin: 0, font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.devices.pairing.issueHint", { name: device?.name ?? "" })}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          {mode === "create" ? (
            <>
              <Select
                label={t("pages.devices.typeLabel")}
                value={type}
                onValueChange={(value) => {
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
            </>
          ) : null}
          {type === "station" ? (
            <Select
              label={t("pages.devices.lineLabel")}
              value={place}
              onValueChange={setPlace}
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
