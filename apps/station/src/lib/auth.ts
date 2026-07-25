import type { OperatorMirrorRecord } from "@markiro/db";
import { readOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { verifyBadge, verifyPin } from "./crypto.js";

/**
 * Returns the active operator whose personnel number is `login` when `pin`
 * matches their verifier, else null. Looking up by login first is not just the
 * UX from the sign-in design — it is correctness: 4-digit PINs collide across a
 * roster of any size, so a PIN-only scan can sign in the wrong person.
 */
export async function verifyOperatorPin(
  exec: SqlExecutor,
  login: string,
  pin: string,
): Promise<OperatorMirrorRecord | null> {
  if (!/^\d{4,}$/.test(pin)) return null;
  if (login.length === 0) return null;
  const operator = (await readOperatorsMirror(exec)).find((op) => op.active && op.login === login);
  if (!operator) return null;
  return (await verifyPin(pin, operator.pinHash)) ? operator : null;
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
