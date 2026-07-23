import type { OperatorMirrorRecord } from "@markiro/db";
import { readOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { verifyBadge, verifyPin } from "./crypto.js";

/** Returns the matching active operator for a PIN, or null. PINs are all-digits, min 4. */
export async function verifyOperatorPin(exec: SqlExecutor, pin: string): Promise<OperatorMirrorRecord | null> {
  if (!/^\d{4,}$/.test(pin)) return null;
  for (const op of await readOperatorsMirror(exec)) {
    if (op.active && (await verifyPin(pin, op.pinHash))) return op;
  }
  return null;
}

/** Returns the matching active operator for a scanned badge string, or null. */
export async function verifyOperatorBadge(exec: SqlExecutor, code: string): Promise<OperatorMirrorRecord | null> {
  if (code.length === 0) return null;
  for (const op of await readOperatorsMirror(exec)) {
    if (op.active && op.badgeHash && (await verifyBadge(code, op.badgeHash))) return op;
  }
  return null;
}
