import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";
import { readOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { verifyBadge, verifyPin } from "./crypto.js";

/**
 * A structurally valid PHC verifier used only to equalize work when no
 * operator matches the submitted login, so an attacker cannot tell a real
 * personnel number from an unknown one by timing the response. Its plaintext
 * is irrelevant — the result is discarded.
 */
const DUMMY_PHC =
  "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=";

/**
 * Turns the deliberately forgiving floor entry into the exact storage key.
 * Only values below the three-digit API minimum are padded; longer values are
 * never canonicalized because leading zeroes are part of the operator login.
 */
export function padShortOperatorLogin(login: string): string | null {
  if (!/^\d{1,12}$/.test(login)) return null;
  return login.padStart(3, "0");
}

/**
 * Returns the active operator whose personnel number is `login` when `pin`
 * matches their verifier, else null. Looking up by login first is not just the
 * UX from the sign-in design — it is correctness: 4-digit PINs collide across a
 * roster of any size, so a PIN-only scan can sign in the wrong person.
 *
 * When `login` matches no active operator we still run a full PBKDF2
 * verification (against `DUMMY_PHC`) before returning null, so the response
 * time for an unknown login is comparable to that of a known one with a wrong
 * PIN — otherwise the sign-in screen's single generic error message would be
 * defeated by a trivial timing side channel that enumerates personnel numbers.
 */
export async function verifyOperatorPin(
  exec: SqlExecutor,
  login: string,
  pin: string,
): Promise<OperatorMirrorRecord | null> {
  if (!/^\d{4,}$/.test(pin)) return null;
  if (!/^\d{3,12}$/.test(login)) return null;
  const operator = (await readOperatorsMirror(exec)).find((op) => op.active && op.login === login);
  const ok = await verifyPin(pin, operator ? operator.pinHash : DUMMY_PHC);
  return ok && operator ? operator : null;
}

/** Returns the matching active operator for a scanned badge string, or null. */
export async function verifyOperatorBadge(
  exec: SqlExecutor,
  code: string,
): Promise<OperatorMirrorRecord | null> {
  if (code.length === 0) return null;
  for (const op of await readOperatorsMirror(exec)) {
    if (op.active && op.badgeHash && (await verifyBadge(code, op.badgeHash))) return op;
  }
  return null;
}
