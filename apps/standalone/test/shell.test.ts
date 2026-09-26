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
    expect(nextShellView(initialShellState)).toEqual({ kind: "loading" });
    expect(nextShellView(unpaired())).toEqual({ kind: "loading" });
  });

  it("reports an unreadable device config", () => {
    expect(nextShellView({ ...initialShellState, device: { kind: "unreadable" } })).toEqual({
      kind: "config_error",
    });
  });

  it("routes an unpaired device by what the local host says", () => {
    expect(
      nextShellView(unpaired({ localHost: { kind: "missing", reason: "unreachable" } })),
    ).toEqual({ kind: "host_missing", reason: "unreachable" });
    expect(
      nextShellView(unpaired({ localHost: { kind: "found", observation: observation(false) } })),
    ).toEqual({ kind: "bootstrap" });
    expect(
      nextShellView(unpaired({ localHost: { kind: "found", observation: observation(true) } })),
    ).toEqual({ kind: "pairing" });
    expect(
      nextShellView(
        unpaired({
          localHost: { kind: "found", observation: observation(true) },
          pairing: { kind: "failed", code: "pair_rejected" },
        }),
      ),
    ).toEqual({ kind: "pair_failed", code: "pair_rejected" });
  });

  it("finishes the wizard for a paired device whose host is not initialized", () => {
    expect(
      nextShellView(paired({ localHost: { kind: "found", observation: observation(false) } })),
    ).toEqual({ kind: "bootstrap" });
    const otherHost = observation(false);
    otherHost.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
    expect(nextShellView(paired({ localHost: { kind: "found", observation: otherHost } }))).toEqual(
      { kind: "floor" },
    );
  });

  it("shows the floor, the office sign-in and the office", () => {
    expect(nextShellView(paired())).toEqual({ kind: "floor" });
    expect(
      nextShellView(paired({ office: { visible: true, session: null, notice: "session_ended" } })),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(
      nextShellView(paired({ office: { visible: true, session: SESSION, notice: null } })),
    ).toEqual({ kind: "office", session: SESSION });
  });

  it("puts a rejected device before everything else", () => {
    expect(
      nextShellView(
        paired({
          rejection: "key_rejected",
          office: { visible: true, session: SESSION, notice: null },
        }),
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

  it("asks for a new sign-in when the session ends", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended" }).office).toEqual({
      visible: true,
      session: null,
      notice: "session_ended",
    });
  });

  it("closes the office for a rejected device and resets after forgetting", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const rejected = shellReducer(open, { type: "device_rejected", reason: "host_changed" });
    expect(rejected.rejection).toBe("host_changed");
    expect(rejected.office.session).toBeNull();
    const forgotten = shellReducer(rejected, { type: "forgotten" });
    expect(forgotten.device).toEqual({ kind: "ready", status: null });
    expect(forgotten.rejection).toBeNull();
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

  it("routes session and device rejections to the shell", () => {
    expect(shellActionFor(unauthorized("session"))).toEqual({ type: "session_ended" });
    expect(shellActionFor(unauthorized("device"))).toEqual({
      type: "device_rejected",
      reason: "key_rejected",
    });
    expect(
      shellActionFor(
        new HostError({ kind: "transport", code: "certificate_mismatch", message: "" }),
      ),
    ).toEqual({ type: "device_rejected", reason: "host_changed" });
  });

  it("leaves everything else to the screen", () => {
    expect(shellActionFor(unauthorized("password"))).toBeNull();
    expect(
      shellActionFor(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBeNull();
    expect(shellActionFor(new Error("boom"))).toBeNull();
  });
});
