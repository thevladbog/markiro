import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";

// Operator credentials as the office makes them (stage 1 spec §5.5): the PIN
// and the badge code are hashed here, in the webview, and only the PHC
// strings reach the host. Neither the PIN nor the code is ever sent, logged
// or kept: the forms pass them in and drop them with the dialog.

/**
 * Iterations of a badge verifier: exactly the host's `secrets::BADGE_ITERATIONS`
 * and the cloud's `hashBadgeWithSalt`, which uses the domain's
 * `PHC_ITERATIONS`. The host refuses another count, and a station finds a
 * scanned badge by comparing the whole string, so a copy with another count
 * would never match.
 */
export const BADGE_ITERATIONS = 100_000;

/** A PIN verifier's salt: 16 random bytes, as `@markiro/domain` expects. */
const SALT_BYTES = 16;

/** Standard base64 with padding, as the PHC strings of the domain carry it. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A PIN verifier: a fresh random salt and the domain's `PHC_ITERATIONS`, in
 * the domain's format (`pbkdf2$sha256$100000$<salt>$<digest>`). The caller
 * passes the PIN its form accepted (`pinRule`).
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  return formatPhc(PHC_ITERATIONS, salt, await deriveDigestB64(pin, salt, PHC_ITERATIONS));
}

/**
 * A badge verifier under the site's salt (`GET /v1/office/badge-salt`) and
 * exactly `BADGE_ITERATIONS`, as the cloud's `hashBadgeWithSalt`: one code
 * always gives one string, which the host keeps on one operator. The code is
 * hashed as given; the caller passes the trimmed code its form accepted
 * (`badgeCodeRule`).
 */
export async function hashBadge(code: string, saltB64: string): Promise<string> {
  return formatPhc(
    BADGE_ITERATIONS,
    saltB64,
    await deriveDigestB64(code, saltB64, BADGE_ITERATIONS),
  );
}
