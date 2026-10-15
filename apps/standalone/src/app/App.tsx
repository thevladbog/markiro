import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { FloorApp } from "../floor/FloorApp.js";
import { FloorStatusBar, type FloorBarTools } from "../floor/FloorStatusBar.js";
import { createGatedScanSource } from "../floor/gated-scan-source.js";
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
  type ScanSource,
} from "../floor/scan-source.js";
import { createPrintRuntime } from "../floor/print/print-runtime.js";
import { UnpairContext, type UnpairApi } from "../floor/setup/unpair-context.js";
import { applySavedScanners } from "../floor/setup/workstation-settings.js";
import { WorkstationSetup } from "../floor/setup/WorkstationSetup.js";
import type { FloorOperator } from "../floor/sign-in.js";
import { createSystemAwake } from "../hardware/awake.js";
import {
  createTauriHardware,
  createTauriWindowsPrinting,
  type HardwareApi,
  type WindowsPrinting,
} from "../hardware/hardware.js";

import { createHostApi, type HostApi } from "../host/api.js";
import { createTauriHostClient, HostError } from "../host/client.js";
import { createTauriConnectionApi, type ConnectionApi } from "../host/connection.js";
import {
  createTauriDeviceApi,
  DeviceError,
  type ClaimInput,
  type DeviceApi,
  type DeviceErrorCode,
  type InstallRole,
} from "../host/device.js";
import { createTauriHostProbe, HostProbeError, type HostProbe } from "../host/probe.js";
import {
  LOCAL_HOST_ADDRESS,
  type BootstrapRequest,
  type DeviceStatus,
  type OfficeLoginRequest,
} from "../host/protocol.js";
import { createTauriLocalExecutor, type LocalExecutor } from "../local/executor.js";
import { countUnsentRecords } from "../local/outbox.js";
import { restoreDue } from "../local/restore-reconcile.js";
import { purgeWarehouseSessions } from "../floor/warehouse/warehouse-store.js";
import { purgeAcknowledged, scheduleRetention } from "../local/retention.js";
import { Office } from "../office/Office.js";
import { OfficeLogin } from "../office/OfficeLogin.js";
import type { OfficeSessionValue } from "../office/office-session.js";
import type { WindowMode } from "../office/window-mode.js";
import { BootstrapWizard } from "../wizard/BootstrapWizard.js";
import { useHostLink } from "./host-link.js";
import { LineSelect } from "./LineSelect.js";
import { createTauriKioskPolicy, type KioskPolicyApi } from "./kiosk-policy.js";
import {
  createLockdownLifecycle,
  kioskDue,
  rolePermitsKiosk,
  type LockdownLifecycle,
} from "./lockdown.js";
import { NetworkPairing } from "./NetworkPairing.js";
import {
  ConfigErrorScreen,
  DeviceRejectedScreen,
  HostMissingScreen,
  OtherHostScreen,
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
import {
  deviceRejection,
  initialShellState,
  nextShellView,
  type ShellView,
  shellActionFor,
  shellReducer,
  type FloorNotice,
} from "./shell.js";

/**
 * The shortest wait between two syncs the floor's sign-in asks for. Each
 * unknown badge or wrong PIN asks for one (a record the office has just
 * added may be on its way); a burst of stray scans must not hammer the host
 * with a sync each, so asks inside the wait become one more sync at its end.
 */
export const SIGN_IN_SYNC_GAP_MS = 2_000;

interface RequestGate {
  request: () => void;
  cancel: () => void;
}

/**
 * Runs `run` at once on the first request, then at most once per `gapMs`:
 * requests that come while it waits are folded into a single run when the
 * wait ends, so the last request is never lost.
 */
function createRequestGate(run: () => void, gapMs: number): RequestGate {
  let cooling = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    run();
    cooling = true;
    timer = setTimeout(() => {
      timer = null;
      cooling = false;
      if (pending) {
        pending = false;
        fire();
      }
    }, gapMs);
  };
  return {
    request() {
      if (cooling) {
        pending = true;
        return;
      }
      fire();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      cooling = false;
      pending = false;
    },
  };
}

