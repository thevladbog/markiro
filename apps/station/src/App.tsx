import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";
import { Button, Card } from "@markiro/ui";
import {
  clearCredential,
  isEnrolled,
  readConfig,
  writeConfig,
  type StationConfig,
} from "./lib/config.js";
import {
  createStationClient,
  StationApiError,
  type ServerReachability,
  type StationClient,
} from "./lib/api-client.js";
import {
  clearRejectedCredentialState,
  beginFloorWorkRetirement,
  createCredentialGeneration,
  createFloorWorkRegistry,
  credentialGenerationIsCurrent,
  readSealedWorkSummary,
  type CredentialGeneration,
  type CredentialRejectedEvent,
  type FloorWorkBarrier,
  type FloorWorkRetirement,
  type SealedWorkSummary,
} from "./lib/credential-recovery.js";
import {
  DEFAULT_HARDWARE_CONFIG,
  loadHardwareConfig,
  type HardwareConfig,
} from "./lib/hardware-config.js";
import { createHardwareScanSource, tauriHardware, type ScannerStatus } from "./lib/hardware.js";
import {
  applyMigrations,
  readShiftContext,
  readShiftMirror,
  type ShiftContextRow,
} from "./lib/mirror.js";
import { mirrorShiftBundle } from "./lib/shift-bundle.js";
import { createOperatorRosterRefresher } from "./lib/roster-sync.js";
import { createKeyboardWedgeSource } from "./lib/scan-source.js";
import { createActivityAwareScanSource, createOperatorIdleLock } from "./lib/operator-idle-lock.js";
import { canonicalStationApiUrl } from "./lib/station-api-url.js";
import { loadSoundSettings, type SoundSettings } from "./lib/signal-sound.js";
import { tauriExecutor } from "./lib/sqlite.js";
import { resolveLegacyStationIdentity } from "./lib/legacy-identity.js";
import { createLockdownLifecycle } from "./lib/lockdown.js";
import { ConfigTransitionCoordinator } from "./lib/config-transition.js";
import {
  resetCredentialForPairing as resetCredentialConfig,
  type RunConfigTransition,
} from "./lib/credential-reset.js";
import { useSyncEngine } from "./lib/use-sync-engine.js";
import { tauriStationUpdater } from "./lib/tauri-updater.js";
import { useStationUpdater } from "./lib/use-station-updater.js";
import { ConflictList } from "./pages/ConflictList.js";
import { Enrollment } from "./pages/Enrollment.js";
import { OperatorLogin } from "./pages/OperatorLogin.js";
import { ShiftSelection } from "./pages/ShiftSelection.js";
import { NewShift } from "./pages/NewShift.js";
import { WorkScreen } from "./pages/WorkScreen.js";
import { WorkstationSetup } from "./pages/WorkstationSetup.js";
import { UpdateCenter } from "./pages/UpdateCenter.js";
import { FloorShell } from "./ui/FloorShell.js";
import { OperatorSwitchControl } from "./ui/OperatorSwitchControl.js";
import { FloorFooter } from "./ui/FloorFooter.js";
import { WindowModeControl } from "./ui/WindowModeControl.js";
import type { ScannerIndicator, UpdateIndicatorModel } from "./ui/StatusBar.js";

interface ActiveShift {
  id: string;
  status: string;
  mode: string;
}

export type CredentialRecoveryPhase = "sealing" | "failed" | "ready";

export type CredentialRecoveryState =
  | { event: CredentialRejectedEvent; phase: Exclude<CredentialRecoveryPhase, "ready"> }
  | { event: CredentialRejectedEvent; phase: "ready"; sealed: SealedWorkSummary };

export type LegacyIdentityState = "resolving" | "degraded" | "rejected" | null;

export type StationView = "loading" | "pairing" | "login" | "floor";

const legacyGatedClient: StationClient = {
  get<T>() {
    return Promise.reject<T>(new Error("legacy station identity is not yet available"));
  },
  post<T>() {
    return Promise.reject<T>(new Error("legacy station identity is not yet available"));
  },
  download() {
    return Promise.reject<Blob>(new Error("legacy station identity is not yet available"));
  },
  whoami() {
    return Promise.reject(new Error("legacy station identity is not yet available"));
  },
};

/**
 * Pure routing decision for the top-level App state machine, factored out so
 * it is unit-testable without rendering (jsdom has no real Tauri runtime, so
 * a full App render needs `invoke` mocked end-to-end; this function captures
 * the actual branch logic App renders from).
 *
 * - No config yet (still reading it on mount) -> "loading".
 * - Config present but the device has no credential -> "pairing".
 * - Enrolled but no operator has signed in this session -> "login".
 * - Enrolled + signed in -> "floor" (ShiftSelection/NewShift/active-shift area).
 */
export function nextStationView(
  config: StationConfig | null,
  operator: OperatorMirrorRecord | null,
): StationView {
  if (!config) return "loading";
  if (!isEnrolled(config)) return "pairing";
  if (!operator) return "login";
  return "floor";
}

/**
 * Fresh devices use the build-time deployment base. A durable device that
 * lost only its key re-pairs with its already trusted persisted API base;
 * neither path ever derives an API target from `window.location.origin`.
 */
export function pairingServerUrl(
  config: StationConfig,
  buildApiUrl: string | undefined,
): string | null {
  return canonicalStationApiUrl(config.deviceId ? config.serverUrl : buildApiUrl);
}

/**
 * A legacy key may prove only its own station identity. Prefer a valid base
 * already persisted on the device, then the deployment-supplied origin. An
 * invalid persisted value is never used as a request prefix.
 */
