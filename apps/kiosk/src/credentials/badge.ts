import { deriveDigestB64, parsePhc, PHC_ITERATIONS } from "@markiro/domain";
import type { KioskBootstrapDto } from "../api/types.js";

/**
 * digestB64 -> employeeId. Every badge verifier in a tenant shares
 * `badgeSalt` precisely so this map can exist: one derivation of the scanned
 * value, then a lookup. Verifying per employee instead would run PBKDF2
 * (100000 iterations) once per row — seconds on a full staff roster, on a
 * screen where a scan must feel instant.
 */
export function buildBadgeIndex(bootstrap: KioskBootstrapDto): Map<string, string> {
  const index = new Map<string, string>();
  for (const employee of bootstrap.employees) {
    if (!employee.badgeHash) continue;
    const parsed = parsePhc(employee.badgeHash);
    if (parsed) index.set(parsed.digestB64, employee.id);
  }
  return index;
}

/**
 * Resolves a raw badge scan to the employee it belongs to, or null when no
 * cached verifier matches. Costs exactly one PBKDF2 derivation regardless of
 * roster size: `index` (built once by `buildBadgeIndex`) turns everything
 * after the derivation into a map lookup.
 */
export async function resolveBadge(
  raw: string,
  bootstrap: KioskBootstrapDto,
  index: Map<string, string>,
): Promise<string | null> {
  if (!raw) return null;
  const digest = await deriveDigestB64(raw, bootstrap.badgeSalt, PHC_ITERATIONS);
  return index.get(digest) ?? null;
}
