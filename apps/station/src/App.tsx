import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OperatorMirrorRecord } from "@markiro/db";
import { isEnrolled, readConfig, type StationConfig } from "./lib/config.js";
import { createStationClient } from "./lib/api-client.js";
import { applyMigrations } from "./lib/mirror.js";
import { mirrorShiftBundle } from "./lib/shift-bundle.js";
import { tauriExecutor } from "./lib/sqlite.js";
import { Enrollment } from "./pages/Enrollment.js";
import { OperatorLogin } from "./pages/OperatorLogin.js";
import { ShiftSelection } from "./pages/ShiftSelection.js";
import { NewShift } from "./pages/NewShift.js";
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
    <FloorShell online={online} tasks={[]} activeTaskId="" onSelectTask={() => {}}>
      {shift ? (
        <main style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 32 }}>
          <h1 style={{ fontSize: "2rem" }}>{t("shifts.active")}</h1>
          <p>{shift.id}</p>
        </main>
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
