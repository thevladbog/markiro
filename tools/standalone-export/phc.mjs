/**
 * PBKDF2 PHC strings as the standalone host reads them
 * (`apps/standalone/host/src/secrets.rs`, `parse_phc`): `pbkdf2$sha256$<n>$<salt>$<digest>`,
 * canonical standard base64 with padding, a 16-byte salt, a 32-byte digest
 * and 10 000–1 000 000 iterations written without a leading zero. The cloud
 * writes PINs and badges in the same format (`apps/api/src/lib/pin-hash.ts`,
 * `badge-salt.ts`), so a hash moves byte for byte; a string the host would
 * refuse is caught here, where the file is made.
 */

import { pbkdf2Sync } from "node:crypto";

/** A badge verifier carries exactly the domain's count (`BADGE_ITERATIONS`). */
export const BADGE_ITERATIONS = 100_000;
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 1_000_000;

/** `bytes` decoded from `text` when `text` is their canonical base64, else `null`. */
export function decodeCanonical(text, bytes) {
  if (typeof text !== "string") return null;
  const decoded = Buffer.from(text, "base64");
  return decoded.length === bytes && decoded.toString("base64") === text ? decoded : null;
}

/** The parts of a PHC string the host accepts, or `null`. */
export function parsePhc(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const [, , count, salt, digest] = parts;
  if (!/^[1-9]\d*$/u.test(count)) return null;
  const iterations = Number(count);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  if (decodeCanonical(salt, 16) === null || decodeCanonical(digest, 32) === null) return null;
  return { iterations, salt, digest };
}

/** Whether a badge verifier is the one `hashBadge` would write under `salt`. */
export function isBadgePhcUnder(text, salt) {
  const parsed = parsePhc(text);
  return parsed !== null && parsed.iterations === BADGE_ITERATIONS && parsed.salt === salt;
}

/** The badge verifier of `code` under the tenant's `salt` (base64), as the cloud's `hashBadgeWithSalt`. */
export function hashBadge(code, salt) {
  const digest = pbkdf2Sync(code, Buffer.from(salt, "base64"), BADGE_ITERATIONS, 32, "sha256");
  return `pbkdf2$sha256$${BADGE_ITERATIONS}$${salt}$${digest.toString("base64")}`;
}
