import type { HostApi } from "../../host/api.js";
import type { BackupState } from "../../host/backups.js";
import { HostError } from "../../host/client.js";
import type { InstallRole } from "../../host/device.js";
import type { DeviceRecord, OfficeShift } from "../../host/protocol.js";
import { updateStarted } from "../../host/requests.js";
import type { UpdateShell, VerifiedReport } from "./update-shell.js";

/** How long the host may take for the copy made before its own PC is updated (spec §10.4 step 3). */
export const BACKUP_WAIT_MS = 10 * 60_000;
/** How often that copy's state is read while it runs. */
export const BACKUP_POLL_MS = 2000;

/** The copy before the update failed; `code` is the host's (`BackupFailure`), `null` when it named none. */
export class BackupFailedError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super(`the copy before the update failed: ${code ?? "no attempt"}`);
    this.name = "BackupFailedError";
    this.code = code;
  }
}

/** The copy before the update did not end within `BACKUP_WAIT_MS`. */
export class BackupTimeoutError extends Error {
  constructor() {
    super("the copy before the update did not end in time");
    this.name = "BackupTimeoutError";
  }
}

/** The page that started the update is gone: nothing more is reported or started. */
export class UpdateCancelledError extends Error {
  constructor() {
    super("the update was left before it started");
    this.name = "UpdateCancelledError";
  }
}

/** How far before its request a copy that already ended may have been made and still be the one asked for. */
const ENDED_COPY_SLACK_MS = 60_000;

/** What the confirmation before the launch says (spec §9.3 item 3, §10.7). */
export interface InstallWarnings {
  /** The host's PC: a copy first, and the host stops for 1-3 minutes. */
  hostRole: boolean;
  /** Paired devices whose protocol the new host no longer takes, by name. */
  incompatibleDevices: string[];
  /** The number of the shift this PC has open, if any. */
  openShift: string | null;
  /** The same version again (the shell asks for `reinstall`). */
  reinstall: boolean;
  /** The host did not answer (the shell asks for `host_unreachable`). */
  hostSilent: boolean;
}

export function installWarnings(input: {
  report: VerifiedReport;
  role: InstallRole | "unknown";
  devices: readonly DeviceRecord[];
  shifts: readonly OfficeShift[];
  thisDeviceId: string | null;
}): InstallWarnings {
  const hostRole = input.role === "host";
  const minProtocol = input.report.manifest.minProtocol;
  return {
    hostRole,
    incompatibleDevices: hostRole
      ? input.devices
          .filter(
            (device) =>
              device.revokedAt === null &&
              device.id !== input.thisDeviceId &&
              typeof device.protocol === "number" &&
              device.protocol < minProtocol,
          )
          .map((device) => device.name)
      : [],
    openShift:
      input.thisDeviceId === null
        ? null
        : (input.shifts.find(
            (shift) => shift.status === "active" && shift.ownerDeviceId === input.thisDeviceId,
          )?.number ?? null),
    reinstall: input.report.confirmations.includes("reinstall"),
    hostSilent: input.report.confirmations.includes("host_unreachable"),
  };
}

export interface BackupDeps {
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
  api: Pick<HostApi, "startBackup" | "getBackups">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `true` once the page that started the update is gone (unmounted): the flow stops at its next step. */
  cancelled?: () => boolean;
}

function stopIfCancelled(deps: BackupDeps): void {
  if (deps.cancelled?.() === true) throw new UpdateCancelledError();
}

async function waitIdle(deps: BackupDeps, deadline: number): Promise<BackupState> {
  for (;;) {
    const state = await deps.call((token) => deps.api.getBackups(token));
    stopIfCancelled(deps);
    if (state.running === null) return state;
    if (deps.now() >= deadline) throw new BackupTimeoutError();
    await deps.sleep(BACKUP_POLL_MS);
  }
}

function copyRunning(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "backup_running"
  );
}

/**
 * «Сделать копию сейчас» before the host's own PC is updated (spec §10.4
 * step 3): asks the host for a copy (after the one already running, if
 * any), waits up to `BACKUP_WAIT_MS` and resolves only when the local
 * folder's last attempt is that copy and it succeeded.
 */
export async function awaitFreshBackup(deps: BackupDeps): Promise<void> {
  const deadline = deps.now() + BACKUP_WAIT_MS;
  let requestedAt = deps.now();
  let started: BackupState | null = null;
  // Another copy (a scheduled one) may start between our wait and our ask: ask again until the deadline.
  while (started === null) {
    try {
      requestedAt = deps.now();
      started = await deps.call((token) => deps.api.startBackup(token));
    } catch (error) {
      if (!copyRunning(error)) throw error;
      await waitIdle(deps, deadline);
      // A host that keeps refusing while it reports no copy must not spin: the deadline holds.
      if (deps.now() >= deadline) throw new BackupTimeoutError();
      await deps.sleep(BACKUP_POLL_MS);
    }
  }
  // Ours runs: its last attempt must not be older than its start. Ours already ended: not
  // older than the request (this is the host's PC, one clock).
  const since =
    started.running === null
      ? requestedAt - ENDED_COPY_SLACK_MS
      : Date.parse(started.running.startedAt);
  const settled = started.running === null ? started : await waitIdle(deps, deadline);
  const attempt = settled.local.lastAttempt;
  if (attempt === null || !attempt.ok || Date.parse(attempt.at) < since) {
    throw new BackupFailedError(attempt !== null && !attempt.ok ? attempt.code : null);
  }
}

export type UpdatePhase = "backup" | "reporting" | "launching";

export interface RunDeps extends BackupDeps {
  api: Pick<HostApi, "startBackup" | "getBackups" | "recordUpdateStarted">;
  shell: Pick<UpdateShell, "install">;
  onPhase: (phase: UpdatePhase) => void;
}

/**
 * The launch of spec §10.4 from the office: on the host's PC a fresh copy
 * first, then the `app.update.start` row, then the shell checks the package
 * again and starts the installer, and the app leaves. A host that does not
 * answer the report stops nothing only when the person confirmed an update
 * without the host (§10.7, ЛО12).
 */
export async function runUpdate(
  deps: RunDeps,
  report: VerifiedReport,
  role: InstallRole | "unknown",
  source: "file" | "host" = "file",
): Promise<void> {
  if (role === "host") {
    deps.onPhase("backup");
    await awaitFreshBackup(deps);
  }
  stopIfCancelled(deps);
  deps.onPhase("reporting");
  try {
    await deps.call((token) =>
      deps.api.recordUpdateStarted(
        token,
        updateStarted(
          {
            from: report.installed,
            to: report.manifest.version,
            installerSha256: report.manifest.installer.sha256,
          },
          source,
        ),
      ),
    );
  } catch (error) {
    const withoutHost =
      error instanceof HostError &&
      error.kind === "transport" &&
      report.confirmations.includes("host_unreachable");
    if (!withoutHost) throw error;
  }
  stopIfCancelled(deps);
  deps.onPhase("launching");
  await deps.shell.install(report.path, report.confirmations);
}
