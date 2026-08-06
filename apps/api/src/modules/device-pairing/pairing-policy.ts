import { randomInt } from "node:crypto";

export const CODE_DIGITS = 8;
export const PAIRING_TTL_MS = 15 * 60_000;
export const PAIR_CODE_MAX_ATTEMPTS = 5;
export const PAIR_ATTEMPT_BUDGET = 10;
export const GLOBAL_PAIR_ATTEMPT_BUDGET = 400;
export const PAIR_ATTEMPT_WINDOW_MS = PAIRING_TTL_MS;
export const GLOBAL_PAIR_SOURCE = "*";

export function mintPairingCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

export function pairAttemptWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PAIR_ATTEMPT_WINDOW_MS) * PAIR_ATTEMPT_WINDOW_MS);
}
