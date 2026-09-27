import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, PageHeader, StatusChip, Table, type TableColumn } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { DeviceRecord, PairingCode } from "../../host/protocol.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeLocal } from "../office-local.js";
import { LoadError, PageLoading } from "../page-state.js";
import { PairingCodeDialog } from "./PairingCodeDialog.js";

/** How long a code lives on the host (`pairing_code::CODE_LIFETIME`, spec §4.7). */
const CODE_LIFETIME_MS = 10 * 60 * 1000;

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });

const lineRow = z.object({ id: z.string(), name: z.string() });

interface Pairing {
  code: PairingCode;
  /** When the host issued the code, by its clock: a device paired since took the code. */
  issuedAt: number;
  /**
   * When the dialog stops showing the code, by this PC's own clock
   * (`receivedAt + CODE_LIFETIME_MS`). The office can run on a PC other than
   * the host, and a cloud-less LAN site cannot promise the two clocks agree,
   * so the countdown is anchored to when this PC received the code, never to
   * the host's `expiresAt`.
   */
  deadline: number;
}

/** Line names from this installation's local copies; a line not there yet shows its id. */
function useLineNames() {
  const local = useOfficeLocal();
  return useQuery({
    queryKey: officeKeys.lineNames,
    queryFn: async () => {
      if (local === null) return new Map<string, string>();
      const rows = await local.query("SELECT id, name FROM ref_lines", [], lineRow);
      return new Map(rows.map((row) => [row.id, row.name]));
    },
  });
}

/** Paired devices and pairing codes (spec §5.5, administrators only; the route is wrapped in `RequireRole`). */
export function DevicesPage() {
  const { t } = useTranslation();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lineNames = useLineNames();
  const create = useOfficeMutation((api, token, _variables: void) => api.createPairingCode(token));
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The dialog closes itself once a device paired after its code was issued.
  const joined =
    pairing === null
      ? undefined
      : devices.data?.find((device) => Date.parse(device.pairedAt) >= pairing.issuedAt);
  const dialogOpen = pairing !== null && joined === undefined;

  // A request still in flight when the dialog closes -- by hand, or because
  // a device joined while a fresh code was being requested -- must not act
  // on its answer: reopening the dialog with a code nobody asked to see
  // anymore, or showing a stray failure for an abandoned action. Bumping the
  // generation on every render where the dialog is not open (including the
  // very first, before any request exists) invalidates whatever request
  // started before that close.
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (!dialogOpen) requestGeneration.current++;
  }, [dialogOpen]);

  const newCode = async () => {
    setFailure(null);
    // A new attempt from the page drops the last notice.
    if (!dialogOpen) setPairing(null);
    const generation = ++requestGeneration.current;
    try {
      const code = await create.mutateAsync();
      if (generation !== requestGeneration.current) return;
      // Anchored to this PC's own clock at the moment it received the code,
      // not to the host's `expiresAt`: the office can run on a PC other than
      // the host, and the two clocks are not promised to agree.
      const receivedAt = Date.now();
      setPairing({
        code,
        issuedAt: Date.parse(code.expiresAt) - CODE_LIFETIME_MS,
        deadline: receivedAt + CODE_LIFETIME_MS,
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setFailure(errorMessageKey(error));
    }
  };

  const close = () => {
    setPairing(null);
    setFailure(null);
    void devices.refetch();
  };

  const lineLabel = (lineId: string | null) => {
    if (lineId === null) return t("office.common.none");
    return lineNames.data?.get(lineId) ?? `${lineId.slice(0, 8)}…`;
  };

  const columns: TableColumn<DeviceRecord>[] = [
    { key: "name", title: t("office.devices.table.name"), render: (device) => device.name },
    {
      key: "kind",
      title: t("office.devices.table.kind"),
      render: (device) => t(`office.devices.kinds.${device.kind}`),
    },
    {
      key: "line",
      title: t("office.devices.table.line"),
      render: (device) => lineLabel(device.lineId),
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
  ];

  const content = () => {
    if (devices.isPending) return <PageLoading />;
    if (devices.isError) {
      return <LoadError error={devices.error} onRetry={() => void devices.refetch()} />;
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
      {failure && !dialogOpen && <Alert tone="error">{t(failure)}</Alert>}
      {content()}
      {pairing && dialogOpen && (
        <PairingCodeDialog
          code={pairing.code}
          deadline={pairing.deadline}
          regenerating={create.isPending}
          failure={failure}
          onRegenerate={() => void newCode()}
          onClose={close}
        />
      )}
    </>
  );
}
