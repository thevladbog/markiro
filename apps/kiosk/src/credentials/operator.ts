import { deriveDigestB64, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import type { KioskBootstrapDto } from "../api/types.js";

/** One row of `bootstrap.operators` — the roster for the settings sign-in. */
export type Operator = KioskBootstrapDto["operators"][number];

/**
 * A structurally valid PHC verifier used only to equalize work when no
 * operator matches the submitted login, so an attacker cannot tell a real
 * personnel number from an unknown one by timing the response. Its plaintext
 * is irrelevant — the result is always discarded. Mirrors
 * `apps/station/src/lib/auth.ts`, which guards the same property for its own
 * (also offline, also locally cached) operator roster.
 */
const DUMMY_PHC =
  "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=";

/**
 * Returns the active operator whose personnel number is `login` when `pin`
 * matches their verifier, else null. Looking up by login first is not just
 * UX — it is correctness: 4-digit PINs collide across a roster of any size,
 * so a PIN-only match could sign in the wrong person (the same point is made
 * in a comment in `apps/station/src/lib/auth.ts`).
 *
 * When `login` matches no active operator we still run a full PBKDF2
 * verification (against `DUMMY_PHC`) before returning null, so the response
 * time for an unknown login is comparable to a known login with a wrong PIN
 * — otherwise the sign-in screen's single generic error would be defeated by
 * a timing side channel that enumerates personnel numbers.
 */
export async function verifyOperatorPin(
  login: string,
  pin: string,
  bootstrap: KioskBootstrapDto,
): Promise<Operator | null> {
  if (login.length === 0) return null;
  const operator = bootstrap.operators.find(
    (candidate) => candidate.active && candidate.login === login,
  );
  const ok = await verifyPhc(pin, operator ? operator.pinHash : DUMMY_PHC);
  return ok && operator ? operator : null;
}

/**
 * digestB64 -> operator, built the same way as the employee badge index
 * (`buildBadgeIndex` in `badge.ts`): every badge verifier in the tenant —
 * an operator's included — shares `badgeSalt`, so a scan costs one
 * derivation and a lookup, never PBKDF2 per operator. Inactive operators and
 * operators without a badge are left out of the index, not merely filtered
 * after a match, so a disabled operator's old badge can never resolve.
 */
function buildOperatorBadgeIndex(bootstrap: KioskBootstrapDto): Map<string, Operator> {
  const index = new Map<string, Operator>();
  for (const operator of bootstrap.operators) {
    if (!operator.active || !operator.badgeHash) continue;
    const parsed = parsePhc(operator.badgeHash);
    if (parsed) index.set(parsed.digestB64, operator);
  }
  return index;
}

/** Returns the active operator behind a scanned badge, or null. */
export async function verifyOperatorBadge(
  raw: string,
  bootstrap: KioskBootstrapDto,
): Promise<Operator | null> {
  if (!raw) return null;
  const digest = await deriveDigestB64(raw, bootstrap.badgeSalt, PHC_ITERATIONS);
  return buildOperatorBadgeIndex(bootstrap).get(digest) ?? null;
}
