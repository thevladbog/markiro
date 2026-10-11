import {
  BACKUP_FAILURES,
  type BackupDestination,
  type BackupFailure,
  type BackupState,
} from "../../host/backups.js";
import { formatWhen } from "./backup-format.js";

/** A copy older than this, by the host's clock, is a warning: the daily copy was missed. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** A copy running longer than this is a warning: a folder that hangs holds every later copy. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;
/**
 * A newest copy later than the host's clock by more than this is a warning: the clock
 * was set back, so the schedule and the retention rule read the copies wrongly.
 */
export const CLOCK_AHEAD_MS = 60 * 60 * 1000;

/** What the office warns about, most serious first; `reason` is a failure code. */
export type BackupWarning =
  | { kind: "held"; since: string; stations: number }
  | { kind: "localFailed"; reason: BackupFailure | "unknown" }
  | { kind: "secondFailed"; reason: BackupFailure | "unknown" }
  | { kind: "noCopies" }
  | { kind: "stale" }
  | { kind: "noSecond" }
  | { kind: "secondStale" }
  | { kind: "clockBehind" }
  | { kind: "stuck" };

/** A failure code the office has words for; a newer host's other code is `unknown`. */
export function failureReason(code: string | null): BackupFailure | "unknown" {
  return BACKUP_FAILURES.find((known) => known === code) ?? "unknown";
}

function lastFailure(destination: BackupDestination): BackupFailure | "unknown" | null {
  const attempt = destination.lastAttempt;
  return attempt === null || attempt.ok ? null : failureReason(attempt.code);
}

/** Whether the folder's newest copy is older than `STALE_AFTER_MS` at the host's `now`. */
function stale(destination: BackupDestination, now: number): boolean {
  const newest = destination.copies[0];
  return newest !== undefined && now - Date.parse(newest.createdAt) > STALE_AFTER_MS;
}

/** Whether the folder's newest copy is later than the host's `now` by more than `CLOCK_AHEAD_MS`. */
function ahead(destination: BackupDestination | null, now: number): boolean {
  const newest = destination?.copies[0];
  return newest !== undefined && Date.parse(newest.createdAt) - now > CLOCK_AHEAD_MS;
}

/**
 * The warnings of a backup state: the stations' facts held since a restore,
 * a failed last attempt in either folder, no copy at all, a newest copy
 * older than a day and a bit, no second folder, a host clock behind the newest
 * copy of either folder, a copy running for more than half an hour. A copy in progress hides nothing: the last attempt still
 * counts until it ends. The held facts name how many stations the host
 * knows, never how many gave their blocks back: no station does yet (plan
 * РК-С), so that number would be a claim about nothing.
 */
export function backupWarnings(state: BackupState): BackupWarning[] {
  const now = Date.parse(state.now);
  const warnings: BackupWarning[] = [];
  const hold = state.restoreHold;
  if (hold !== null) {
    warnings.push({ kind: "held", since: hold.since, stations: hold.stations.length });
  }
  const local = lastFailure(state.local);
  if (local !== null) warnings.push({ kind: "localFailed", reason: local });
  const second = state.second === null ? null : lastFailure(state.second);
  if (second !== null) warnings.push({ kind: "secondFailed", reason: second });
  if (state.local.copies.length === 0) {
    warnings.push({ kind: "noCopies" });
  } else if (stale(state.local, now)) {
    warnings.push({ kind: "stale" });
  }
  if (state.second === null) {
    warnings.push({ kind: "noSecond" });
  } else if (second === null && stale(state.second, now)) {
    warnings.push({ kind: "secondStale" });
  }
  if (ahead(state.local, now) || ahead(state.second, now)) {
    warnings.push({ kind: "clockBehind" });
  }
  if (state.running !== null && now - Date.parse(state.running.startedAt) > STUCK_AFTER_MS) {
    warnings.push({ kind: "stuck" });
  }
  return warnings;
}

/** The alert tone of a warning: held facts and a failure are errors, the rest warnings. */
export function warningTone(warning: BackupWarning): "error" | "warn" {
  return warning.kind === "held" ||
    warning.kind === "localFailed" ||
    warning.kind === "secondFailed"
    ? "error"
    : "warn";
}

/**
 * The i18n key of the word that names a warning's tone ("Ошибка", "Внимание"):
 * a screen reader does not hear the colour or the glyph of an alert.
 */
export function warningToneKey(warning: BackupWarning): string {
  return `office.backups.tone.${warningTone(warning)}`;
}

/**
 * The i18n key of a warning's text and its values; `reason` is itself an
 * i18n key, to translate before it goes into the text. Times are written
 * with `format` (the organization's zone); this PC's zone without one.
 */
export function warningText(
  warning: BackupWarning,
  format: (instant: string) => string = formatWhen,
): {
  key: string;
  reason?: string;
  values?: Record<string, string | number>;
} {
  const key = `office.backups.warnings.${warning.kind}`;
  if (warning.kind === "localFailed" || warning.kind === "secondFailed") {
    return { key, reason: `office.backups.failures.${warning.reason}` };
  }
  if (warning.kind === "held") {
    return { key, values: { since: format(warning.since), stations: warning.stations } };
  }
  return { key };
}
