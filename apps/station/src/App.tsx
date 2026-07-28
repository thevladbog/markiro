import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OperatorMirrorRecord } from "@markiro/db";
import { isEnrolled, readConfig, type StationConfig } from "./lib/config.js";
import { createStationClient } from "./lib/api-client.js";
import {
  DEFAULT_HARDWARE_CONFIG,
  loadHardwareConfig,
  type HardwareConfig,
} from "./lib/hardware-config.js";
import { createHardwareScanSource, tauriHardware, type ScannerStatus } from "./lib/hardware.js";
import { applyMigrations, readShiftContext, type ShiftContextRow } from "./lib/mirror.js";
import { mirrorShiftBundle } from "./lib/shift-bundle.js";
import { syncOperatorRoster } from "./lib/roster-sync.js";
import { createKeyboardWedgeSource } from "./lib/scan-source.js";
import { loadSoundSettings, type SoundSettings } from "./lib/signal-sound.js";
import { tauriExecutor } from "./lib/sqlite.js";
import { Enrollment } from "./pages/Enrollment.js";
import { OperatorLogin } from "./pages/OperatorLogin.js";
import { ShiftSelection } from "./pages/ShiftSelection.js";
import { NewShift } from "./pages/NewShift.js";
import { WorkScreen } from "./pages/WorkScreen.js";
import { WorkstationSetup } from "./pages/WorkstationSetup.js";
import { FloorShell } from "./ui/FloorShell.js";
import type { ScannerIndicator } from "./ui/StatusBar.js";

interface ActiveShift {
  id: string;
  status: string;
  mode: string;
}

/**
 * Pure routing decision for the top-level App state machine, factored out so
 * it is unit-testable without rendering (jsdom has no real Tauri runtime, so
 * a full App render needs `invoke` mocked end-to-end; this function captures
 * the actual branch logic App renders from).
 *
 * - No config yet (still reading it on mount) -> "loading".
 * - Config present but the device has no tenant/key/server -> "enrollment".
 * - Enrolled but no operator has signed in this session -> "login".
 * - Enrolled + signed in -> "floor" (ShiftSelection/NewShift/active-shift area).
 */
