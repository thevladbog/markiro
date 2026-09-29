import {
  deriveDigestB64,
  formatPhc,
  parsePhc,
  PHC_ITERATIONS,
  type ParsedPhc,
} from "@markiro/domain";

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

/** The fewest iterations the host takes in a verifier (`secrets::MIN_ITERATIONS`). */
export const MIN_PHC_ITERATIONS = 10_000;
/** The most (`secrets::MAX_ITERATIONS`): a station verifies with the count a hash carries. */
export const MAX_PHC_ITERATIONS = 1_000_000;

/**
 * `phc` parsed, when it is written exactly as the host writes a verifier:
 * the domain's format (`parsePhc`) with a count in plain digits, so writing
 * it out again gives the same string. The host's `parse_phc` refuses
 * `0100000` or `1e5`, which `parsePhc` reads as 100 000.
 */
function asHostWrites(phc: string): ParsedPhc | null {
  const parsed = parsePhc(phc);
  if (parsed === null) return null;
  return formatPhc(parsed.iterations, parsed.saltB64, parsed.digestB64) === phc ? parsed : null;
}

/** A PIN verifier a station can use: as the host writes it, with 10 000–1 000 000 iterations. */
export function isPinPhc(phc: string): boolean {
  const parsed = asHostWrites(phc);
  return (
    parsed !== null &&
    parsed.iterations >= MIN_PHC_ITERATIONS &&
    parsed.iterations <= MAX_PHC_ITERATIONS
  );
}

/**
 * A badge verifier a station can match: as the host writes it, with exactly
 * `BADGE_ITERATIONS`. The salt is not checked against the `site` record: the
 * host takes only the site's, the salt never changes after the wizard, and a
 * copy with another salt matches no scan anyway, since a station hashes a
 * scan with the site's salt and compares whole strings.
 */
export function isBadgePhc(phc: string): boolean {
  return asHostWrites(phc)?.iterations === BADGE_ITERATIONS;
}
