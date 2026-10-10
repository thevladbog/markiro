import type { FloorOperator } from "../floor/sign-in.js";
import { HostError } from "../host/client.js";
import { DeviceError, type DeviceErrorCode } from "../host/device.js";
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, HostStatus, OfficeSession, OfficeUser } from "../host/protocol.js";
import type { SyncResult } from "../local/reference-sync.js";

/** What the probe of the host on this computer found. */
export type LocalHostState =
  | { kind: "probing" }
  | { kind: "missing"; reason: HostProbeErrorCode }
  | { kind: "found"; observation: HelloObservation };

/** The pairing kept by the shell; `null` status means not paired. */
export type DeviceState =
  { kind: "loading" } | { kind: "unreadable" } | { kind: "ready"; status: DeviceStatus | null };

/** Pairing: with the host on this computer (idle, pairing, failed) or one in the network. */
export type PairingState =
  | { kind: "idle" }
  | { kind: "pairing" }
  | { kind: "failed"; code: DeviceErrorCode }
  | { kind: "network" };

/** Why the host no longer accepts this device. */
export type RejectionReason = "key_rejected" | "host_changed";

/** Why the office sign-in shows a note. */
export type OfficeLoginNotice = "session_ended" | "already_initialized";

/**
 * The office: closed (the floor shows), signing in, or open with a session
 * kept only in memory. There is no hidden session: leaving the office ends
 * it (owner decision 2026-09-26), so coming back always asks to sign in.
 */
export type OfficeState =
  | { kind: "closed" }
  | { kind: "signing_in"; notice: OfficeLoginNotice | null }
  | { kind: "open"; session: OfficeSession };

/**
 * Why a reference sync failed: the host could not be reached, or it refused
 * or failed the request (`HostError`, except an answer this build cannot
 * read); this computer could not write its copies (`LocalDbError`); or the
 * host's feed could not be applied (an answer this build cannot read, a
 * `SyncFeedError`, anything else).
 */
export type SyncFailure = "host" | "local" | "feed";

/**
 * Why the last send of the outbox failed: the host could not be reached
 * (`offline`); it answered with an error or with receipts that do not fit
 * (`host`: a 500, a 400 for a batch it cannot take, an answer this build
 * cannot read); or this computer could not keep its receipts (`local`).
 * Either way nothing was kept and the same batch goes again; the status bar
 * names a failure that is not the link's.
 */
export type FactsFailure = "offline" | "host" | "local";

/**
 * The reference sync (`src/local/reference-sync.ts`): what the latest run
 * is doing or how it ended; how many runs brought the local copies up to
 * date since the pairing, so a screen reading them knows when to read
 * again; why the last failed run failed, kept through the retry's own run
 * until one succeeds; and how many feed records the copies hold in
 * quarantine, as the last successful run counted them.
 */
export interface SyncState {
  kind: "idle" | "running" | "done" | "failed" | "other_host";
  synced: number;
  failure: SyncFailure | null;
  quarantined: number;
}

/**
 * Why the floor's sign-in screen says the last operator is no longer signed
 * in: nobody touched the station for the idle timeout (`idle`), the host
 * turned the operator off and the copies lost them (`removed`), or the office
 * moved the station to another line or cleared it (`line_changed`).
 */
export type FloorNotice = "idle" | "removed" | "line_changed";

/**
 * The operator signed in on the floor, and the number of this sign-in's
 * session (stage 2a spec, decision 26): every sign-in starts a session with a
 * new number, and the floor's timers and checks name the session they belong
 * to, so a late one of an earlier session of the same operator ends nothing.
 * A refresh of the name and role from the copies keeps the session.
 */
export interface FloorSession extends FloorOperator {
  sessionId: number;
}

/** The shift the operator of `sessionId` works in, from entering it until leaving it. */
export interface FloorWork {
  sessionId: number;
  shiftId: string;
}

