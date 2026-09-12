import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, ConfirmDialog, StatusChip } from "@markiro/ui";
import type { WorkingDevicePool } from "@markiro/platform-contracts";
import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import { cancelTenantDeviceReservation, getTenantDeviceLicensing } from "./api.js";

const poolKey = (tenantId: string) =>
  ["platform", "tenants", tenantId, "device-licensing"] as const;
const attemptKey = (tenantId: string, deviceId: string) =>
  [...poolKey(tenantId), "cancel-attempt", deviceId] as const;
export function DeviceLicensingPanel({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const session = useAuthClient().useSession();
  const query = useQuery({
    queryKey: poolKey(tenantId),
    queryFn: () => getTenantDeviceLicensing(tenantId),
  });
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
    }) => cancelTenantDeviceReservation(tenantId, deviceId, body),
  });
  useEffect(() => {
    if (!selected) return;
    const current = query.data?.devices.find((device) => device.deviceId === selected.deviceId);
    if (
      !canWrite ||
      !query.data?.canCancelReservations ||
      !current?.canCancel ||
      current.revision !== selected.revision
    ) {
      setSelected(null);
    }
  }, [canWrite, query.data, selected]);
  const confirm = async () => {
    const current = query.data?.devices.find((device) => device.deviceId === selected?.deviceId);
    if (
      !selected?.revision ||
      !canWrite ||
      !query.data?.canCancelReservations ||
      !current?.canCancel ||
      current.revision !== selected.revision
    ) {
      setSelected(null);
      return;
    }
    setStale(false);
    setPermissionError(false);
    const key = attemptKey(tenantId, selected.deviceId);
    qc.setQueryDefaults(key, { gcTime: Infinity });
    const old = qc.getQueryData<{ requestId: string; expectedRevision: number }>(key);
    const body =
      old?.expectedRevision === selected.revision
        ? old
        : { requestId: crypto.randomUUID(), expectedRevision: selected.revision };
    qc.setQueryData(key, body);
    try {
      await mutation.mutateAsync({ deviceId: selected.deviceId, body });
      qc.removeQueries({ queryKey: key, exact: true });
      setSelected(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: poolKey(tenantId) }),
        qc.invalidateQueries({ queryKey: ["platform", "tenants", tenantId] }),
        qc.invalidateQueries({ queryKey: ["platform", "tenants"] }),
        qc.invalidateQueries({ queryKey: ["platform", "tenants", tenantId, "entitlements"] }),
      ]);
    } catch (error) {
      if (error instanceof ApiRequestError && error.kind === "domain" && error.status === 409) {
        qc.removeQueries({ queryKey: key, exact: true });
        setSelected(null);
        setStale(true);
        await qc.invalidateQueries({ queryKey: poolKey(tenantId) });
      } else if (
        error instanceof ApiRequestError &&
        error.kind === "authorization" &&
        (error.status === 401 || error.status === 403)
      ) {
        qc.removeQueries({ queryKey: key, exact: true });
        setSelected(null);
        setPermissionError(true);
        await Promise.all([
          session.refetch?.(),
          qc.invalidateQueries({ queryKey: poolKey(tenantId) }),
          qc.invalidateQueries({ queryKey: ["platform", "me"] }),
        ]);
      }
    }
  };
  if (query.isPending) return <p role="status">{t("auth.boundary.loading")}</p>;
  if (!query.data)
    return <Alert tone="error">{t("tenants.detail.deviceLicensing.loadError")}</Alert>;
  const pool = query.data;
  return (
    <Card title={t("tenants.detail.deviceLicensing.title")} titleAs="h2">
      <p>
        {pool.limit === null
          ? t("tenants.detail.deviceLicensing.unlimited", { usage: pool.usage })
          : t("tenants.detail.deviceLicensing.count", { usage: pool.usage, limit: pool.limit })}
      </p>
      {stale ? <Alert tone="warn">{t("tenants.detail.deviceLicensing.stale")}</Alert> : null}
      {permissionError ? (
        <Alert tone="error">{t("tenants.detail.deviceLicensing.permissionError")}</Alert>
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
          <span>
            {device.name} · {t(`tenants.detail.deviceLicensing.kind.${device.kind}`)}
          </span>
          <StatusChip
            status={
              device.state === "released"
                ? "neutral"
                : device.state === "inconsistent"
                  ? "error"
                  : "info"
            }
            label={t(`tenants.detail.deviceLicensing.state.${device.state}`)}
          />
          {canWrite && pool.canCancelReservations && device.canCancel ? (
            <Button size="compact" variant="secondary" onClick={() => setSelected(device)}>
              {t("tenants.detail.deviceLicensing.cancel")}
            </Button>
          ) : null}
        </div>
      ))}
      <ConfirmDialog
        open={selected !== null}
        title={t("tenants.detail.deviceLicensing.confirmTitle")}
        description={t("tenants.detail.deviceLicensing.confirmBody")}
        confirmLabel={t("tenants.detail.deviceLicensing.confirm")}
        cancelLabel={t("tenants.cancel")}
        busy={mutation.isPending}
        onCancel={() => setSelected(null)}
        onConfirm={() => void confirm()}
      />
      {mutation.isError && !stale && !permissionError ? (
        <Alert tone="error">{t("tenants.detail.deviceLicensing.retry")}</Alert>
      ) : null}
    </Card>
  );
}
