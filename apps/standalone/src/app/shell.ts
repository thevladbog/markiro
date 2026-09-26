import { HostError } from "../host/client.js";
import type { DeviceErrorCode } from "../host/device.js";
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, OfficeSession } from "../host/protocol.js";

/** What the probe of the host on this computer found. */
export type LocalHostState =
  | { kind: "probing" }
  | { kind: "missing"; reason: HostProbeErrorCode }
  | { kind: "found"; observation: HelloObservation };

/** The pairing kept by the shell; `null` status means not paired. */
export type DeviceState =
  { kind: "loading" } | { kind: "unreadable" } | { kind: "ready"; status: DeviceStatus | null };

export type PairingState =
  { kind: "idle" } | { kind: "pairing" } | { kind: "failed"; code: DeviceErrorCode };

/** Why the host no longer accepts this device. */
export type RejectionReason = "key_rejected" | "host_changed";

export interface OfficeState {
  visible: boolean;
  /** Kept only in memory; the host ends it after 30 idle minutes. */
  session: OfficeSession | null;
  notice: "session_ended" | null;
}

export interface ShellState {
  device: DeviceState;
  localHost: LocalHostState;
  pairing: PairingState;
  rejection: RejectionReason | null;
  office: OfficeState;
}

export type ShellView =
  | { kind: "loading" }
  | { kind: "config_error" }
  | { kind: "host_missing"; reason: HostProbeErrorCode }
  | { kind: "bootstrap" }
  | { kind: "pairing" }
  | { kind: "pair_failed"; code: DeviceErrorCode }
  | { kind: "device_rejected"; reason: RejectionReason }
  | { kind: "floor" }
  | { kind: "office_login"; notice: "session_ended" | null }
  | { kind: "office"; session: OfficeSession };

export type ShellAction =
  | { type: "device_loaded"; status: DeviceStatus | null }
  | { type: "device_unreadable" }
  | { type: "host_probed"; localHost: LocalHostState }
  | { type: "pairing_started" }
  | { type: "paired"; status: DeviceStatus }
  | { type: "pairing_failed"; code: DeviceErrorCode }
  | { type: "pairing_retried" }
  | { type: "forgotten" }
  | { type: "host_initialized" }
  | { type: "office_requested" }
  | { type: "office_opened"; session: OfficeSession }
  | { type: "office_left" }
  | { type: "logged_out" }
  | { type: "session_ended"; token: string }
  | { type: "device_rejected"; reason: RejectionReason; token?: string };

const CLOSED_OFFICE: OfficeState = { visible: false, session: null, notice: null };

export const initialShellState: ShellState = {
  device: { kind: "loading" },
  localHost: { kind: "probing" },
  pairing: { kind: "idle" },
  rejection: null,
  office: CLOSED_OFFICE,
};

/**
 * The screen for a snapshot (stage 1 spec §5.1), a pure function like the
 * station's `nextStationView`. Code pairing and line selection arrive in
 * plan 1c; until then an unpaired device can only pair with the host on
 * this computer.
 *
 * `localAddress` is the address `host_probe` was asked about (`App`'s
 * `address` prop). A paired device whose own `hostAddress` differs from it
 * is paired with a remote host (plan 1c); the local probe says nothing
 * about that host, so it is ignored entirely for that device.
 */