export function legacyIdentityServerUrl(
  config: StationConfig,
  buildApiUrl: string | undefined,
): string | null {
  if (!config.apiKey || config.deviceId) return null;
  return canonicalStationApiUrl(config.serverUrl) ?? canonicalStationApiUrl(buildApiUrl);
}

function configuredStationApiUrl(): string | undefined {
  // `import.meta.env` is untyped in this Tauri build, so narrow its untrusted
  // build-time value before it reaches the URL parser.
  const value = (import.meta.env as unknown as Record<string, unknown>).VITE_STATION_API_URL;
  return typeof value === "string" ? value : undefined;
}

/**
 * Which scan source a configured station should use. The keyboard wedge is
 * the default because most USB scanners are HID keyboards and need no setup;
 * a serial scanner is opted into on the setup screen.
 */
export function pickScanSource(config: HardwareConfig): "wedge" | "hardware" {
  return config.scanner ? "hardware" : "wedge";
}

/**
 * What the status bar may honestly claim. Without a configured serial scanner
 * the wedge is working but undetectable, so we say "keyboard" rather than
 * claiming or denying a device. With one configured, the Rust status event is
 * the only truth — and until it arrives we assume disconnected, because
 * showing a green light for a scanner that never opened is the failure this
 * indicator exists to prevent.
 */
export function scannerIndicator(
  config: HardwareConfig,
  status: ScannerStatus | null,
): ScannerIndicator {
  if (!config.scanner) return "keyboard";
  return status === "connected" ? "connected" : "disconnected";
}

