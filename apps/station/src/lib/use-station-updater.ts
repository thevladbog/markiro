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
  | "policy-denied"
  | "check-superseded"
  | "candidate-invalid"
  | "internal-error"
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
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
}

export interface UseStationUpdaterDeps {
  enabled: boolean;
  updateCenterVisible: boolean;
  exec: SqlExecutor;
  activeShift: boolean;
  pendingOutbox: number;
  port: StationUpdaterPort;
  now?: () => number;
  updateOperationBlocked?: () => boolean;
  activeShiftGuard?: () => boolean;
}

function toIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function availableFromHandle(handle: StationUpdateHandle): KnownStationUpdate {
  return { version: handle.version, publishedAt: handle.publishedAt };
}

function controllerError(caught: unknown): StationUpdateError {
  if (caught instanceof StationUpdaterCommandError) {
    const mapped: Record<StationUpdaterCommandErrorCode, StationUpdateError> = {
      "origins-unavailable": "check-failed",
      "origin-mismatch": "origin-mismatch",
      "integrity-failed": "integrity-failed",
      "policy-denied": "policy-denied",
      "check-superseded": "check-superseded",
      "candidate-invalid": "candidate-invalid",
      "candidate-expired": "candidate-invalid",
      "installation-failed": "install-failed",
      internal: "internal-error",
    };
    return mapped[caught.code];
  }
  if (
    caught instanceof Error &&
    /^invalid station update (result|error|progress)$/.test(caught.message)
  ) {
    return "invalid-metadata";
  }
  return "internal-error";
}

function availabilityFailure(caught: unknown): boolean {
  return caught instanceof StationUpdaterCommandError && caught.code === "origins-unavailable";
}

class StationUpdateOperationCancelled extends Error {
  constructor() {
    super("station update operation cancelled");
    this.name = "StationUpdateOperationCancelled";
  }
}