export interface ShellState {
  device: DeviceState;
  localHost: LocalHostState;
  pairing: PairingState;
  rejection: RejectionReason | null;
  office: OfficeState;
  /** The link to the host as the shell reports it; `null` before the first status. */
  link: HostStatus | null;
  sync: SyncState;
  /** The latest revision the host announced; the office re-reads the signed-in user when it changes. */
  hostRevision: number | null;
  /**
   * The operator signed in on the floor (plan 1f), kept only in memory: a
   * restart, a new pairing, a rejected device, the office and a change of
   * the line all sign the operator out. Never an office user (spec §4.8).
   */
  operator: FloorSession | null;
  /** The number of the last session; the next sign-in's is one more. */
  lastSessionId: number;
  /** Why the last operator was signed out, until the next one signs in. */
  floorNotice: FloorNotice | null;
  /**
   * The shift the operator works in. While it is set, what would take the
   * floor away waits until the operator leaves the shift: a refused device
   * (`pendingRejection`, question В8) and another line (`pendingDevice`,
   * question В9).
   */
  floorWork: FloorWork | null;
  pendingRejection: RejectionReason | null;
  pendingDevice: DeviceStatus | null;
  /**
   * A sync found another host at the paired address while the operator works
   * in a shift. Like a refusal it waits for them to leave: the work screen
   * writes to the local database, and the screens that follow — this host is
   * not ours, forget the pairing — assume nothing is being written (the
   * shell's `device_forget`). The link is stopped meanwhile (`App`).
   */
  pendingOtherHost: boolean;
  /**
   * The answer of a probe of the host on this computer that landed while the
   * operator works in a shift; it takes the floor when they leave.
   */
  pendingProbe: LocalHostState | null;
  /**
   * The station's reads of its shifts (`GET /v1/device/shifts`): how many
   * landed in the copies since the pairing, so a screen reading them knows
   * when to read again, and whether the last one failed.
   */
  shiftReads: { done: number; failed: boolean };
  /** The office's change of this device could not be saved on this computer. */
  deviceNotSaved: boolean;
  /**
   * Grows with every change of the outbox: a record written by the floor, a
   * batch of receipts applied, a block of SSCC serials kept. The status bar
   * reads its counts again when it changes.
   */
  outboxVersion: number;
  /** Why the last send of the outbox failed, until a send goes through. */
  factsFailure: FactsFailure | null;
}

export type ShellView =
  | { kind: "loading" }
  | { kind: "config_error" }
  | { kind: "host_missing"; reason: HostProbeErrorCode }
  | { kind: "bootstrap" }
  | { kind: "pairing" }
  | { kind: "network_pairing" }
  | { kind: "pair_failed"; code: DeviceErrorCode }
  | { kind: "device_rejected"; reason: RejectionReason }
  | { kind: "other_host"; hostAddress: string }
  | { kind: "line_select" }
  /** The floor with nobody signed in: the operator sign-in and the way into the office. */
  | { kind: "floor" }
  /** The floor with an operator signed in: their shifts (`FloorApp`). */
  | { kind: "floor_operator"; operator: FloorSession }
  | { kind: "office_login"; notice: OfficeLoginNotice | null }
  | { kind: "office"; session: OfficeSession };

export type ShellAction =
  | { type: "device_loaded"; status: DeviceStatus | null }
  | { type: "device_unreadable" }
  | { type: "host_probed"; localHost: LocalHostState }
  | { type: "pairing_started" }
  | { type: "paired"; status: DeviceStatus }
  | { type: "pairing_failed"; code: DeviceErrorCode }
  | { type: "pairing_retried" }
  | { type: "network_pairing_requested" }
  | { type: "network_pairing_cancelled" }
  | { type: "forgotten" }
  | { type: "host_initialized" }
  // "session_ended" is set only by the reducer's own `session_ended` branch;
  // nothing outside the reducer may request that notice directly.
  | { type: "office_requested"; notice?: Exclude<OfficeLoginNotice, "session_ended"> }
  | { type: "office_opened"; session: OfficeSession }
  | { type: "office_closed" }
  | { type: "session_ended"; token: string }
  | { type: "device_rejected"; reason: RejectionReason; token?: string }
  | { type: "office_user_refreshed"; token: string; user: OfficeUser }
  | { type: "link_status"; status: HostStatus }
  | { type: "host_revision"; rev: number }
  | { type: "sync_started" }
  | { type: "sync_finished"; result: SyncResult }
  | { type: "sync_failed"; failure: SyncFailure; quarantined: number | null }
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus }
  // `deviceId` and `lineId`: the pairing and the line the sign-in began on, as
  // the screen that asked had them (not what the shell has by now);
  // `address`: the local host address the shell derives its screen with.
  | {
      type: "operator_signed_in";
      deviceId: string;
      lineId: string | null;
      address: string;
      operator: FloorOperator;
    }
  // `notice: null` is the operator's own «Сменить оператора».
  | { type: "operator_signed_out"; sessionId: number; notice: FloorNotice | null }
  // The name and role of the session's operator, as a sync brought them.
  | { type: "operator_refreshed"; sessionId: number; name: string; role: string | null }
  | { type: "work_entered"; sessionId: number; shiftId: string }
  | { type: "work_left"; sessionId: number }
  | { type: "shifts_read"; ok: boolean }
  // `device_refresh` could not keep the host's answer in `device.json`.
  | { type: "device_not_saved" }
  // The floor wrote a record, the link applied receipts, a block was kept.
  | { type: "outbox_changed" }
  // A send of the outbox went through, or failed and why.
  | { type: "facts_sent" }
  | { type: "facts_failed"; failure: FactsFailure };