export interface AppProps {
  probe?: HostProbe;
  device?: DeviceApi;
  host?: HostApi;
  connection?: ConnectionApi;
  local?: LocalExecutor;
  address?: string;
  /**
   * Where the floor's scans come from; by default the keyboard wedge on this
   * window and the shell's COM scanners, both at once.
   */
  scanSource?: ScanSource;
  /** The shell's printers, COM scanners and power request; tests give their own. */
  hardware?: HardwareApi;
  /** The shell's printing through Windows drivers (plan ДРВ); tests give their own. */
  windowsPrinting?: WindowsPrinting;
  /** How long a signed-in operator may leave the station untouched; tests shorten it. */
  idleTimeoutMs?: number;
  /** The shortest wait between two syncs the sign-in asks for; tests lengthen it. */
  signInSyncGapMs?: number;
  /** Kiosk mode of the window: the shell's commands outside development by default. */
  lockdown?: LockdownLifecycle;
  /** What the shell permits of kiosk mode on this PC; the shell's by default. */
  kioskPolicy?: KioskPolicyApi;
  /**
   * Where the pairing screen hears a scanner that is not a keyboard: the
   * shell's COM scanners by default. A keyboard-wedge scanner types into the
   * screen's own field, so the keyboard is not a source here.
   */
  pairingScanSource?: ScanSource;
}

