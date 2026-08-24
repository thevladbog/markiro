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
import { compareStationVersions } from "./station-version.js";

export type StationUpdateOrigin = "yandex" | "github";
export type StationUpdateFallbackReason = "primary-unavailable" | "primary-metadata-invalid";
export type StationUpdatePackageFallbackReason = "http" | "network" | "timeout";

export type StationUpdateDownloadEvent =
  | { event: "Started"; contentLength: number | null }
  | { event: "Progress"; chunkLength: number }
  | {
      event: "Fallback";
      from: "yandex";
      to: "github";
      reason: StationUpdatePackageFallbackReason;
    }
  | { event: "Finished" };

export interface StationUpdateHandle {
  currentVersion: string;
  version: string;
  publishedAt: string;
  origin: StationUpdateOrigin;
  fallbackReason: StationUpdateFallbackReason | null;
  downloadAndInstall(onProgress: (event: StationUpdateDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export interface StationUpdaterPort {
  check(): Promise<StationUpdateHandle | null>;
  relaunch(): Promise<void>;
}

export type StationUpdaterCommandErrorCode =
  | "origins-unavailable"
  | "origin-mismatch"
  | "integrity-failed"
  | "policy-denied"
  | "check-superseded"
  | "candidate-invalid"
  | "candidate-expired"
  | "installation-failed"
  | "internal";

export class StationUpdaterCommandError extends Error {
  readonly code: StationUpdaterCommandErrorCode;
  readonly retryable: boolean;

  constructor(code: StationUpdaterCommandErrorCode, retryable: boolean) {
    super("station update request failed");
    this.name = "StationUpdaterCommandError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type StationUpdatePhase = "idle" | "checking" | "downloading" | "installing" | "restarting";
export type StationUpdateError =
  | "check-failed"
  | "invalid-metadata"
  | "state-write-failed"
  | "active-shift"
  | "target-changed"
  | "origin-mismatch"
  | "integrity-failed"
  | "install-failed";

export interface StationUpdaterSnapshot {
  phase: StationUpdatePhase;
  persisted: PersistedUpdateState | null;
  severity: UpdateSeverity;
  error: StationUpdateError | null;
  origin: StationUpdateOrigin | null;
  fallbackReason: StationUpdateFallbackReason | null;
  packageFallbackReason: StationUpdatePackageFallbackReason | null;
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

function toIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function availableFromHandle(handle: StationUpdateHandle): KnownStationUpdate {
  return { version: handle.version, publishedAt: handle.publishedAt };
}

function controllerError(
  caught: unknown,
  fallback: "check-failed" | "install-failed",
): StationUpdateError {
  if (caught instanceof StationUpdaterCommandError) {
    if (caught.code === "origin-mismatch") return "origin-mismatch";
    if (caught.code === "integrity-failed") return "integrity-failed";
    return fallback;
  }
  if (
    caught instanceof Error &&
    /^invalid station update (result|progress)$/.test(caught.message)
  ) {
    return "invalid-metadata";
  }
  return fallback;
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
  const [origin, setOrigin] = useState<StationUpdateOrigin | null>(null);
  const [fallbackReason, setFallbackReason] = useState<StationUpdateFallbackReason | null>(null);
  const [packageFallbackReason, setPackageFallbackReason] =
    useState<StationUpdatePackageFallbackReason | null>(null);
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

  const clearCandidateProvenance = useCallback(() => {
    setOrigin(null);
    setFallbackReason(null);
    setPackageFallbackReason(null);
  }, []);

  const applyCandidateProvenance = useCallback((handle: StationUpdateHandle) => {
    setOrigin(handle.origin);
    setFallbackReason(handle.fallbackReason);
    setPackageFallbackReason(null);
  }, []);

  const closeCurrentHandle = useCallback(async (): Promise<void> => {
    const current = handleRef.current;
    handleRef.current = null;
    await current?.close();
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
        clearCandidateProvenance();
        await closeCurrentHandle().catch(() => undefined);
        const attemptedAt = toIso(now);
        const attempted = recordCheckAttempt(persistedRef.current, attemptedAt);
        await save(attempted);
        let handle: StationUpdateHandle | null = null;
        try {
          handle = await port.check();
          if (runGeneration !== generation.current) {
            await handle?.close().catch(() => undefined);
            return;
          }
          handleRef.current = handle;
          if (handle) applyCandidateProvenance(handle);
          const next = recordCheckSuccess(
            attempted,
            toIso(now),
            handle ? availableFromHandle(handle) : null,
          );
          await save(next);
          setPhase("idle");
          setDownloadedBytes(0);
          setTotalBytes(null);
        } catch (caught) {
          if (handle) await handle.close().catch(() => undefined);
          if (handleRef.current === handle) handleRef.current = null;
          if (runGeneration === generation.current) {
            clearCandidateProvenance();
            setError(controllerError(caught, "check-failed"));
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
    [applyCandidateProvenance, clearCandidateProvenance, closeCurrentHandle, now, port, save],
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
    clearCandidateProvenance();
    await closeCurrentHandle().catch(() => undefined);
    let handle: StationUpdateHandle | null = null;
    try {
      handle = await port.check();
      if (
        !handle ||
        compareStationVersions(handle.version, target.version) !== 0 ||
        handle.publishedAt !== target.publishedAt
      ) {
        await handle?.close().catch(() => undefined);
        handle = null;
        setError("target-changed");
        throw new Error("target changed");
      }
      handleRef.current = handle;
      applyCandidateProvenance(handle);
      setDownloadedBytes(0);
      setTotalBytes(null);
      setPhase("downloading");
      await handle.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setTotalBytes(event.contentLength);
          setDownloadedBytes(0);
        } else if (event.event === "Progress") {
          setDownloadedBytes((current) => current + event.chunkLength);
        } else if (event.event === "Fallback") {
          setPackageFallbackReason(event.reason);
        }
      });
      await closeCurrentHandle();
      handle = null;
      setPhase("installing");
      setPhase("restarting");
      await port.relaunch();
    } catch (caught) {
      if (handleRef.current === handle) await closeCurrentHandle().catch(() => undefined);
      else if (handle) await handle.close().catch(() => undefined);
      if (
        (caught as Error).message === "active shift" ||
        (caught as Error).message === "target changed"
      ) {
        throw caught;
      }
      setError(controllerError(caught, "install-failed"));
      setPhase("idle");
      throw caught;
    }
  }, [activeShift, applyCandidateProvenance, clearCandidateProvenance, closeCurrentHandle, port]);

  useEffect(() => {
    if (!enabled) return undefined;
    const currentGeneration = ++generation.current;
    let cancelled = false;
    void (async () => {
      const loaded = await loadUpdateState(exec);
      if (cancelled || currentGeneration !== generation.current) return;
      applyState(loaded);
      await runCheck(Boolean(loaded?.available));
    })();
    return () => {
      cancelled = true;
      generation.current += 1;
      void closeCurrentHandle().catch(() => undefined);
    };
  }, [applyState, closeCurrentHandle, enabled, exec, runCheck]);

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

  return {
    phase,
    persisted,
    severity,
    error,
    origin,
    fallbackReason,
    packageFallbackReason,
    downloadedBytes,
    totalBytes,
    checkNow,
    install,
  };
}

function AUTO_CHECK_DELAY(lastAttemptAt: string, now: number): number {
  return Math.max(0, Date.parse(lastAttemptAt) + 86_400_000 - now);
}