export function nextStationView(
  config: StationConfig | null,
  operator: OperatorMirrorRecord | null,
): "loading" | "enrollment" | "login" | "floor" {
  if (!config) return "loading";
  if (!isEnrolled(config)) return "enrollment";
  if (!operator) return "login";
  return "floor";
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
  const [operator, setOperator] = useState<OperatorMirrorRecord | null>(null);
  const [floorView, setFloorView] = useState<"select" | "new">("select");
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [sound, setSound] = useState<SoundSettings>({ muted: false, volume: 1 });
  const [shiftContext, setShiftContext] = useState<ShiftContextRow | null>(null);
  const [hardwareConfig, setHardwareConfig] = useState<HardwareConfig>(DEFAULT_HARDWARE_CONFIG);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [showSetup, setShowSetup] = useState(false);
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

  useEffect(() => {
    void loadSoundSettings(tauriExecutor).then(setSound);
  }, []);

  useEffect(() => {
    void loadHardwareConfig(tauriExecutor).then(setHardwareConfig);
  }, []);

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
  const scanSource = pickScanSource(hardwareConfig) === "hardware" ? hardwareSource : wedgeSource;

  useEffect(() => {
    if (!shift) {
      setShiftContext(null);
      return;
    }
    let cancelled = false;
    // mirrorShiftBundle writes in the background, so poll briefly until the
    // product row lands rather than blocking shift entry on the network.
    const tick = setInterval(() => {
      void readShiftContext(tauriExecutor, shift.id)
        .then((ctx) => {
          if (cancelled || !ctx) return;
          setShiftContext(ctx);
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
      if (!cancelled) setConfig(cfg);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Memoized (keyed on apiKey+serverUrl, not the whole `config` object, which
  // is a fresh reference on every `readConfig()`/`refreshConfig()` call) so
  // ShiftSelection's fetch-on-mount effect (keyed on `client`) does not
  // refetch on every render — e.g. every online/offline flap re-renders App.
  // Must run unconditionally (before the `!config` early return below) to
  // respect the Rules of Hooks; it degrades to `null` until enrolled.
  const client = useMemo(
    () => (config?.apiKey && config.serverUrl ? createStationClient(config) : null),
    [config?.apiKey, config?.serverUrl],
  );

  // Initialization sync: as soon as the device has a credential — right after
  // enrollment, and on every later start — pull the operator roster so the
  // sign-in screen has someone to authenticate. Without this a freshly
  // enrolled station shows a PIN pad no PIN can ever satisfy.
  useEffect(() => {
    if (!client) return;
    void syncOperatorRoster(client, tauriExecutor);
  }, [client]);

  // Retry: the initial sync above runs exactly once, so a device that is
  // briefly offline at that moment would otherwise strand the operator at a
  // PIN pad no PIN can satisfy until the app is restarted. Re-running on
  // every `online` event is a cheap one-shot retry (`syncOperatorRoster`
  // never throws), not a polling loop.
  useEffect(() => {
    if (!client) return;
    const retrySync = () => void syncOperatorRoster(client, tauriExecutor);
    window.addEventListener("online", retrySync);
    return () => window.removeEventListener("online", retrySync);
  }, [client]);

  async function refreshConfig() {
    setConfig(await readConfig());
  }

  if (!config) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <h1 style={{ fontSize: "2rem" }}>{t("app.booting")}</h1>
      </main>
    );
  }

  // `config` is narrowed to non-null for the rest of this render.
  const stage = nextStationView(config, operator);

  if (stage === "enrollment") {
    return <Enrollment machineId={config.machineId} onEnrolled={() => void refreshConfig()} />;
  }

  if (stage === "login") {
    return <OperatorLogin exec={tauriExecutor} onAuthed={setOperator} />;
  }

  // stage === "floor" here, which requires `isEnrolled(config)` (apiKey +
  // serverUrl truthy) — the same condition the `client` memo above builds
  // from, so it is guaranteed non-null in this branch.
  const activeClient = client!;

  // Shared by ShiftSelection's `onSelected` and NewShift's `onStarted`: the
  // shift is entered immediately (never blocked on the network), and the
  // bundle download + SQLite mirror happens in the background so it's
  // available offline afterward. See `mirrorShiftBundle` for the
  // resilience contract (a download failure must not block entry).
  function handleShiftEntered(entered: ActiveShift) {
    setShift(entered);
    void mirrorShiftBundle(activeClient, tauriExecutor, entered.id);
  }

  return (
    // The scanner reads green only once the Rust side has confirmed a port
    // is actually open; the printer only reflects whether one is configured,
    // since it cannot be proven alive without printing to it.
    <FloorShell
      online={online}
      scanner={scannerIndicator(hardwareConfig, scannerStatus)}
      printerConfigured={hardwareConfig.printer !== null}
      tasks={[]}
      activeTaskId=""
      onSelectTask={() => {}}
    >
      {showSetup ? (
        <WorkstationSetup
          hw={tauriHardware}
          exec={tauriExecutor}
          sound={sound}
          onSoundChange={setSound}
          onConfigChange={setHardwareConfig}
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
      ) : shift ? (
        shiftContext ? (
          <WorkScreen
            exec={tauriExecutor}
            shiftId={shift.id}
            terminalId={config.deviceId ?? null}
            expectedGtin14={shiftContext.gtin14}
            productName={shiftContext.productName}
            counterpartyName={shiftContext.counterpartyName}
            source={scanSource}
            sound={sound}
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
          onNew={() => setFloorView("new")}
          onSetup={() => setShowSetup(true)}
        />
      ) : (
        <NewShift
          client={activeClient}
          onStarted={handleShiftEntered}
          onBack={() => setFloorView("select")}
        />
      )}
    </FloorShell>
  );
}
