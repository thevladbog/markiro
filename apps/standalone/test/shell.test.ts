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
import type { HostStatus } from "../src/host/protocol.js";
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
    expect(nextShellView(office, ADDRESS)).toEqual({ kind: "floor" });
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
  const signIn: ShellAction = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    operator: ANNA,
  };

  function signedIn(overrides: Partial<ShellState> = {}): ShellState {
    return shellReducer(paired(overrides), signIn);
  }

  it("shows the signed-in operator's floor, and the sign-in again once they leave", () => {
    const floor = signedIn();
    expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
    const left = shellReducer(floor, {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: null,
    });
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "floor" });
    expect(left.floorNotice).toBeNull();
  });

  it("says why the operator was signed out until the next one signs in", () => {
    const idle = shellReducer(signedIn(), {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: "idle",
    });
    expect(idle.floorNotice).toBe("idle");
    const next = shellReducer(idle, { ...signIn, operator: BORIS });
    expect(next.operator).toEqual(BORIS);
    expect(next.floorNotice).toBeNull();
  });

  it("ignores a late sign-out for an operator who already left", () => {
    const boris = shellReducer(signedIn(), { ...signIn, operator: BORIS });
    expect(
      shellReducer(boris, { type: "operator_signed_out", operatorId: ANNA.id, notice: "idle" }),
    ).toBe(boris);
    const nobody = paired();
    expect(
      shellReducer(nobody, { type: "operator_signed_out", operatorId: ANNA.id, notice: "removed" }),
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
    expect(nextShellView(state, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
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
  const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
  const OTHER_DEVICE = "5d1c2b3a-4f6e-4a8b-9c0d-7e8f9a0b1c2d";
  const signIn: ShellAction = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    operator: ANNA,
  };

  function signedIn(overrides: Partial<ShellState> = {}): ShellState {
    return shellReducer(paired(overrides), signIn);
  }

  // One entry per action type: the compiler rejects a table that misses a new
  // action, so a transition nobody decided about cannot slip in. `survives`
  // is whether Anna is still signed in after the action lands on her floor.
  type Case = { action: ShellAction; survives: boolean };
  const TABLE: Record<ShellAction["type"], Case[]> = {
    // Dispatched once at mount, when nobody can be signed in yet.
    device_loaded: [{ action: { type: "device_loaded", status: DEVICE_STATUS }, survives: true }],
    device_unreadable: [{ action: { type: "device_unreadable" }, survives: true }],
    // A probe only changes the screen (the pairing is checked by the view).
    host_probed: [
      { action: { type: "host_probed", localHost: { kind: "probing" } }, survives: true },
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
    // Only ever follows `office_requested`, which already signed the operator out.
    office_opened: [{ action: { type: "office_opened", session: SESSION }, survives: true }],
    office_closed: [{ action: { type: "office_closed" }, survives: true }],
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
    // A sign-in while somebody is signed in replaces them, as a new sign-in does.
    operator_signed_in: [{ action: { ...signIn, operator: BORIS }, survives: false }],
    operator_signed_out: [
      {
        action: { type: "operator_signed_out", operatorId: ANNA.id, notice: null },
        survives: false,
      },
      {
        action: { type: "operator_signed_out", operatorId: BORIS.id, notice: "idle" },
        survives: true,
      },
    ],
  };

  const CASES = Object.values(TABLE).flat();

  it.each(CASES.map((c) => [`${c.action.type} ${JSON.stringify(c.action)}`, c] as const))(
    "decides whether the operator survives: %s",
    (_name, { action, survives }) => {
      const after = shellReducer(signedIn(), action);
      if (action.type === "operator_signed_in") {
        expect(after.operator).toEqual(BORIS);
        return;
      }
      expect(after.operator).toEqual(survives ? ANNA : null);
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
    expect(Object.keys(state.operator ?? {}).sort()).toEqual(["id", "login", "name", "role"]);
    expect(JSON.stringify(state)).not.toMatch(/pin|badge|hash|pbkdf|secret/i);
  });

  it("records the reason for every kind of sign-out, and only the operator's own can carry none", () => {
    for (const notice of ["idle", "removed", "line_changed"] as const) {
      const left = shellReducer(signedIn(), {
        type: "operator_signed_out",
        operatorId: ANNA.id,
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

  it("lets a sign-in through on a floor that came back after the office closed", () => {
    const opened = shellReducer(shellReducer(paired(), { type: "office_requested" }), {
      type: "office_opened",
      session: SESSION,
    });
    const back = shellReducer(opened, { type: "office_closed" });
    expect(shellReducer(back, signIn).operator).toEqual(ANNA);
  });

  it("signs in a device of the office or the handheld kind without a line", () => {
    for (const kind of ["office", "handheld"] as const) {
      const state = paired({
        device: { kind: "ready", status: { ...DEVICE_STATUS, kind, lineId: null } },
      });
      const floor = shellReducer(state, signIn);
      expect(floor.operator).toEqual(ANNA);
      expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
    }
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
