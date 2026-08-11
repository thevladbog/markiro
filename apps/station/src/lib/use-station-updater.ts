import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  automaticCheckDue,
  loadUpdateState,
  recordCheckAttempt,
  recordCheckSuccess,
  saveUpdateState,
  updateSeverity,
  type KnownStationUpdate,
  type PersistedUpdateState,
  type UpdateSeverity,
} from "./update-state.js";
import type { SqlExecutor } from "./mirror.js";

export type StationUpdateDownloadEvent =
  | { event: "Started"; contentLength: number | null }
  | { event: "Progress"; chunkLength: number }
  | { event: "Finished" };

export interface StationUpdateHandle {
  currentVersion: string;
  version: string;
  publishedAt: string;
  downloadAndInstall(onProgress: (event: StationUpdateDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export interface StationUpdaterPort {
  check(): Promise<StationUpdateHandle | null>;
  relaunch(): Promise<void>;
}

export type StationUpdatePhase = "idle" | "checking" | "downloading" | "installing" | "restarting";
export type StationUpdateError =
  | "check-failed"
  | "invalid-metadata"
  | "state-write-failed"
  | "active-shift"
  | "target-changed"
  | "install-failed";

export interface StationUpdaterSnapshot {
  phase: StationUpdatePhase;
  persisted: PersistedUpdateState | null;
  severity: UpdateSeverity;
  error: StationUpdateError | null;
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface StationUpdaterController extends StationUpdaterSnapshot {
  checkNow(): Promise<void>;
  install(): Promise<void>;
}

export interface UseStationUpdaterDeps {
  enabled: boolean;
  exec: SqlExecutor;
  activeShift: boolean;
  pendingOutbox: number;
  port: StationUpdaterPort;
  now?: () => number;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(value);
    if (!match) throw new Error("invalid station update state");
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.length; index += 1) {
    const leftValue = a[index] ?? 0;
    const rightValue = b[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function toIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function availableFromHandle(handle: StationUpdateHandle): KnownStationUpdate {
  return { version: handle.version, publishedAt: handle.publishedAt };
}

export function useStationUpdater({
  enabled,
  exec,
  activeShift,
  pendingOutbox: _pendingOutbox,
  port,
  now = Date.now,
}: UseStationUpdaterDeps): StationUpdaterController {
  const [persisted, setPersisted] = useState<PersistedUpdateState | null>(null);
  const [phase, setPhase] = useState<StationUpdatePhase>("idle");
  const [error, setError] = useState<StationUpdateError | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const handleRef = useRef<StationUpdateHandle | null>(null);
  const persistedRef = useRef<PersistedUpdateState | null>(null);
  const timerRef = useRef<number | null>(null);

  const applyState = useCallback((next: PersistedUpdateState | null) => {
    persistedRef.current = next;
    setPersisted(next);
  }, []);

  const save = useCallback(
    async (next: PersistedUpdateState): Promise<boolean> => {
      try {
        await saveUpdateState(exec, next);
        applyState(next);
        return true;
      } catch {
        setError("state-write-failed");
        return false;
      }
    },
    [applyState, exec],
  );

  const runCheck = useCallback(
    async (force: boolean): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const runGeneration = generation.current;
      const task = (async () => {
        if (!force && !automaticCheckDue(now(), persistedRef.current)) return;
        setPhase("checking");
        setError(null);
        const attemptedAt = toIso(now);
        const attempted = recordCheckAttempt(persistedRef.current, attemptedAt);
        await save(attempted);
        let handle: StationUpdateHandle | null = null;
        try {
          handle = await port.check();
          if (runGeneration !== generation.current) return;
          if (handleRef.current && handleRef.current !== handle) await handleRef.current.close();
          handleRef.current = handle;
          const next = recordCheckSuccess(
            attempted,
            toIso(now),
            handle ? availableFromHandle(handle) : null,
          );
          await save(next);
          setPhase("idle");
          setDownloadedBytes(0);
          setTotalBytes(null);
        } catch {
          if (handle) await handle.close().catch(() => undefined);
          if (runGeneration === generation.current) {
            setError("check-failed");
            setPhase("idle");
          }
        }
      })();
      inFlight.current = task;
      try {
        await task;
      } finally {
        if (inFlight.current === task) inFlight.current = null;
      }
    },
    [now, port, save],
  );

  const checkNow = useCallback(() => runCheck(true), [runCheck]);

  const install = useCallback(async (): Promise<void> => {
    if (activeShift) {
      setError("active-shift");
      throw new Error("active shift");
    }
    const target = persistedRef.current?.available;
    if (!target) return;
    setError(null);
    let handle: StationUpdateHandle | null = null;
    try {
      handle = await port.check();
      if (!handle || compareVersions(handle.version, target.version) < 0) {
        if (handle) await handle.close();
        setError("target-changed");
        throw new Error("target changed");
      }
      setDownloadedBytes(0);
      setTotalBytes(null);
      setPhase("downloading");
      await handle.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setTotalBytes(event.contentLength);
          setDownloadedBytes(0);
        } else if (event.event === "Progress") {
          setDownloadedBytes((current) => current + event.chunkLength);
        }
      });
      await handle.close();
      setPhase("installing");
      setPhase("restarting");
      await port.relaunch();
    } catch (caught) {
      if (handle) await handle.close().catch(() => undefined);
      if (
        (caught as Error).message === "active shift" ||
        (caught as Error).message === "target changed"
      )
        throw caught;
      setError("install-failed");
      setPhase("idle");
      throw caught;
    }
  }, [activeShift, port]);

  useEffect(() => {
    if (!enabled) return undefined;
    const currentGeneration = ++generation.current;
    let cancelled = false;
    void (async () => {
      const loaded = await loadUpdateState(exec);
      if (cancelled || currentGeneration !== generation.current) return;
      applyState(loaded);
      await runCheck(false);
    })();
    return () => {
      cancelled = true;
      generation.current += 1;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [applyState, enabled, exec, runCheck]);

  useEffect(() => {
    if (!enabled || !persisted?.lastAttemptAt) return undefined;
    const delay = Math.max(0, AUTO_CHECK_DELAY(persisted.lastAttemptAt, now()));
    timerRef.current = window.setTimeout(
      () => void runCheck(false),
      Math.min(delay, 2_147_483_647),
    );
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [enabled, now, persisted?.lastAttemptAt, runCheck]);

  const severity = useMemo(() => {
    try {
      return updateSeverity(now(), persisted?.available ?? null);
    } catch {
      return "none" as const;
    }
  }, [now, persisted?.available]);

  return { phase, persisted, severity, error, downloadedBytes, totalBytes, checkNow, install };
}

function AUTO_CHECK_DELAY(lastAttemptAt: string, now: number): number {
  return Math.max(0, Date.parse(lastAttemptAt) + 86_400_000 - now);
}