const CLOSED_OFFICE: OfficeState = { kind: "closed" };
const IDLE_SYNC: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
const NO_SHIFT_READS = { done: 0, failed: false };

/** No operator, so no work and nothing waiting for it. */
const NO_FLOOR_SESSION = {
  operator: null,
  floorWork: null,
  pendingRejection: null,
  pendingDevice: null,
  pendingOtherHost: false,
  pendingProbe: null,
} as const;

export const initialShellState: ShellState = {
  device: { kind: "loading" },
  localHost: { kind: "probing" },
  pairing: { kind: "idle" },
  rejection: null,
  office: CLOSED_OFFICE,
  link: null,
  sync: IDLE_SYNC,
  hostRevision: null,
  operator: null,
  lastSessionId: 0,
  floorNotice: null,
  floorWork: null,
  pendingRejection: null,
  pendingDevice: null,
  pendingOtherHost: false,
  pendingProbe: null,
  shiftReads: NO_SHIFT_READS,
  deviceNotSaved: false,
  outboxVersion: 0,
  factsFailure: null,
};

/**
 * A link failure that no retry can cure: the host refuses this device's key,
 * or presents another certificate than the one pinned at pairing.
 */
function linkRejection(status: HostStatus): RejectionReason | null {
  if (status.lastError === "key_rejected") return "key_rejected";
  if (status.lastError === "certificate_mismatch") return "host_changed";
  return null;
}

/**
 * The screen for a snapshot (stage 1 spec §5.1), a pure function like the
 * station's `nextStationView`. An unpaired device pairs with the host on
 * this computer on its own, or with a host in the network by a code when
 * the user asks for it; a paired station without a line chooses one.
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
    if (state.pairing.kind === "network") return { kind: "network_pairing" };
    if (localHost.kind === "probing") return { kind: "loading" };
    if (localHost.kind === "missing") return { kind: "host_missing", reason: localHost.reason };
    if (!localHost.observation.hello.initialized) return { kind: "bootstrap" };
    if (state.pairing.kind === "failed") return { kind: "pair_failed", code: state.pairing.code };
    return { kind: "pairing" };
  }
  if (state.rejection) return { kind: "device_rejected", reason: state.rejection };
  if (state.sync.kind === "other_host") {
    return { kind: "other_host", hostAddress: status.hostAddress };
  }
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
  switch (state.office.kind) {
    case "closed":
      // A station works on one line and chooses it before the floor.
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
      if (state.operator !== null) return { kind: "floor_operator", operator: state.operator };
      return { kind: "floor" };
    case "signing_in":
      return { kind: "office_login", notice: state.office.notice };
    case "open":
      return { kind: "office", session: state.office.session };
  }
}

/** The station moves to the line of `status`: an operator signed in for one line is not for another. */
function changeLine(state: ShellState, status: DeviceStatus): ShellState {
  return {
    ...state,
    device: { kind: "ready", status },
    ...NO_FLOOR_SESSION,
    floorNotice: state.operator === null ? state.floorNotice : "line_changed",
  };
}

