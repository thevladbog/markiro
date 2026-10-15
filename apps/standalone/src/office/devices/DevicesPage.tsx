import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { DeviceRecord, PairingCode } from "../../host/protocol.js";
import { pairingCodeRequest } from "../../host/requests.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { useThisDeviceId } from "../this-device.js";
import { DeviceDialog } from "./DeviceDialog.js";
import { deviceVersionText } from "./device-version.js";
import { lineLabel } from "./line-label.js";
import { codeLifetimeMs, PairingCodeDialog } from "./PairingCodeDialog.js";
import { RevokeDeviceDialog } from "./RevokeDeviceDialog.js";

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });

interface Pairing {
  code: PairingCode;
  /** When the host created the code, by its clock: a device paired since took the code. */
  issuedAt: number;
  /**
   * When the dialog stops showing the code, by this PC's own clock:
   * `requestedAt` (captured just before the request was sent — see
   * `newCode`) plus the code's lifetime by the host (`codeLifetimeMs`). The
   * office can run on a PC other than the host, and a cloud-less LAN site
   * cannot promise the two clocks agree, so only the duration crosses over:
   * no host timestamp is ever compared with this PC's clock.
   */
  deadline: number;
  /** Set when the code re-pairs this device with its own `deviceId` (plan ТСД-Х, task Х6). */
  repairFor?: DeviceRecord;
}

type DevicesDialog =
  { kind: "edit"; device: DeviceRecord } | { kind: "revoke"; device: DeviceRecord };

/**
 * Paired devices and pairing codes (spec §5.5, administrators only; the
 * route is wrapped in `RequireRole`). Line names come from the host's list,
 * which the edit dialog offers too: a line added a moment ago can be chosen
 * at once, and the table and the dialog name lines alike.
 */
