import { useCallback, useEffect, useRef, useState } from "react";
import type { StationClient } from "./api-client.js";
import type { SqlExecutor } from "./mirror.js";
import { createSyncEngine, type SyncEngine, type SyncState } from "./sync.js";

/**
 * Nudge the engine even without a triggering event, so a connection that
 * silently recovers (e.g. a captive portal clearing with no `online` event)
 * still drains within a bounded window.
 */
const HEARTBEAT_MS = 15_000;

export interface UseSyncEngineDeps {
  exec: SqlExecutor;
  /** `null` before the device has an API client (not yet enrolled). */
  client: Pick<StationClient, "post"> | null;
  /** `null`/`undefined` whenever `client` is `null`. */
  machineId: string | null | undefined;
}

export interface UseSyncEngineResult {
  /** Latest published sync state (pending count, last success, stuck flag). */
  state: SyncState;
  /**
   * Ask the current engine (if any) for a drain. A no-op before the engine
   * exists. Stable identity across renders, so callers (a scan recorded, the
   * `online` listener) do not need this hook's internals as an effect
   * dependency and keep working across a StrictMode remount.
   *
   * Declared as a property (arrow-typed), not a method shorthand, so
   * destructuring `nudge` off the returned object at call sites does not
   * trip `@typescript-eslint/unbound-method` — it never reads `this`.
   */
  nudge: () => void;
}

/**
 * Owns the sync engine for the life of the app: the outbox belongs to the
 * DEVICE, not to a shift or an operator, so entering or leaving a shift must
 * never stop the drain. The engine is (re)built only when `client` or
 * `machineId` actually change — a shift change, an operator sign-out, an
 * online/offline flap, or a config refresh that leaves both the same must
 * never rebuild it.
 *
 * Construction and teardown are paired inside ONE effect, rather than a
 * `useMemo` paired with a separate cleanup effect, so they are pinned to the
 * same lifecycle event. That pairing matters because React's StrictMode dev
 * double-invoke runs an effect's setup -> cleanup -> setup again without a
 * re-render: if the engine were built by a memo instead, both setups would
 * receive the SAME memoized engine, so the second setup's `nudge()` calls
 * would land on the object the first cleanup just permanently `stop()`ped
 * (`stopped` in sync.ts has no restart path) -- every later nudge (a scan,
 * `online`, this heartbeat) would then be a silent no-op for the rest of the
 * dev session, with the published state frozen at whatever the first publish
 * reported. Here, each cleanup only ever stops the engine ITS OWN setup
 * created, so the second setup's fresh engine is unaffected.
 *
 * Residual: `stop()` prevents an instance's future retries and nudges, but
 * cannot abort a drain already past its first `await`. If the effect were
 * ever torn down mid-drain, an orphaned engine's in-flight batch and a fresh
 * engine's batch could briefly overlap -- inert today because batch ids are
 * deterministic and the server ack is idempotent, but worth naming so nobody
 * assumes `stop()` is instantaneous.
 */
export function useSyncEngine(deps: UseSyncEngineDeps): UseSyncEngineResult {
  const { exec, client, machineId } = deps;
  const [state, setState] = useState<SyncState>({
    pending: 0,
    lastSuccessAt: null,
    stuck: false,
  });
  const engineRef = useRef<SyncEngine | null>(null);

  useEffect(() => {
    if (!client || !machineId) {
      engineRef.current = null;
      return;
    }
    const engine = createSyncEngine({ exec, client, machineId, onState: setState });
    engineRef.current = engine;
    engine.nudge();
    const heartbeat = setInterval(() => engine.nudge(), HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      engine.stop();
      // React always runs a cleanup before the next setup, so the ref can
      // never point at a newer engine here -- this guard just keeps that
      // invariant explicit instead of assumed.
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [exec, client, machineId]);

  const nudge = useCallback(() => {
    engineRef.current?.nudge();
  }, []);

  return { state, nudge };
}
