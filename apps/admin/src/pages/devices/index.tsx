import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useMatch, useSearchParams } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useActiveOrg } from "../../layout/useActiveOrg.js";
import type { KiosksPanelContext } from "../kiosks/KioskPanelRoute.js";
import { useKiosks } from "../kiosks/api.js";
import { DeviceActions } from "./DeviceActions.js";
import { DeviceDrawer } from "./DeviceDrawer.js";
import { StationDownloadLink } from "./StationDownloadLink.js";
import { DevicePager } from "./DevicePager.js";
import { useDevices, type DeviceDto, type DeviceStatus, type DeviceType } from "./api.js";

const PAGE_SIZE = 8;
const deviceTypes: readonly DeviceType[] = ["station", "kiosk"];
const deviceStatuses: readonly DeviceStatus[] = [
  "awaiting_pairing",
  "online",
  "offline",
  "revoked",
];

function parseType(value: string | null): DeviceType | undefined {
  return deviceTypes.includes(value as DeviceType) ? (value as DeviceType) : undefined;
}
function parseStatus(value: string | null): DeviceStatus | undefined {
  return deviceStatuses.includes(value as DeviceStatus) ? (value as DeviceStatus) : undefined;
}
function parsePage(value: string | null): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

/**
 * Mounts the kiosks query only while a kiosk panel route is open, so the plain
 * devices list never calls `GET /kiosks`, and feeds the panels the same
 * `KiosksPanelContext` the retired kiosk list used to provide.
 */
function KioskPanelOutlet(): ReactElement {
  const kiosks = useKiosks();
  return (
    <Outlet
      context={
        {
          kiosks: kiosks.data ?? [],
          kiosksPending: kiosks.isPending,
          kiosksError: kiosks.isError,
          kiosksResolved: kiosks.data !== undefined,
          retryPanelData: async () => {
            await kiosks.refetch();
          },
        } satisfies KiosksPanelContext
      }
    />
  );
}

export function DevicesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawer, setDrawer] = useState<
    { mode: "create" } | { mode: "pair" | "reassign"; device: DeviceDto } | null
  >(null);
  const { orgName } = useActiveOrg();
  const type = parseType(searchParams.get("type"));
  const status = parseStatus(searchParams.get("status"));
  const page = parsePage(searchParams.get("page"));
  const canWriteOperations = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  const allowStation = canManageCredentials;
  const allowKiosk = canWriteOperations;
  const kioskPanelOpen = useMatch("/devices/kiosks/*") !== null;
  const result = useDevices({
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    page,
    pageSize: PAGE_SIZE,
  });

  const setFilters = useCallback(
    (next: { type?: DeviceType | null; status?: DeviceStatus | null; page?: number }) => {
      const params = new URLSearchParams();
      const nextType = next.type === undefined ? type : (next.type ?? undefined);
      const nextStatus = next.status === undefined ? status : (next.status ?? undefined);
      if (nextType) params.set("type", nextType);
      if (nextStatus) params.set("status", nextStatus);
      if ((next.page ?? page) > 1) params.set("page", String(next.page ?? page));
      setSearchParams(params);
    },
    [page, setSearchParams, status, type],
  );

  useEffect(() => {
    if (!result.data) return;
    const lastPage = Math.max(1, Math.ceil(result.data.total / result.data.pageSize));
    if (page > lastPage) setFilters({ page: lastPage });
  }, [page, result.data, setFilters]);

  const columns = useMemo<TableColumn<DeviceDto>[]>(
    () => [
      { key: "name", title: t("pages.devices.table.name") },
      {
        key: "type",
        title: t("pages.devices.table.type"),
        render: (row) => t(`pages.devices.type.${row.type}`),
      },
      {
        key: "place",
        title: t("pages.devices.table.place"),
        render: (row) => row.place.name ?? "—",
      },
      {
        key: "status",
        title: t("pages.devices.table.status"),
        render: (row) => (
          <StatusChip
            status={
              row.status === "online"
                ? "ok"
                : row.status === "revoked"
                  ? "error"
                  : row.status === "offline"
                    ? "neutral"
                    : "info"
            }
            label={t(`pages.devices.status.${row.status}`)}
          />
        ),
      },
      {
        key: "actions",
        title: t("pages.devices.table.actions"),
        align: "right",
        render: (row) => (
          <DeviceActions
            device={row}
            canReassign={row.type === "station" ? canManageCredentials : canWriteOperations}
            canManageCredentials={canManageCredentials}
            onReassign={(device) => setDrawer({ mode: "reassign", device })}
            onPair={(device) => setDrawer({ mode: "pair", device })}
          />
        ),
      },
    ],
    [canManageCredentials, canWriteOperations, t],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.devices.title")}
        actions={
          <>
            <StationDownloadLink
              data-analytics="station_download_click"
              data-placement="devices-header"
            >
              {t("pages.devices.downloadStation")}
            </StationDownloadLink>
            {allowStation || allowKiosk ? (
              <Button onClick={() => setDrawer({ mode: "create" })}>
                {t("pages.devices.add")}
              </Button>
            ) : null}
          </>
        }
      />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Select
          label={t("pages.devices.typeLabel")}
          value={type ?? ""}
          onValueChange={(value) => setFilters({ type: parseType(value) ?? null, page: 1 })}
          options={[
            { value: "", label: t("pages.devices.allTypes") },
            ...deviceTypes.map((item) => ({ value: item, label: t(`pages.devices.type.${item}`) })),
          ]}
        />
        <Select
          label={t("pages.devices.statusLabel")}
          value={status ?? ""}
          onValueChange={(value) => setFilters({ status: parseStatus(value) ?? null, page: 1 })}
          options={[
            { value: "", label: t("pages.devices.allStatuses") },
            ...deviceStatuses.map((item) => ({
              value: item,
              label: t(`pages.devices.status.${item}`),
            })),
          ]}
        />
      </div>
      {result.isPending ? (
        <Spinner label={t("common.loading")} />
      ) : result.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : result.data ? (
        <>
          {result.data.items.length ? (
            <Table columns={columns} rows={result.data.items} />
          ) : (
            <EmptyState title={t("pages.devices.emptyTitle")} hint={t("pages.devices.emptyHint")} />
          )}
          {result.data.total > 0 ? (
            <DevicePager
              page={result.data.page}
              pageSize={result.data.pageSize}
              total={result.data.total}
              onPage={(nextPage) => setFilters({ page: nextPage })}
              label={t("pages.devices.pager.label")}
              previousLabel={t("pages.devices.pager.previous")}
              nextLabel={t("pages.devices.pager.next")}
            />
          ) : null}
        </>
      ) : null}
      {drawer ? (
        <DeviceDrawer
          open
          allowStation={allowStation}
          allowKiosk={allowKiosk}
          canIssueKiosk={canManageCredentials}
          organizationName={orgName}
          {...(drawer.mode === "create" ? {} : { device: drawer.device })}
          mode={drawer.mode}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {kioskPanelOpen ? <KioskPanelOutlet /> : null}
    </div>
  );
}
