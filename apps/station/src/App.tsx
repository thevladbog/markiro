import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OperatorMirrorRecord } from "@markiro/db";
import { isEnrolled, readConfig, type StationConfig } from "./lib/config.js";
import { createStationClient } from "./lib/api-client.js";
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
import { FloorShell } from "./ui/FloorShell.js";

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

export function App() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<StationConfig | null>(null);
  const [operator, setOperator] = useState<OperatorMirrorRecord | null>(null);
  const [floorView, setFloorView] = useState<"select" | "new">("select");
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [sound, setSound] = useState<SoundSettings>({ muted: false, volume: 1 });
  const [shiftContext, setShiftContext] = useState<ShiftContextRow | null>(null);

  useEffect(() => {
    void loadSoundSettings(tauriExecutor).then(setSound);
  }, []);

  // The keyboard wedge needs no setup: most USB scanners are HID keyboards.
  // A serial scanner is opted into from the workstation setup screen.
  const scanSource = useMemo(() => createKeyboardWedgeSource(), []);

  useEffect(() => {
    if (!shift) {
      setShiftContext(null);
      return;
    }
    let cancelled = false;
    // mirrorShiftBundle writes in the background, so poll briefly until the
    // product row lands rather than blocking shift entry on the network.
    const tick = setInterval(() => {
      void readShiftContext(tauriExecutor, shift.id).then((ctx) => {
        if (cancelled || !ctx) return;
        setShiftContext(ctx);
        clearInterval(tick);
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
    // scannerConnected is true because `scanSource` above is always the
    // keyboard wedge, which needs no hardware handshake to be usable; a
    // serial scanner's live connection state belongs to WorkstationSetup, not
    // the floor shell. printerConfigured is false because no printer target
    // is persisted anywhere yet (a future slice).
    <FloorShell
      online={online}
      scannerConnected
      printerConfigured={false}
      tasks={[]}
      activeTaskId=""
      onSelectTask={() => {}}
    >
      {shift ? (
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