export function useStationUpdater({
  enabled,
  updateCenterVisible,
  exec,
  activeShift,
  pendingOutbox: _pendingOutbox,
  port,
  now = Date.now,
  updateOperationBlocked,
  activeShiftGuard,
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
  const checkInFlight = useRef<Promise<void> | null>(null);
  const installInFlight = useRef<Promise<void> | null>(null);
  const handleRef = useRef<StationUpdateHandle | null>(null);
  const closedHandles = useRef(new WeakMap<StationUpdateHandle, Promise<void>>());
  const persistedRef = useRef<PersistedUpdateState | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeShiftRef = useRef(activeShift);
  const updateCenterVisibleRef = useRef(updateCenterVisible);
  const previousActiveShift = useRef(activeShift);
  const previousUpdateCenterVisible = useRef(updateCenterVisible);
  const updateOperationBlockedRef = useRef(updateOperationBlocked);
  const activeShiftGuardRef = useRef(activeShiftGuard);
  activeShiftRef.current = activeShift;
  updateCenterVisibleRef.current = updateCenterVisible;
  updateOperationBlockedRef.current = updateOperationBlocked;
  activeShiftGuardRef.current = activeShiftGuard;

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

  const closeHandle = useCallback((handle: StationUpdateHandle): Promise<void> => {
    const existing = closedHandles.current.get(handle);
    if (existing) return existing;
    let closing: Promise<void>;
    try {
      closing = handle.close();
    } catch (error) {
      closing = Promise.reject(error instanceof Error ? error : new Error("update close failed"));
    }
    closedHandles.current.set(handle, closing);
    return closing;
  }, []);

  const closeCurrentHandle = useCallback(
    async (clearProvenance = true): Promise<void> => {
      const current = handleRef.current;
      handleRef.current = null;
      if (clearProvenance) clearCandidateProvenance();
      if (current) await closeHandle(current);
    },
    [clearCandidateProvenance, closeHandle],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const cancelGeneration = ++generation.current;
    const current = handleRef.current;
    handleRef.current = null;
    clearCandidateProvenance();
    const closing = current ? closeHandle(current) : Promise.resolve();
    const installing = installInFlight.current ?? Promise.resolve();
    await Promise.allSettled([closing, installing]);
    if (generation.current === cancelGeneration) setPhase("idle");
  }, [clearCandidateProvenance, closeHandle]);

  const runCheck = useCallback(
    async (force: boolean): Promise<void> => {
      if (updateOperationBlockedRef.current?.()) return;
      if (checkInFlight.current) return checkInFlight.current;
      if (installInFlight.current) return installInFlight.current;
      const runGeneration = generation.current;
      const task = (async () => {
        if (!force && !automaticCheckDue(now(), persistedRef.current)) return;
        setPhase("checking");
        setError(null);
        clearCandidateProvenance();
        try {
          await closeCurrentHandle();
        } catch (caught) {
          if (runGeneration === generation.current) {
            let nextError = controllerError(caught);
            const attempted = recordCheckAttempt(persistedRef.current, toIso(now));
            const next = availabilityFailure(caught)
              ? attempted
              : { ...attempted, available: null };
            try {
              await saveUpdateState(exec, next);
              if (runGeneration === generation.current) applyState(next);
            } catch {
              nextError = "state-write-failed";
            }
            if (runGeneration !== generation.current) return;
            setError(nextError);
            setPhase("idle");
          }
          return;
        }
        if (runGeneration !== generation.current) return;
        const attemptedAt = toIso(now);
        const attempted = recordCheckAttempt(persistedRef.current, attemptedAt);
        try {
          await saveUpdateState(exec, attempted);
        } catch {
          if (runGeneration === generation.current) {
            setError("state-write-failed");
            setPhase("idle");
          }
          return;
        }
        if (runGeneration !== generation.current) return;
        applyState(attempted);
        let handle: StationUpdateHandle | null = null;
        try {
          handle = await port.check();
          if (runGeneration !== generation.current) {
            if (handle) await closeHandle(handle).catch(() => undefined);
            return;
          }
          const next = recordCheckSuccess(
            attempted,
            toIso(now),
            handle ? availableFromHandle(handle) : null,
          );
          try {
            await saveUpdateState(exec, next);
          } catch {
            if (handle) await closeHandle(handle).catch(() => undefined);
            if (runGeneration === generation.current) {
              clearCandidateProvenance();
              setError("state-write-failed");
              setPhase("idle");
            }
            return;
          }
          if (runGeneration !== generation.current) {
            if (handle) await closeHandle(handle).catch(() => undefined);
            return;
          }
          applyState(next);
          handleRef.current = handle;
          if (handle) applyCandidateProvenance(handle);
          setPhase("idle");
          setDownloadedBytes(0);
          setTotalBytes(null);
        } catch (caught) {
          if (handle) await closeHandle(handle).catch(() => undefined);
          if (handleRef.current === handle) handleRef.current = null;
          if (runGeneration === generation.current) {
            clearCandidateProvenance();
            let nextError = controllerError(caught);
            if (!availabilityFailure(caught)) {
              const withoutCandidate = { ...attempted, available: null };
              try {
                await saveUpdateState(exec, withoutCandidate);
                if (runGeneration === generation.current) applyState(withoutCandidate);
              } catch {
                nextError = "state-write-failed";
              }
            }
            if (runGeneration === generation.current) {
              setError(nextError);
              setPhase("idle");
            }
          }
        }
      })();
      checkInFlight.current = task;
      try {
        await task;
      } finally {
        if (checkInFlight.current === task) checkInFlight.current = null;
      }
    },
    [
      applyCandidateProvenance,
      applyState,
      clearCandidateProvenance,
      closeCurrentHandle,
      closeHandle,
      exec,
      now,
      port,
    ],
  );

  const checkNow = useCallback(() => runCheck(true), [runCheck]);

  const install = useCallback((): Promise<void> => {
    if (updateOperationBlockedRef.current?.()) {
      return Promise.reject(new Error("station update operation blocked"));
    }
    if (installInFlight.current) return installInFlight.current;
    if (activeShiftRef.current || activeShiftGuardRef.current?.()) {
      setError("active-shift");
      return cancel().then(() => {
        setError("active-shift");
        throw new Error("active shift");
      });
    }
    if (!updateCenterVisibleRef.current) {
      return Promise.reject(new StationUpdateOperationCancelled());
    }
    const target = persistedRef.current?.available;
    if (!target) return Promise.resolve();
    const installGeneration = ++generation.current;
    const targetChanged = new Error("target changed");
    const operation = (async () => {
      setPhase("checking");
      setError(null);
      clearCandidateProvenance();
      setDownloadedBytes(0);
      setTotalBytes(null);
      let handle: StationUpdateHandle | null = null;
      const current = (): boolean =>
        generation.current === installGeneration &&
        updateCenterVisibleRef.current &&
        !activeShiftRef.current;
      try {
        await closeCurrentHandle();
        if (!current()) throw new StationUpdateOperationCancelled();
        handle = await port.check();
        if (!current()) {
          if (handle) await closeHandle(handle).catch(() => undefined);
          handle = null;
          throw new StationUpdateOperationCancelled();
        }
        if (
          !handle ||
          compareStationVersions(handle.version, target.version) !== 0 ||
          handle.publishedAt !== target.publishedAt
        ) {
          if (handle) await closeHandle(handle).catch(() => undefined);
          handle = null;
          throw targetChanged;
        }
        handleRef.current = handle;
        applyCandidateProvenance(handle);
        if (!current()) throw new StationUpdateOperationCancelled();
        setPhase("downloading");
        await handle.downloadAndInstall((event) => {
          if (!current() || handleRef.current !== handle) return;
          if (event.event === "Started") {
            setTotalBytes((known) => known ?? event.contentLength);
          } else if (event.event === "Progress") {
            setDownloadedBytes((downloaded) => downloaded + event.chunkLength);
          } else if (event.event === "Fallback") {
            setPackageFallbackReason(event.reason);
          } else {
            setPhase("installing");
          }
        });
        if (!current()) throw new StationUpdateOperationCancelled();
        await closeCurrentHandle(false);
        handle = null;
        if (!current()) throw new StationUpdateOperationCancelled();
        setPhase("restarting");
        await port.relaunch();
      } catch (caught) {
        if (handleRef.current === handle) {
          handleRef.current = null;
        }
        if (handle) await closeHandle(handle).catch(() => undefined);
        clearCandidateProvenance();
        setPhase("idle");
        if (caught instanceof StationUpdateOperationCancelled) throw caught;
        if (caught === targetChanged) {
          setError("target-changed");
          throw caught;
        }
        setError(controllerError(caught));
        throw caught;
      }
    })();
    const task = operation.finally(() => {
      if (installInFlight.current === task) installInFlight.current = null;
    });
    installInFlight.current = task;
    return task;
  }, [
    applyCandidateProvenance,
    cancel,
    clearCandidateProvenance,
    closeCurrentHandle,
    closeHandle,
    port,
  ]);

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
      void cancel();
    };
  }, [applyState, cancel, enabled, exec, runCheck]);

  useEffect(() => {
    const wasActive = previousActiveShift.current;
    previousActiveShift.current = activeShift;
    if (!wasActive && activeShift) void cancel();
  }, [activeShift, cancel]);

  useEffect(() => {
    const wasVisible = previousUpdateCenterVisible.current;
    previousUpdateCenterVisible.current = updateCenterVisible;
    if (wasVisible && !updateCenterVisible) void cancel();
  }, [cancel, updateCenterVisible]);

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
    cancel,
  };
}

function AUTO_CHECK_DELAY(lastAttemptAt: string, now: number): number {
  return Math.max(0, Date.parse(lastAttemptAt) + 86_400_000 - now);
}
