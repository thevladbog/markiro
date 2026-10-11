import { useEffect, useRef } from "react";

/** The wait between reads of a copy that has just started. */
export const BACKUP_POLL_MS = 1000;
/** The wait between reads of a page where nothing runs: scheduled copies still change it. */
export const BACKUP_IDLE_POLL_MS = 60_000;
/** The longest wait after failed reads. */
const FAILURE_POLL_MAX_MS = 30_000;

/**
 * How long to wait before the next read. A running copy is read every second
 * for ten reads, every two seconds for twenty more, then every five: a copy
 * that takes minutes does not need a request per second. Every failed read
 * in a row doubles the wait from two seconds up to half a minute, but never
 * below the usual wait: a host that does not answer is not asked harder.
 */
export function pollDelay(running: boolean, polls: number, failures: number): number {
  let base = BACKUP_IDLE_POLL_MS;
  if (running) base = polls < 10 ? BACKUP_POLL_MS : polls < 30 ? 2000 : 5000;
  if (failures === 0) return base;
  return Math.max(base, Math.min(FAILURE_POLL_MAX_MS, 2000 * 2 ** (failures - 1)));
}

export interface BackupPollingOptions {
  /** Whether to read at all; a page that has no state yet does not. */
  enabled: boolean;
  /** Whether a copy runs, by the last state read. */
  running: boolean;
}

/**
 * Reads the state of the copies again and again for as long as the page is
 * mounted: quickly while a copy runs, once a minute otherwise. `poll`
 * resolves `true` when the read worked. The next read is scheduled after the
 * last one ends, so reads never pile up; it waits while the window is hidden
 * (a minimised or covered window needs no fresh figures) and reads at once
 * when the window comes back; unmounting clears the timer, and a read that
 * ends afterwards schedules nothing.
 */
export function useBackupPolling(
  poll: () => Promise<boolean>,
  { enabled, running }: BackupPollingOptions,
): void {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let failures = 0;

    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void tick(), pollDelay(running, polls, failures));
    };
    const tick = async () => {
      timer = undefined;
      inFlight = true;
      let worked: boolean;
      try {
        worked = await pollRef.current();
      } catch {
        worked = false;
      }
      inFlight = false;
      if (stopped) return;
      polls += 1;
      failures = worked ? 0 : failures + 1;
      schedule();
    };
    const onVisibility = () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && !inFlight) {
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, running]);
}
