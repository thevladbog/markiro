import type { SqlExecutor } from "./mirror.js";
import { isStationBetaVersion } from "./station-version.js";

export const UPDATE_STATE_KEY = "station_update_state_v1";
export const AUTO_CHECK_INTERVAL_MS = 86_400_000;
const MAX_STATE_BYTES = 2 * 1024;

export type UpdateSeverity = "none" | "info" | "warn" | "urgent";

export interface KnownStationUpdate {
  version: string;
  publishedAt: string;
}

export interface PersistedUpdateState {
  schemaVersion: 1;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  available: KnownStationUpdate | null;
}

const EMPTY_STATE: PersistedUpdateState = {
  schemaVersion: 1,
  lastAttemptAt: null,
  lastSuccessfulCheckAt: null,
  available: null,
};

function invalid(): never {
  throw new Error("invalid station update state");
}

function canonicalDate(value: unknown): string {
  if (typeof value !== "string") invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
  return date.toISOString();
}

function ensureNotFuture(value: string, now = Date.now()): void {
  if (Date.parse(value) > now + 5 * 60_000) invalid();
}

function validateVersion(value: unknown): string {
  if (!isStationBetaVersion(value)) invalid();
  return value;
}

function validateKnown(value: unknown, now = Date.now()): KnownStationUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "publishedAt,version") invalid();
  const publishedAt = canonicalDate(candidate.publishedAt);
  ensureNotFuture(publishedAt, now);
  return { version: validateVersion(candidate.version), publishedAt };
}

function validateState(value: unknown, now = Date.now()): PersistedUpdateState {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !==
    "available,lastAttemptAt,lastSuccessfulCheckAt,schemaVersion"
  )
    invalid();
  if (candidate.schemaVersion !== 1) invalid();
  const lastAttemptAt =
    candidate.lastAttemptAt === null ? null : canonicalDate(candidate.lastAttemptAt);
  const lastSuccessfulCheckAt =
    candidate.lastSuccessfulCheckAt === null
      ? null
      : canonicalDate(candidate.lastSuccessfulCheckAt);
  if (lastAttemptAt) ensureNotFuture(lastAttemptAt, now);
  if (lastSuccessfulCheckAt) ensureNotFuture(lastSuccessfulCheckAt, now);
  const available = candidate.available === null ? null : validateKnown(candidate.available, now);
  return { schemaVersion: 1, lastAttemptAt, lastSuccessfulCheckAt, available };
}

function cloneEmpty(): PersistedUpdateState {
  return { ...EMPTY_STATE };
}

function dateForTransition(value: string): string {
  const canonical = canonicalDate(value);
  ensureNotFuture(canonical);
  return canonical;
}

export function automaticCheckDue(now: number, state: PersistedUpdateState | null): boolean {
  if (!Number.isFinite(now)) invalid();
  if (!state?.lastAttemptAt) return true;
  const last = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(last)) invalid();
  return now - last >= AUTO_CHECK_INTERVAL_MS;
}

export function recordCheckAttempt(
  state: PersistedUpdateState | null,
  attemptedAt: string,
): PersistedUpdateState {
  const current = state ? validateState(state) : cloneEmpty();
  return { ...current, lastAttemptAt: dateForTransition(attemptedAt) };
}

export function recordCheckSuccess(
  state: PersistedUpdateState | null,
  checkedAt: string,
  available: KnownStationUpdate | null,
): PersistedUpdateState {
  const current = state ? validateState(state) : cloneEmpty();
  const lastSuccessfulCheckAt = dateForTransition(checkedAt);
  return {
    ...current,
    lastAttemptAt: current.lastAttemptAt ?? lastSuccessfulCheckAt,
    lastSuccessfulCheckAt,
    available: available === null ? null : validateKnown(available),
  };
}

export function updateSeverity(now: number, available: KnownStationUpdate | null): UpdateSeverity {
  if (available === null) return "none";
  const known = validateKnown(available, now);
  const age = now - Date.parse(known.publishedAt);
  if (age < 0) invalid();
  if (age >= 30 * AUTO_CHECK_INTERVAL_MS) return "urgent";
  if (age >= 7 * AUTO_CHECK_INTERVAL_MS) return "warn";
  return "info";
}

export async function loadUpdateState(exec: SqlExecutor): Promise<PersistedUpdateState | null> {
  try {
    const rows = await exec.all<{ value?: unknown }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [UPDATE_STATE_KEY],
    );
    const raw = rows[0]?.value;
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_STATE_BYTES)
      return null;
    return validateState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveUpdateState(
  exec: SqlExecutor,
  state: PersistedUpdateState,
): Promise<void> {
  const validated = validateState(state);
  const value = JSON.stringify(validated);
  if (new TextEncoder().encode(value).byteLength > MAX_STATE_BYTES) invalid();
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [UPDATE_STATE_KEY, value],
  );
}
