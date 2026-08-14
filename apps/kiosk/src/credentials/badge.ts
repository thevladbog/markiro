import { deriveDigestB64, parsePhc, PHC_ITERATIONS } from "@markiro/domain";
import type { KioskBootstrapSnapshotDto } from "../api/types.js";

/**
 * digestB64 -> employeeId. Every badge verifier in a tenant shares
 * `badgeSalt` precisely so this map can exist: one derivation of the scanned
 * value, then a lookup. Verifying per employee instead would run PBKDF2
 * (100000 iterations) once per row — seconds on a full staff roster, on a
 * screen where a scan must feel instant.
 *
 * The map assumes each digest maps to at most one employeeId within a tenant.
 * This holds because the server enforces a unique constraint on active
 * `badge_code` per tenant (`employee_badges_tenant_code_active_uq`), and the
 * bootstrap payload ships only active badges; digests derive deterministically
 * from (badge_code, badgeSalt), so distinct codes yield distinct digests.
 * Thus last-write-wins here is unreachable rather than tolerated — if this
 * constraint is ever relaxed server-side, this map would need a duplicate guard.
 */
export function buildBadgeIndex(bootstrap: KioskBootstrapSnapshotDto): Map<string, string> {
  const index = new Map<string, string>();
  for (const employee of bootstrap.employees) {
    if (!employee.badgeHash) continue;
    const parsed = parsePhc(employee.badgeHash);
    if (parsed) index.set(parsed.digestB64, employee.id);
  }
  return index;
}

/** A badge this device recognised: who it belongs to, and the derivation that
 * matched. */
export interface ResolvedBadge {
  employeeId: string;
  /**
   * The digest the lookup was made with — carried out rather than discarded
   * because it is also what the ORDER names the employee by
   * (`CreateOrderDto.badgeDigest`).
   *
   * Returning it is what keeps the raw code out of the device's stores
   * entirely: an order is written to IndexedDB before any network attempt, so
   * whatever identifies the worker in that body is what an unattended tablet
   * holds at rest, and this value is already in the snapshot the match was
   * made against. The server rebuilds the same verifier around it to
   * re-resolve the badge against live data at sync time.
   */
  digest: string;
}

/**
 * Resolves a raw badge scan to the employee it belongs to, or null when no
 * cached verifier matches. Costs exactly one PBKDF2 derivation regardless of
 * roster size: `index` (built once by `buildBadgeIndex`) turns everything
 * after the derivation into a map lookup.
 */
export async function resolveBadge(
  raw: string,
  bootstrap: KioskBootstrapSnapshotDto,
  index: Map<string, string>,
): Promise<ResolvedBadge | null> {
  if (!raw) return null;
  const digest = await deriveDigestB64(raw, bootstrap.badgeSalt, PHC_ITERATIONS);
  const employeeId = index.get(digest);
  return employeeId === undefined ? null : { employeeId, digest };
}
