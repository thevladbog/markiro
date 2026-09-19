import { DeviceRetentionPanel } from "./DeviceRetentionPanel.js";
import { DeviceReplacementPanel } from "./DeviceReplacementPanel.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  ConfirmDialog,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";
import type { WorkingDevicePool } from "@markiro/platform-contracts";

type PoolDevice = WorkingDevicePool["devices"][number];

/**
 * Тот же union, что `DeviceStatus` в `apps/admin/src/pages/devices/index.tsx`
 * (`awaiting_pairing` | `online` | `offline` | `revoked`), и та же фаза для
 * каждого значения: `revoked` — отзыв человеком, терминально и без тревоги
 * (`retired`), `offline` — определённое состояние, требующее внимания
 * (`attention`), а не отсутствие значения.
 */
function connectionPhase(status: PoolDevice["connectionStatus"]): TagPhase {
  switch (status) {
    case "online":
      return "active";
    case "revoked":
      return "retired";
    case "offline":
      return "attention";
    case "awaiting_pairing":
      return "planned";
  }
}

/**
 * Фактический union — `workingDeviceSchema["state"]`
 * (`packages/platform-contracts/src/device-licensing.ts`): `reserved` |
 * `assigned` | `released` | `inconsistent`. Раньше три ветки схлопывали
 * `reserved` и `assigned` в один и тот же `info`, хотя «зарезервировано»
 * ещё не занято устройством (`planned`), а «занято» — идёт прямо сейчас
 * (`active`). `released` — освобождение места всегда по решению человека
 * (`releaseReason`: `reservation_cancelled` | `security_revoked`) — `retired`.
 */
function slotPhase(state: PoolDevice["state"]): TagPhase {
  switch (state) {
    case "reserved":
      return "planned";
    case "assigned":
      return "active";
    case "released":
      return "retired";
    case "inconsistent":
      return "attention";
  }
}
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
  const available = pool.limit === null ? null : Math.max(0, pool.limit - pool.usage);
  const needsAttention = pool.devices.filter(
    (device) =>
      device.state === "inconsistent" ||
      device.connectionStatus === "offline" ||
      device.connectionStatus === "revoked",
  ).length;
  const columns: TableColumn<WorkingDevicePool["devices"][number]>[] = [
    {
      key: "device",
      title: t("tenants.detail.deviceLicensing.columns.device"),
      render: (device) => (
        <span className="equipment-device-name">
          <strong>{device.name}</strong>
          <small>{t(`tenants.detail.deviceLicensing.kind.${device.kind}`)}</small>
        </span>
      ),
    },
    {
      key: "connection",
      title: t("tenants.detail.deviceLicensing.columns.connection"),
      render: (device) => (
        <StatusChip
          phase={connectionPhase(device.connectionStatus)}
          label={t(`tenants.detail.deviceLicensing.connection.${device.connectionStatus}`)}
        />
      ),
    },
    {
      key: "slot",
      title: t("tenants.detail.deviceLicensing.columns.slot"),
      render: (device) => (
        <StatusChip
          phase={slotPhase(device.state)}
          label={t(`tenants.detail.deviceLicensing.state.${device.state}`)}
        />
      ),
    },
    {
      key: "actions",
      title: t("tenants.detail.deviceLicensing.columns.actions"),
      align: "right",
      render: (device) =>
        canWrite && pool.canCancelReservations && device.canCancel ? (
          <Button size="compact" variant="secondary" onClick={() => setSelected(device)}>
            {t("tenants.detail.deviceLicensing.cancel")}
          </Button>
        ) : (
          <span className="equipment-no-action">—</span>
        ),
    },
  ];
  return (
    <div className="tenant-equipment-content">
      <section
        className="equipment-summary"
        aria-label={t("tenants.detail.deviceLicensing.summaryLabel")}
      >
        <div className="equipment-summary__lead">
          <span>{t("tenants.detail.deviceLicensing.title")}</span>
          <strong>
            {pool.limit === null
              ? t("tenants.detail.deviceLicensing.unlimited", { usage: pool.usage })
              : t("tenants.detail.deviceLicensing.count", { usage: pool.usage, limit: pool.limit })}
          </strong>
        </div>
        <dl className="equipment-summary__metrics">
          <div>
            <dt>{t("tenants.detail.deviceLicensing.metrics.occupied")}</dt>
            <dd>{pool.usage}</dd>
          </div>
          <div>
            <dt>{t("tenants.detail.deviceLicensing.metrics.available")}</dt>
            <dd>{available ?? "∞"}</dd>
          </div>
          <div data-tone={needsAttention > 0 ? "attention" : "calm"}>
            <dt>{t("tenants.detail.deviceLicensing.metrics.attention")}</dt>
            <dd>{needsAttention}</dd>
          </div>
        </dl>
      </section>
      <section className="equipment-registry" aria-labelledby="equipment-registry-title">
        <header>
          <div>
            <p>{t("tenants.detail.deviceLicensing.registryEyebrow")}</p>
            <h3 id="equipment-registry-title">
              {t("tenants.detail.deviceLicensing.registryTitle")}
            </h3>
          </div>
          <span>
            {t("tenants.detail.deviceLicensing.registryCount", { count: pool.devices.length })}
          </span>
        </header>
        {stale ? <Alert tone="warn">{t("tenants.detail.deviceLicensing.stale")}</Alert> : null}
        {permissionError ? (
          <Alert tone="error">{t("tenants.detail.deviceLicensing.permissionError")}</Alert>
        ) : null}
        {pool.devices.length > 0 ? (
          <Table
            columns={columns}
            rows={pool.devices}
            getRowKey={(device) => device.deviceId}
            scrollLabel={t("tenants.detail.deviceLicensing.registryTitle")}
          />
        ) : (
          <p className="equipment-registry__empty">{t("tenants.detail.deviceLicensing.empty")}</p>
        )}
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
      </section>
      <div className="equipment-workflows">
        <details>
          <summary>
            <span>{t("tenants.detail.deviceLicensing.workflows.replacement")}</span>
            <small>{t("tenants.detail.deviceLicensing.workflows.replacementHint")}</small>
          </summary>
          <DeviceReplacementPanel pool={pool} canWrite={canWrite} />
        </details>
        <details>
          <summary>
            <span>{t("tenants.detail.deviceLicensing.workflows.retention")}</span>
            <small>{t("tenants.detail.deviceLicensing.workflows.retentionHint")}</small>
          </summary>
          <DeviceRetentionPanel tenantId={tenantId} canWrite={canWrite} />
        </details>
      </div>
    </div>
  );
}
