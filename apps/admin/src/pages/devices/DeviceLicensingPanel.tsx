import { DeviceReplacementPanel } from "./DeviceReplacementPanel.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, ConfirmDialog, StatusChip } from "@markiro/ui";
import { ApiRequestError } from "../../api/client.js";
import { CABINET_ACCESS_QUERY_KEY } from "../../access/api.js";
import { useAuthClient } from "../../auth/client.js";
import {
  cancelDeviceReservation,
  DEVICE_LICENSING_QUERY_KEY,
  DEVICES_QUERY_KEY,
  useDeviceLicensing,
} from "./api.js";
import type { WorkingDevicePool } from "@markiro/platform-contracts";

const attemptKey = (deviceId: string) => ["device-licensing", "cancel-attempt", deviceId] as const;
export function DeviceLicensingPanel({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const session = useAuthClient().useSession();
  const query = useDeviceLicensing(enabled);
  const [selected, setSelected] = useState<WorkingDevicePool["devices"][number] | null>(null);
  const [stale, setStale] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const mutation = useMutation({
    mutationFn: ({
      deviceId,
      body,
    }: {
      deviceId: string;
      body: { requestId: string; expectedRevision: number };
    }) => cancelDeviceReservation(deviceId, body),
  });
  useEffect(() => {
    if (!selected) return;
    const current = query.data?.devices.find((device) => device.deviceId === selected.deviceId);
    if (
      !enabled ||
      !query.data?.canCancelReservations ||
      !current?.canCancel ||
      current.revision !== selected.revision
    ) {
      setSelected(null);
    }
  }, [enabled, query.data, selected]);
  if (!enabled) return null;
  const confirm = async () => {
    const current = query.data?.devices.find((device) => device.deviceId === selected?.deviceId);
    if (
      !selected?.revision ||
      !enabled ||
      !query.data?.canCancelReservations ||
      !current?.canCancel ||
      current.revision !== selected.revision
    ) {
      setSelected(null);
      return;
    }
    setStale(false);
    setPermissionError(false);
    const key = attemptKey(selected.deviceId);
    qc.setQueryDefaults(key, { gcTime: Infinity });
    const existing = qc.getQueryData<{ requestId: string; expectedRevision: number }>(key);
    const body =
      existing?.expectedRevision === selected.revision
        ? existing
        : { requestId: crypto.randomUUID(), expectedRevision: selected.revision };
    qc.setQueryData(key, body);
    try {
      await mutation.mutateAsync({ deviceId: selected.deviceId, body });
      qc.removeQueries({ queryKey: key, exact: true });
      setSelected(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: DEVICE_LICENSING_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: DEVICES_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: CABINET_ACCESS_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: ["billing", "entitlements"] }),
      ]);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        qc.removeQueries({ queryKey: key, exact: true });
        setSelected(null);
        setStale(true);
        await qc.invalidateQueries({ queryKey: DEVICE_LICENSING_QUERY_KEY });
      } else if (
        error instanceof ApiRequestError &&
        (error.status === 401 || error.status === 403)
      ) {
        qc.removeQueries({ queryKey: key, exact: true });
        setSelected(null);
        setPermissionError(true);
        await Promise.all([
          session.refetch?.(),
          qc.invalidateQueries({ queryKey: DEVICE_LICENSING_QUERY_KEY }),
          qc.invalidateQueries({ queryKey: CABINET_ACCESS_QUERY_KEY }),
        ]);
      }
    }
  };
  if (query.isPending) return <p role="status">{t("common.loading")}</p>;
  if (!query.data) return <Alert tone="error">{t("pages.devices.licensing.loadError")}</Alert>;
  const pool = query.data;
  return (
    <>
      <Card title={t("pages.devices.licensing.title")} titleAs="h2">
        <p>
          {pool.limit === null
            ? t("pages.devices.licensing.unlimited", { usage: pool.usage })
            : t("pages.devices.licensing.count", { usage: pool.usage, limit: pool.limit })}
        </p>
        {stale ? <Alert tone="warn">{t("pages.devices.licensing.stale")}</Alert> : null}
        {permissionError ? (
          <Alert tone="error">{t("pages.devices.licensing.permissionError")}</Alert>
        ) : null}
        {pool.devices.map((device) => (
          <div
            key={device.deviceId}
            style={{
              display: "flex",
              gap: "var(--sp-3)",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
            }}
          >
            <span>{device.name}</span>
            <StatusChip
              status={
                device.state === "released"
                  ? "neutral"
                  : device.state === "inconsistent"
                    ? "error"
                    : "info"
              }
              label={t(`pages.devices.licensing.state.${device.state}`)}
            />
            {device.canCancel && pool.canCancelReservations ? (
              <Button size="compact" variant="secondary" onClick={() => setSelected(device)}>
                {t("pages.devices.licensing.cancel")}
              </Button>
            ) : null}
          </div>
        ))}
        <ConfirmDialog
          open={selected !== null}
          title={t("pages.devices.licensing.confirmTitle")}
          description={t("pages.devices.licensing.confirmBody")}
          confirmLabel={t("pages.devices.licensing.confirm")}
          cancelLabel={t("pages.devices.cancel")}
          busy={mutation.isPending}
          onCancel={() => setSelected(null)}
          onConfirm={() => void confirm()}
        />
        {mutation.isError && !stale && !permissionError ? (
          <Alert tone="error">{t("pages.devices.licensing.retry")}</Alert>
        ) : null}
      </Card>
      <DeviceReplacementPanel pool={pool} canWrite={enabled} />
    </>
  );
}