export function App() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<StationConfig | null>(null);
  const configRef = useRef<StationConfig | null>(null);
  const configTransitions = useRef(new ConfigTransitionCoordinator());
  const [operator, setOperator] = useState<OperatorMirrorRecord | null>(null);
  const [floorView, setFloorView] = useState<"select" | "new">("select");
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [serverReachability, setServerReachability] = useState<ServerReachability>("checking");
  const [sound, setSound] = useState<SoundSettings>({ muted: false, volume: 1 });
  const [shiftContext, setShiftContext] = useState<ShiftContextRow | null>(null);
  // Threaded into WorkScreen's box UI (Task 13 review, Finding 1) --
  // `boxCapacity` was already a `shift_mirror` column written by
  // `mirrorShiftBundle`, just never read back; `issuerPrefix` is mirrored
  // there for the same reason (see mirror.ts's `upsertBundleBody`). Both are
  // read together with `shiftContext` below, off the same `shift_mirror` row,
  // and reset alongside it whenever the shift itself changes.
  const [boxCapacity, setBoxCapacity] = useState<number | null>(null);
  const [issuerPrefix, setIssuerPrefix] = useState<string | null>(null);
  const [hardwareConfig, setHardwareConfig] = useState<HardwareConfig>(DEFAULT_HARDWARE_CONFIG);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [printRecoveryBlocked, setPrintRecoveryBlocked] = useState(false);
  // Printer Setup deliberately unmounts WorkScreen. Its cleanup publishes
  // `false`, but that does not resolve the persisted recovery which opened
  // Setup. Keep the App-level block latched until the remounted WorkScreen
  // first rehydrates that row (`true`) and later reports its real resolution
  // (`false`).
  const printRecoverySetupLatch = useRef<"idle" | "awaiting-remount" | "remounted">("idle");
  const handlePrintRecoveryChange = useCallback((blocked: boolean): void => {
    const phase = printRecoverySetupLatch.current;
    if (blocked) {
      if (phase === "awaiting-remount") printRecoverySetupLatch.current = "remounted";
      setPrintRecoveryBlocked(true);
      return;
    }
    if (phase === "awaiting-remount") return;
    if (phase === "remounted") printRecoverySetupLatch.current = "idle";
    setPrintRecoveryBlocked(false);
  }, []);
  const openPrintRecoverySetup = useCallback((): void => {
    printRecoverySetupLatch.current = "awaiting-remount";
    setPrintRecoveryBlocked(true);
    setShowSetup(true);
  }, []);
  const [showConflicts, setShowConflicts] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [operatorSwitchState, setOperatorSwitchState] = useState<"idle" | "settling" | "failed">(
    "idle",
  );
  const [credentialRecovery, setCredentialRecovery] = useState<CredentialRecoveryState | null>(
    null,
  );
  const [legacyIdentityState, setLegacyIdentityState] = useState<LegacyIdentityState>(null);
  const legacyIdentityAttempt = useRef<Promise<unknown> | null>(null);
  const recoveryCleanupStarted = useRef<CredentialRejectedEvent | null>(null);
  const floorWorkRegistry = useMemo(() => createFloorWorkRegistry(), []);
  const operatorRetirement = useRef<FloorWorkRetirement | null>(null);
  const operatorSwitchAttempt = useRef<Promise<void> | null>(null);
  const switchOperatorRef = useRef<() => Promise<void>>(async () => {});
  const operatorIdleLock = useMemo(
    () =>
      createOperatorIdleLock({
        target: window,
        onIdle: () => {
          void switchOperatorRef.current().catch(() => {
            // The switch state exposes the recoverable failure on the floor.
          });
        },
      }),
    [],
  );
  const lockdown = useMemo(() => createLockdownLifecycle({ dev: import.meta.env.DEV }), []);
  const subscribeLockdown = useCallback(
    (listener: () => void) => lockdown.subscribe(listener),
    [lockdown],
  );
  const getLockdownSnapshot = useCallback(() => lockdown.getSnapshot(), [lockdown]);
  const enterLockdown = useCallback(() => lockdown.enter(), [lockdown]);
  const exitLockdown = useCallback(() => lockdown.exit(), [lockdown]);
  const clearLockdownError = useCallback(() => lockdown.clearError(), [lockdown]);
  const lockdownSnapshot = useSyncExternalStore(
    subscribeLockdown,
    getLockdownSnapshot,
    getLockdownSnapshot,
  );
  const restoreLockdownAfterSetup = useRef(false);
  const registerFloorWorkBarrier = useCallback(
    (barrier: FloorWorkBarrier) => floorWorkRegistry.register(barrier),
    [floorWorkRegistry],
  );
  const publishConfig = useCallback((next: StationConfig) => {
    configRef.current = next;
    setConfig(next);
  }, []);
  const reportServerReachability = useCallback(
    (state: Exclude<ServerReachability, "checking">) => setServerReachability(state),
    [],
  );
  const runConfigTransition: RunConfigTransition = useCallback(
    async <T,>(transition: () => Promise<T>, publish: (value: T) => void): Promise<T> => {
      const generation = configTransitions.current.begin();
      let committedValue: T | undefined;
      const result = await configTransitions.current.commit({
        generation,
        isOriginCurrent: () => true,
        transition,
        publish: (value) => {
          committedValue = value;
          publish(value);
        },
      });
      if (result === "stale") throw new Error("config transition superseded");
      return committedValue as T;
    },
    [],
  );
  const runEnrollmentConfigTransition = useCallback(
    (transition: () => Promise<void>) => runConfigTransition(transition, () => {}),
    [runConfigTransition],
  );
  // Bumped every time the operator leaves the setup screen (Done or Back),
  // so the scanner-session effect below re-runs even when the saved
  // `hardwareConfig.scanner` port/baud are unchanged -- e.g. Setup's own
  // "Connect scanner" button opened a different port that failed, or a
  // manual test-connect was never saved. Without this, saving an identical
  // configuration only changes the config object's identity, not the
  // port/baud values the effect is keyed on, so it would never re-run and
  // the station would be left with whatever session Setup's own buttons put
  // it in.
  const [sessionEpoch, setSessionEpoch] = useState(0);

  useEffect(() => lockdown.start(), [lockdown]);

  useEffect(() => {
    if (!showSetup) return;
    let cancelled = false;
    restoreLockdownAfterSetup.current = false;
    void (async () => {
      await lockdown.whenSettled();
      if (cancelled) return;
      restoreLockdownAfterSetup.current = lockdown.getSnapshot().mode === "locked";
      // Even a confirmed windowed snapshot cannot prove the OS window is
      // fully restored after a partial enter failure (`applied === null` in
      // the lifecycle). Always request exit; the lifecycle de-duplicates the
      // already-confirmed windowed case and retries the uncertain one.
      await lockdown.exit();
    })();
    return () => {
      cancelled = true;
      const shouldRestore = restoreLockdownAfterSetup.current;
      restoreLockdownAfterSetup.current = false;
      if (shouldRestore) void lockdown.enter();
    };
  }, [lockdown, showSetup]);

  useEffect(() => {
    void loadSoundSettings(tauriExecutor).then(setSound);
  }, []);

  useEffect(() => {
    void loadHardwareConfig(tauriExecutor).then(setHardwareConfig);
  }, []);

  useEffect(
    () => () => {
      // Invalidate responses from both initial and reconnect identity attempts.
      // Clearing the ref lets React StrictMode's effect remount launch a fresh
      // generation while the first development-only request becomes a no-op.
      configTransitions.current.seal();
      legacyIdentityAttempt.current = null;
    },
    [],
  );

  // Open a configured scanner at start so a set-up station comes up ready,
  // and again whenever the configured scanner changes (e.g. from Setup).
  // `scannerStatus` is reset to null up front so a scanner that has not (yet,
  // or ever) opened successfully never keeps showing a stale "connected"
  // left over from whatever was configured before -- `scannerIndicator`
  // reads a null status as disconnected once a scanner is configured.
  useEffect(() => {
    let cancelled = false;
    setScannerStatus(null);
    void (async () => {
      // Retire any previous session before evaluating the new configuration
      // -- even when the new configuration has no scanner at all -- so
      // clearing the port in Setup actually releases the OS handle instead
      // of leaving the Rust session open and emitting `station://scan`
      // until the app restarts. Order matters: await the close, then open;
      // never fire both concurrently. This is the same close-before-open
      // the setup screen's "Connect scanner" button already does -- the
      // Rust `open_scanner` retry loop is what absorbs the up-to-200ms the
      // retiring reader thread needs to release the port handle.
      await tauriHardware.closeScanner();
      if (cancelled || !hardwareConfig.scanner) return;
      const { port, baud } = hardwareConfig.scanner;
      await tauriHardware.openScanner(port, baud);
    })().catch((err: unknown) => {
      // A stale run's failure (superseded by a newer configuration, or the
      // component already unmounted) must not be reported as if it were the
      // current configuration's problem.
      if (!cancelled) console.error("station: opening the configured scanner failed", err);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the scanner's port/baud rather than the object identity, so a re-read of the config that changed nothing does not close and reopen the port.
  }, [hardwareConfig.scanner?.port, hardwareConfig.scanner?.baud, sessionEpoch]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    void tauriHardware
      .onScannerStatus(setScannerStatus)
      .then((fn) => {
        if (stopped) fn();
        else unsubscribe = fn;
      })
      .catch((err: unknown) => {
        console.error("station: scanner status subscription failed", err);
      });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }, []);

  // The keyboard wedge needs no setup: most USB scanners are HID keyboards.
  // A serial scanner is opted into from the workstation setup screen.
  const wedgeSource = useMemo(() => createKeyboardWedgeSource(), []);
  const hardwareSource = useMemo(() => createHardwareScanSource(tauriHardware), []);
  const selectedScanSource =
    pickScanSource(hardwareConfig) === "hardware" ? hardwareSource : wedgeSource;
  const scanSource = useMemo(
    () => createActivityAwareScanSource(selectedScanSource, () => operatorIdleLock.activity()),
    [operatorIdleLock, selectedScanSource],
  );

  useEffect(() => {
    if (!operator || operatorSwitchState !== "idle") {
      operatorIdleLock.stop();
      return;
    }
    operatorIdleLock.start();
    return () => operatorIdleLock.stop();
  }, [operator, operatorIdleLock, operatorSwitchState]);

  useEffect(() => {
    if (!shift) {
      setShiftContext(null);
      setBoxCapacity(null);
      setIssuerPrefix(null);
      return;
    }
    let cancelled = false;
    // mirrorShiftBundle writes in the background, so poll briefly until the
    // product row lands rather than blocking shift entry on the network.
    // `readShiftMirror` is fetched alongside `readShiftContext` on every
    // tick: the shift row it reads is written before the product row
    // `readShiftContext`'s join depends on (see `upsertBundleBody`), so by
    // the time `ctx` resolves non-null the mirror row is already there too --
    // gating this poll on `ctx` (rather than adding a second one) is enough.
    // `readShiftMirror` carries its OWN `.catch(() => null)` (Task 13 review,
    // Finding 2), separate from the `.catch` below that guards the whole
    // `Promise.all`: without it, a mirror-read failure -- including
    // `applyMigrations` rethrowing a genuine (non-duplicate-column) migration
    // error, plausible if a lock or transient error hits the `issuer_prefix`
    // column or any ALTER before it -- would reject the WHOLE `Promise.all`,
    // so `ctx` is never reached and `setShiftContext` is never called,
    // stranding the operator on "Preparing the shift..." indefinitely. Before
    // this task, a mirror-read failure only degraded the box feature to
    // absent; it must not now be able to block shift entry entirely.
    const tick = setInterval(() => {
      void Promise.all([
        readShiftContext(tauriExecutor, shift.id),
        readShiftMirror(tauriExecutor, shift.id).catch(() => null),
      ])
        .then(([ctx, mirror]) => {
          if (cancelled || !ctx) return;
          setShiftContext(ctx);
          setBoxCapacity(mirror?.boxCapacity ?? null);
          setIssuerPrefix(mirror?.issuerPrefix ?? null);
          clearInterval(tick);
        })
        .catch((err) => {
          // A transient SQLite lock while mirrorShiftBundle's transaction is
          // in flight must not surface as an unhandled rejection on this
          // tick; the poll keeps running and the next tick self-heals.
          console.error("station: readShiftContext poll failed", err);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [shift]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Applied once on startup, before the mirror is read by OperatorLogin
      // or hydrated further. A migration failure must not permanently strand
      // the device on the boot screen, so it is logged, not rethrown — the
      // rest of the flow (config read, enrollment) still proceeds.
      try {
        await applyMigrations(tauriExecutor);
      } catch (err) {
        console.error("station: applyMigrations failed", err);
      }
      const cfg = await readConfig();
      if (!cancelled) publishConfig(cfg);
    })();
    return () => {
      cancelled = true;
    };
  }, [publishConfig]);

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => {
      setBrowserOnline(false);
      setServerReachability("unreachable");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const legacyKeyedConfig = Boolean(config?.apiKey && !config.deviceId);
  const legacyApiUrl = config ? legacyIdentityServerUrl(config, configuredStationApiUrl()) : null;

  // Memoized (keyed on identity-bearing fields and canonical legacy base, not
  // the whole `config` object, which
  // is a fresh reference on every `readConfig()`/`refreshConfig()` call) so
  // ShiftSelection's fetch-on-mount effect (keyed on `client`) does not
  // refetch on every render — e.g. every online/offline flap re-renders App.
  // Must run unconditionally (before the `!config` early return below) to
  // respect the Rules of Hooks; it degrades to `null` until enrolled.
  const client = useMemo(
    () => {
      if (!config?.apiKey) return null;
      if (!config.deviceId) {
        return legacyApiUrl ? createStationClient({ ...config, serverUrl: legacyApiUrl }) : null;
      }
      return config.serverUrl ? createStationClient(config) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above; the client reads only these credential/base fields.
    [config?.apiKey, config?.deviceId, config?.serverUrl, legacyApiUrl],
  );

  const verifiedClient = config?.deviceId ? client : null;

  const attemptLegacyIdentity = useCallback(() => {
    if (
      !config ||
      !client ||
      !legacyApiUrl ||
      config.deviceId ||
      legacyIdentityState === "rejected"
    ) {
      return;
    }
    if (legacyIdentityAttempt.current) return;
    const origin = config;
    const generation = configTransitions.current.begin();
    setLegacyIdentityState("resolving");
    const attempt = resolveLegacyStationIdentity(client, { ...origin, serverUrl: legacyApiUrl })
      .then((backfilled) => {
        return configTransitions.current.commit({
          generation,
          isOriginCurrent: () => configRef.current === origin,
          transition: async () => {
            await writeConfig(backfilled);
            return backfilled;
          },
          publish: (committed) => {
            publishConfig(committed);
            setLegacyIdentityState(null);
          },
        });
      })
      .catch((error: unknown) => {
        if (!configTransitions.current.isCurrent(generation) || configRef.current !== origin) {
          return;
        }
        setLegacyIdentityState(
          error instanceof StationApiError && error.status === 401 ? "rejected" : "degraded",
        );
      })
      .finally(() => {
        if (legacyIdentityAttempt.current === attempt) legacyIdentityAttempt.current = null;
      });
    legacyIdentityAttempt.current = attempt;
  }, [client, config, legacyApiUrl, legacyIdentityState, publishConfig]);

  useEffect(() => {
    if (
      !config ||
      !client ||
      config.deviceId ||
      (legacyIdentityState !== null && legacyIdentityState !== "resolving")
    ) {
      return;
    }
    attemptLegacyIdentity();
  }, [attemptLegacyIdentity, client, config, legacyIdentityState]);

  useEffect(() => {
    if (legacyIdentityState !== "degraded") return;
    const retry = () => attemptLegacyIdentity();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [attemptLegacyIdentity, legacyIdentityState]);

  // One shared generation per authenticated key, not per sync-engine instance.
  // This makes React StrictMode overlap and any late async response obey the
  // same terminal seal. A newly provisioned apiKey creates a fresh generation.
  const credentialGeneration = useMemo(
    () => (verifiedClient ? createCredentialGeneration() : null),
    [verifiedClient],
  );
  const currentCredentialGeneration = useRef<CredentialGeneration | null>(null);
  currentCredentialGeneration.current = credentialGeneration;

  const onCredentialRejected = useCallback((event: CredentialRejectedEvent) => {
    if (currentCredentialGeneration.current !== event.generation) return;
    configTransitions.current.seal();
    // These updates gate every authenticated surface in the next render.
    // Cache deletion happens only from the post-commit effect below.
    setOperator(null);
    setShift(null);
    setShiftContext(null);
    setBoxCapacity(null);
    setIssuerPrefix(null);
    setFloorView("select");
    setShowSetup(false);
    printRecoverySetupLatch.current = "idle";
    setPrintRecoveryBlocked(false);
    setShowConflicts(false);
    setCredentialRecovery((current) => current ?? { event, phase: "sealing" });
  }, []);

  const credentialBoundClient = useMemo(() => {
    if (
      !config?.apiKey ||
      !config.deviceId ||
      !config.serverUrl ||
      !verifiedClient ||
      !credentialGeneration
    ) {
      return null;
    }
    return createStationClient(config, {
      onReachabilityChange: (state) => {
        // A request from a replaced credential/client may settle after the
        // new session has already proved its own reachability. Only the
        // generation that currently owns authenticated work may publish.
        if (currentCredentialGeneration.current === credentialGeneration) {
          reportServerReachability(state);
        }
      },
      credentialBoundary: {
        machineId: config.machineId,
        generation: credentialGeneration,
        onCredentialRejected,
      },
    });
    // The raw verified client and generation already have these exact identity
    // dependencies; listing primitives keeps unrelated config refreshes stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config?.apiKey,
    config?.deviceId,
    config?.machineId,
    config?.serverUrl,
    credentialGeneration,
    onCredentialRejected,
    reportServerReachability,
    verifiedClient,
  ]);
  const authenticatedClient = credentialRecovery ? null : credentialBoundClient;
  const refreshOperatorRoster = useMemo(() => {
    if (!authenticatedClient || !credentialGeneration) return null;
    return createOperatorRosterRefresher(authenticatedClient, tauriExecutor, credentialGeneration);
  }, [authenticatedClient, credentialGeneration]);

  // One engine for the life of the app: the outbox belongs to the DEVICE, not
  // to a shift or an operator, so entering or leaving a shift must never stop
  // the drain. Built only once a client exists — before enrollment there is
  // nowhere to send. See `useSyncEngine`'s doc comment for why construction
  // and teardown are paired inside one effect there (a StrictMode hazard) and
  // for why `nudge` below is safe to call from anywhere without needing the
  // engine's identity as a dependency.
  const { state: syncState, nudge: nudgeSync } = useSyncEngine({
    exec: tauriExecutor,
    client: authenticatedClient,
    machineId: config?.machineId,
    ...(credentialGeneration ? { credentialGeneration } : {}),
    onCredentialRejected,
  });

  // The hook is mounted unconditionally to preserve hook order, but it only
  // starts discovery after migrations have completed and readConfig has
  // published a non-null config. Discovery is non-blocking and never changes
  // the active shift or sync engine.
  const updater = useStationUpdater({
    enabled: config !== null,
    exec: tauriExecutor,
    activeShift: shift !== null,
    pendingOutbox: syncState.pending,
    port: tauriStationUpdater,
  });

  // React runs effects only after committing the recovery render. This is
  // the ordering boundary that guarantees an operator can no longer act on
  // the authenticated floor before roster/reference caches are removed.
  useEffect(() => {
    if (!credentialRecovery || credentialRecovery.phase !== "sealing" || !config) return;
    if (recoveryCleanupStarted.current === credentialRecovery.event) return;
    recoveryCleanupStarted.current = credentialRecovery.event;
    const previous = config;
    void runConfigTransition(
      async () => {
        if (
          !previous.deviceId ||
          previous.machineId !== credentialRecovery.event.machineId ||
          !previous.serverUrl
        ) {
          throw new Error("credential recovery identity unavailable");
        }
        // The recovery render above has already removed every authenticated
        // action. Count all durable unsent facts in one SQLite snapshot before
        // deleting any reproducible state; a count failure stays fail-closed.
        const sealed = await readSealedWorkSummary(tauriExecutor, floorWorkRegistry.current());
        await clearRejectedCredentialState({ exec: tauriExecutor, clearCredential });
        const cleared = await readConfig();
        if (
          cleared.machineId !== previous.machineId ||
          cleared.deviceId !== previous.deviceId ||
          cleared.serverUrl !== previous.serverUrl ||
          cleared.apiKey !== undefined
        ) {
          throw new Error("credential recovery clear contract violation");
        }
        return { cleared, sealed };
      },
      ({ cleared, sealed }) => {
        publishConfig(cleared);
        setCredentialRecovery((current) =>
          current?.event === credentialRecovery.event
            ? { event: credentialRecovery.event, phase: "ready", sealed }
            : current,
        );
      },
    ).catch(() => {
      setCredentialRecovery((current) =>
        current?.event === credentialRecovery.event
          ? { event: credentialRecovery.event, phase: "failed" }
          : current,
      );
    });
  }, [config, credentialRecovery, floorWorkRegistry, publishConfig, runConfigTransition]);

  // Initialization sync: as soon as the device has a credential — right after
  // enrollment, and on every later start — pull the operator roster so the
  // sign-in screen has someone to authenticate. Without this a freshly
  // enrolled station shows a PIN pad no PIN can ever satisfy.
  useEffect(() => {
    if (!refreshOperatorRoster) return;
    void refreshOperatorRoster();
  }, [refreshOperatorRoster]);

  // Retry: the initial sync above runs exactly once, so a device that is
  // briefly offline at that moment would otherwise strand the operator at a
  // PIN pad no PIN can satisfy until the app is restarted. Re-running on
  // every `online` event is a cheap one-shot retry, not a polling loop. The
  // shared refresher coalesces this with startup or login-driven refreshes.
  // The sync engine's queue drain is a second, independent consumer of the
  // same event — one listener, two reasons to nudge.
  useEffect(() => {
    if (!refreshOperatorRoster) return;
    const retrySync = () => {
      void refreshOperatorRoster();
      nudgeSync();
    };
    window.addEventListener("online", retrySync);
    return () => window.removeEventListener("online", retrySync);
  }, [nudgeSync, refreshOperatorRoster]);

  async function refreshConfig() {
    await runConfigTransition(readConfig, publishConfig);
  }

  async function finishCredentialRecovery() {
    try {
      await runConfigTransition(
        async () => {
          const refreshed = await readConfig();
          if (
            !credentialRecovery ||
            refreshed.machineId !== credentialRecovery.event.machineId ||
            refreshed.deviceId !== configRef.current?.deviceId
          ) {
            throw new Error("credential recovery identity changed");
          }
          return refreshed;
        },
        (refreshed) => {
          publishConfig(refreshed);
          recoveryCleanupStarted.current = null;
          setCredentialRecovery(null);
        },
      );
    } catch {
      setCredentialRecovery((current) =>
        current ? { event: current.event, phase: "failed" } : current,
      );
    }
  }

  /**
   * Explicit service action only. Task 11 owns automatic 401 sealing; this
   * handler is never called by a network failure path.
   */
  async function resetCredentialForPairing() {
    const previous = configRef.current;
    if (!previous) throw new Error(t("setup.resetCredentialFailed"));
    try {
      await resetCredentialConfig(previous, {
        clearCredential,
        readConfig,
        runTransition: runConfigTransition,
        publishConfig,
      });
      setOperator(null);
      setShift(null);
      setFloorView("select");
      setShowSetup(false);
      printRecoverySetupLatch.current = "idle";
      setPrintRecoveryBlocked(false);
    } catch {
      // Never expose IPC details or a device key in the service UI.
      throw new Error(t("setup.resetCredentialFailed"));
    }
  }

  async function performOperatorSwitch(): Promise<void> {
    setOperatorSwitchState("settling");
    const retirement =
      operatorRetirement.current ?? beginFloorWorkRetirement(floorWorkRegistry.current());
    operatorRetirement.current = retirement;
    try {
      await retirement.wait();
      operatorRetirement.current = null;
      setShowSetup(false);
      setShowConflicts(false);
      setShowUpdates(false);
      if (!shift) setFloorView("select");
      setOperator(null);
      setOperatorSwitchState("idle");
    } catch {
      setOperatorSwitchState("failed");
      throw new Error("operator switch did not settle");
    }
  }

  async function switchOperator(): Promise<void> {
    if (printRecoveryBlocked) return;
    if (operatorSwitchAttempt.current) return operatorSwitchAttempt.current;
    const attempt = performOperatorSwitch();
    operatorSwitchAttempt.current = attempt;
    try {
      await attempt;
    } finally {
      if (operatorSwitchAttempt.current === attempt) operatorSwitchAttempt.current = null;
    }
  }

  switchOperatorRef.current = switchOperator;

  const windowModeControl = (
    <WindowModeControl
      snapshot={lockdownSnapshot}
      activeShift={shift !== null}
      disabled={operatorSwitchState !== "idle" || printRecoveryBlocked}
      onEnter={enterLockdown}
      onExit={exitLockdown}
      onDismissError={clearLockdownError}
    />
  );

  function withWindowChrome(content: ReactNode): ReactNode {
    return (
      <div className="station-window-frame">
        {content}
        <div className="station-window-chrome">{windowModeControl}</div>
      </div>
    );
  }

  if (!config) {
    return withWindowChrome(
      <main className="station-centered-screen">
        <h1 style={{ fontSize: "2rem" }}>{t("app.booting")}</h1>
      </main>,
    );
  }

  if (legacyKeyedConfig && !legacyApiUrl) {
    return withWindowChrome(
      <main className="station-centered-screen">
        <Card style={{ width: "min(720px, calc(100vw - 64px))", padding: 32 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("legacyIdentity.title")}</h1>
          <p role="alert">{t("legacyIdentity.missingServer")}</p>
        </Card>
      </main>,
    );
  }

  if (credentialRecovery) {
    if (credentialRecovery.phase === "ready") {
      return withWindowChrome(
        <Enrollment
          machineId={config.machineId}
          {...(config.deviceId ? { expectedDeviceId: config.deviceId } : {})}
          sealedWork={credentialRecovery.sealed}
          onEnrolled={() => void finishCredentialRecovery()}
          runConfigTransition={runEnrollmentConfigTransition}
          scanSource={scanSource}
          pairingServerUrl={pairingServerUrl(config, configuredStationApiUrl())}
        />,
      );
    }
    return withWindowChrome(
      <main className="station-centered-screen">
        <Card style={{ minWidth: 480, padding: 32 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("enroll.title")}</h1>
          <p role="status">
            {t(
              credentialRecovery.phase === "failed"
                ? "enroll.recoveryFailed"
                : "enroll.recoverySealing",
            )}
          </p>
          {credentialRecovery.phase === "failed" ? (
            <Button
              size="floor"
              onClick={() => {
                recoveryCleanupStarted.current = null;
                setCredentialRecovery({ event: credentialRecovery.event, phase: "sealing" });
              }}
            >
              {t("enroll.retryRecovery")}
            </Button>
          ) : null}
        </Card>
      </main>,
    );
  }

  if (legacyIdentityState === "rejected") {
    return withWindowChrome(
      <main className="station-centered-screen">
        <Card style={{ width: "min(720px, calc(100vw - 64px))", padding: 32 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("legacyIdentity.title")}</h1>
          <p role="alert">{t("legacyIdentity.rejected")}</p>
        </Card>
      </main>,
    );
  }

  const legacyNotice = legacyIdentityState ? (
    <FloorFooter ariaLabel={t("legacyIdentity.title")}>
      <p className="legacy-identity-notice__message" role="status">
        {t(
          legacyIdentityState === "resolving"
            ? "legacyIdentity.resolving"
            : "legacyIdentity.degraded",
        )}
      </p>
      {legacyIdentityState === "degraded" ? (
        <Button size="floor" onClick={attemptLegacyIdentity}>
          {t("legacyIdentity.retry")}
        </Button>
      ) : null}
    </FloorFooter>
  ) : null;

  // `config` is narrowed to non-null for the rest of this render.
  const stage = legacyKeyedConfig
    ? operator
      ? "floor"
      : "login"
    : nextStationView(config, operator);
  const legacyCredentialResetBlocked = Boolean(config.apiKey && !config.deviceId);

  if (stage === "pairing") {
    if (showSetup) {
      return withWindowChrome(
        <WorkstationSetup
          hw={tauriHardware}
          exec={tauriExecutor}
          sound={sound}
          onSoundChange={setSound}
          onConfigChange={setHardwareConfig}
          onDone={() => {
            setShowSetup(false);
            setSessionEpoch((epoch) => epoch + 1);
          }}
        />,
      );
    }
    return withWindowChrome(
      <Enrollment
        machineId={config.machineId}
        {...(config.deviceId ? { expectedDeviceId: config.deviceId } : {})}
        onEnrolled={() => void refreshConfig()}
        runConfigTransition={runEnrollmentConfigTransition}
        onSetup={() => setShowSetup(true)}
        scanSource={scanSource}
        pairingServerUrl={pairingServerUrl(config, configuredStationApiUrl())}
      />,
    );
  }

  if (stage === "login") {
    return withWindowChrome(
      <OperatorLogin
        exec={tauriExecutor}
        source={scanSource}
        online={browserOnline}
        {...(refreshOperatorRoster ? { refreshRoster: refreshOperatorRoster } : {})}
        onAuthed={setOperator}
        notice={legacyNotice}
      />,
    );
  }

  // Both floor-routing branches require an authenticated operator. Keep the
  // runtime guard beside the render boundary so future routing changes cannot
  // accidentally expose a floor screen with missing operator context.
  if (!operator) return withWindowChrome(null);

  // stage === "floor" here, which requires `isEnrolled(config)` (apiKey +
  // serverUrl truthy) — the same condition the `client` memo above builds
  // from, so it is guaranteed non-null in this branch.
  const activeClient = authenticatedClient ?? legacyGatedClient;
  const floorGeneration = credentialGeneration;
  const updateIndicator: UpdateIndicatorModel = {
    severity: updater.severity,
    glyph: updater.persisted?.available ? "!" : "↻",
    available: updater.persisted?.available !== null && updater.persisted?.available !== undefined,
    label: updater.persisted?.available
      ? t("updates.indicatorAvailable", { version: updater.persisted.available.version })
      : t("updates.indicatorCurrent"),
  };
  const operatorControl = (
    <OperatorSwitchControl
      activeShift={shift !== null}
      pending={operatorSwitchState === "settling" || printRecoveryBlocked}
      error={operatorSwitchState === "failed"}
      onSwitch={switchOperator}
      onDismissError={() => {
        if (operatorRetirement.current === null) setOperatorSwitchState("idle");
      }}
    />
  );

  // Shared by ShiftSelection's `onSelected` and NewShift's `onStarted`: the
  // shift is entered immediately (never blocked on the network), and the
  // bundle download + SQLite mirror happens in the background so it's
  // available offline afterward. See `mirrorShiftBundle` for the
  // resilience contract (a download failure must not block entry).
  function handleShiftEntered(entered: ActiveShift) {
    if (floorGeneration && !credentialGenerationIsCurrent(floorGeneration)) return;
    setShift(entered);
    if (floorGeneration) {
      void mirrorShiftBundle(activeClient, tauriExecutor, entered.id, floorGeneration);
    }
  }

  // The scanner reads green only once the Rust side has confirmed a port is
  // actually open; the printer only reflects whether one is configured,
  // since it cannot be proven alive without printing to it.
  return (
    <FloorShell
      windowControl={windowModeControl}
      operatorControl={operatorControl}
      stationName={config.deviceName ?? config.deviceId ?? config.machineId}
      lineName={config.lineName ?? null}
      operatorName={operator.name}
      shiftLabel={shift ? (shiftContext?.productName ?? shift.id) : null}
      serverReachability={serverReachability}
      scanner={scannerIndicator(hardwareConfig, scannerStatus)}
      printerConfigured={hardwareConfig.printer !== null}
      syncPending={syncState.pending}
      syncStuck={syncState.stuck}
      conflicts={syncState.conflicts}
      update={updateIndicator}
      actionsDisabled={operatorSwitchState !== "idle" || printRecoveryBlocked}
      onOpenUpdates={() => setShowUpdates(true)}
      footer={legacyNotice}
    >
      {operatorSwitchState !== "idle" ? (
        <main className="station-centered-screen" data-testid="operator-switch-settling">
          <Card style={{ width: "min(720px, calc(100vw - 64px))", padding: 32 }}>
            <p role="status">
              {t(
                operatorSwitchState === "failed"
                  ? "operatorSwitch.error"
                  : "operatorSwitch.pending",
              )}
            </p>
          </Card>
        </main>
      ) : showUpdates ? (
        <UpdateCenter
          controller={updater}
          activeShift={shift !== null}
          pendingOutbox={syncState.pending}
          onBack={() => setShowUpdates(false)}
        />
      ) : showSetup ? (
        <WorkstationSetup
          hw={tauriHardware}
          exec={tauriExecutor}
          sound={sound}
          onSoundChange={setSound}
          onConfigChange={setHardwareConfig}
          {...(legacyCredentialResetBlocked
            ? { credentialResetBlockedReason: t("setup.legacyRepairBlocked") }
            : { onResetCredential: resetCredentialForPairing })}
          onDone={() => {
            setShowSetup(false);
            // Covers both exits from Setup with one line: `finish()` calls
            // `onConfigChange` then `onDone`, and Back calls only `onDone` --
            // either way, whatever session Setup's own "Connect scanner"
            // button left running (possibly on a port that was never saved)
            // must be reconciled against the actually-persisted config.
            setSessionEpoch((epoch) => epoch + 1);
          }}
        />
      ) : showConflicts ? (
        <ConflictList exec={tauriExecutor} onBack={() => setShowConflicts(false)} />
      ) : shift ? (
        shiftContext ? (
          <WorkScreen
            exec={tauriExecutor}
            shiftId={shift.id}
            terminalId={config.deviceId ?? null}
            operatorId={operator.operatorId}
            expectedGtin14={shiftContext.gtin14}
            productName={shiftContext.productName}
            counterpartyName={shiftContext.counterpartyName}
            source={scanSource}
            sound={sound}
            onScanRecorded={nudgeSync}
            onScanQueueRegister={registerFloorWorkBarrier}
            onExit={() => {
              // Both cleared together: `floorView` is separate state that
              // stays "new" when this shift was entered through NewShift, so
              // clearing only `shift` would re-render NewShift instead of
              // shift selection -- the opposite of what this exit control
              // promises (Finding 5).
              setShift(null);
              setFloorView("select");
            }}
            pendingSync={syncState.pending}
            // Read off `shift_mirror` alongside `shiftContext` above (Task 13
            // review, Finding 1) -- null for a validation-mode shift, or a
            // device the server could not resolve an issuer prefix for,
            // which is exactly what turns WorkScreen's box UI off entirely.
            issuerPrefix={issuerPrefix}
            boxCapacity={boxCapacity}
            verifyPrintedLabel={hardwareConfig.verifyPrintedLabel}
            printing={
              hardwareConfig.printer
                ? {
                    target: hardwareConfig.printer,
                    language: hardwareConfig.printerLanguage,
                    print: (target, bytes) => tauriHardware.print(target, bytes),
                  }
                : null
            }
            onOpenPrinterSetup={openPrintRecoverySetup}
            onPrintRecoveryChange={handlePrintRecoveryChange}
          />
        ) : (
          <main style={{ minHeight: "100%", display: "grid", placeItems: "center" }}>
            <h1 style={{ fontSize: "2rem" }}>{t("shifts.preparing")}</h1>
          </main>
        )
      ) : floorView === "select" ? (
        <ShiftSelection
          client={activeClient}
          onSelected={handleShiftEntered}
          isCurrent={() =>
            floorGeneration ? credentialGenerationIsCurrent(floorGeneration) : false
          }
          onNew={() => setFloorView("new")}
          onSetup={() => setShowSetup(true)}
          onConflicts={() => setShowConflicts(true)}
        />
      ) : (
        <NewShift
          client={activeClient}
          source={scanSource}
          onStarted={handleShiftEntered}
          onBack={() => setFloorView("select")}
        />
      )}
    </FloorShell>
  );
}
