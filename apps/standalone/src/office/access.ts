import type { OfficeRole } from "../host/protocol.js";
import { useOfficeSession } from "./office-session.js";

/**
 * What each office role may change (spec §4.8). The host enforces the same
 * table on every request; the office reads it to show a form or a read-only
 * view. Administrator-only pages (users, devices) are gated by `OFFICE_NAV`
 * and `RequireRole` instead.
 */
const CAPABILITIES = {
  /** The organization, SSCC counters, counterparties and lines; every role reads them. */
  editReference: ["admin"],
  /** The catalog, label templates and their defaults (plan 1e). */
  editCatalog: ["admin", "technologist"],
  /** Shifts: plan, change, delete a planned one, close an active one (stage 2a spec §4.9). */
  planShifts: ["admin", "technologist"],
} as const satisfies Record<string, readonly OfficeRole[]>;

export type OfficeCapability = keyof typeof CAPABILITIES;

/** Whether `role` may do `capability`. */
export function can(role: OfficeRole, capability: OfficeCapability): boolean {
  const roles: readonly OfficeRole[] = CAPABILITIES[capability];
  return roles.includes(role);
}

/** Whether the signed-in user may do `capability`; follows a role changed mid-session. */
export function useCan(capability: OfficeCapability): boolean {
  return can(useOfficeSession().user.role, capability);
}
