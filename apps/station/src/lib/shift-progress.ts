import { z } from "zod";
import { StationApiError, type StationClient } from "./api-client.js";
import type { SqlExecutor } from "./mirror.js";

/**
 * The shift-wide total of the work screen's band (design 2026-09-25). The
 * server answers how many units the whole shift holds and how many of them
 * belong to this device; this terminal's own count is always the live local
 * one, so own scans and corrections move the number immediately and the
 * other terminals arrive with the next answer.
 */
export interface ShiftProgressSnapshot {
  shiftId: string;
  acceptedUnits: number;
  deviceAcceptedUnits: number;
  /** Server transaction time of the answer. */
  asOf: string;
  /** Wall-clock time this station received the answer. */
  fetchedAt: string;
}

export const SHIFT_PROGRESS_META_KEY = "shift_progress";
export const SHIFT_PROGRESS_INTERVAL_MS = 15_000;
export const SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS = 10 * 60_000;
export const SHIFT_PROGRESS_STALE_AFTER_MS = 2 * 60_000;

const count = z.number().int().nonnegative();
const answerSchema = z
  .object({
    shiftId: z.string().min(1),
    acceptedUnits: count,
    deviceAcceptedUnits: count,
    asOf: z.string().min(1),
  })
  .refine((value) => value.deviceAcceptedUnits <= value.acceptedUnits);
const snapshotSchema = z
  .object({
    shiftId: z.string().min(1),
    acceptedUnits: count,
    deviceAcceptedUnits: count,
    asOf: z.string().min(1),
    fetchedAt: z.string().min(1),
  })
  .refine((value) => value.deviceAcceptedUnits <= value.acceptedUnits);

export interface ShiftTotalView {
  /** "terminal" until a server answer for this shift exists. */
  scope: "all" | "terminal";
  total: number;
  planned: number | null;
  /** 0..1 for the plan bar; null without a plan. */
  planRatio: number | null;
  /** This terminal's count, shown only when other terminals contributed. */
  terminal: number | null;
  /** `fetchedAt` of an answer older than two minutes that counts other terminals. */
  othersAsOf: string | null;
}

export function shiftTotalView(input: {
  shiftId: string;
  snapshot: ShiftProgressSnapshot | null;
  local: number;
  plannedQty: number | null | undefined;
  nowMs: number;
}): ShiftTotalView {
  const planned =
    input.plannedQty !== null && input.plannedQty !== undefined && input.plannedQty > 0
      ? input.plannedQty
      : null;
  const ratio = (value: number) => (planned === null ? null : Math.min(1, value / planned));
  const snapshot = input.snapshot?.shiftId === input.shiftId ? input.snapshot : null;
  if (!snapshot) {
    return {
      scope: "terminal",
      total: input.local,
      planned,
      planRatio: ratio(input.local),
      terminal: null,
      othersAsOf: null,
    };
  }
  const others = Math.max(0, snapshot.acceptedUnits - snapshot.deviceAcceptedUnits);
  const total = others + input.local;
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  const stale =
    Number.isFinite(fetchedMs) && input.nowMs - fetchedMs > SHIFT_PROGRESS_STALE_AFTER_MS;
  return {
    scope: "all",
    total,
    planned,
    planRatio: ratio(total),
    terminal: others > 0 ? input.local : null,
    othersAsOf: others > 0 && stale ? snapshot.fetchedAt : null,
  };
}

export interface ShiftProgressTracker {
  /** Which shift's total to keep fresh; null when no work screen is open. */
  watch(shiftId: string | null): void;
  /** The last answer for the watched shift, loaded from `station_meta` once. */
  current(): Promise<ShiftProgressSnapshot | null>;
  /**
   * One throttled fetch. A 404 suspends further attempts for ten minutes;
   * any other failure propagates to the caller and keeps the last answer.
   */
  refresh(stillCurrent: () => boolean): Promise<void>;
}

export function createShiftProgressTracker(deps: {
  exec: SqlExecutor;
  client: Partial<Pick<StationClient, "get">>;
  now: () => number;
}): ShiftProgressTracker {
  let watchedShiftId: string | null = null;
  let snapshot: ShiftProgressSnapshot | null = null;
  let loadPromise: Promise<void> | null = null;
  let lastAttemptAt: number | null = null;
  let suspendedUntil: number | null = null;

  /**
   * Reads the persisted answer at most once per tracker instance. Memoized
   * so every caller (`current()` and `refresh()`) shares the same in-flight
   * read instead of racing separate queries — a second `current()` call that
   * starts before the first read resolves awaits the same promise rather
   * than short-circuiting past the in-progress read and returning no answer.
   *
   * A `station_meta` read failure degrades to "no cached answer": the
   * promise still resolves (never rejects) and that resolution is cached,
   * so a display-only read failure neither blocks `current()` — called from
   * the sync engine's state publication — nor makes every later call reject.
   *
   * If `refresh()` stores a fresher answer before this read's row arrives,
   * the guard below leaves `snapshot` alone instead of overwriting it with
   * the older (or absent) persisted value.
   */
  function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const rows = await deps.exec.all<{ value: string | null }>(
            "SELECT value FROM station_meta WHERE key = ?",
            [SHIFT_PROGRESS_META_KEY],
          );
          const raw = rows[0]?.value;
          if (!raw) return;
          try {
            const parsed = snapshotSchema.safeParse(JSON.parse(raw));
            if (parsed.success && snapshot === null) snapshot = parsed.data;
          } catch {
            // A damaged cache is no cache: the next answer replaces it.
          }
        } catch {
          // station_meta is a display-only cache; a read failure means no
          // cached answer, not a rejection callers must handle.
        }
      })();
    }
    return loadPromise;
  }

  return {
    watch(shiftId) {
      if (shiftId === watchedShiftId) return;
      watchedShiftId = shiftId;
      lastAttemptAt = null;
    },
    async current() {
      await ensureLoaded();
      return watchedShiftId !== null && snapshot?.shiftId === watchedShiftId ? snapshot : null;
    },
    async refresh(stillCurrent) {
      const shiftId = watchedShiftId;
      if (shiftId === null || deps.client.get === undefined) return;
      const at = deps.now();
      if (suspendedUntil !== null && at < suspendedUntil) return;
      if (lastAttemptAt !== null && at - lastAttemptAt < SHIFT_PROGRESS_INTERVAL_MS) return;
      lastAttemptAt = at;
      let raw: unknown;
      try {
        // Display-only: this GET ends every drain, and an older server's CORS
        // policy refuses it without a response; the server pill stays with
        // the requests that carry sync.
        raw = await deps.client.get(`/station/shifts/${encodeURIComponent(shiftId)}/progress`, {
          displayOnly: true,
        });
      } catch (error) {
        if (error instanceof StationApiError && error.status === 404) {
          suspendedUntil = at + SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS;
          return;
        }
        throw error;
      }
      const parsed = answerSchema.safeParse(raw);
      if (!parsed.success || parsed.data.shiftId !== shiftId) return;
      if (!stillCurrent() || watchedShiftId !== shiftId) return;
      const next: ShiftProgressSnapshot = {
        ...parsed.data,
        fetchedAt: new Date().toISOString(),
      };
      await deps.exec.run(
        `INSERT INTO station_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SHIFT_PROGRESS_META_KEY, JSON.stringify(next)],
      );
      snapshot = next;
      // Skip a redundant station_meta read on a later current() call, but
      // never touch a load that is already in flight — its own guard above
      // is what keeps it from overwriting the fresh answer just stored.
      if (!loadPromise) loadPromise = Promise.resolve();
    },
  };
}
