import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import type { DeviceErrorCode } from "../host/device.js";
import type { HostProbeErrorCode } from "../host/probe.js";
import type { RejectionReason } from "./shell.js";

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
}: {
  reason: HostProbeErrorCode;
  address: string;
  /** Function-typed property, not a TS method: kept safe to pass around unbound. */
  onRetry: () => void;
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
      <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
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
  busy,
  error,
  onRepair,
}: {
  reason: RejectionReason;
  busy: boolean;
  error: DeviceErrorCode | null;
  onRepair: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.deviceRejected.title")} titleAs="h2">
      <Alert tone="warn">
        {t(
          reason === "key_rejected"
            ? "shell.deviceRejected.keyRejected"
            : "shell.deviceRejected.hostChanged",
        )}
      </Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <Button onClick={onRepair} loading={busy}>
        {t("shell.deviceRejected.repair")}
      </Button>
    </Card>
  );
}

/** The floor placeholder until plan 1f: the way into the office. */
export function FloorScreen({ onOffice }: { onOffice: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <p>{t("floor.body")}</p>
      <Button onClick={onOffice}>{t("floor.office")}</Button>
    </Card>
  );
}
