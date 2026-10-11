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

/** A forget the shell refused for records not yet sent (`unsent_facts`), and how many. */
export interface UnsentRecords {
  records: number | null;
}

/**
 * The forget the shell refused while this device holds shift records the
 * host has not acknowledged (question В7): it says how many and lets a person
 * go ahead; the records stay on this PC's disk (`keepUnsent`). A rejected
 * device can send nothing more, so waiting for them would trap it here.
 */
function UnsentNotice({
  unsent,
  busy,
  onConfirm,
}: {
  unsent: UnsentRecords | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (unsent === null) return null;
  return (
    <>
      <Alert tone="warn">
        {unsent.records === null
          ? t("shell.unsent.bodyUnknown")
          : t("shell.unsent.body", { records: unsent.records })}
      </Alert>
      <Button variant="destructive" onClick={onConfirm} loading={busy}>
        {t("shell.unsent.confirm")}
      </Button>
    </>
  );
}

/**
 * A forget held back while this pairing still owes a host restored from a
 * copy its SSCC blocks (plan РК-С): once forgotten it never returns them, so
 * the host would not know the serials issued to it after the copy. It says so
 * and lets a person go ahead.
 */
function RestoreOwedNotice({
  owed,
  busy,
  onConfirm,
}: {
  owed: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!owed) return null;
  return (
    <>
      <Alert tone="warn">{t("shell.restoreOwed.body")}</Alert>
      <Button variant="destructive" onClick={onConfirm} loading={busy}>
        {t("shell.restoreOwed.confirm")}
      </Button>
    </>
  );
}

export function ConfigErrorScreen({
  busy,
  error,
  unsent,
  onReset,
  onConfirm,
}: {
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  onReset: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.configError.title")} titleAs="h2">
      <p>{t("shell.configError.body")}</p>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
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
  unsent,
  owed,
  onRepair,
  onConfirm,
  onConfirmOwed,
}: {
  reason: RejectionReason;
  /** The paired host's address when that host is not on this computer. */
  remoteAddress: string | null;
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  /** The forget waits: the pairing still owes a restored host its blocks. */
  owed: boolean;
  onRepair: () => void;
  onConfirm: () => void;
  onConfirmOwed: () => void;
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
      <RestoreOwedNotice owed={owed} busy={busy} onConfirm={onConfirmOwed} />
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
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
  unsent,
  owed,
  onRepair,
  onConfirm,
  onConfirmOwed,
}: {
  hostAddress: string;
  busy: boolean;
  error: DeviceErrorCode | null;
  unsent: UnsentRecords | null;
  /** The forget waits: the pairing still owes a restored host its blocks. */
  owed: boolean;
  onRepair: () => void;
  onConfirm: () => void;
  onConfirmOwed: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.otherHost.title")} titleAs="h2">
      <Alert tone="warn">{t("shell.otherHost.body", { address: hostAddress })}</Alert>
      {error && <Alert tone="error">{t(`errors.device.${error}`)}</Alert>}
      <RestoreOwedNotice owed={owed} busy={busy} onConfirm={onConfirmOwed} />
      <UnsentNotice unsent={unsent} busy={busy} onConfirm={onConfirm} />
      <Button onClick={onRepair} loading={busy}>
        {t("shell.otherHost.repair")}
      </Button>
    </Card>
  );
}
