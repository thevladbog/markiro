import { createHash, createHmac, randomBytes } from "node:crypto";

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

/**
 * Keyed digest for the 8-digit kiosk pairing code
 * (`kiosk_pairing_codes.code_hash`). Unlike `hashDeviceToken` above, this
 * MUST be keyed: the device token is 192 bits of entropy, so an unkeyed
 * digest is fine there, but the pairing code is drawn from a 10^8 space,
 * which is trivially brute-forceable offline from a leaked DB dump with a
 * plain digest -- recovering every still-live code and letting it be
 * redeemed directly, bypassing the HTTP rate limiter entirely. HMAC with a
 * server-held pepper (`PAIRING_CODE_PEPPER`, never persisted) turns that
 * from seconds of offline GPU time into infeasible without the key.
 *
 * Used identically for both issuance (`PairingService.issueCode`) and
 * redemption lookup (`PairingService.attemptRedeem`) so the two paths can
 * never diverge onto different digests for the same code.
 */
export function hashPairingCode(code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(code).digest("hex");
}