export function DevicesPage() {
  const { t } = useTranslation();
  const thisDevice = useThisDeviceId();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const storeDevice = useStoreRecord<DeviceRecord>(officeKeys.devices);
  const create = useOfficeMutation(
    (api, token, ask: { replaces: string | null; device: string | null }) =>
      ask.device !== null
        ? api.createDevicePairingCode(token, ask.device)
        : ask.replaces === null
          ? api.createPairingCode(token)
          : api.createPairingCode(token, pairingCodeRequest(ask.replaces)),
  );
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DevicesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The dialog closes itself once a device paired after its code was issued.
  const joined =
    pairing === null || pairing.repairFor !== undefined
      ? undefined
      : devices.data?.find((device) => Date.parse(device.pairedAt) >= pairing.issuedAt);
  const dialogOpen = pairing !== null && joined === undefined;

  // A request still in flight when the dialog closes -- by a click on
  // "Закрыть", Escape, or because a device joined while a fresh code was
  // being requested -- must not act on its answer: reopening the dialog
  // with a code nobody asked to see anymore, or showing a stray failure for
  // an abandoned action. This effect runs whenever `dialogOpen` changes
  // value, not on every render, bumping the generation each time the new
  // value is `false` -- including its first run at mount, before any
  // request exists, which is harmless. It relies on React flushing passive
  // effects synchronously for the commit that flips `dialogOpen`: a click
  // or an Escape keydown commits on the synchronous lane, and so does the
  // `useSyncExternalStore` update React Query uses to publish a fresh poll
  // result (the joined device arriving) -- in both cases the bump has
  // already happened by the time a pending request's `await` settles.
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (!dialogOpen) requestGeneration.current++;
  }, [dialogOpen]);
  // A code request is on its way: another click asks for nothing, so a
  // double click leaves one live code, not two. The mutation's own
  // `isPending`, which disables the buttons, reaches React a tick later.
  const requesting = useRef(false);

  const newCode = async (device?: DeviceRecord) => {
    if (requesting.current) return;
    requesting.current = true;
    setFailure(null);
    setNotice(null);
    // «Новый код» names the code on screen, and the host ends it at once;
    // with no code on screen the request has no body.
    const shown = pairing !== null && dialogOpen ? pairing.code.id : null;
    // A device's code is asked for that device again; the host replaces nothing.
    const target = device ?? (dialogOpen ? pairing?.repairFor : undefined);
    // A new attempt from the page drops the last notice.
    if (!dialogOpen) setPairing(null);
    const generation = ++requestGeneration.current;
    // Captured before the request, not after it resolves: the host stamps
    // the code's times before a database write that can wait up to its 5 s
    // busy timeout, so a deadline taken after the answer arrives could read
    // later than the host's own expiry. Taking the local time first keeps
    // this PC's deadline at or before the host's.
    const requestedAt = Date.now();
    try {
      const code = await create.mutateAsync({
        replaces: target === undefined ? shown : null,
        device: target?.id ?? null,
      });
      if (generation !== requestGeneration.current) return;
      setPairing({
        code,
        issuedAt: Date.parse(code.createdAt),
        deadline: requestedAt + codeLifetimeMs(code),
        ...(target === undefined ? {} : { repairFor: target }),
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setFailure(errorMessageKey(error));
    } finally {
      requesting.current = false;
    }
  };

  const close = () => {
    setPairing(null);
    setFailure(null);
    void devices.refetch();
  };

  const open = (next: DevicesDialog) => {
    // A code still on its way must not open its dialog over this one.
    requestGeneration.current++;
    setPairing(null);
    setFailure(null);
    setNotice(null);
    setDialog(next);
  };

  const columns: TableColumn<DeviceRecord>[] = [
    {
      key: "name",
      title: t("office.devices.table.name"),
      render: (device) => (
        <>
          {device.name}
          {device.id === thisDevice && (
            <>
              {" "}
              <Badge tone="info">{t("office.devices.thisDevice")}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: "kind",
      title: t("office.devices.table.kind"),
      render: (device) => t(`office.devices.kinds.${device.kind}`),
    },
    {
      key: "line",
      title: t("office.devices.table.line"),
      render: (device) => lineLabel(lines.data ?? [], device.lineId, t),
    },
    {
      // What the device reports on every request since plan ОБН-1.
      key: "version",
      title: t("office.devices.table.version"),
      // Wraps at «(при подключении)» rather than push «Доступ» and the
      // actions out of a 1280-pixel window.
      wrap: true,
      minWidth: 110,
      render: (device) => deviceVersionText(device, t),
    },
    {
      key: "pairedAt",
      title: t("office.devices.table.pairedAt"),
      render: (device) => DATE_TIME.format(new Date(device.pairedAt)),
    },
    {
      // Updated at most once a minute, and by a stream only when it opens:
      // the time the host last heard from the device, not "online".
      key: "lastSeenAt",
      title: t("office.devices.table.lastSeenAt"),
      render: (device) =>
        device.lastSeenAt === null
          ? t("office.common.none")
          : DATE_TIME.format(new Date(device.lastSeenAt)),
    },
    {
      key: "status",
      title: t("office.devices.table.status"),
      render: (device) => (
        <StatusChip
          phase={device.revokedAt === null ? "active" : "retired"}
          label={t(
            device.revokedAt === null
              ? "office.devices.status.active"
              : "office.devices.status.revoked",
          )}
        />
      ),
    },
    {
      // A revoked device is a dead record: its key is refused for good and a
      // new pairing makes a new device, so it offers nothing to change. A live
      // station or handheld may pair again with its own `deviceId`.
      key: "actions",
      stickyEnd: true,
      title: t("office.devices.table.actions"),
      render: (device) =>
        device.revokedAt === null ? (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.devices.editNamed", { name: device.name })}
              onClick={() => open({ kind: "edit", device })}
            >
              {t("office.devices.edit")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.devices.revokeNamed", { name: device.name })}
              onClick={() => open({ kind: "revoke", device })}
            >
              {t("office.devices.revoke")}
            </Button>
            {device.kind !== "office" && (
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.devices.repairNamed", { name: device.name })}
                onClick={() => void newCode(device)}
              >
                {t("office.devices.repair.button")}
              </Button>
            )}
          </RowActions>
        ) : null,
    },
  ];

  const content = () => {
    if (devices.isPending || lines.isPending) return <PageLoading />;
    if (devices.isError) {
      return <LoadError error={devices.error} onRetry={() => void devices.refetch()} />;
    }
    if (lines.isError) {
      return <LoadError error={lines.error} onRetry={() => void lines.refetch()} />;
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={devices.data}
          getRowKey={(device) => device.id}
          empty={t("office.devices.empty")}
          scrollLabel={t("office.devices.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.devices.title")}
        actions={
          <Button loading={create.isPending && !dialogOpen} onClick={() => void newCode()}>
            {t("office.devices.add")}
          </Button>
        }
      />
      {joined && <Alert tone="ok">{t("office.devices.joined", { name: joined.name })}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failure && !dialogOpen && <Alert tone="error">{t(failure)}</Alert>}
      {content()}
      {pairing && dialogOpen && (
        <PairingCodeDialog
          code={pairing.code}
          deadline={pairing.deadline}
          regenerating={create.isPending}
          failure={failure}
          repairFor={pairing.repairFor?.name}
          onRegenerate={() => void newCode()}
          onClose={close}
        />
      )}
      {dialog?.kind === "edit" && (
        <DeviceDialog
          device={dialog.device}
          lines={lines.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={(device) => {
            storeDevice(device);
            setDialog(null);
            setNotice(t("office.common.saved"));
          }}
        />
      )}
      {dialog?.kind === "revoke" && (
        <RevokeDeviceDialog
          device={dialog.device}
          own={dialog.device.id === thisDevice}
          onClose={() => setDialog(null)}
          onRevoked={(device) => {
            // The record the revoke returned goes in first: the row is dead
            // now, not when the list has been read again.
            storeDevice(device);
            setDialog(null);
            setNotice(t("office.devices.revoked", { name: device.name }));
            void devices.refetch();
          }}
        />
      )}
    </>
  );
}