/**
 * The operator left the shift: what waited for that happens now, a refused
 * device first (it ends everything), then another host (the same), then the
 * answer of a probe, then another line.
 */
function endWork(state: ShellState): ShellState {
  const left = {
    ...state,
    floorWork: null,
    pendingRejection: null,
    pendingDevice: null,
    pendingOtherHost: false,
    pendingProbe: null,
    localHost: state.pendingProbe ?? state.localHost,
    // What the held sync found is a fact whichever screen comes first.
    sync: state.pendingOtherHost ? { ...state.sync, kind: "other_host" as const } : state.sync,
  };
  if (state.pendingRejection !== null) {
    return { ...left, rejection: state.pendingRejection, office: CLOSED_OFFICE, operator: null };
  }
  if (state.pendingOtherHost) return { ...left, office: CLOSED_OFFICE, ...NO_FLOOR_SESSION };
  if (state.pendingDevice !== null) return changeLine(left, state.pendingDevice);
  // A probe's answer ends the session as it would have at once.
  if (state.pendingProbe !== null) return { ...left, ...NO_FLOOR_SESSION };
  return left;
}

/**
 * A refusal of this device: at once, or, while the operator works in a shift,
 * once they leave it (question В8): the line finishes its box, and nothing
 * reaches the host meanwhile.
 */
