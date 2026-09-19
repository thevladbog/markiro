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
import type { TableColumn, TagPhase } from "@markiro/ui";
import type { WorkingDevicePool } from "@markiro/platform-contracts";

import { useCan } from "../../access/context.js";
import { useActiveOrg } from "../../layout/useActiveOrg.js";
import type { KiosksPanelContext } from "../kiosks/KioskPanelRoute.js";
import { useKiosks } from "../kiosks/api.js";
import { DeviceActions } from "./DeviceActions.js";
import { DeviceDrawer } from "./DeviceDrawer.js";
import { StationDownloadLink } from "./StationDownloadLink.js";
import { DevicePager } from "./DevicePager.js";
import { DeviceLicensingPanel } from "./DeviceLicensingPanel.js";
import {
  useDeviceLicensing,
  useDevices,
  type DeviceDto,
  type DeviceStatus,
  type DeviceType,
} from "./api.js";

const PAGE_SIZE = 8;
const deviceTypes: readonly DeviceType[] = ["station", "kiosk", "handheld"];
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
 * `revoked` — отзыв устройства человеком, терминальное состояние без тревоги
 * (`retired`), а не сбой системы (`failed`). `offline` — определённое
 * состояние, требующее внимания (`attention`), а не отсутствие значения
 * (`none`): страница считает `offline` наравне с `revoked` поводом для
 * `attentionCount` выше по файлу, и тег обязан отражать ту же логику.
 */
export function deviceStatusPhase(status: DeviceStatus): TagPhase {
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

export function reservationCancelledOrUnknown(
  device: DeviceDto,
  pool: WorkingDevicePool | undefined,
): boolean {
  if (device.type === "kiosk") return false;
  const assignment = pool?.devices.find((item) => item.deviceId === device.id);
  return assignment === undefined || assignment.releaseReason === "reservation_cancelled";
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
  const licensing = useDeviceLicensing(canManageCredentials);
  const pageItems = result.data?.items ?? [];
  const attentionCount = pageItems.filter(
    (device) => device.status === "offline" || device.status === "revoked",
  ).length;

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
        key: "licensing",
        title: t("pages.devices.table.licensing"),
        render: (row) => {
          if (row.type === "kiosk") return "—";
          const assignment = licensing.data?.devices.find((item) => item.deviceId === row.id);
          return assignment ? t(`pages.devices.licensing.state.${assignment.state}`) : "—";
        },
      },
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
            phase={deviceStatusPhase(row.status)}
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
            reservationCancelledOrUnknown={reservationCancelledOrUnknown(row, licensing.data)}
            onReassign={(device) => setDrawer({ mode: "reassign", device })}
            onPair={(device) => setDrawer({ mode: "pair", device })}
          />
        ),
      },
    ],
    [canManageCredentials, canWriteOperations, licensing.data, t],
  );

  return (
    <div className="devices-page">
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
      <p className="devices-page__description">{t("pages.devices.description")}</p>
      <section className="devices-overview" aria-label={t("pages.devices.overview.label")}>
        <div className="devices-overview__lead">
          <span>{t("pages.devices.overview.eyebrow")}</span>
          <strong>{t("pages.devices.overview.title")}</strong>
        </div>
        <dl>
          <div>
            <dt>{t("pages.devices.overview.total")}</dt>
            <dd>{result.data?.total ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("pages.devices.overview.slots")}</dt>
            <dd>
              {licensing.data
                ? licensing.data.limit === null
                  ? `${licensing.data.usage} / ∞`
                  : `${licensing.data.usage} / ${licensing.data.limit}`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("pages.devices.overview.page")}</dt>
            <dd>{pageItems.length}</dd>
          </div>
          <div data-tone={attentionCount > 0 ? "attention" : "calm"}>
            <dt>{t("pages.devices.overview.attention")}</dt>
            <dd>{result.data ? attentionCount : "—"}</dd>
          </div>
        </dl>
      </section>
      <section className="devices-registry" aria-label={t("pages.devices.registry.label")}>
        <header className="devices-registry__toolbar">
          <div>
            <span>{t("pages.devices.registry.eyebrow")}</span>
            <h2>{t("pages.devices.registry.title")}</h2>
          </div>
          <div
            className="devices-filters"
            role="group"
            aria-label={t("pages.devices.filtersLabel")}
          >
            <Select
              label={t("pages.devices.typeLabel")}
              value={type ?? ""}
              onValueChange={(value) => setFilters({ type: parseType(value) ?? null, page: 1 })}
              options={[
                { value: "", label: t("pages.devices.allTypes") },
                ...deviceTypes.map((item) => ({
                  value: item,
                  label: t(`pages.devices.type.${item}`),
                })),
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
        </header>
        <div className="devices-registry__body">
          {result.isPending ? (
            <Spinner label={t("common.loading")} />
          ) : result.isError ? (
            <Alert tone="error">{t("common.loadError")}</Alert>
          ) : result.data ? (
            <>
              {result.data.items.length ? (
                <Table
                  className="devices-table"
                  columns={columns}
                  rows={result.data.items}
                  scrollLabel={t("pages.devices.registry.tableLabel")}
                />
              ) : (
                <EmptyState
                  title={t("pages.devices.emptyTitle")}
                  hint={t("pages.devices.emptyHint")}
                />
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
        </div>
      </section>
      {canManageCredentials ? (
        <details className="devices-service-workflows">
          <summary>
            <span>{t("pages.devices.workflows.title")}</span>
            <small>{t("pages.devices.workflows.description")}</small>
          </summary>
          <div className="devices-service-workflows__body">
            <DeviceLicensingPanel enabled />
          </div>
        </details>
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
