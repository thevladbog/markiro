import { describe, expect, it, vi } from "vitest";

import {
  deviceRejection,
  initialShellState,
  nextShellView,
  shellActionFor,
  shellReducer,
  type ShellAction,
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import type { DeviceStatus, HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, NEW_STATION, observation, SESSION } from "./support/fixtures.js";

/** The address `App` probes; `DEVICE_STATUS.hostAddress` matches it by default. */
const ADDRESS = DEVICE_STATUS.hostAddress;

function unpaired(overrides: Partial<ShellState> = {}): ShellState {
  return { ...initialShellState, device: { kind: "ready", status: null }, ...overrides };
}

function linkStatus(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    state: "online",
    lastContactAt: 1_790_000_000_000,
    lastError: null,
    seq: 3,
    ...overrides,
  };
}

function paired(overrides: Partial<ShellState> = {}): ShellState {
  return {
    ...initialShellState,
    device: { kind: "ready", status: DEVICE_STATUS },
    localHost: { kind: "found", observation: observation(true) },
    ...overrides,
  };
}

describe("nextShellView", () => {
  it("waits for the device and the local host", () => {
    expect(nextShellView(initialShellState, ADDRESS)).toEqual({ kind: "loading" });
    expect(nextShellView(unpaired(), ADDRESS)).toEqual({ kind: "loading" });
  });

  it("reports an unreadable device config", () => {
    expect(
      nextShellView({ ...initialShellState, device: { kind: "unreadable" } }, ADDRESS),
    ).toEqual({ kind: "config_error" });
  });

  it("routes an unpaired device by what the local host says", () => {
    expect(
      nextShellView(unpaired({ localHost: { kind: "missing", reason: "unreachable" } }), ADDRESS),
    ).toEqual({ kind: "host_missing", reason: "unreachable" });
    expect(
      nextShellView(
        unpaired({ localHost: { kind: "found", observation: observation(false) } }),
        ADDRESS,
      ),
    ).toEqual({ kind: "bootstrap" });
    expect(
      nextShellView(
        unpaired({ localHost: { kind: "found", observation: observation(true) } }),
        ADDRESS,
      ),
    ).toEqual({ kind: "pairing" });
    expect(
      nextShellView(
        unpaired({
          localHost: { kind: "found", observation: observation(true) },
          pairing: { kind: "failed", code: "pair_rejected" },
        }),
        ADDRESS,
      ),
    ).toEqual({ kind: "pair_failed", code: "pair_rejected" });
  });

  it("pairs in the network when asked, whatever the local host says", () => {
    const network = shellReducer(
      unpaired({ localHost: { kind: "missing", reason: "unreachable" } }),
      { type: "network_pairing_requested" },
    );
    expect(nextShellView(network, ADDRESS)).toEqual({ kind: "network_pairing" });
    expect(nextShellView({ ...network, localHost: { kind: "probing" } }, ADDRESS)).toEqual({
      kind: "network_pairing",
    });
    const back = shellReducer(network, { type: "network_pairing_cancelled" });
    expect(nextShellView(back, ADDRESS)).toEqual({ kind: "host_missing", reason: "unreachable" });
    const claimed = shellReducer(network, { type: "paired", status: NEW_STATION });
    expect(claimed.pairing).toEqual({ kind: "idle" });
  });

  it("finishes the wizard for a paired device whose local host is not initialized", () => {
    expect(
      nextShellView(
        paired({ localHost: { kind: "found", observation: observation(false) } }),
        ADDRESS,
      ),
    ).toEqual({ kind: "bootstrap" });
  });

  it("flags a paired device once the local host's identity no longer matches", () => {
    const otherHost = observation(false);
    otherHost.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
    expect(
      nextShellView(paired({ localHost: { kind: "found", observation: otherHost } }), ADDRESS),
    ).toEqual({ kind: "device_rejected", reason: "host_changed" });

    // Same hostId, but the certificate the probe observed no longer matches
    // the one pinned at pairing time (a reinstalled host, a restored copy).
    const otherFingerprint = observation(true);
    otherFingerprint.fingerprint = "cd".repeat(32);
    expect(
      nextShellView(
        paired({ localHost: { kind: "found", observation: otherFingerprint } }),
        ADDRESS,
      ),
    ).toEqual({ kind: "device_rejected", reason: "host_changed" });
  });

  it("shows the version screen for a paired device behind an incompatible local host", () => {
    expect(
      nextShellView(paired({ localHost: { kind: "missing", reason: "app_too_old" } }), ADDRESS),
    ).toEqual({ kind: "host_missing", reason: "app_too_old" });
    expect(
      nextShellView(paired({ localHost: { kind: "missing", reason: "host_too_old" } }), ADDRESS),
    ).toEqual({ kind: "host_missing", reason: "host_too_old" });
  });

  it("stays on the floor for a paired device when the local host is merely unreachable", () => {
    expect(
      nextShellView(paired({ localHost: { kind: "missing", reason: "unreachable" } }), ADDRESS),
    ).toEqual({ kind: "floor" });
    expect(nextShellView(paired({ localHost: { kind: "probing" } }), ADDRESS)).toEqual({
      kind: "floor",
    });
  });

  it("ignores the local probe entirely for a device paired with another host address", () => {
    const remote = paired({
      device: {
        kind: "ready",
        status: { ...DEVICE_STATUS, hostAddress: "https://10.0.0.5:45710" },
      },
      localHost: { kind: "missing", reason: "host_too_old" },
    });
    expect(nextShellView(remote, ADDRESS)).toEqual({ kind: "floor" });

    const remoteRejectable = paired({
      device: {
        kind: "ready",
        status: { ...DEVICE_STATUS, hostAddress: "https://10.0.0.5:45710" },
      },
      localHost: { kind: "found", observation: observation(false) },
    });
    expect(nextShellView(remoteRejectable, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("shows the floor, the office sign-in and the office", () => {
    expect(nextShellView(paired(), ADDRESS)).toEqual({ kind: "floor" });
    expect(
      nextShellView(paired({ office: { kind: "signing_in", notice: "session_ended" } }), ADDRESS),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(nextShellView(paired({ office: { kind: "open", session: SESSION } }), ADDRESS)).toEqual({
      kind: "office",
      session: SESSION,
    });
  });

  it("has a station without a line choose it, unless the office is open or opening", () => {
    const station = paired({ device: { kind: "ready", status: NEW_STATION } });
    expect(nextShellView(station, ADDRESS)).toEqual({ kind: "line_select" });
    expect(
      nextShellView({ ...station, office: { kind: "signing_in", notice: null } }, ADDRESS),
    ).toEqual({ kind: "office_login", notice: null });
    expect(
      nextShellView({ ...station, office: { kind: "open", session: SESSION } }, ADDRESS),
    ).toEqual({ kind: "office", session: SESSION });
    const office = paired({
      device: { kind: "ready", status: { ...NEW_STATION, kind: "office" } },
    });
    expect(nextShellView(office, ADDRESS)).toEqual({ kind: "office_login", notice: null });
  });

  it("gives an office PC the office sign-in for a home, never the floor", () => {
    const officePc = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "office" } },
    });
    expect(nextShellView(officePc, ADDRESS)).toEqual({ kind: "office_login", notice: null });
    expect(
      nextShellView(
        { ...officePc, office: { kind: "signing_in", notice: "session_ended" } },
        ADDRESS,
      ),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(
      nextShellView({ ...officePc, office: { kind: "open", session: SESSION } }, ADDRESS),
    ).toEqual({ kind: "office", session: SESSION });
    // Leaving the office comes back to the sign-in.
    const left = shellReducer(
      { ...officePc, office: { kind: "open", session: SESSION } },
      { type: "office_closed" },
    );
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "office_login", notice: null });
  });

  it("puts a rejected device before everything else", () => {
    expect(
      nextShellView(
        paired({
          rejection: "key_rejected",
          office: { kind: "open", session: SESSION },
        }),
        ADDRESS,
      ),
    ).toEqual({ kind: "device_rejected", reason: "key_rejected" });
  });
});

describe("a PC paired with a host in the network, when the versions do not match (plan ОБН-3)", () => {
  const remote: DeviceStatus = { ...DEVICE_STATUS, hostAddress: "https://192.168.1.10:45710" };
  const refused = linkStatus({
    state: "offline",
    lastContactAt: null,
    lastError: "app_too_old",
    hostVersion: "0.3.0",
    hostProtocol: 4,
    hostMinProtocol: 4,
  });

  it("shows an office PC the version screen: the office is closed to it", () => {
    const state = paired({
      device: { kind: "ready", status: { ...remote, kind: "office" } },
      link: refused,
    });
    expect(nextShellView(state, ADDRESS)).toEqual({
      kind: "host_missing",
      reason: "app_too_old",
    });
    const older = { ...state, link: { ...refused, lastError: "host_too_old" } } as ShellState;
    expect(nextShellView(older, ADDRESS)).toEqual({
      kind: "host_missing",
      reason: "host_too_old",
    });
  });

  it("keeps a station on its floor: it works offline, and the floor offers the update", () => {
    const state = paired({ device: { kind: "ready", status: remote }, link: refused });
    expect(nextShellView(state, ADDRESS)).toEqual({ kind: "floor" });
  });
});