function reject(state: ShellState, reason: RejectionReason): ShellState {
  if (state.floorWork !== null) return { ...state, pendingRejection: reason };
  return { ...state, rejection: reason, office: CLOSED_OFFICE, ...NO_FLOOR_SESSION };
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "device_loaded":
      return { ...state, device: { kind: "ready", status: action.status } };
    case "device_unreadable":
      return { ...state, device: { kind: "unreadable" } };
    case "host_probed":
      // A probe runs only at start-up, on a retry and after a forget: a
      // session must not outlive a screen that is not the floor, nor come back
      // after it (a blocked version screen, another host). Losing the link
      // is not a probe, and keeps the operator. The start-up probe has a
      // timeout of seconds, so its answer can land after the operator
      // entered a shift: it waits for them to leave it (the last answer
      // counts), as the work screen's writes must not be cut off by a screen
      // that offers to forget the pairing.
      if (state.floorWork !== null) return { ...state, pendingProbe: action.localHost };
      return { ...state, localHost: action.localHost, ...NO_FLOOR_SESSION };
    case "pairing_started":
      return { ...state, pairing: { kind: "pairing" } };
    case "paired":
      // Between `dispatch({ type: "forgotten" })` and the effect's cleanup
      // (which only runs after React re-renders), a run still in flight for
      // the old host can land a late `sync_finished`/`sync_failed`; reset
      // the same fields `forgotten` resets, so this new pairing never starts
      // already `{ kind: "done" }` (or worse, `hostRevision` set) from a sync
      // it never ran against the old host. `paired` is dispatched only from
      // an unpaired device: `pairLocally` (on its own when pairing is due, or
      // from `bootstrap`) and network pairing's `claim` are the only
      // dispatchers, so the reset is always correct here.
      return {
        ...state,
        device: { kind: "ready", status: action.status },
        pairing: { kind: "idle" },
        rejection: null,
        link: null,
        sync: IDLE_SYNC,
        hostRevision: null,
        ...NO_FLOOR_SESSION,
        floorNotice: null,
        shiftReads: NO_SHIFT_READS,
        deviceNotSaved: false,
        factsFailure: null,
      };
    case "pairing_failed":
      return { ...state, pairing: { kind: "failed", code: action.code } };
    case "pairing_retried":
      return { ...state, pairing: { kind: "idle" } };
    case "network_pairing_requested":
      return { ...state, pairing: { kind: "network" } };
    case "network_pairing_cancelled":
      return { ...state, pairing: { kind: "idle" } };
    case "forgotten":
      return {
        ...state,
        device: { kind: "ready", status: null },
        pairing: { kind: "idle" },
        rejection: null,
        office: CLOSED_OFFICE,
        link: null,
        sync: IDLE_SYNC,
        hostRevision: null,
        ...NO_FLOOR_SESSION,
        floorNotice: null,
        shiftReads: NO_SHIFT_READS,
        deviceNotSaved: false,
        factsFailure: null,
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
      // The office and an operator never share the screen: the operator
      // is signed out, and the office signs in with its own credentials.
      return {
        ...state,
        office: { kind: "signing_in", notice: action.notice ?? null },
        ...NO_FLOOR_SESSION,
        floorNotice: null,
      };
    case "office_opened":
      // The bootstrap wizard opens the office without `office_requested`, so
      // the action itself ends the operator's session (D4).
      return {
        ...state,
        office: { kind: "open", session: action.session },
        ...NO_FLOOR_SESSION,
        floorNotice: null,
      };
    case "office_closed":
      return { ...state, office: CLOSED_OFFICE };
    case "session_ended": {
      // A late failure from a session the user already left or replaced
      // (by leaving the office, or signing back in) must not disturb the
      // current one: only the session that actually ended asks to sign in.
      if (state.office.kind !== "open" || state.office.session.token !== action.token) {
        return state;
      }
      return { ...state, office: { kind: "signing_in", notice: "session_ended" } };
    }
    case "device_rejected": {
      // A tokened rejection (from an in-flight `call`) only applies to the
      // session that issued it, so a late answer from a superseded session
      // cannot mark a fresh pairing rejected. An untokened rejection (from
      // sign-in or the wizard, where no session exists yet) always applies.
      if (
        action.token !== undefined &&
        (state.office.kind !== "open" || state.office.session.token !== action.token)
      ) {
        return state;
      }
      return reject(state, action.reason);
    }
    case "office_user_refreshed":
      // Only the session the answer belongs to takes the new name and role.
      if (state.office.kind !== "open" || state.office.session.token !== action.token) {
        return state;
      }
      return {
        ...state,
        office: { kind: "open", session: { ...state.office.session, user: action.user } },
      };
    case "link_status": {
      const rejection = linkRejection(action.status);
      if (rejection === null) return { ...state, link: action.status };
      return reject({ ...state, link: action.status }, rejection);
    }
    case "host_revision":
      return { ...state, hostRevision: action.rev };
    case "sync_started":
      // Absorbing: `other_host` (also the one that waits for the operator to
      // leave the shift) only a new pairing clears (`paired`, `forgotten`).
      // Second line of defence — `useHostLink` also stops the scheduler as
      // soon as a run finds `other_host` or a rejection, but a run already
      // queued by a revision can still land here first. A retry keeps the
      // last failure, so the warning does not flicker.
      if (state.sync.kind === "other_host" || state.pendingOtherHost) return state;
      return { ...state, sync: { ...state.sync, kind: "running" } };
    case "sync_finished":
      if (state.sync.kind === "other_host" || state.pendingOtherHost) return state;
      if (action.result.kind === "other_host") {
        // The operator in a shift keeps working until they leave it: the
        // screens that follow assume no write is in flight.
        if (state.floorWork !== null) return { ...state, pendingOtherHost: true };
        // Office requests would reach a host this device was never paired with.
        return {
          ...state,
          sync: { ...state.sync, kind: "other_host" },
          office: CLOSED_OFFICE,
          ...NO_FLOOR_SESSION,
        };
      }
      return {
        ...state,
        sync: {
          kind: "done",
          synced: state.sync.synced + 1,
          failure: null,
          quarantined: action.result.quarantined,
        },
      };
    case "sync_failed":
      if (state.sync.kind === "other_host" || state.pendingOtherHost) return state;
      return {
        ...state,
        sync: {
          ...state.sync,
          kind: "failed",
          failure: action.failure,
          // `null` means the run never read a count of its own (say, a
          // rejection): keep whatever the last successful run reported
          // rather than resetting it to zero.
          quarantined: action.quarantined ?? state.sync.quarantined,
        },
      };
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status }, ...NO_FLOOR_SESSION };
    case "device_refreshed": {
      // The line and the name the office assigned (plans 1d3, 2a4). Only the
      // pairing the answer belongs to takes it, so a late answer cannot bring
      // back a pairing that ended or changed. A cleared line sends the
      // station back to choosing one.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const current = state.device.status;
      if (current.deviceId !== action.status.deviceId || current.hostId !== action.status.hostId) {
        return state;
      }
      if (current.lineId === action.status.lineId) {
        // The same line: a new name at most, and an earlier move that waits
        // for the work is undone by this one.
        if (
          current.deviceName === action.status.deviceName &&
          state.pendingDevice === null &&
          !state.deviceNotSaved
        ) {
          return state;
        }
        return {
          ...state,
          device: { kind: "ready", status: action.status },
          pendingDevice: null,
          deviceNotSaved: false,
        };
      }
      const saved = { ...state, deviceNotSaved: false };
      // Another line waits until the operator leaves the shift (question В9).
      if (state.floorWork !== null) return { ...saved, pendingDevice: action.status };
      return changeLine(saved, action.status);
    }
    case "operator_signed_in": {
      // Only onto the floor the sign-in started from: a late answer must not
      // sign anybody in after the pairing changed or ended, the device was
      // rejected, the office opened or the station lost its line meanwhile.
      // The reducer sees the actions queued before this one, which the screen
      // (whose line and `key` change only when React commits) does not.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const status = state.device.status;
      if (status.lineId !== action.lineId) return state;
      // Only a floor screen (the bootstrap wizard, a version screen, the line
      // choice, the office or a rejection are not one) ...
      const view = nextShellView(state, action.address);
      if (view.kind !== "floor" && view.kind !== "floor_operator") return state;
      // ... and never onto a running session: it ends by its own sign-out.
      if (state.operator !== null) return state;
      if (
        status.deviceId !== action.deviceId ||
        state.rejection !== null ||
        state.sync.kind === "other_host" ||
        state.office.kind !== "closed" ||
        (status.kind === "station" && status.lineId === null)
      ) {
        return state;
      }
      // The four fields, copied: a hash that slipped into the action's object
      // never reaches the state; and a new session number.
      const { id, login, name, role } = action.operator;
      const sessionId = state.lastSessionId + 1;
      return {
        ...state,
        operator: { sessionId, id, login, name, role },
        lastSessionId: sessionId,
        floorNotice: null,
      };
    }
    case "operator_signed_out": {
      // A late sign-out (an idle timer, a check of the copies) of a session
      // that already ended must not sign out the next one, even of the same
      // operator.
      if (state.operator?.sessionId !== action.sessionId) return state;
      // A sign-out in the middle of the work ends the work first: what waited
      // for it (a refused device, another line) takes the floor.
      const left = state.floorWork === null ? state : endWork(state);
      if (left.operator === null) return left;
      return { ...left, ...NO_FLOOR_SESSION, floorNotice: action.notice };
    }
    case "operator_refreshed": {
      const operator = state.operator;
      if (operator?.sessionId !== action.sessionId) return state;
      if (operator.name === action.name && operator.role === action.role) return state;
      return { ...state, operator: { ...operator, name: action.name, role: action.role } };
    }
    case "work_entered":
      if (state.operator?.sessionId !== action.sessionId || state.floorWork !== null) return state;
      return {
        ...state,
        floorWork: { sessionId: action.sessionId, shiftId: action.shiftId },
      };
    case "work_left":
      if (state.floorWork?.sessionId !== action.sessionId) return state;
      return endWork(state);
    case "shifts_read":
      return {
        ...state,
        shiftReads: action.ok
          ? { done: state.shiftReads.done + 1, failed: false }
          : { done: state.shiftReads.done, failed: true },
      };
    case "device_not_saved":
      return state.deviceNotSaved ? state : { ...state, deviceNotSaved: true };
    case "outbox_changed":
      return { ...state, outboxVersion: state.outboxVersion + 1 };
    case "facts_sent":
      return state.factsFailure === null ? state : { ...state, factsFailure: null };
    case "facts_failed":
      return state.factsFailure === action.failure
        ? state
        : { ...state, factsFailure: action.failure };
  }
}

/**
 * Why a failed device command needs a new pairing: the host refused this
 * device's key, or presented another certificate than the one pinned at
 * pairing. `null` for anything else, which the caller explains or ignores.
 */
export function deviceRejection(error: unknown): RejectionReason | null {
  if (!(error instanceof DeviceError)) return null;
  if (error.code === "key_rejected") return "key_rejected";
  if (error.code === "certificate_mismatch") return "host_changed";
  return null;
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
