import { createHash, randomBytes } from "node:crypto";

/**
 * Kiosk device enrollment token support (plan-05, consumed later by
 * `KioskDeviceGuard` in Task 7). The plaintext token is handed to the
 * operator exactly once (`POST /kiosks/:id/enroll`); only its sha256 hash is
 * ever persisted (`kiosks.device_token_hash`), so a DB leak doesn't expose
 * live device credentials.
 */

/** Generates a fresh, URL-safe device enrollment token (192 bits of entropy). */
export function generateDeviceToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Deterministic sha256 hex digest of a device token, for storage/lookup. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