export function nextShellView(state: ShellState, localAddress: string): ShellView {
  const { device, localHost } = state;
  if (device.kind === "loading") return { kind: "loading" };
  if (device.kind === "unreadable") return { kind: "config_error" };
  const status = device.status;
  if (status === null) {
    if (localHost.kind === "probing") return { kind: "loading" };
    if (localHost.kind === "missing") return { kind: "host_missing", reason: localHost.reason };
    if (!localHost.observation.hello.initialized) return { kind: "bootstrap" };
    if (state.pairing.kind === "failed") return { kind: "pair_failed", code: state.pairing.code };
    return { kind: "pairing" };
  }
  if (state.rejection) return { kind: "device_rejected", reason: state.rejection };
  if (status.hostAddress === localAddress) {
    if (localHost.kind === "found") {
      const { hello, fingerprint } = localHost.observation;
      if (hello.hostId !== status.hostId || fingerprint !== status.fingerprint) {
        return { kind: "device_rejected", reason: "host_changed" };
      }
      if (!hello.initialized) return { kind: "bootstrap" };
    } else if (
      localHost.kind === "missing" &&
      (localHost.reason === "host_too_old" || localHost.reason === "app_too_old")
    ) {
      // Any other missing reason (unreachable, not a Markiro host, an
      // invalid response) or still probing keeps today's flow: the line
      // stays offline-first and a stale probe never blocks the floor.
      return { kind: "host_missing", reason: localHost.reason };
    }
  }
  if (!state.office.visible) return { kind: "floor" };
  if (state.office.session) return { kind: "office", session: state.office.session };
  return { kind: "office_login", notice: state.office.notice };
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "device_loaded":
      return { ...state, device: { kind: "ready", status: action.status } };
    case "device_unreadable":
      return { ...state, device: { kind: "unreadable" } };
    case "host_probed":
      return { ...state, localHost: action.localHost };
    case "pairing_started":
      return { ...state, pairing: { kind: "pairing" } };
    case "paired":
      return {
        ...state,
        device: { kind: "ready", status: action.status },
        pairing: { kind: "idle" },
        rejection: null,
      };
    case "pairing_failed":
      return { ...state, pairing: { kind: "failed", code: action.code } };
    case "pairing_retried":
      return { ...state, pairing: { kind: "idle" } };
    case "forgotten":
      return {
        ...state,
        device: { kind: "ready", status: null },
        pairing: { kind: "idle" },
        rejection: null,
        office: CLOSED_OFFICE,
      };
    case "host_initialized":
      if (state.localHost.kind !== "found") return state;
      return {
        ...state,
        localHost: {
          kind: "found",
          observation: {
            ...state.localHost.observation,
            hello: { ...state.localHost.observation.hello, initialized: true },
          },
        },
      };
    case "office_requested":
      return { ...state, office: { ...state.office, visible: true, notice: null } };
    case "office_opened":
      return { ...state, office: { visible: true, session: action.session, notice: null } };
    case "office_left":
      return { ...state, office: { ...state.office, visible: false, notice: null } };
    case "logged_out":
      return { ...state, office: CLOSED_OFFICE };
    case "session_ended": {
      // A late failure from a session the user already left or replaced
      // (by signing out, or signing back in) must not disturb the current
      // one: only the session that actually ended may ask for a new sign-in.
      if (state.office.session?.token !== action.token) return state;
      return {
        ...state,
        office: {
          visible: state.office.visible,
          session: null,
          notice: state.office.visible ? "session_ended" : null,
        },
      };
    }
    case "device_rejected": {
      // A tokened rejection (from an in-flight `call`) only applies to the
      // session that issued it, so a late answer from a superseded session
      // cannot mark a fresh pairing rejected. An untokened rejection (from
      // sign-in or the wizard, where no session exists yet) always applies.
      if (action.token !== undefined && state.office.session?.token !== action.token) {
        return state;
      }
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE };
    }
  }
}

/**
 * The shell action a failed host call implies: an ended session asks for a
 * new sign-in, a rejected device key or a changed host certificate needs a
 * new pairing. Everything else is the screen's to explain.
 *
 * `token` identifies the session that issued the call (`null` for sign-in
 * and the wizard, which have no session yet); it is carried on the
 * resulting action so the reducer can ignore a stale answer from a session
 * that already ended or was replaced. A `credential=session` failure with
 * no token is not actionable (there is no session left to end) and yields
 * no action.
 */
export function shellActionFor(error: unknown, token: string | null): ShellAction | null {
  if (!(error instanceof HostError)) return null;
  if (error.kind === "transport") {
    if (error.code !== "certificate_mismatch") return null;
    return token === null
      ? { type: "device_rejected", reason: "host_changed" }
      : { type: "device_rejected", reason: "host_changed", token };
  }
  if (error.credential === "device") {
    return token === null
      ? { type: "device_rejected", reason: "key_rejected" }
      : { type: "device_rejected", reason: "key_rejected", token };
  }
  if (error.credential === "session") {
    return token === null ? null : { type: "session_ended", token };
  }
  return null;
}