describe("shellReducer", () => {
  it("opens the office sign-in, with a note when there is one", () => {
    expect(shellReducer(paired(), { type: "office_requested" }).office).toEqual({
      kind: "signing_in",
      notice: null,
    });
    expect(
      shellReducer(paired(), { type: "office_requested", notice: "already_initialized" }).office,
    ).toEqual({ kind: "signing_in", notice: "already_initialized" });
  });

  it("drops the session when the office is closed: there is no hidden session", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(open.office).toEqual({ kind: "open", session: SESSION });
    const closed = shellReducer(open, { type: "office_closed" });
    expect(closed.office).toEqual({ kind: "closed" });
    // Coming back asks for the password again.
    expect(shellReducer(closed, { type: "office_requested" }).office).toEqual({
      kind: "signing_in",
      notice: null,
    });
  });

  it("returns to the office sign-in, with no notice, when the header's «Выйти» ends the session", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "office_signed_out" }).office).toEqual({
      kind: "signing_in",
      notice: null,
    });
    // Nothing to sign out of: the press changes nothing.
    const closed = paired();
    expect(shellReducer(closed, { type: "office_signed_out" })).toBe(closed);
  });

  it("asks for a new sign-in when its own session ends", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended", token: SESSION.token }).office).toEqual({
      kind: "signing_in",
      notice: "session_ended",
    });
  });

  it("ignores a stale session_ended for a token that is not the current session", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended", token: "some-other-token" })).toEqual(open);
    // A late failure of a session the user already left changes nothing.
    const closed = shellReducer(open, { type: "office_closed" });
    expect(shellReducer(closed, { type: "session_ended", token: SESSION.token })).toEqual(closed);
    expect(shellReducer(paired(), { type: "session_ended", token: SESSION.token })).toEqual(
      paired(),
    );
  });

  it("closes the office for a rejected device and resets after forgetting", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const rejected = shellReducer(open, { type: "device_rejected", reason: "host_changed" });
    expect(rejected.rejection).toBe("host_changed");
    expect(rejected.office).toEqual({ kind: "closed" });
    const forgotten = shellReducer(rejected, { type: "forgotten" });
    expect(forgotten.device).toEqual({ kind: "ready", status: null });
    expect(forgotten.rejection).toBeNull();
    expect(forgotten.pairing).toEqual({ kind: "idle" });
    expect(forgotten.office).toEqual({ kind: "closed" });
  });

  it("ignores a tokened device_rejected for a different session, but an untokened one always applies", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const ignored = shellReducer(open, {
      type: "device_rejected",
      reason: "host_changed",
      token: "some-other-token",
    });
    expect(ignored).toEqual(open);

    const applied = shellReducer(open, { type: "device_rejected", reason: "key_rejected" });
    expect(applied.rejection).toBe("key_rejected");
    expect(applied.office).toEqual({ kind: "closed" });

    // A late tokened rejection from a session the user already left changes nothing.
    const closed = shellReducer(open, { type: "office_closed" });
    expect(
      shellReducer(closed, {
        type: "device_rejected",
        reason: "key_rejected",
        token: SESSION.token,
      }),
    ).toEqual(closed);
    // Nor does a late session_ended while the user is signing in again.
    const signingIn = shellReducer(closed, { type: "office_requested" });
    expect(shellReducer(signingIn, { type: "session_ended", token: SESSION.token })).toEqual(
      signingIn,
    );
  });

  it("marks the local host initialized after the wizard", () => {
    const fresh = unpaired({ localHost: { kind: "found", observation: observation(false) } });
    const next = shellReducer(fresh, { type: "host_initialized" });
    expect(next.localHost).toEqual({ kind: "found", observation: observation(true) });
  });

  it("keeps the line the host confirmed", () => {
    const station = paired({ device: { kind: "ready", status: NEW_STATION } });
    const chosen = shellReducer(station, { type: "line_selected", status: DEVICE_STATUS });
    expect(chosen.device).toEqual({ kind: "ready", status: DEVICE_STATUS });
    expect(nextShellView(chosen, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("follows a line the office assigned or cleared, on a refresh of this device", () => {
    const station = paired();
    const cleared = shellReducer(station, { type: "device_refreshed", status: NEW_STATION });
    expect(cleared.device).toEqual({ kind: "ready", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS)).toEqual({ kind: "line_select" });
    const assigned = shellReducer(cleared, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(nextShellView(assigned, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("keeps the state for a refresh that changes nothing or belongs to another pairing", () => {
    const station = paired();
    expect(shellReducer(station, { type: "device_refreshed", status: DEVICE_STATUS })).toBe(
      station,
    );
    const otherDevice = { ...NEW_STATION, deviceId: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d" };
    expect(shellReducer(station, { type: "device_refreshed", status: otherDevice })).toBe(station);
    const otherHost = { ...NEW_STATION, hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
    expect(shellReducer(station, { type: "device_refreshed", status: otherHost })).toBe(station);
    // A late answer after the pairing was forgotten does not bring it back.
    const forgotten = shellReducer(station, { type: "forgotten" });
    expect(shellReducer(forgotten, { type: "device_refreshed", status: NEW_STATION })).toBe(
      forgotten,
    );
  });

  it("takes the host's new address only for its own pairing", () => {
    const remote = paired({
      device: {
        kind: "ready",
        status: { ...DEVICE_STATUS, hostAddress: "https://192.168.1.10:45710" },
      },
    });
    const moved = { ...DEVICE_STATUS, hostAddress: "https://192.168.1.20:45710" };
    expect(shellReducer(remote, { type: "address_changed", status: moved }).device).toEqual({
      kind: "ready",
      status: moved,
    });
    const otherDevice = { ...moved, deviceId: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d" };
    expect(shellReducer(remote, { type: "address_changed", status: otherDevice })).toBe(remote);
    const otherHost = { ...moved, hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
    expect(shellReducer(remote, { type: "address_changed", status: otherHost })).toBe(remote);
    const forgotten = shellReducer(remote, { type: "forgotten" });
    expect(shellReducer(forgotten, { type: "address_changed", status: moved })).toBe(forgotten);
  });

  it("retries a failed pairing", () => {
    const failed = unpaired({ pairing: { kind: "failed", code: "unreachable" } });
    expect(shellReducer(failed, { type: "pairing_retried" }).pairing).toEqual({ kind: "idle" });
  });

  it("takes a re-read user only for its own session", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const renamed = { ...SESSION.user, name: "Ирина Орлова", role: "technologist" as const };
    expect(
      shellReducer(open, { type: "office_user_refreshed", token: SESSION.token, user: renamed })
        .office,
    ).toEqual({ kind: "open", session: { ...SESSION, user: renamed } });
    expect(
      shellReducer(open, {
        type: "office_user_refreshed",
        token: "some-other-token",
        user: renamed,
      }),
    ).toEqual(open);
    const closed = shellReducer(open, { type: "office_closed" });
    expect(
      shellReducer(closed, { type: "office_user_refreshed", token: SESSION.token, user: renamed }),
    ).toEqual(closed);
  });
});

describe("link and reference sync", () => {
  it("keeps the link status the shell reports", () => {
    expect(shellReducer(paired(), { type: "link_status", status: linkStatus() }).link).toEqual(
      linkStatus(),
    );
  });

  it("treats a refused key or a changed certificate on the link as a rejected device", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const refused = shellReducer(open, {
      type: "link_status",
      status: linkStatus({ state: "offline", lastError: "key_rejected" }),
    });
    expect(refused.rejection).toBe("key_rejected");
    expect(refused.office).toEqual({ kind: "closed" });
    const changed = shellReducer(paired(), {
      type: "link_status",
      status: linkStatus({ state: "connecting", lastError: "certificate_mismatch" }),
    });
    expect(nextShellView(changed, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "host_changed",
    });
    const unreachable = shellReducer(paired(), {
      type: "link_status",
      status: linkStatus({ state: "offline", lastError: "unreachable" }),
    });
    expect(unreachable.rejection).toBeNull();
    expect(nextShellView(unreachable, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("keeps the latest revision the host announced", () => {
    expect(shellReducer(paired(), { type: "host_revision", rev: 42 }).hostRevision).toBe(42);
  });

  it("counts the syncs that brought the copies up to date", () => {
    const running = shellReducer(paired(), { type: "sync_started" });
    expect(running.sync).toEqual({ kind: "running", synced: 0, failure: null, quarantined: 0 });
    const done = shellReducer(running, {
      type: "sync_finished",
      result: { kind: "synced", rev: 42, quarantined: 0 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1, failure: null, quarantined: 0 });
    const again = shellReducer(done, { type: "sync_started" });
    expect(again.sync).toEqual({ kind: "running", synced: 1, failure: null, quarantined: 0 });
    // A number carried on the action replaces the count: the run's own catch
    // read it fresh (say, right after a restart with the host away).
    expect(
      shellReducer(again, { type: "sync_failed", failure: "host", quarantined: 3 }).sync,
    ).toEqual({
      kind: "failed",
      synced: 1,
      failure: "host",
      quarantined: 3,
    });
  });

  it("keeps why a sync failed through its retry, and the quarantine of the last success", () => {
    const failed = shellReducer(shellReducer(paired(), { type: "sync_started" }), {
      type: "sync_failed",
      failure: "host",
      quarantined: null,
    });
    // The retry's run keeps the warning, so it does not flicker away.
    const retrying = shellReducer(failed, { type: "sync_started" });
    expect(retrying.sync).toEqual({ kind: "running", synced: 0, failure: "host", quarantined: 0 });
    const local = shellReducer(retrying, {
      type: "sync_failed",
      failure: "local",
      quarantined: null,
    });
    expect(local.sync).toEqual({ kind: "failed", synced: 0, failure: "local", quarantined: 0 });
    const done = shellReducer(shellReducer(local, { type: "sync_started" }), {
      type: "sync_finished",
      result: { kind: "synced", rev: 43, quarantined: 2 },
    });
    expect(done.sync).toEqual({ kind: "done", synced: 1, failure: null, quarantined: 2 });
    // A later failure with `quarantined: null` (the run never read a count of
    // its own) keeps the count the last successful run read, rather than
    // resetting it to zero.
    const feed = shellReducer(shellReducer(done, { type: "sync_started" }), {
      type: "sync_failed",
      failure: "feed",
      quarantined: null,
    });
    expect(feed.sync).toEqual({ kind: "failed", synced: 1, failure: "feed", quarantined: 2 });
    // But a failed run that did read a fresh count replaces it with that
    // number instead, even when it differs from the last success's.
    const recounted = shellReducer(done, {
      type: "sync_failed",
      failure: "host",
      quarantined: 5,
    });
    expect(recounted.sync).toEqual({ kind: "failed", synced: 1, failure: "host", quarantined: 5 });
  });

  it("stops at another host before anything else but a rejected device", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const other = shellReducer(open, { type: "sync_finished", result: { kind: "other_host" } });
    expect(other.office).toEqual({ kind: "closed" });
    expect(nextShellView(other, ADDRESS)).toEqual({
      kind: "other_host",
      hostAddress: DEVICE_STATUS.hostAddress,
    });
    expect(nextShellView({ ...other, rejection: "key_rejected" }, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
  });

  it("keeps sync at other_host until a new pairing, absorbing every other sync action", () => {
    const other = shellReducer(paired(), { type: "sync_finished", result: { kind: "other_host" } });
    expect(other.sync).toEqual({ kind: "other_host", synced: 0, failure: null, quarantined: 0 });
    // A run a revision already queued during the run that found `other_host`
    // can still land here (`useHostLink` stops the scheduler, but not before
    // this): none of these may leave `other_host` or count as a sync.
    expect(shellReducer(other, { type: "sync_started" }).sync).toEqual(other.sync);
    expect(
      shellReducer(other, { type: "sync_failed", failure: "host", quarantined: 1 }).sync,
    ).toEqual(other.sync);
    expect(
      shellReducer(other, {
        type: "sync_finished",
        result: { kind: "synced", rev: 1, quarantined: 0 },
      }).sync,
    ).toEqual(other.sync);
    // Only a new pairing clears it.
    const idle = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
    expect(shellReducer(other, { type: "forgotten" }).sync).toEqual(idle);
    expect(shellReducer(other, { type: "paired", status: DEVICE_STATUS }).sync).toEqual(idle);
  });

  it("forgets the link, the sync and the revision with the pairing", () => {
    const actions: ShellAction[] = [
      { type: "link_status", status: linkStatus() },
      { type: "host_revision", rev: 42 },
      { type: "sync_finished", result: { kind: "other_host" } },
    ];
    const forgotten = shellReducer(actions.reduce(shellReducer, paired()), { type: "forgotten" });
    expect(forgotten.link).toBeNull();
    expect(forgotten.hostRevision).toBeNull();
    expect(forgotten.sync).toEqual({ kind: "idle", synced: 0, failure: null, quarantined: 0 });
  });

  it("resets the link, the sync and the revision on a new pairing, not just on forgetting", () => {
    const busy: ShellState = {
      ...paired(),
      link: linkStatus(),
      sync: { kind: "failed", synced: 1, failure: "feed", quarantined: 3 },
      hostRevision: 42,
    };
    const next = shellReducer(busy, { type: "paired", status: DEVICE_STATUS });
    expect(next.link).toBeNull();
    expect(next.sync).toEqual({ kind: "idle", synced: 0, failure: null, quarantined: 0 });
    expect(next.hostRevision).toBeNull();
  });
});

describe("deviceRejection", () => {
  it("needs a new pairing for a refused key or a changed certificate, and nothing else", () => {
    expect(deviceRejection(new DeviceError("key_rejected", "revoked"))).toBe("key_rejected");
    expect(deviceRejection(new DeviceError("certificate_mismatch", "reinstalled"))).toBe(
      "host_changed",
    );
    expect(deviceRejection(new DeviceError("unreachable", "down"))).toBeNull();
    expect(deviceRejection(new DeviceError("storage", "disk"))).toBeNull();
    expect(
      deviceRejection(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBeNull();
    expect(deviceRejection(new Error("boom"))).toBeNull();
  });
});

describe("shellActionFor", () => {
  function unauthorized(credential: string): HostError {
    return new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: credential,
      details: { credential },
    });
  }

  it("routes session and device rejections to the shell, tagged with the given token", () => {
    expect(shellActionFor(unauthorized("session"), SESSION.token)).toEqual({
      type: "session_ended",
      token: SESSION.token,
    });
    expect(shellActionFor(unauthorized("device"), SESSION.token)).toEqual({
      type: "device_rejected",
      reason: "key_rejected",
      token: SESSION.token,
    });
    expect(
      shellActionFor(
        new HostError({ kind: "transport", code: "certificate_mismatch", message: "" }),
        SESSION.token,
      ),
    ).toEqual({ type: "device_rejected", reason: "host_changed", token: SESSION.token });
  });

  it("omits the token for sign-in and the wizard, which have no session yet", () => {
    expect(shellActionFor(unauthorized("device"), null)).toEqual({
      type: "device_rejected",
      reason: "key_rejected",
    });
    expect(
      shellActionFor(
        new HostError({ kind: "transport", code: "certificate_mismatch", message: "" }),
        null,
      ),
    ).toEqual({ type: "device_rejected", reason: "host_changed" });
  });

  it("cannot end a session that does not exist yet", () => {
    expect(shellActionFor(unauthorized("session"), null)).toBeNull();
  });

  it("leaves everything else to the screen", () => {
    expect(shellActionFor(unauthorized("password"), SESSION.token)).toBeNull();
    expect(
      shellActionFor(
        new HostError({ kind: "transport", code: "unreachable", message: "" }),
        SESSION.token,
      ),
    ).toBeNull();
    expect(shellActionFor(new Error("boom"), SESSION.token)).toBeNull();
  });
});

describe("the operator on the floor", () => {
  const ANNA = {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "0042",
    name: "Анна",
    role: null,
  };
  const BORIS = {
    id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    login: "0099",
    name: "Борис",
    role: null,
  };
  /** Anna as the first session of a pairing has her. */
  const ANNA_SESSION = { ...ANNA, sessionId: 1 };
  const signIn: Extract<ShellAction, { type: "operator_signed_in" }> = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    lineId: DEVICE_STATUS.lineId,
    address: ADDRESS,
    operator: ANNA,
  };

  function signedIn(overrides: Partial<ShellState> = {}): ShellState {
    return shellReducer(paired(overrides), signIn);
  }

  it("shows the signed-in operator's floor, and the sign-in again once they leave", () => {
    const floor = signedIn();
    expect(nextShellView(floor, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: ANNA_SESSION,
    });
    const left = shellReducer(floor, {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "floor" });
    expect(left.floorNotice).toBeNull();
  });

  it("stores exactly the operator's four fields and a new session number, whatever the action carries", () => {
    // The sign-in builds `{ id, login, name, role }` itself; the reducer does
    // not rely on it, so a hash that slipped into the object never reaches the
    // state (and with it the screen, the idle timer and the router).
    const carrying = { ...ANNA, pinPhc: "pbkdf2$sha256$100000$c2FsdA==$ZGlnZXN0" };
    const first = shellReducer(paired(), { ...signIn, operator: carrying });
    expect(first.operator).toEqual(ANNA_SESSION);
    expect(Object.keys(first.operator ?? {}).sort()).toEqual([
      "id",
      "login",
      "name",
      "role",
      "sessionId",
    ]);
    // The same operator again is another session, with the next number.
    const left = shellReducer(first, { type: "operator_signed_out", sessionId: 1, notice: null });
    const again = shellReducer(left, { ...signIn, operator: carrying });
    expect(again.operator).toEqual({ ...ANNA, sessionId: 2 });
    expect(again.lastSessionId).toBe(2);
  });

  it("says why the operator was signed out until the next one signs in", () => {
    const idle = shellReducer(signedIn(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: "idle",
    });
    expect(idle.floorNotice).toBe("idle");
    const next = shellReducer(idle, { ...signIn, operator: BORIS });
    expect(next.operator).toEqual({ ...BORIS, sessionId: 2 });
    expect(next.floorNotice).toBeNull();
  });

  it("ignores a late sign-out for an operator who already left", () => {
    const left = shellReducer(signedIn(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    const boris = shellReducer(left, { ...signIn, operator: BORIS });
    expect(boris.operator).toEqual({ ...BORIS, sessionId: 2 });
    expect(shellReducer(boris, { type: "operator_signed_out", sessionId: 1, notice: "idle" })).toBe(
      boris,
    );
    const nobody = paired();
    expect(
      shellReducer(nobody, { type: "operator_signed_out", sessionId: 1, notice: "removed" }),
    ).toBe(nobody);
  });

  it("signs nobody in from another pairing, a rejected device, an open office or a station without a line", () => {
    for (const state of [
      paired({ device: { kind: "ready", status: { ...DEVICE_STATUS, deviceId: BORIS.id } } }),
      unpaired(),
      paired({ rejection: "key_rejected" }),
      paired({ sync: { kind: "other_host", synced: 0, failure: null, quarantined: 0 } }),
      paired({ office: { kind: "signing_in", notice: null } }),
      paired({ device: { kind: "ready", status: NEW_STATION } }),
    ]) {
      expect(shellReducer(state, signIn)).toBe(state);
    }
  });

  it("signs the operator out for the office, a new pairing, a forget and a rejected device", () => {
    for (const action of [
      { type: "office_requested" },
      { type: "paired", status: DEVICE_STATUS },
      { type: "forgotten" },
      { type: "device_rejected", reason: "key_rejected" },
      { type: "link_status", status: linkStatus({ lastError: "key_rejected" }) },
      { type: "sync_finished", result: { kind: "other_host" } },
    ] satisfies ShellAction[]) {
      expect(shellReducer(signedIn(), action).operator).toBeNull();
    }
  });

  it("signs the operator out when the office moves the station to another line or clears it", () => {
    const moved = shellReducer(signedIn(), {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" },
    });
    expect(moved.operator).toBeNull();
    expect(moved.floorNotice).toBe("line_changed");
    const cleared = shellReducer(signedIn(), { type: "device_refreshed", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS)).toEqual({ kind: "line_select" });
    expect(cleared.floorNotice).toBe("line_changed");
    // The same line again changes nothing.
    const same = signedIn();
    expect(shellReducer(same, { type: "device_refreshed", status: DEVICE_STATUS })).toBe(same);
  });

  it("keeps the operator through the link going down and failed syncs: the floor works offline", () => {
    let state = signedIn();
    for (const action of [
      { type: "link_status", status: linkStatus({ state: "offline", lastError: "unreachable" }) },
      { type: "sync_started" },
      { type: "sync_failed", failure: "host", quarantined: null },
      { type: "host_revision", rev: 7 },
    ] satisfies ShellAction[]) {
      state = shellReducer(state, action);
    }
    expect(nextShellView(state, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: ANNA_SESSION,
    });
  });
});

describe("the operator session: every action and every late answer", () => {
  const ANNA = {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "0042",
    name: "Анна",
    role: null,
  };
  const BORIS = {
    id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    login: "0099",
    name: "Борис",
    role: "brigadier",
  };
  const ANNA_SESSION = { ...ANNA, sessionId: 1 };
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const OTHER_DEVICE = "5d1c2b3a-4f6e-4a8b-9c0d-7e8f9a0b1c2d";
  const signIn: Extract<ShellAction, { type: "operator_signed_in" }> = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    lineId: DEVICE_STATUS.lineId,
    address: ADDRESS,
    operator: ANNA,
  };
  const OTHER_HOST = observation(true);
  OTHER_HOST.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

  function signedIn(overrides: Partial<ShellState> = {}): ShellState {
    return shellReducer(paired(overrides), signIn);
  }

  // One non-empty list per action type, and every row filed under its own
  // type: the compiler rejects a table that misses a new action, files a row
  // under another key or leaves a key empty, so a transition nobody decided
  // about cannot slip in. `survives` is whether Anna is still signed in after
  // the action lands on her floor.
  type Case<K extends ShellAction["type"]> = {
    action: Extract<ShellAction, { type: K }>;
    survives: boolean;
  };
  const TABLE: { [K in ShellAction["type"]]: [Case<K>, ...Case<K>[]] } = {
    // Dispatched once at mount, when nobody can be signed in yet.
    device_loaded: [{ action: { type: "device_loaded", status: DEVICE_STATUS }, survives: true }],
    device_unreadable: [{ action: { type: "device_unreadable" }, survives: true }],
    // A probe runs only at start-up, on a retry and after a forget, never on
    // a working floor, and the screen it brings back must not resurrect a
    // session: every answer signs the operator out (a lost link does not).
    host_probed: [
      { action: { type: "host_probed", localHost: { kind: "probing" } }, survives: false },
      {
        action: { type: "host_probed", localHost: { kind: "missing", reason: "host_too_old" } },
        survives: false,
      },
      {
        action: {
          type: "host_probed",
          localHost: { kind: "found", observation: observation(true) },
        },
        survives: false,
      },
      {
        action: { type: "host_probed", localHost: { kind: "found", observation: OTHER_HOST } },
        survives: false,
      },
    ],
    pairing_started: [{ action: { type: "pairing_started" }, survives: true }],
    paired: [{ action: { type: "paired", status: DEVICE_STATUS }, survives: false }],
    pairing_failed: [{ action: { type: "pairing_failed", code: "pair_rejected" }, survives: true }],
    pairing_retried: [{ action: { type: "pairing_retried" }, survives: true }],
    network_pairing_requested: [{ action: { type: "network_pairing_requested" }, survives: true }],
    network_pairing_cancelled: [{ action: { type: "network_pairing_cancelled" }, survives: true }],
    forgotten: [{ action: { type: "forgotten" }, survives: false }],
    host_initialized: [{ action: { type: "host_initialized" }, survives: true }],
    office_requested: [
      { action: { type: "office_requested" }, survives: false },
      { action: { type: "office_requested", notice: "already_initialized" }, survives: false },
    ],
    // The bootstrap wizard opens the office without `office_requested`, so the
    // action itself ends the operator's session (D4).
    office_opened: [{ action: { type: "office_opened", session: SESSION }, survives: false }],
    office_closed: [{ action: { type: "office_closed" }, survives: true }],
    // The office is not open on a floor with an operator: a late «Выйти» is ignored.
    office_signed_out: [{ action: { type: "office_signed_out" }, survives: true }],
    // The office is not open on a floor with an operator: a late failure is ignored.
    session_ended: [{ action: { type: "session_ended", token: SESSION.token }, survives: true }],
    device_rejected: [
      { action: { type: "device_rejected", reason: "key_rejected" }, survives: false },
      { action: { type: "device_rejected", reason: "host_changed" }, survives: false },
      // A tokened answer belongs to an office session, and none is open here.
      {
        action: { type: "device_rejected", reason: "key_rejected", token: SESSION.token },
        survives: true,
      },
    ],
    office_user_refreshed: [
      {
        action: { type: "office_user_refreshed", token: SESSION.token, user: SESSION.user },
        survives: true,
      },
    ],
    link_status: [
      { action: { type: "link_status", status: linkStatus() }, survives: true },
      {
        action: {
          type: "link_status",
          status: linkStatus({ state: "offline", lastError: "unreachable" }),
        },
        survives: true,
      },
      {
        action: { type: "link_status", status: linkStatus({ lastError: "key_rejected" }) },
        survives: false,
      },
      {
        action: { type: "link_status", status: linkStatus({ lastError: "certificate_mismatch" }) },
        survives: false,
      },
    ],
    host_revision: [{ action: { type: "host_revision", rev: 9 }, survives: true }],
    sync_started: [{ action: { type: "sync_started" }, survives: true }],
    sync_finished: [
      {
        action: { type: "sync_finished", result: { kind: "synced", rev: 4, quarantined: 0 } },
        survives: true,
      },
      { action: { type: "sync_finished", result: { kind: "other_host" } }, survives: false },
    ],
    sync_failed: [
      { action: { type: "sync_failed", failure: "local", quarantined: 2 }, survives: true },
    ],
    line_selected: [
      {
        action: { type: "line_selected", status: { ...DEVICE_STATUS, lineId: OTHER_LINE } },
        survives: false,
      },
    ],
    device_refreshed: [
      {
        action: { type: "device_refreshed", status: { ...DEVICE_STATUS, lineId: OTHER_LINE } },
        survives: false,
      },
      { action: { type: "device_refreshed", status: NEW_STATION }, survives: false },
      // The same line, a late answer of another pairing: nothing changes.
      { action: { type: "device_refreshed", status: DEVICE_STATUS }, survives: true },
      {
        action: {
          type: "device_refreshed",
          status: { ...DEVICE_STATUS, deviceId: OTHER_DEVICE, lineId: OTHER_LINE },
        },
        survives: true,
      },
      {
        action: {
          type: "device_refreshed",
          status: { ...DEVICE_STATUS, hostId: OTHER_DEVICE, lineId: OTHER_LINE },
        },
        survives: true,
      },
    ],
    // A new address of the same host keeps the pairing, the line and the
    // operator (plan УСТ); one of another pairing changes nothing.
    address_changed: [
      {
        action: {
          type: "address_changed",
          status: { ...DEVICE_STATUS, hostAddress: "https://192.168.1.20:45710" },
        },
        survives: true,
      },
      {
        action: {
          type: "address_changed",
          status: {
            ...DEVICE_STATUS,
            deviceId: OTHER_DEVICE,
            hostAddress: "https://192.168.1.20:45710",
          },
        },
        survives: true,
      },
    ],
    // A sign-in never replaces a session that is running: the answer of
    // another check, or of the same operator again, is refused.
    operator_signed_in: [
      { action: { ...signIn, operator: BORIS }, survives: true },
      { action: signIn, survives: true },
      { action: { ...signIn, lineId: OTHER_LINE, operator: BORIS }, survives: true },
    ],
    operator_signed_out: [
      {
        action: { type: "operator_signed_out", sessionId: 1, notice: null },
        survives: false,
      },
      {
        action: { type: "operator_signed_out", sessionId: 2, notice: "idle" },
        survives: true,
      },
    ],
    // A refresh with the same name and role changes nothing; another
    // session's is ignored; neither ends the session.
    operator_refreshed: [
      {
        action: { type: "operator_refreshed", sessionId: 1, name: ANNA.name, role: ANNA.role },
        survives: true,
      },
      {
        action: { type: "operator_refreshed", sessionId: 2, name: "Борис", role: null },
        survives: true,
      },
    ],
    work_entered: [
      { action: { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE }, survives: true },
      { action: { type: "work_entered", sessionId: 2, shiftId: OTHER_LINE }, survives: true },
    ],
    // Leaving work that never began changes nothing.
    work_left: [{ action: { type: "work_left", sessionId: 1 }, survives: true }],
    shifts_read: [
      { action: { type: "shifts_read", ok: true }, survives: true },
      { action: { type: "shifts_read", ok: false }, survives: true },
    ],
    device_not_saved: [{ action: { type: "device_not_saved" }, survives: true }],
    outbox_changed: [{ action: { type: "outbox_changed" }, survives: true }],
    facts_sent: [{ action: { type: "facts_sent" }, survives: true }],
    facts_failed: [{ action: { type: "facts_failed", failure: "host" }, survives: true }],
  };

  const CASES = Object.values(TABLE).flat();

  it.each(CASES.map((c) => [`${c.action.type} ${JSON.stringify(c.action)}`, c] as const))(
    "decides whether the operator survives: %s",
    (_name, { action, survives }) => {
      const after = shellReducer(signedIn(), action);
      expect(after.operator).toEqual(survives ? ANNA_SESSION : null);
    },
  );

  it("never writes the session anywhere: it lives in the state and nowhere else", () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    try {
      for (const { action } of CASES) shellReducer(signedIn(), action);
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
  });

  it("holds the operator's identity and nothing that could open a door", () => {
    const state = signedIn();
    expect(Object.keys(state.operator ?? {}).sort()).toEqual([
      "id",
      "login",
      "name",
      "role",
      "sessionId",
    ]);
    expect(JSON.stringify(state)).not.toMatch(/pin|badge|hash|pbkdf|secret/i);
  });

  it("records the reason for every kind of sign-out, and only the operator's own can carry none", () => {
    for (const notice of ["idle", "removed", "line_changed"] as const) {
      const left = shellReducer(signedIn(), {
        type: "operator_signed_out",
        sessionId: 1,
        notice,
      });
      expect(left.floorNotice).toBe(notice);
      expect(left.operator).toBeNull();
    }
  });

  it("ignores a sign-in that answers after the pairing ended, changed or was rejected", () => {
    const late: [string, ShellState[]][] = [
      ["forgotten", [shellReducer(paired(), { type: "forgotten" })]],
      [
        "re-paired as another device",
        [
          shellReducer(shellReducer(paired(), { type: "forgotten" }), {
            type: "paired",
            status: { ...DEVICE_STATUS, deviceId: OTHER_DEVICE },
          }),
        ],
      ],
      [
        "the office opened",
        [
          shellReducer(paired(), { type: "office_requested" }),
          shellReducer(shellReducer(paired(), { type: "office_requested" }), {
            type: "office_opened",
            session: SESSION,
          }),
        ],
      ],
      [
        "the office cleared the line",
        [shellReducer(paired(), { type: "device_refreshed", status: NEW_STATION })],
      ],
      [
        "another host",
        [shellReducer(paired(), { type: "sync_finished", result: { kind: "other_host" } })],
      ],
      [
        "the device was rejected",
        [
          shellReducer(paired(), { type: "device_rejected", reason: "key_rejected" }),
          shellReducer(paired(), {
            type: "link_status",
            status: linkStatus({ lastError: "certificate_mismatch" }),
          }),
        ],
      ],
      [
        "the device is not read yet",
        [
          { ...paired(), device: { kind: "loading" } },
          { ...paired(), device: { kind: "unreadable" } },
        ],
      ],
    ];
    for (const [name, states] of late) {
      for (const state of states) expect(shellReducer(state, signIn), name).toBe(state);
    }
  });

  it("refuses a sign-in that began on another line than the station has now", () => {
    const nobody = paired();
    for (const lineId of [OTHER_LINE, null]) {
      expect(shellReducer(nobody, { ...signIn, lineId })).toBe(nobody);
    }
    // The office moved the station while the check ran, and the answer was
    // queued behind that move: it is read against the line the move left.
    const moved = shellReducer(nobody, {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: OTHER_LINE },
    });
    expect(shellReducer(moved, signIn)).toBe(moved);
    expect(moved.operator).toBeNull();
    // A sign-in that began on the new line is the one that counts.
    const next = shellReducer(moved, { ...signIn, lineId: OTHER_LINE });
    expect(next.operator).toEqual(ANNA_SESSION);
  });

  it("never replaces a running session with another sign-in, not even the same operator's", () => {
    const running = signedIn();
    expect(shellReducer(running, { ...signIn, operator: BORIS })).toBe(running);
    expect(shellReducer(running, { ...signIn, operator: { ...ANNA } })).toBe(running);
    // Once the operator leaves, the next sign-in is a new session.
    const left = shellReducer(running, {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    expect(shellReducer(left, { ...signIn, operator: BORIS }).operator).toEqual({
      ...BORIS,
      sessionId: 2,
    });
  });

  it("refuses a sign-in whose floor is not on screen, whatever else is right", () => {
    const wizard = paired({ localHost: { kind: "found", observation: observation(false) } });
    const old = paired({ localHost: { kind: "missing", reason: "host_too_old" } });
    const appOld = paired({ localHost: { kind: "missing", reason: "app_too_old" } });
    const replaced = paired({ localHost: { kind: "found", observation: OTHER_HOST } });
    for (const [name, state, view] of [
      ["the wizard", wizard, "bootstrap"],
      ["a host too old", old, "host_missing"],
      ["an app too old", appOld, "host_missing"],
      ["another host's certificate", replaced, "device_rejected"],
    ] as const) {
      expect(nextShellView(state, ADDRESS).kind, name).toBe(view);
      expect(shellReducer(state, signIn), name).toBe(state);
    }
  });

  it("signs in a station paired with a host in the network, whatever the local probe says", () => {
    const remote = paired({
      device: {
        kind: "ready",
        status: { ...DEVICE_STATUS, hostAddress: "https://192.168.1.10:45710" },
      },
      localHost: { kind: "missing", reason: "host_too_old" },
    });
    expect(nextShellView(remote, ADDRESS)).toEqual({ kind: "floor" });
    expect(shellReducer(remote, signIn).operator).toEqual(ANNA_SESSION);
  });

  it("signs the operator out of the office the bootstrap wizard opens, and closing it shows the sign-in", () => {
    // The operator signed in while the start-up probe was still running.
    const floor = signedIn({ localHost: { kind: "probing" } });
    expect(floor.operator).toEqual(ANNA_SESSION);
    const probed = shellReducer(floor, {
      type: "host_probed",
      localHost: { kind: "found", observation: observation(false) },
    });
    expect(probed.operator).toBeNull();
    expect(nextShellView(probed, ADDRESS)).toEqual({ kind: "bootstrap" });
    // Whatever way an operator is in the state on that screen (a sign-in that
    // answers late), the wizard's office must end the session itself.
    const withOperator = { ...probed, operator: ANNA_SESSION };
    const opened = shellReducer(shellReducer(withOperator, { type: "host_initialized" }), {
      type: "office_opened",
      session: SESSION,
    });
    expect(opened.operator).toBeNull();
    const closed = shellReducer(opened, { type: "office_closed" });
    expect(nextShellView(closed, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("signs the operator out of the office opened without office_requested, whatever the notice was", () => {
    const noticed = { ...signedIn(), floorNotice: "idle" as const };
    const opened = shellReducer(noticed, { type: "office_opened", session: SESSION });
    expect(opened.operator).toBeNull();
    expect(opened.floorNotice).toBeNull();
  });

  it("does not bring the operator back when a blocked version screen is retried", () => {
    const floor = signedIn({ localHost: { kind: "probing" } });
    const blocked = shellReducer(floor, {
      type: "host_probed",
      localHost: { kind: "missing", reason: "host_too_old" },
    });
    expect(nextShellView(blocked, ADDRESS)).toEqual({
      kind: "host_missing",
      reason: "host_too_old",
    });
    const retried = shellReducer(blocked, { type: "host_probed", localHost: { kind: "probing" } });
    expect(nextShellView(retried, ADDRESS)).toEqual({ kind: "floor" });
  });

  it("does not keep the operator for a host the probe found to be another one", () => {
    const floor = signedIn({ localHost: { kind: "probing" } });
    const replaced = shellReducer(floor, {
      type: "host_probed",
      localHost: { kind: "found", observation: OTHER_HOST },
    });
    expect(nextShellView(replaced, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "host_changed",
    });
    expect(replaced.operator).toBeNull();
  });

  it("lets a sign-in through on a floor that came back after the office closed", () => {
    const opened = shellReducer(shellReducer(paired(), { type: "office_requested" }), {
      type: "office_opened",
      session: SESSION,
    });
    const back = shellReducer(opened, { type: "office_closed" });
    expect(shellReducer(back, signIn).operator).toEqual(ANNA_SESSION);
  });

  it("signs in a handheld without a line, and nobody on an office PC", () => {
    const handheld = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "handheld", lineId: null } },
    });
    const floor = shellReducer(handheld, { ...signIn, lineId: null });
    expect(floor.operator).toEqual(ANNA_SESSION);
    expect(nextShellView(floor, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: ANNA_SESSION,
    });
    // An answer that began on a line is not this device's: it has none.
    expect(shellReducer(handheld, signIn)).toBe(handheld);
    // An office PC has no floor (plan УСТ): no answer signs anybody in there.
    const officePc = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "office", lineId: null } },
    });
    expect(shellReducer(officePc, { ...signIn, lineId: null })).toBe(officePc);
  });

  it("forgets the sign-out reason with the next sign-in, the office, a new pairing and a forget", () => {
    const noticed = paired({ floorNotice: "idle" });
    expect(shellReducer(noticed, signIn).floorNotice).toBeNull();
    for (const action of [
      { type: "office_requested" },
      { type: "paired", status: DEVICE_STATUS },
      { type: "forgotten" },
    ] satisfies ShellAction[]) {
      expect(shellReducer(noticed, action).floorNotice).toBeNull();
    }
    // A sign-in that is refused leaves the reason where it was.
    const refused = paired({ floorNotice: "idle", rejection: "key_rejected" });
    expect(shellReducer(refused, signIn).floorNotice).toBe("idle");
  });

  it("keeps the reason of an earlier sign-out through a line change that signs nobody out", () => {
    const idle = paired({ floorNotice: "idle" });
    const moved = shellReducer(idle, {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: OTHER_LINE },
    });
    expect(moved.floorNotice).toBe("idle");
    const quiet = shellReducer(paired(), {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: OTHER_LINE },
    });
    expect(quiet.floorNotice).toBeNull();
  });

  it("does not turn a chosen line into a reason: the operator signs in again without a notice", () => {
    const chosen = shellReducer(signedIn(), {
      type: "line_selected",
      status: { ...DEVICE_STATUS, lineId: OTHER_LINE },
    });
    expect(chosen.operator).toBeNull();
    expect(chosen.floorNotice).toBeNull();
  });

  it("puts the line, a rejection, another host and the office before the operator's floor", () => {
    const floor = signedIn();
    expect(
      nextShellView({ ...floor, device: { kind: "ready", status: NEW_STATION } }, ADDRESS),
    ).toEqual({ kind: "line_select" });
    expect(nextShellView({ ...floor, rejection: "key_rejected" }, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
    expect(
      nextShellView(
        { ...floor, sync: { kind: "other_host", synced: 0, failure: null, quarantined: 0 } },
        ADDRESS,
      ),
    ).toEqual({ kind: "other_host", hostAddress: DEVICE_STATUS.hostAddress });
    expect(
      nextShellView({ ...floor, office: { kind: "signing_in", notice: null } }, ADDRESS),
    ).toEqual({ kind: "office_login", notice: null });
  });

  it("starts with nobody signed in and no reason, as a fresh pairing does", () => {
    expect(initialShellState.operator).toBeNull();
    expect(initialShellState.floorNotice).toBeNull();
    const fresh = shellReducer(signedIn({ floorNotice: null }), {
      type: "paired",
      status: NEW_STATION,
    });
    expect(fresh.operator).toBeNull();
    expect(fresh.floorNotice).toBeNull();
  });
});

describe("the operator's session, the shift's work and what waits for it", () => {
  const ANNA = {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "0042",
    name: "Анна",
    role: null,
  };
  const BORIS = {
    id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    login: "0099",
    name: "Борис",
    role: null,
  };
  const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const THIRD_LINE = "6a1f2c3d-4e5b-4a6c-8d7e-9f0a1b2c3d4e";
  const MOVED: DeviceStatus = { ...DEVICE_STATUS, lineId: OTHER_LINE };
  const signIn: ShellAction = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    lineId: DEVICE_STATUS.lineId,
    address: ADDRESS,
    operator: ANNA,
  };

  function working(): ShellState {
    return shellReducer(shellReducer(paired(), signIn), {
      type: "work_entered",
      sessionId: 1,
      shiftId: SHIFT_ID,
    });
  }

  it("refreshes the name and role of the running session only, without a new session", () => {
    const floor = shellReducer(paired(), signIn);
    const renamed = shellReducer(floor, {
      type: "operator_refreshed",
      sessionId: 1,
      name: "Анна Кузнецова",
      role: "Упаковщик",
    });
    expect(renamed.operator).toEqual({
      ...ANNA,
      sessionId: 1,
      name: "Анна Кузнецова",
      role: "Упаковщик",
    });
    expect(renamed.lastSessionId).toBe(1);
    const late = shellReducer(renamed, {
      type: "operator_refreshed",
      sessionId: 2,
      name: "Кто-то",
      role: null,
    });
    expect(late).toBe(renamed);
    expect(
      shellReducer(renamed, {
        type: "operator_refreshed",
        sessionId: 1,
        name: "Анна Кузнецова",
        role: "Упаковщик",
      }),
    ).toBe(renamed);
  });

  it("enters the work of the running session once, and leaves it", () => {
    const state = working();
    expect(state.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(shellReducer(state, { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE })).toBe(
      state,
    );
    const floor = shellReducer(paired(), signIn);
    expect(shellReducer(floor, { type: "work_entered", sessionId: 2, shiftId: SHIFT_ID })).toBe(
      floor,
    );
    expect(shellReducer(state, { type: "work_left", sessionId: 2 })).toBe(state);
    const left = shellReducer(state, { type: "work_left", sessionId: 1 });
    expect(left.floorWork).toBeNull();
    expect(left.operator).toEqual({ ...ANNA, sessionId: 1 });
  });

  it.each([
    [
      "the link refuses the key",
      { type: "link_status", status: linkStatus({ lastError: "key_rejected" }) },
    ],
    ["a call refuses the key", { type: "device_rejected", reason: "key_rejected" }],
  ] satisfies [string, ShellAction][])(
    "keeps the operator in the shift when %s, and refuses the device once they leave it",
    (_name, action) => {
      const refused = shellReducer(working(), action);
      expect(refused.rejection).toBeNull();
      expect(refused.pendingRejection).toBe("key_rejected");
      expect(nextShellView(refused, ADDRESS)).toEqual({
        kind: "floor_operator",
        operator: { ...ANNA, sessionId: 1 },
      });
      const left = shellReducer(refused, { type: "work_left", sessionId: 1 });
      expect(left.rejection).toBe("key_rejected");
      expect(left.operator).toBeNull();
      expect(left.pendingRejection).toBeNull();
      expect(nextShellView(left, ADDRESS)).toEqual({
        kind: "device_rejected",
        reason: "key_rejected",
      });
    },
  );

  it("refuses the device at once when the operator is not in a shift", () => {
    const floor = shellReducer(paired(), signIn);
    const refused = shellReducer(floor, {
      type: "link_status",
      status: linkStatus({ lastError: "certificate_mismatch" }),
    });
    expect(refused.rejection).toBe("host_changed");
    expect(refused.operator).toBeNull();
  });

  it("keeps the station on its line while the operator works, and moves it once they leave", () => {
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    expect(moved.pendingDevice).toEqual(MOVED);
    expect(moved.device).toEqual({ kind: "ready", status: DEVICE_STATUS });
    expect(moved.operator).toEqual({ ...ANNA, sessionId: 1 });
    const left = shellReducer(moved, { type: "work_left", sessionId: 1 });
    expect(left.device).toEqual({ kind: "ready", status: MOVED });
    expect(left.operator).toBeNull();
    expect(left.floorNotice).toBe("line_changed");
    // A cleared line waits too, then sends the station to choose one.
    const cleared = shellReducer(working(), { type: "device_refreshed", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS).kind).toBe("floor_operator");
    expect(
      nextShellView(shellReducer(cleared, { type: "work_left", sessionId: 1 }), ADDRESS),
    ).toEqual({ kind: "line_select" });
  });

  it("forgets a waiting move when the office moves the station back before the work ends", () => {
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    const back = shellReducer(moved, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(back.pendingDevice).toBeNull();
    const left = shellReducer(back, { type: "work_left", sessionId: 1 });
    expect(left.operator).toEqual({ ...ANNA, sessionId: 1 });
    expect(left.floorNotice).toBeNull();
  });

  it("lets a refused device win over another line when the work ends", () => {
    const both = shellReducer(
      shellReducer(working(), { type: "device_refreshed", status: MOVED }),
      { type: "device_rejected", reason: "key_rejected" },
    );
    const left = shellReducer(both, { type: "work_left", sessionId: 1 });
    expect(nextShellView(left, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
    expect(left.pendingDevice).toBeNull();
  });

  it("ends the work with a sign-out, and what waited for it happens then", () => {
    const idle = shellReducer(working(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: "idle",
    });
    expect(idle.floorWork).toBeNull();
    expect(idle.floorNotice).toBe("idle");
    const moved = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    const out = shellReducer(moved, { type: "operator_signed_out", sessionId: 1, notice: "idle" });
    expect(out.device).toEqual({ kind: "ready", status: MOVED });
    expect(out.floorNotice).toBe("line_changed");
  });

  it("drops the work and what waits for it with the operator: the office, a new pairing, a forget", () => {
    const holds: ShellAction[] = [
      { type: "device_refreshed", status: MOVED },
      { type: "device_rejected", reason: "key_rejected" },
      { type: "sync_finished", result: { kind: "other_host" } },
      { type: "host_probed", localHost: { kind: "missing", reason: "host_too_old" } },
    ];
    const waiting = holds.reduce(shellReducer, working());
    expect(waiting.pendingOtherHost).toBe(true);
    expect(waiting.pendingProbe).not.toBeNull();
    for (const action of [
      { type: "office_requested" },
      { type: "paired", status: DEVICE_STATUS },
      { type: "forgotten" },
    ] satisfies ShellAction[]) {
      const after = shellReducer(waiting, action);
      expect(after.floorWork).toBeNull();
      expect(after.pendingRejection).toBeNull();
      expect(after.pendingDevice).toBeNull();
      expect(after.pendingOtherHost).toBe(false);
      expect(after.pendingProbe).toBeNull();
    }
  });

  it("takes a new name of the device on the same line without ending the session", () => {
    const floor = shellReducer(paired(), signIn);
    const renamed = shellReducer(floor, {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, deviceName: "Станция у окна" },
    });
    expect(renamed.device).toEqual({
      kind: "ready",
      status: { ...DEVICE_STATUS, deviceName: "Станция у окна" },
    });
    expect(renamed.operator).toEqual({ ...ANNA, sessionId: 1 });
  });

  it("says the office's change was not saved until a read of the device lands", () => {
    const failed = shellReducer(paired(), { type: "device_not_saved" });
    expect(failed.deviceNotSaved).toBe(true);
    expect(shellReducer(failed, { type: "device_not_saved" })).toBe(failed);
    const saved = shellReducer(failed, { type: "device_refreshed", status: DEVICE_STATUS });
    expect(saved.deviceNotSaved).toBe(false);
    const fresh = shellReducer(failed, { type: "paired", status: DEVICE_STATUS });
    expect(fresh.deviceNotSaved).toBe(false);
  });

  it("counts the reads of the station's shifts and keeps whether the last failed", () => {
    let state = paired();
    state = shellReducer(state, { type: "shifts_read", ok: true });
    state = shellReducer(state, { type: "shifts_read", ok: false });
    expect(state.shiftReads).toEqual({ done: 1, failed: true });
    state = shellReducer(state, { type: "shifts_read", ok: true });
    expect(state.shiftReads).toEqual({ done: 2, failed: false });
    expect(shellReducer(state, { type: "forgotten" }).shiftReads).toEqual({
      done: 0,
      failed: false,
    });
    expect(shellReducer(state, { type: "paired", status: DEVICE_STATUS }).shiftReads).toEqual({
      done: 0,
      failed: false,
    });
  });

  it("numbers the sessions strictly upward, through a forget and a new pairing, and a late call of an earlier one ends nothing", () => {
    let state = shellReducer(paired(), signIn);
    state = shellReducer(state, { type: "operator_signed_out", sessionId: 1, notice: null });
    state = shellReducer(state, { ...signIn, operator: BORIS });
    expect(state.operator?.sessionId).toBe(2);
    const forgotten = shellReducer(state, { type: "forgotten" });
    expect(forgotten.lastSessionId).toBe(2);
    const repaired = shellReducer(forgotten, { type: "paired", status: DEVICE_STATUS });
    expect(repaired.lastSessionId).toBe(2);
    const third = shellReducer(repaired, signIn);
    expect(third.operator).toEqual({ ...ANNA, sessionId: 3 });
    // The earlier sessions' timers and checks name their own numbers.
    for (const sessionId of [1, 2]) {
      expect(shellReducer(third, { type: "operator_signed_out", sessionId, notice: "idle" })).toBe(
        third,
      );
      expect(
        shellReducer(third, { type: "operator_refreshed", sessionId, name: "X", role: null }),
      ).toBe(third);
    }
  });

  it("lets nothing of an earlier session touch the work of the next one", () => {
    const out = shellReducer(working(), {
      type: "operator_signed_out",
      sessionId: 1,
      notice: null,
    });
    expect(out.floorWork).toBeNull();
    const boris = shellReducer(out, { ...signIn, operator: BORIS });
    const second = shellReducer(boris, { type: "work_entered", sessionId: 2, shiftId: SHIFT_ID });
    expect(second.floorWork).toEqual({ sessionId: 2, shiftId: SHIFT_ID });
    expect(shellReducer(second, { type: "work_left", sessionId: 1 })).toBe(second);
    expect(shellReducer(second, { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE })).toBe(
      second,
    );
    expect(
      shellReducer(second, { type: "operator_signed_out", sessionId: 1, notice: "idle" }),
    ).toBe(second);
  });

  it.each(["idle", "removed", null] as const)(
    "lets the operator leave a shift under a held refusal (notice %s), and the refusal comes at once",
    (notice) => {
      const refused = shellReducer(working(), { type: "device_rejected", reason: "key_rejected" });
      const out = shellReducer(refused, { type: "operator_signed_out", sessionId: 1, notice });
      expect(out.rejection).toBe("key_rejected");
      expect(out.operator).toBeNull();
      expect(out.floorWork).toBeNull();
      expect(out.pendingRejection).toBeNull();
      expect(out.pendingDevice).toBeNull();
      expect(nextShellView(out, ADDRESS)).toEqual({
        kind: "device_rejected",
        reason: "key_rejected",
      });
    },
  );

  it("recovers after a held refusal is released: a new pairing starts clean and signs in again", () => {
    const refused = shellReducer(working(), { type: "device_rejected", reason: "host_changed" });
    const released = shellReducer(refused, { type: "work_left", sessionId: 1 });
    expect(nextShellView(released, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "host_changed",
    });
    // Nothing signs in under the refusal.
    expect(shellReducer(released, signIn)).toBe(released);
    const repaired = shellReducer(shellReducer(released, { type: "forgotten" }), {
      type: "paired",
      status: DEVICE_STATUS,
    });
    expect(repaired.rejection).toBeNull();
    expect(repaired.pendingRejection).toBeNull();
    const again = shellReducer(repaired, signIn);
    expect(again.operator).toEqual({ ...ANNA, sessionId: 2 });
    const entered = shellReducer(again, { type: "work_entered", sessionId: 2, shiftId: SHIFT_ID });
    expect(entered.floorWork).toEqual({ sessionId: 2, shiftId: SHIFT_ID });
  });

  it("holds one refusal at a time: a second one while it waits replaces it, and the shift goes on", () => {
    const first = shellReducer(working(), { type: "device_rejected", reason: "key_rejected" });
    const same = shellReducer(first, { type: "device_rejected", reason: "key_rejected" });
    expect(same.pendingRejection).toBe("key_rejected");
    expect(same.rejection).toBeNull();
    const other = shellReducer(first, {
      type: "link_status",
      status: linkStatus({ lastError: "certificate_mismatch" }),
    });
    expect(other.pendingRejection).toBe("host_changed");
    expect(other.rejection).toBeNull();
    expect(other.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(other.operator).toEqual({ ...ANNA, sessionId: 1 });
    const left = shellReducer(other, { type: "work_left", sessionId: 1 });
    expect(left.rejection).toBe("host_changed");
    expect(left.pendingRejection).toBeNull();
  });

  it("holds the latest of several moves to other lines, and a move back undoes them all", () => {
    const first = shellReducer(working(), { type: "device_refreshed", status: MOVED });
    const second = shellReducer(first, {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: THIRD_LINE },
    });
    expect(second.pendingDevice?.lineId).toBe(THIRD_LINE);
    expect(second.device).toEqual({ kind: "ready", status: DEVICE_STATUS });
    const left = shellReducer(second, { type: "work_left", sessionId: 1 });
    expect(left.device).toEqual({
      kind: "ready",
      status: { ...DEVICE_STATUS, lineId: THIRD_LINE },
    });
  });

  it("moves the station at once when the work has ended and the operator still stands on the floor", () => {
    const left = shellReducer(working(), { type: "work_left", sessionId: 1 });
    expect(left.floorWork).toBeNull();
    const moved = shellReducer(left, { type: "device_refreshed", status: MOVED });
    expect(moved.pendingDevice).toBeNull();
    expect(moved.device).toEqual({ kind: "ready", status: MOVED });
    expect(moved.operator).toBeNull();
    expect(moved.floorNotice).toBe("line_changed");
    const refused = shellReducer(left, { type: "device_rejected", reason: "key_rejected" });
    expect(refused.pendingRejection).toBeNull();
    expect(refused.rejection).toBe("key_rejected");
  });

  it("keeps the work and what waits for it through everything that does not decide them", () => {
    const waiting = shellReducer(
      shellReducer(working(), { type: "device_refreshed", status: MOVED }),
      { type: "device_rejected", reason: "key_rejected" },
    );
    expect(waiting.pendingDevice).toEqual(MOVED);
    expect(waiting.pendingRejection).toBe("key_rejected");
    for (const action of [
      { type: "link_status", status: linkStatus() },
      { type: "link_status", status: linkStatus({ state: "offline", lastError: "unreachable" }) },
      { type: "host_revision", rev: 11 },
      { type: "sync_started" },
      { type: "sync_finished", result: { kind: "synced", rev: 4, quarantined: 0 } },
      { type: "sync_failed", failure: "host", quarantined: null },
      { type: "shifts_read", ok: true },
      { type: "shifts_read", ok: false },
      { type: "device_not_saved" },
      { type: "operator_refreshed", sessionId: 1, name: "Анна К.", role: "Упаковщик" },
      { type: "work_entered", sessionId: 1, shiftId: OTHER_LINE },
      { type: "work_left", sessionId: 2 },
      { type: "office_closed" },
      { type: "session_ended", token: SESSION.token },
      { type: "device_rejected", reason: "host_changed", token: SESSION.token },
      { type: "device_refreshed", status: { ...DEVICE_STATUS, deviceId: OTHER_LINE } },
    ] satisfies ShellAction[]) {
      const after = shellReducer(waiting, action);
      expect(after.floorWork, action.type).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
      expect(after.pendingRejection, action.type).toBe("key_rejected");
      expect(after.pendingDevice, action.type).toEqual(MOVED);
      expect(after.rejection, action.type).toBeNull();
      expect(after.operator?.sessionId, action.type).toBe(1);
    }
  });

  it("holds the work of an operator whose host was replaced, like a refusal, until they leave", () => {
    const before = working();
    const held = shellReducer(before, { type: "sync_finished", result: { kind: "other_host" } });
    // Nothing but the wait changes: the line goes on, the shift is still entered.
    expect(held.operator).toEqual({ ...ANNA, sessionId: 1 });
    expect(held.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(held.pendingOtherHost).toBe(true);
    expect(held.sync).toEqual(before.sync);
    expect(nextShellView(held, ADDRESS)).toEqual({
      kind: "floor_operator",
      operator: { ...ANNA, sessionId: 1 },
    });
    const left = shellReducer(held, { type: "work_left", sessionId: 1 });
    expect(left.operator).toBeNull();
    expect(left.floorWork).toBeNull();
    expect(left.pendingOtherHost).toBe(false);
    expect(left.sync.kind).toBe("other_host");
    expect(left.office).toEqual({ kind: "closed" });
    expect(nextShellView(left, ADDRESS).kind).toBe("other_host");
    // A sign-out in the middle of the work ends it, and the screen comes then.
    const out = shellReducer(held, { type: "operator_signed_out", sessionId: 1, notice: "idle" });
    expect(nextShellView(out, ADDRESS).kind).toBe("other_host");
    expect(out.operator).toBeNull();
    // Nobody in a shift: the screen at once, as before.
    const floor = shellReducer(paired(), signIn);
    const at = shellReducer(floor, { type: "sync_finished", result: { kind: "other_host" } });
    expect(at.operator).toBeNull();
    expect(at.pendingOtherHost).toBe(false);
    expect(nextShellView(at, ADDRESS).kind).toBe("other_host");
  });

  it("takes no sync for the held host: a late run of it counts for nothing", () => {
    const held = shellReducer(working(), { type: "sync_finished", result: { kind: "other_host" } });
    for (const action of [
      { type: "sync_started" },
      { type: "sync_finished", result: { kind: "synced", rev: 4, quarantined: 0 } },
      { type: "sync_failed", failure: "host", quarantined: 3 },
    ] satisfies ShellAction[]) {
      expect(shellReducer(held, action), action.type).toBe(held);
    }
  });

  it("lets a refused device win over a replaced host when the work ends, and keeps both views right", () => {
    const both = shellReducer(
      shellReducer(working(), { type: "sync_finished", result: { kind: "other_host" } }),
      { type: "device_rejected", reason: "key_rejected" },
    );
    expect(both.pendingRejection).toBe("key_rejected");
    expect(both.pendingOtherHost).toBe(true);
    const left = shellReducer(both, { type: "work_left", sessionId: 1 });
    expect(left.rejection).toBe("key_rejected");
    expect(left.sync.kind).toBe("other_host");
    expect(nextShellView(left, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "key_rejected",
    });
  });

  it("holds the answer of a probe that lands while the operator works, and applies it when they leave", () => {
    const working0 = shellReducer(
      shellReducer(paired({ localHost: { kind: "probing" } }), signIn),
      { type: "work_entered", sessionId: 1, shiftId: SHIFT_ID },
    );
    const replaced = observation(true);
    replaced.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
    const held = shellReducer(working0, {
      type: "host_probed",
      localHost: { kind: "found", observation: replaced },
    });
    expect(held.localHost).toEqual({ kind: "probing" });
    expect(held.pendingProbe).toEqual({ kind: "found", observation: replaced });
    expect(held.operator).toEqual({ ...ANNA, sessionId: 1 });
    expect(held.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(nextShellView(held, ADDRESS).kind).toBe("floor_operator");
    // The last answer is the one that counts.
    const later = shellReducer(held, {
      type: "host_probed",
      localHost: { kind: "missing", reason: "host_too_old" },
    });
    expect(later.pendingProbe).toEqual({ kind: "missing", reason: "host_too_old" });
    const left = shellReducer(later, { type: "work_left", sessionId: 1 });
    expect(left.localHost).toEqual({ kind: "missing", reason: "host_too_old" });
    expect(left.pendingProbe).toBeNull();
    expect(left.operator).toBeNull();
    expect(left.floorWork).toBeNull();
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "host_missing", reason: "host_too_old" });
    // The probe that found another host decides the same way, once the work is over.
    const swapped = shellReducer(held, { type: "work_left", sessionId: 1 });
    expect(nextShellView(swapped, ADDRESS)).toEqual({
      kind: "device_rejected",
      reason: "host_changed",
    });
    // A move to another line that waited comes out after the probe's answer.
    const moved = shellReducer(held, { type: "device_refreshed", status: MOVED });
    const both = shellReducer(moved, { type: "work_left", sessionId: 1 });
    expect(both.device).toEqual({ kind: "ready", status: MOVED });
    expect(both.localHost).toEqual({ kind: "found", observation: replaced });
    expect(both.operator).toBeNull();
    expect(both.floorNotice).toBe("line_changed");
  });

  it("applies a probe that nobody holds at once: outside a shift the session ends with it", () => {
    const floor = shellReducer(paired({ localHost: { kind: "probing" } }), signIn);
    const after = shellReducer(floor, {
      type: "host_probed",
      localHost: { kind: "missing", reason: "host_too_old" },
    });
    expect(after.operator).toBeNull();
    expect(after.pendingProbe).toBeNull();
    expect(after.localHost).toEqual({ kind: "missing", reason: "host_too_old" });
  });

  it("counts the reads of the shifts without touching the session or its work", () => {
    const after = shellReducer(working(), { type: "shifts_read", ok: true });
    expect(after.shiftReads).toEqual({ done: 1, failed: false });
    expect(after.floorWork).toEqual({ sessionId: 1, shiftId: SHIFT_ID });
    expect(after.operator).toEqual({ ...ANNA, sessionId: 1 });
  });
});

describe("the outbox's delivery", () => {
  it("keeps why the last send failed until a send goes through", () => {
    const host = shellReducer(initialShellState, { type: "facts_failed", failure: "host" });
    const offline = shellReducer(host, { type: "facts_failed", failure: "offline" });
    const sent = shellReducer(offline, { type: "facts_sent" });
    expect([initialShellState.factsFailure, host.factsFailure, offline.factsFailure]).toEqual([
      null,
      "host",
      "offline",
    ]);
    expect(sent.factsFailure).toBeNull();
    expect(shellReducer(sent, { type: "outbox_changed" }).factsFailure).toBeNull();
  });

  it("does not carry a failure of one pairing over to the next", () => {
    const failed = shellReducer(initialShellState, { type: "facts_failed", failure: "local" });
    expect(failed.factsFailure).toBe("local");
    expect(shellReducer(failed, { type: "forgotten" }).factsFailure).toBeNull();
    expect(shellReducer(failed, { type: "paired", status: DEVICE_STATUS }).factsFailure).toBeNull();
  });

  it("changes nothing when a send fails for the reason already named", () => {
    const failed = shellReducer(initialShellState, { type: "facts_failed", failure: "host" });
    expect(shellReducer(failed, { type: "facts_failed", failure: "host" })).toBe(failed);
    expect(shellReducer(initialShellState, { type: "facts_sent" })).toBe(initialShellState);
  });
});

describe("the outbox's changes", () => {
  it("count up with every change, whatever the floor shows", () => {
    const once = shellReducer(initialShellState, { type: "outbox_changed" });
    const twice = shellReducer(once, { type: "outbox_changed" });
    expect([initialShellState.outboxVersion, once.outboxVersion, twice.outboxVersion]).toEqual([
      0, 1, 2,
    ]);
  });
});
