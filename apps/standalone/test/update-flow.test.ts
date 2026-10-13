import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { HostApi } from "../src/host/api.js";
import type { BackupState } from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import { officeShiftSchema, type DeviceRecord, type OfficeShift } from "../src/host/protocol.js";
import {
  BACKUP_POLL_MS,
  BACKUP_WAIT_MS,
  BackupFailedError,
  BackupTimeoutError,
  awaitFreshBackup,
  installWarnings,
  runUpdate,
  type RunDeps,
  type UpdatePhase,
} from "../src/office/info/update-flow.js";
import type { UpdateShell, VerifiedReport } from "../src/office/info/update-shell.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { DEVICE_ID } from "./support/fixtures.js";

const testModuleUrl = import.meta.url;
const SHIFT: OfficeShift = officeShiftSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/office-shift.json", testModuleUrl), "utf8")),
);
const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

function report(overrides: Partial<VerifiedReport> = {}): VerifiedReport {
  return {
    path: "C:\\Updates\\markiro-standalone-0.2.0.update.jws",
    kid: "test-upd-1",
    manifest: {
      v: 1,
      product: "markiro-standalone",
      version: "0.2.0",
      channel: "stable",
      releasedAt: "2026-11-02T10:00:00Z",
      sourceSha: "a".repeat(40),
      installer: {
        name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe",
        sha256: SHA,
        sizeBytes: 29,
      },
      protocol: 3,
      minProtocol: 2,
      minUpgradeFrom: "0.1.0",
      notes: ["Тестовый выпуск 0.2.0"],
    },
    installed: "0.1.0",
    installerPath: "C:\\Updates\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
    comparison: "newer",
    refusal: null,
    confirmations: [],
    host: null,
    ...overrides,
  };
}

let devices = 0;

/** A paired device; `protocol` is what plan ОБН-1 records (absent: never reported). */
function device(name: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  devices += 1;
  return {
    id: `00000000-0000-4000-8000-${String(devices).padStart(12, "0")}`,
    kind: "station",
    name,
    lineId: null,
    appVersion: "0.1.0",
    protocol: 1,
    versionSeenAt: "2026-10-09T14:00:00Z",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt: "2026-10-09T14:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

/** A device of a host before plan ОБН-1: no protocol recorded. */
function withoutProtocol(record: DeviceRecord): DeviceRecord {
  const copy = { ...record };
  delete copy.protocol;
  return copy;
}

const RUNNING: BackupState = {
  ...HEALTHY_BACKUPS,
  running: { trigger: "manual", startedAt: "2026-10-09T14:21:00Z" },
};
const DONE: BackupState = {
  ...HEALTHY_BACKUPS,
  local: {
    ...HEALTHY_BACKUPS.local,
    lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok: true, code: null },
  },
};

/** Deps of a run whose clock moves only when it sleeps. */
function deps(
  api: Partial<RunDeps["api"]>,
  install = vi.fn<UpdateShell["install"]>(async () => undefined),
) {
  let clock = 0;
  const phases: UpdatePhase[] = [];
  const full: RunDeps = {
    call: (operation) => operation("office-session-token"),
    api: {
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => DONE),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
      ...api,
    },
    shell: { install },
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    onPhase: (phase) => phases.push(phase),
  };
  return { deps: full, phases, install };
}

