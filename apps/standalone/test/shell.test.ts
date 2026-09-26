import { describe, expect, it } from "vitest";

import {
  initialShellState,
  nextShellView,
  shellActionFor,
  shellReducer,
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";

/** The address `App` probes; `DEVICE_STATUS.hostAddress` matches it by default. */
const ADDRESS = DEVICE_STATUS.hostAddress;

function unpaired(overrides: Partial<ShellState> = {}): ShellState {
  return { ...initialShellState, device: { kind: "ready", status: null }, ...overrides };
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
      nextShellView(
        paired({ office: { visible: true, session: null, notice: "session_ended" } }),
        ADDRESS,
      ),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(
      nextShellView(paired({ office: { visible: true, session: SESSION, notice: null } }), ADDRESS),
    ).toEqual({ kind: "office", session: SESSION });
  });

  it("puts a rejected device before everything else", () => {
    expect(
      nextShellView(
        paired({
          rejection: "key_rejected",
          office: { visible: true, session: SESSION, notice: null },
        }),
        ADDRESS,
      ),
    ).toEqual({ kind: "device_rejected", reason: "key_rejected" });
  });
});

describe("shellReducer", () => {
  it("keeps the session when the office is left and drops it on sign-out", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const left = shellReducer(open, { type: "office_left" });
    expect(left.office).toEqual({ visible: false, session: SESSION, notice: null });
    expect(shellReducer(left, { type: "office_requested" }).office.visible).toBe(true);
    expect(shellReducer(open, { type: "logged_out" }).office).toEqual({
      visible: false,
      session: null,
      notice: null,
    });
  });

  it("asks for a new sign-in when its own session ends", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended", token: SESSION.token }).office).toEqual({
      visible: true,
      session: null,
      notice: "session_ended",
    });
  });

  it("keeps a hidden office hidden when its session ends", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const left = shellReducer(open, { type: "office_left" });
    expect(shellReducer(left, { type: "session_ended", token: SESSION.token }).office).toEqual({
      visible: false,
      session: null,
      notice: null,
    });
  });

  it("ignores a stale session_ended for a token that is not the current session", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended", token: "some-other-token" })).toEqual(open);
    // No session at all (e.g. on the floor): still nothing to end.
    expect(shellReducer(paired(), { type: "session_ended", token: SESSION.token })).toEqual(
      paired(),
    );
  });

  it("closes the office for a rejected device and resets after forgetting", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const rejected = shellReducer(open, { type: "device_rejected", reason: "host_changed" });
    expect(rejected.rejection).toBe("host_changed");
    expect(rejected.office).toEqual({ visible: false, session: null, notice: null });
    const forgotten = shellReducer(rejected, { type: "forgotten" });
    expect(forgotten.device).toEqual({ kind: "ready", status: null });
    expect(forgotten.rejection).toBeNull();
    expect(forgotten.pairing).toEqual({ kind: "idle" });
    expect(forgotten.office).toEqual({ visible: false, session: null, notice: null });
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
    expect(applied.office.visible).toBe(false);
  });

  it("marks the local host initialized after the wizard", () => {
    const fresh = unpaired({ localHost: { kind: "found", observation: observation(false) } });
    const next = shellReducer(fresh, { type: "host_initialized" });
    expect(next.localHost).toEqual({ kind: "found", observation: observation(true) });
  });

  it("retries a failed pairing", () => {
    const failed = unpaired({ pairing: { kind: "failed", code: "unreachable" } });
    expect(shellReducer(failed, { type: "pairing_retried" }).pairing).toEqual({ kind: "idle" });
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
