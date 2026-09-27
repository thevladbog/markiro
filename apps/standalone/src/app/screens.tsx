import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import type { DeviceErrorCode } from "../host/device.js";
import type { HostProbeErrorCode } from "../host/probe.js";
import type { HostStatus } from "../host/protocol.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { RejectionReason, SyncState } from "./shell.js";

const PROBE_REASON_KEY = {
  unreachable: "shell.hostMissing.unreachable",
  not_markiro_host: "shell.hostMissing.notHost",
  invalid_response: "shell.hostMissing.invalidResponse",
  host_too_old: "shell.version.hostTooOld",
  app_too_old: "shell.version.appTooOld",
} as const satisfies Record<HostProbeErrorCode, string>;

export function WaitScreen({
  messageKey,
}: {
  messageKey: "shell.loading" | "shell.pairing.title";
}) {
  const { t } = useTranslation();
  return (
    <div className="standalone-probing" role="status">
      <Spinner size={32} />
      <p>{t(messageKey)}</p>
    </div>
  );
}

export function HostMissingScreen({
  reason,
  address,
  onRetry,
  onNetwork,
}: {
  reason: HostProbeErrorCode;
  address: string;
  /** Function-typed property, not a TS method: kept safe to pass around unbound. */
  onRetry: () => void;
  /** Pair with a host in the network instead; `null` for a device that is already paired. */
  onNetwork: (() => void) | null;
}) {
  const { t } = useTranslation();
  const versionMismatch = reason === "host_too_old" || reason === "app_too_old";
  return (
    <Card
      className="standalone-card"
      title={t(versionMismatch ? "shell.version.title" : "shell.hostMissing.title")}
      titleAs="h2"
    >
      {!versionMismatch && <p>{t("shell.hostMissing.body", { address })}</p>}
      <Alert tone="warn">{t(PROBE_REASON_KEY[reason])}</Alert>
      <div className="standalone-form__actions">
        {onNetwork && (
          <Button variant="secondary" onClick={onNetwork}>
            {t("shell.hostMissing.network")}
          </Button>
        )}
        <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
      </div>
    </Card>
  );
}

export function ConfigErrorScreen({
  busy,
  error,
  onReset,
}: {
  busy: boolean;
  error: DeviceErrorCode | null;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.configError.title")} titleAs="h2">
      <p>{t("shell.configError.body")}</p>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onReset} loading={busy}>
        {t("shell.configError.reset")}
      </Button>
    </Card>
  );
}

export function PairFailedScreen({
  code,
  onRetry,
}: {
  code: DeviceErrorCode;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.pairFailed.title")} titleAs="h2">
      <Alert tone="error">{t(`errors.device.${code}`)}</Alert>
      <Button onClick={onRetry}>{t("shell.pairFailed.retry")}</Button>
    </Card>
  );
}

export function DeviceRejectedScreen({
  reason,
  remoteAddress,
  busy,
  error,
  onRepair,
}: {
  reason: RejectionReason;
  /** The paired host's address when that host is not on this computer. */
  remoteAddress: string | null;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  let explanation = t("shell.deviceRejected.keyRejected");
  if (reason === "host_changed") {
    explanation =
      remoteAddress === null
        ? t("shell.deviceRejected.hostChanged")
        : t("shell.deviceRejected.hostChangedRemote", { address: remoteAddress });
  }
  return (
    <Card className="standalone-card" title={t("shell.deviceRejected.title")} titleAs="h2">
      <Alert tone="warn">{explanation}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
      </Button>
    </Card>
  );
}

/**
 * The change feed came from another host than the paired one (spec §5.4):
 * nothing more is synced, and the device pairs again from scratch.
 */
export function OtherHostScreen({
  hostAddress,
  busy,
  error,
  onRepair,
}: {
  hostAddress: string;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.otherHost.title")} titleAs="h2">
      <Alert tone="warn">{t("shell.otherHost.body", { address: hostAddress })}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.otherHost.repair")}
      </Button>
    </Card>
  );
}

/**
 * The floor placeholder until plan 1f: the link to the host, the health of
 * the local copies and the way into the office.
 */
export function FloorScreen({
  link,
  sync,
  onOffice,
}: {
  link: HostStatus | null;
  sync: SyncState;
  onOffice: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("floor.body")}</p>
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          <Button onClick={onOffice}>{t("floor.office")}</Button>
        </div>
      </div>
    </Card>
  );
}