describe("the warnings before an update (spec §9.3, §10.7)", () => {
  it("name, on the host's PC, the devices the new host will not take, and this PC's open shift", () => {
    const warnings = installWarnings({
      report: report(),
      role: "host",
      devices: [
        device("Станция линии 2"),
        device("Станция линии 3", { protocol: 2 }),
        device("Старая станция", { revokedAt: "2026-10-01T10:00:00Z" }),
        withoutProtocol(device("Не сообщала")),
        device("Этот ПК", { id: DEVICE_ID }),
      ],
      shifts: [SHIFT],
      thisDeviceId: DEVICE_ID,
    });
    expect(warnings).toEqual({
      hostRole: true,
      incompatibleDevices: ["Станция линии 2"],
      openShift: "OCT26-004",
      reinstall: false,
      hostSilent: false,
    });
  });

  it("name no devices on another PC, no shift of another device, and pass the shell's confirmations on", () => {
    const warnings = installWarnings({
      report: report({ confirmations: ["reinstall", "host_unreachable"] }),
      role: "station",
      devices: [device("Станция линии 2")],
      shifts: [
        { ...SHIFT, ownerDeviceId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" },
        { ...SHIFT, status: "planned" },
      ],
      thisDeviceId: DEVICE_ID,
    });
    expect(warnings).toEqual({
      hostRole: false,
      incompatibleDevices: [],
      openShift: null,
      reinstall: true,
      hostSilent: true,
    });
  });
});

describe("the copy before the host's PC is updated", () => {
  it("asks the host for a copy, waits for it and takes it only when that copy succeeded", async () => {
    const getBackups = vi
      .fn<HostApi["getBackups"]>()
      .mockResolvedValueOnce(RUNNING)
      .mockResolvedValueOnce(DONE);
    const { deps: run } = deps({ getBackups });
    await awaitFreshBackup(run);
    expect(run.api.startBackup).toHaveBeenCalledTimes(1);
    expect(getBackups).toHaveBeenCalledTimes(2);
    expect(run.sleep).toHaveBeenCalledWith(BACKUP_POLL_MS);
  });

  it("fails with the host's reason, and an attempt older than the copy asked for is no copy", async () => {
    const failed: BackupState = {
      ...DONE,
      local: {
        ...DONE.local,
        lastAttempt: {
          at: "2026-10-09T14:21:04Z",
          trigger: "manual",
          ok: false,
          code: "disk_full",
        },
      },
    };
    await expect(awaitFreshBackup(deps({ getBackups: async () => failed }).deps)).rejects.toEqual(
      new BackupFailedError("disk_full"),
    );
    // HEALTHY_BACKUPS' last attempt is 14:00, before the copy started at 14:21.
    const error = await awaitFreshBackup(
      deps({ getBackups: async () => HEALTHY_BACKUPS }).deps,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(error instanceof BackupFailedError ? error.code : "?").toBeNull();
  });

  it("gives up after ten minutes of a copy that does not end", async () => {
    const getBackups = vi.fn<HostApi["getBackups"]>(async () => RUNNING);
    await expect(awaitFreshBackup(deps({ getBackups }).deps)).rejects.toBeInstanceOf(
      BackupTimeoutError,
    );
    expect(getBackups.mock.calls.length).toBe(BACKUP_WAIT_MS / BACKUP_POLL_MS + 1);
  });

  it("waits for a copy already running, then asks for its own", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "a copy is being made already",
      details: { constraint: "backup_running" },
    });
    const startBackup = vi
      .fn<HostApi["startBackup"]>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce(RUNNING);
    const getBackups = vi
      .fn<HostApi["getBackups"]>()
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(DONE);
    await awaitFreshBackup(deps({ startBackup, getBackups }).deps);
    expect(startBackup).toHaveBeenCalledTimes(2);
  });
});

describe("an update the office starts (spec §10.4)", () => {
  it("on a station: reports the start, then lets the shell start the installer", async () => {
    const { deps: run, phases, install } = deps({});
    await runUpdate(run, report(), "station");
    expect(phases).toEqual(["reporting", "launching"]);
    expect(run.api.startBackup).not.toHaveBeenCalled();
    expect(run.api.recordUpdateStarted).toHaveBeenCalledWith("office-session-token", {
      from: "0.1.0",
      to: "0.2.0",
      installerSha256: SHA,
      source: "file",
    });
    expect(install).toHaveBeenCalledWith("C:\\Updates\\markiro-standalone-0.2.0.update.jws", []);
    const recorded = vi.mocked(run.api.recordUpdateStarted).mock.invocationCallOrder[0] ?? 0;
    expect(install.mock.invocationCallOrder[0]).toBeGreaterThan(recorded);
  });

  it("on the host's PC: a fresh copy first; a failed copy stops everything", async () => {
    const { deps: run, phases, install } = deps({});
    await runUpdate(run, report(), "host");
    expect(phases).toEqual(["backup", "reporting", "launching"]);
    expect(install).toHaveBeenCalledTimes(1);

    const failed: BackupState = {
      ...DONE,
      local: {
        ...DONE.local,
        lastAttempt: {
          at: "2026-10-09T14:21:04Z",
          trigger: "manual",
          ok: false,
          code: "write_failed",
        },
      },
    };
    const broken = deps({ getBackups: async () => failed });
    await expect(runUpdate(broken.deps, report(), "host")).rejects.toBeInstanceOf(
      BackupFailedError,
    );
    expect(broken.deps.api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(broken.install).not.toHaveBeenCalled();
  });

  it("goes on without the report only when the person confirmed an update without the host", async () => {
    const silent = new HostError({ kind: "transport", code: "unreachable", message: "no host" });
    const recordUpdateStarted = vi.fn<HostApi["recordUpdateStarted"]>(async () => {
      throw silent;
    });
    const confirmed = deps({ recordUpdateStarted });
    await runUpdate(confirmed.deps, report({ confirmations: ["host_unreachable"] }), "station");
    expect(confirmed.install).toHaveBeenCalledWith(expect.any(String), ["host_unreachable"]);
    const unconfirmed = deps({ recordUpdateStarted });
    await expect(runUpdate(unconfirmed.deps, report(), "station")).rejects.toBe(silent);
    expect(unconfirmed.install).not.toHaveBeenCalled();
  });
});