export function App({
  probe,
  device,
  host,
  connection,
  local,
  address = LOCAL_HOST_ADDRESS,
  scanSource,
  hardware,
  windowsPrinting,
  idleTimeoutMs,
  signInSyncGapMs = SIGN_IN_SYNC_GAP_MS,
  lockdown,
  kioskPolicy,
  pairingScanSource,
}: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const deviceApi = useMemo(() => device ?? createTauriDeviceApi(), [device]);
  const hostApi = useMemo(() => host ?? createHostApi(createTauriHostClient()), [host]);
  const connectionApi = useMemo(() => connection ?? createTauriConnectionApi(), [connection]);
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
  const hardwareApi = useMemo(() => hardware ?? createTauriHardware(), [hardware]);
  const scanner = useMemo(
    () =>
      scanSource ??
      mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardwareApi.onScan)),
    [scanSource, hardwareApi],
  );
  // What the floor's screens hear: the same scans, muted while a dialog asks
  // for a badge of its own (the identity re-confirmation, beta 3).
  const floorGate = useMemo(() => createGatedScanSource(scanner), [scanner]);
  // The COM scanners the workstation's settings name, once the app starts;
  // the setup gives the shell a changed set itself.
  useEffect(() => {
    void applySavedScanners(localDb, hardwareApi.configureScanners);
  }, [localDb, hardwareApi]);
  // One queue of sends per printer for the whole app, and the request that
  // keeps the computer awake, let go at the start: a webview that reloaded
  // during a shift leaves the shell's request held.
  const windowsApi = useMemo(
    () => windowsPrinting ?? createTauriWindowsPrinting(),
    [windowsPrinting],
  );
  const printing = useMemo(
    () => createPrintRuntime(hardwareApi.printBytes, { windows: windowsApi }),
    [hardwareApi, windowsApi],
  );
  const awake = useMemo(() => createSystemAwake(hardwareApi.setSystemAwake), [hardwareApi]);
  useEffect(() => {
    void awake.reset();
  }, [awake]);
  const kiosk = useMemo(
    () => lockdown ?? createLockdownLifecycle({ dev: import.meta.env.DEV }),
    [lockdown],
  );
  const kioskSnapshot = useSyncExternalStore(kiosk.subscribe, kiosk.getSnapshot);
  const kioskShell = useMemo(() => kioskPolicy ?? createTauriKioskPolicy(), [kioskPolicy]);
  // What the shell permits of kiosk mode (the role, `"kiosk": false`, a
  // `--windowed` launch); `null` until it answers. A second launch with
  // `--windowed` turns it off for the running app.
  const [shellPermitted, setShellPermitted] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    void kioskShell.permitted().then((permitted) => {
      if (!cancelled) setShellPermitted((now) => (now === false ? false : permitted));
    });
    void kioskShell
      .onTurnedOff(() => {
        if (!cancelled) setShellPermitted(false);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [kioskShell]);
  const comScans = useMemo(
    () => pairingScanSource ?? createComScanSource(hardwareApi.onScan),
    [pairingScanSource, hardwareApi],
  );
  // The scanner settings opened from the pairing screen (owner feedback, first
  // Windows test): the same settings as the floor's «Рабочее место», scanners only.
  const [scannerSetup, setScannerSetup] = useState(false);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
  // The installer's role, `"unknown"` until the shell answers (plan УСТ). It
  // comes from the shell alone: nothing the page can write sets it.
  const [role, setRole] = useState<InstallRole | "unknown">("unknown");
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
  // A forget the shell refused for records not yet sent, how many there are,
  // and the screen it was asked on: the count is not another screen's.
  const [unsent, setUnsent] = useState<{
    records: number | null;
    view: ShellView["kind"];
  } | null>(null);
  // A forget held back because the pairing still owes a restored host its
  // SSCC blocks (plan РК-С), and the screen it was asked on.
  const [owed, setOwed] = useState<ShellView["kind"] | null>(null);
  // An office PC has no floor: whatever pairing its disk holds, the station's
  // screens are not shown there, and the office sign-in is the home (plan УСТ).
  const shellView = nextShellView(state, address);
  const view: ShellView =
    role === "office" &&
    (shellView.kind === "floor" ||
      shellView.kind === "floor_operator" ||
      shellView.kind === "line_select")
      ? { kind: "office_login", notice: null }
      : shellView;
  const unsentHere = unsent !== null && unsent.view === view.kind ? unsent : null;
  const owedHere = owed !== null && owed === view.kind;
  const localName = t("device.localName");
  const pairedStatus = state.device.kind === "ready" ? state.device.status : null;
  // The pairing's host when it is not the one on this computer.
  const remoteAddress =
    pairedStatus !== null && pairedStatus.hostAddress !== address ? pairedStatus.hostAddress : null;

  // A refusal that waits for the operator to leave the shift (question В8), and
  // another host that waits the same way, already stop the link: nothing more
  // reaches a host that refused us or is not ours.
  const linked =
    pairedStatus !== null &&
    state.rejection === null &&
    state.pendingRejection === null &&
    !state.pendingOtherHost &&
    state.sync.kind !== "other_host"
      ? pairedStatus
      : null;
  // The records of the shifts the host took 30 days ago go, at the start and
  // every hour (decision 31); a failed pass is tried again at the next.
  const keptHostId = pairedStatus?.hostId ?? null;
  const keptDeviceId = pairedStatus?.deviceId ?? null;
  useEffect(() => {
    if (keptHostId === null || keptDeviceId === null) return;
    const pairing = { hostId: keptHostId, deviceId: keptDeviceId };
    return scheduleRetention(async () => {
      // The warehouse sessions done with (plan СКЛ) go in the same hourly pass.
      // Neither purge waits for the other: one that fails does not hold the
      // other's pass back, and the pass fails (to be tried again) all the same.
      let purged = 0;
      let failure: unknown = null;
      try {
        purged += await purgeAcknowledged(localDb, pairing, new Date());
      } catch (error) {
        failure = error;
      }
      try {
        purged += await purgeWarehouseSessions(localDb, pairing, new Date());
      } catch (error) {
        failure ??= error;
      }
      if (purged > 0) dispatch({ type: "outbox_changed" });
      if (failure !== null) {
        throw failure instanceof Error ? failure : new Error("retention pass failed");
      }
    });
  }, [localDb, keptHostId, keptDeviceId]);

  const { requestSync, requestFacts } = useHostLink({
    hostId: linked?.hostId ?? null,
    deviceId: linked?.deviceId ?? null,
    connection: connectionApi,
    local: localDb,
    changes: hostApi.getChanges,
    refresh: deviceApi.refresh,
    deviceShifts: hostApi.getDeviceShifts,
    sendFacts: hostApi.sendFacts,
    registerKnownBlocks: hostApi.registerKnownBlocks,
    sendWarehouseRecords: hostApi.sendWarehouseRecords,
    conflictStatus: hostApi.conflictStatus,
    listDisplacements: hostApi.listDisplacements,
    deviceProductPhoto: hostApi.getDeviceProductPhoto,
    dispatch,
  });

  useEffect(() => {
    let cancelled = false;
    deviceApi.status().then(
      (status) => {
        if (!cancelled) dispatch({ type: "device_loaded", status });
      },
      () => {
        if (!cancelled) dispatch({ type: "device_unreadable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceApi]);

  useEffect(() => {
    let cancelled = false;
    deviceApi.installRole().then(
      (installed) => {
        if (!cancelled) setRole(installed);
      },
      // An answer the shell could not give: work as a station, kiosk mode included.
      () => {
        if (!cancelled) setRole(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceApi]);

  useEffect(() => {
    let cancelled = false;
    hostProbe.hello(address).then(
      (observation) => {
        if (!cancelled)
          dispatch({ type: "host_probed", localHost: { kind: "found", observation } });
      },
      (error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "host_probed",
            localHost: {
              kind: "missing",
              reason: error instanceof HostProbeError ? error.code : "unreachable",
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostProbe, address, probeAttempt]);

  /** Pair with the host on this computer; a pairing another call already made is adopted. */
  const pairLocally = useCallback(async (): Promise<DeviceStatus> => {
    try {
      return await deviceApi.pairLocally(localName);
    } catch (error) {
      if (error instanceof DeviceError && error.code === "already_paired") {
        const status = await deviceApi.status();
        if (status) return status;
      }
      throw error;
    }
  }, [deviceApi, localName]);

  const pairingDue = view.kind === "pairing" && state.pairing.kind === "idle";
  useEffect(() => {
    if (!pairingDue) return;
    dispatch({ type: "pairing_started" });
    pairLocally().then(
      (status) => dispatch({ type: "paired", status }),
      (error: unknown) =>
        dispatch({
          type: "pairing_failed",
          code: error instanceof DeviceError ? error.code : "unreachable",
        }),
    );
  }, [pairingDue, pairLocally]);

  const claim = useCallback(
    async (input: ClaimInput) => {
      dispatch({ type: "paired", status: await deviceApi.claim(input) });
    },
    [deviceApi],
  );

  const selectLine = useCallback(
    async (lineId: string) => {
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        const reason = deviceRejection(error);
        if (reason !== null) {
          dispatch({ type: "device_rejected", reason });
          return;
        }
        throw error;
      }
    },
    [deviceApi],
  );

  const changeAddress = useCallback(
    async (newAddress: string) => {
      try {
        dispatch({ type: "address_changed", status: await deviceApi.changeAddress(newAddress) });
      } catch (error) {
        // The key no longer works there: the device is refused, as anywhere.
        const reason = deviceRejection(error);
        if (reason !== null) {
          dispatch({ type: "device_rejected", reason });
          return;
        }
        throw error;
      }
    },
    [deviceApi],
  );

  const retryProbe = useCallback(() => {
    dispatch({ type: "host_probed", localHost: { kind: "probing" } });
    setProbeAttempt((attempt) => attempt + 1);
  }, []);

  const forgetHostId = pairedStatus?.hostId ?? null;
  const forgetDeviceId = pairedStatus?.deviceId ?? null;
  const forget = useCallback(
    (keepUnsent: boolean, blocksAnswered: boolean) => {
      const screenKind = view.kind;
      const pairing =
        forgetHostId === null || forgetDeviceId === null
          ? null
          : { hostId: forgetHostId, deviceId: forgetDeviceId };
      setRepairState("busy");
      // A pairing that still owes a restored host its blocks never returns
      // them once forgotten (plan РК-С): a person decides first. The question
      // of the records not yet sent comes after that one, and a failed read
      // does not trap the device here.
      const owes =
        blocksAnswered || pairing === null
          ? Promise.resolve(false)
          : restoreDue(localDb, pairing).catch(() => false);
      void owes.then((due) => {
        if (due) {
          setOwed(screenKind);
          setRepairState("idle");
          return;
        }
        setOwed(null);
        deviceApi.forget(keepUnsent ? { keepUnsent: true } : undefined).then(
          () => {
            setRepairState("idle");
            setUnsent(null);
            dispatch({ type: "forgotten" });
            retryProbe();
          },
          (error: unknown) => {
            if (error instanceof DeviceError && error.code === "unsent_facts") {
              // A rejected device can send nothing more, so a person decides,
              // knowing how many (question В7): the records stay on this PC. The
              // pairing's own, or every pairing's when the file is unreadable,
              // as the shell counts them.
              void countUnsentRecords(localDb, pairing).then((records) => {
                setUnsent({ records, view: screenKind });
                setRepairState("idle");
              });
              return;
            }
            // The config could not be removed; this screen stays and offers the
            // same action again, now explaining why it did not work.
            setRepairState(error instanceof DeviceError ? error.code : "unreachable");
          },
        );
      });
    },
    [deviceApi, retryProbe, localDb, forgetHostId, forgetDeviceId, view.kind],
  );
  const repair = useCallback(() => forget(false, false), [forget]);
  const confirmRepair = useCallback(() => forget(true, true), [forget]);
  const confirmOwed = useCallback(() => forget(false, true), [forget]);

  const unpaired = state.device.kind === "ready" && state.device.status === null;
  const bootstrap = useCallback(
    async (request: BootstrapRequest) => {
      if (unpaired) dispatch({ type: "paired", status: await pairLocally() });
      try {
        const response = await hostApi.bootstrap(request);
        dispatch({ type: "host_initialized" });
        dispatch({ type: "office_opened", session: response.session });
      } catch (error) {
        if (error instanceof HostError && error.code === "already_initialized") {
          dispatch({ type: "host_initialized" });
          dispatch({ type: "office_requested", notice: "already_initialized" });
          return;
        }
        // No session exists yet during the wizard, so any rejection applies
        // unconditionally (`shellActionFor(error, null)`).
        const action = shellActionFor(error, null);
        if (action?.type === "device_rejected") {
          dispatch(action);
          return;
        }
        throw error;
      }
    },
    [unpaired, pairLocally, hostApi],
  );

  const login = useCallback(
    async (request: OfficeLoginRequest) => {
      try {
        dispatch({ type: "office_opened", session: await hostApi.officeLogin(request) });
      } catch (error) {
        // No session exists yet during sign-in either.
        const action = shellActionFor(error, null);
        if (action?.type === "device_rejected") {
          dispatch(action);
          return;
        }
        throw error;
      }
    },
    [hostApi],
  );

  // The sign-in's asks for a sync are spaced out, whichever screen asks.
  const signInSync = useMemo(
    () => createRequestGate(requestSync, signInSyncGapMs),
    [requestSync, signInSyncGapMs],
  );
  useEffect(() => () => signInSync.cancel(), [signInSync]);

  const pairedDeviceId = pairedStatus?.deviceId ?? null;
  const operatorSignedIn = useCallback(
    (operator: FloorOperator, lineId: string | null) => {
      if (pairedDeviceId !== null) {
        // The reducer gives the sign-in a new session number.
        dispatch({
          type: "operator_signed_in",
          deviceId: pairedDeviceId,
          lineId,
          address,
          operator,
        });
      }
    },
    [pairedDeviceId, address],
  );
  // Bound to ONE session by its number: a late idle timer or copy check of an
  // earlier session of the same operator ends nothing (the reducer compares
  // the number). The callback changes only with the session, so the screen's
  // idle timer is not restarted by every event of the link or a new name.
  const sessionId = state.operator?.sessionId ?? null;
  const operatorSignedOut = useCallback(
    (notice: FloorNotice | null) => {
      if (sessionId !== null) dispatch({ type: "operator_signed_out", sessionId, notice });
    },
    [sessionId],
  );
  // «Сменить оператора» stands in the status bar (as on the cloud station), but
  // the leave — waiting for the work a shift's screen tracks — is the floor's:
  // the floor hands its leave here while it is on screen.
  const floorSignOut = useRef<(() => void) | null>(null);
  const floorSignOutReady = useCallback((signOut: (() => void) | null) => {
    floorSignOut.current = signOut;
  }, []);
  const switchOperator = useCallback(() => floorSignOut.current?.(), []);

  const session = view.kind === "office" ? view.session : null;
  // The scanner settings belong to the pairing screen: leaving it closes them.
  if (scannerSetup && view.kind !== "network_pairing") setScannerSetup(false);

  // An office PC (the installer's role «только офис») has no floor and is
  // never locked (plan УСТ, owner question П11). The role is the shell's; a
  // device paired as an office one counts only where the shell gave no role,
  // so a station or host PC with a stale office pairing stays locked.
  const officePc =
    role === "office" || (role !== "host" && role !== "station" && pairedStatus?.kind === "office");
  const officeAdmin = session?.user.role === "admin";
  // A station is configured once it is paired as a station with a line (owner
  // decision 2026-10-13): pairing alone leaves the line to choose, which a
  // person does at this window or in the office, and a line is only ever
  // stored from the host's answer. Until then the window is an ordinary one,
  // with a frame and a close button. Once configured, a line the office
  // clears later keeps the window locked for this pairing: the floor cannot
  // leave kiosk mode by having its line taken away. A new pairing (another
  // device id) starts unconfigured again.
  const pairedStationId = pairedStatus?.kind === "station" ? pairedStatus.deviceId : null;
  const [configuredDevice, setConfiguredDevice] = useState<string | null>(null);
  if (
    pairedStationId !== null &&
    pairedStatus?.lineId != null &&
    configuredDevice !== pairedStationId
  ) {
    setConfiguredDevice(pairedStationId);
  }
  const configured =
    pairedStationId !== null &&
    (pairedStatus?.lineId != null || configuredDevice === pairedStationId);
  // The window mode (owner decision 2026-10-13, `kioskDue`): a host PC and an
  // office PC never lock; a station locks once configured, at once and at every
  // later start, except while an administrator's office session is open (the
  // office is a mouse-and-keyboard app; a technologist's session stays
  // locked); the shell may forbid kiosk mode on this PC (`"kiosk": false` in
  // `installation.json`, a `--windowed` launch). Decided once the role, the
  // shell's answer and the device are known; until then nothing is sent.
  const decided = role !== "unknown" && shellPermitted !== null && state.device.kind === "ready";
  const due =
    decided &&
    !officePc &&
    kioskDue({
      permitted: shellPermitted && rolePermitsKiosk(role),
      configured,
      office: session === null ? "none" : officeAdmin ? "administrator" : "other",
    });
  useEffect(() => {
    if (!decided) return;
    // `exit` sends nothing for a window that was never locked.
    void (due ? kiosk.enter() : kiosk.exit());
  }, [kiosk, decided, due]);
  const leaveKiosk = useCallback(async (): Promise<boolean> => {
    await kiosk.exit();
    const { mode, error } = kiosk.getSnapshot();
    if (error !== null) kiosk.clearError();
    return mode === "windowed";
  }, [kiosk]);
  const windowMode = useMemo<WindowMode | null>(
    () => (kiosk.enabled && officeAdmin ? { mode: kioskSnapshot.mode, leave: leaveKiosk } : null),
    [kiosk.enabled, officeAdmin, kioskSnapshot.mode, leaveKiosk],
  );
  // The floor's own way to change the window (beta 3): only where the table
  // locks this PC (`due`), so a host, an office PC and an unconfigured station
  // never show it. Leaving needs a fresh proof of identity (`Reconfirm`, in the
  // control); the way back needs none.
  const floorWindowMode = useMemo<FloorBarTools["windowMode"]>(
    () =>
      kiosk.enabled && due
        ? {
            snapshot: kioskSnapshot,
            enter: kiosk.enter,
            exit: async () => {
              await kiosk.exit();
            },
            clearError: kiosk.clearError,
          }
        : null,
    [kiosk, due, kioskSnapshot],
  );
  // When the reference sync last finished since the app started.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (state.sync.kind === "done") setLastSyncedAt(new Date());
  }, [state.sync.kind, state.sync.synced]);
  const retryNow = useCallback(() => {
    requestSync();
    requestFacts();
  }, [requestSync, requestFacts]);
  const floorTools = useMemo<FloorBarTools>(
    () => ({
      retry: retryNow,
      lastSyncedAt,
      windowMode: floorWindowMode,
      source: scanner,
      onMute: floorGate.setMuted,
    }),
    [retryNow, lastSyncedAt, floorWindowMode, scanner, floorGate],
  );
  // «Отвязать станцию» in «Рабочее место» (beta 3): the existing forget, behind
  // the identity re-confirmation and with the unsent records kept on the disk.
  const unpairApi = useMemo<UnpairApi | null>(
    () =>
      forgetHostId === null || forgetDeviceId === null
        ? null
        : {
            local: localDb,
            pairing: { hostId: forgetHostId, deviceId: forgetDeviceId },
            operatorId: state.operator?.id ?? null,
            inShift: state.floorWork !== null,
            source: scanner,
            onMute: floorGate.setMuted,
            countUnsent: () =>
              countUnsentRecords(localDb, { hostId: forgetHostId, deviceId: forgetDeviceId }),
            owesBlocks: () =>
              restoreDue(localDb, { hostId: forgetHostId, deviceId: forgetDeviceId }),
            forget: async (keepUnsent) => {
              await deviceApi.forget(keepUnsent ? { keepUnsent: true } : undefined);
              setUnsent(null);
              dispatch({ type: "forgotten" });
              retryProbe();
            },
          },
    [
      localDb,
      forgetHostId,
      forgetDeviceId,
      state.operator?.id,
      state.floorWork,
      scanner,
      floorGate,
      deviceApi,
      retryProbe,
    ],
  );
  const officeSession = useMemo<OfficeSessionValue | null>(() => {
    if (!session) return null;
    // Scoped to this session's token: a late failure from a session the
    // user already left or replaced must not pull them back into sign-in or
    // mark a fresh pairing rejected.
    const route = (error: unknown): void => {
      const action = shellActionFor(error, session.token);
      if (action) dispatch(action);
    };
    const refreshUser = async (): Promise<void> => {
      try {
        const user = await hostApi.officeMe(session.token);
        dispatch({ type: "office_user_refreshed", token: session.token, user });
      } catch (error) {
        route(error);
        throw error;
      }
    };
    const call = async <T,>(operation: (token: string) => Promise<T>): Promise<T> => {
      try {
        return await operation(session.token);
      } catch (error) {
        route(error);
        if (error instanceof HostError && error.code === "forbidden") {
          // The role changed on the host: read the user again so the menu
          // and the pages follow it. A failure there is routed like any other.
          void refreshUser().catch(() => undefined);
        }
        throw error;
      }
    };
    return {
      user: session.user,
      api: hostApi,
      call,
      refreshUser,
      exitTo: officePc ? "sign_in" : "floor",
      signOut: () => {
        dispatch({ type: "office_signed_out" });
        void hostApi.officeLogout(session.token).catch(() => undefined);
      },
      logout: () => {
        dispatch({ type: "office_closed" });
        // The token is already gone from this device; if the host cannot be
        // told now, it expires the session on its own after 30 idle minutes.
        void hostApi.officeLogout(session.token).catch(() => undefined);
      },
    };
  }, [session, hostApi, officePc]);

  if (session && officeSession) {
    return (
      <Office
        key={session.token}
        session={officeSession}
        link={state.link}
        sync={state.sync}
        hostRevision={state.hostRevision}
        deviceId={pairedStatus?.deviceId ?? null}
        windowMode={windowMode}
      />
    );
  }

  const repairBusy = repairState === "busy";
  const repairError = repairState === "idle" || repairState === "busy" ? null : repairState;

  return (
    <main className="standalone-screen">
      {view.kind === "loading" && <WaitScreen messageKey="shell.loading" />}
      {view.kind === "config_error" && (
        <ConfigErrorScreen
          busy={repairBusy}
          error={repairError}
          unsent={unsentHere}
          onReset={repair}
          onConfirm={confirmRepair}
        />
      )}
      {view.kind === "host_missing" && (
        <HostMissingScreen
          reason={view.reason}
          address={address}
          onRetry={retryProbe}
          onNetwork={unpaired ? () => dispatch({ type: "network_pairing_requested" }) : null}
        />
      )}
      {view.kind === "bootstrap" && <BootstrapWizard onSubmit={bootstrap} />}
      {view.kind === "pairing" && <WaitScreen messageKey="shell.pairing.title" />}
      {view.kind === "network_pairing" && scannerSetup && (
        <WorkstationSetup
          scope="scanners"
          local={localDb}
          hardware={hardwareApi}
          printing={printing}
          source={scanner}
          onSaved={() => undefined}
          onBack={() => setScannerSetup(false)}
        />
      )}
      {view.kind === "network_pairing" && !scannerSetup && (
        <NetworkPairing
          probe={hostProbe}
          onClaim={claim}
          onBack={() => dispatch({ type: "network_pairing_cancelled" })}
          comScans={comScans}
          onScannerSetup={() => setScannerSetup(true)}
        />
      )}
      {view.kind === "pair_failed" && (
        <PairFailedScreen
          code={view.code}
          onRetry={() => {
            // A stale probe snapshot can carry the wrong host identity (e.g.
            // after a host swap): re-probe as well, not just the pairing.
            dispatch({ type: "pairing_retried" });
            retryProbe();
          }}
        />
      )}
      {view.kind === "device_rejected" && (
        <DeviceRejectedScreen
          reason={view.reason}
          remoteAddress={remoteAddress}
          busy={repairBusy}
          error={repairError}
          unsent={unsentHere}
          owed={owedHere}
          onRepair={repair}
          onConfirm={confirmRepair}
          onConfirmOwed={confirmOwed}
        />
      )}
      {view.kind === "other_host" && (
        <OtherHostScreen
          hostAddress={view.hostAddress}
          busy={repairBusy}
          error={repairError}
          unsent={unsentHere}
          owed={owedHere}
          onRepair={repair}
          onConfirm={confirmRepair}
          onConfirmOwed={confirmOwed}
        />
      )}
      {view.kind === "line_select" && (
        <LineSelect
          local={localDb}
          sync={state.sync}
          link={state.link}
          onSelect={selectLine}
          onSync={requestSync}
          onOffice={() => dispatch({ type: "office_requested" })}
        />
      )}
      {(view.kind === "floor" || view.kind === "floor_operator") && pairedStatus !== null && (
        <div className="floor-frame">
          <FloorStatusBar
            local={localDb}
            pairing={pairedStatus}
            lineId={pairedStatus.lineId}
            operator={view.kind === "floor_operator" ? view.operator : null}
            link={state.link}
            sync={state.sync}
            deviceName={pairedStatus.deviceName}
            shiftId={state.floorWork?.shiftId ?? null}
            deviceNotSaved={state.deviceNotSaved}
            outboxVersion={state.outboxVersion}
            factsFailure={state.factsFailure}
            refusalHeld={state.pendingRejection !== null || state.pendingOtherHost}
            otherHostHeld={state.pendingRejection === null && state.pendingOtherHost}
            watchScanners={hardwareApi.watchScanners}
            tools={floorTools}
            {...(view.kind === "floor_operator" ? { onSwitchOperator: switchOperator } : {})}
          />
          {view.kind === "floor" ? (
            <OperatorSignIn
              // A number or PIN typed under another pairing or line is not kept.
              key={`${pairedStatus.hostId}:${pairedStatus.deviceId}:${pairedStatus.lineId ?? ""}`}
              local={localDb}
              pairing={pairedStatus}
              lineId={pairedStatus.lineId}
              sync={state.sync}
              notice={state.floorNotice}
              source={floorGate.source}
              onSignedIn={operatorSignedIn}
              onSync={signInSync.request}
              onOffice={() => dispatch({ type: "office_requested" })}
              watchScanners={hardwareApi.watchScanners}
            />
          ) : (
            <UnpairContext.Provider value={unpairApi}>
              <FloorApp
                // One session's screen: nothing of it outlives the sign-out.
                key={`${pairedStatus.hostId}:${pairedStatus.deviceId}:${view.operator.sessionId}`}
                operator={view.operator}
                local={localDb}
                device={pairedStatus}
                link={state.link}
                sync={state.sync}
                shiftReads={state.shiftReads}
                outboxVersion={state.outboxVersion}
                lineChangePending={state.pendingDevice !== null}
                rejectionPending={state.pendingRejection !== null || state.pendingOtherHost}
                enter={hostApi.enterShift}
                create={hostApi.createDeviceShift}
                checkCode={hostApi.checkCode}
                requestBlock={hostApi.requestSsccBlock}
                warehouseLookup={hostApi.warehouseLookup}
                requestFacts={requestFacts}
                source={floorGate.source}
                printing={printing}
                hardware={hardwareApi}
                awake={awake}
                {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
                dispatch={dispatch}
                onSignOut={operatorSignedOut}
                onSignOutReady={floorSignOutReady}
              />
            </UnpairContext.Provider>
          )}
        </div>
      )}
      {view.kind === "office_login" && (
        <OfficeLogin
          notice={view.notice}
          onLogin={login}
          onBack={officePc ? null : () => dispatch({ type: "office_closed" })}
          hostAddress={remoteAddress}
          onChangeAddress={changeAddress}
          link={state.link}
        />
      )}
    </main>
  );
}
