import { OPERATOR_LOCKOUT, STATION_LOCKOUT } from "../lockout.js";

/**
 * How the sign-in shows a lockout (design kit 2026-10): a countdown and a bar, the fields held,
 * and what a screen reader hears. Display only. The lockout itself is the policy in
 * `lockout.ts` and is enforced by every check, so a screen that shows a lock too long or too
 * short changes what is on screen, never what is allowed.
 */
export interface LockView {
  scope: "station" | "operator";
  /** The personnel number the PIN lockout belongs to (`null` for the station's). */
  login: string | null;
  /** This computer's clock (Unix ms) when the lockout ends. */
  endsAt: number;
}

/** The lockout's own length, from the policies. */
export function lockTotalMs(scope: LockView["scope"]): number {
  return scope === "station" ? STATION_LOCKOUT.durationMs : OPERATOR_LOCKOUT.durationMs;
}

/** «04:32»: the seconds rounded up, so a lockout never reads 00:00 while it still holds. */
export function formatCountdown(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** The bar's share of what is left, 0 to 1. */
export function lockFraction(remainingMs: number, totalMs: number): number {
  if (!(totalMs > 0) || !Number.isFinite(remainingMs)) return 0;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}

export function remainingOf(lock: LockView, now: () => number): number {
  return Math.max(0, lock.endsAt - now());
}

/**
 * What is spoken of a lockout: once when it starts (the message says so, with the minutes) and
 * once when it ends, never in between: a countdown read out every second would drown the screen.
 * `previous` is the lockout last spoken of. A lockout already over when first seen is not news.
 */
export function lockAnnouncement(
  previous: LockView | null,
  next: LockView | null,
  now: number,
): "started" | "ended" | null {
  if (next === null) return null;
  const same = previous !== null && previous.scope === next.scope && previous.login === next.login;
  if (now >= next.endsAt) return same ? "ended" : null;
  return same ? null : "started";
}

/**
 * An operator's PIN lockout belongs to one personnel number: while the number on the screen is
 * another one, the keypad is free (a lockout is checked again by the next attempt anyway). The
 * station's holds whatever is typed.
 */
export function lockViewAfterEdit(lock: LockView | null, login: string): LockView | null {
  if (lock === null || lock.scope === "station") return lock;
  return lock.login === login ? lock : null;
}
