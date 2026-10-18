import type { DeviceLicense } from "../host/protocol.js";
import { lastMomentBefore, licenseDayMonth, licenseMinute } from "../lib/license-dates.js";

/** The states in which the host opens no new shift (license spec §3.2–3.3). */
const BLOCKED: ReadonlySet<string> = new Set(["restricted", "trial_expired", "inn_mismatch"]);

/** Why the station opens no new shift: the host's state, or its refusal `license_restricted`. */
export type LicenseRefusal =
  "license_restricted" | "license_trial_expired" | "license_inn_mismatch";

function refusalOfState(state: unknown): LicenseRefusal {
  if (state === "trial_expired") return "license_trial_expired";
  if (state === "inn_mismatch") return "license_inn_mismatch";
  return "license_restricted";
}

/**
 * The refusal to say before asking the host, from the license the station
 * last heard (`GET /v1/device`); `null` while new shifts open, while the host
 * says the emergency extension runs (the host opens; once it has ended the
 * host refuses for itself, and the refusal is said: this PC's clock never
 * hides the button), or when nothing is known.
 */
export function opensBlocked(license: DeviceLicense | null): LicenseRefusal | null {
  if (license === null || !BLOCKED.has(license.state) || license.emergencyUntil !== null) {
    return null;
  }
  return refusalOfState(license.state);
}

/** A host's `conflict` on `license_restricted`, by its `details.state`. */
export function licenseRefusalOf(details: Readonly<Record<string, unknown>>): LicenseRefusal {
  return refusalOfState(details.state);
}

/** The status bar's line: its tone and its text in `ru.json`. */
export interface FloorLicenseLine {
  tone: "warn" | "error";
  key: string;
  values?: Record<string, string>;
}

/**
 * When the emergency extension the host announced ends, in milliseconds;
 * `null` when none is announced, or for a time the station cannot read.
 */
export function emergencyEndsAt(license: DeviceLicense | null): number | null {
  if (license === null || license.emergencyUntil === null) return null;
  const end = Date.parse(license.emergencyUntil);
  return Number.isNaN(end) ? null : end;
}

/**
 * The status bar's line (spec §9.6): silent in the trial, while the license
 * runs, in its last weeks, on another host (all works there for 30 days)
 * and for a state a newer host adds; the grace says till when new shifts
 * open, the restricted states that none opens, and the emergency extension
 * till when it opens them (this PC's zone). The extension is said only while
 * its end is still ahead by this PC's clock (`now`): the host stops sending
 * it once it has ended, but the station keeps the last state it heard while
 * the link is down, and a line saying shifts open when they no longer do
 * would send people to a refusal.
 */
export function floorLicenseLine(
  license: DeviceLicense | null,
  now: Date,
): FloorLicenseLine | null {
  if (license === null) return null;
  if (license.state === "grace") {
    return license.phaseEndsAt === null
      ? { tone: "warn", key: "floor.license.graceNoDate" }
      : {
          tone: "warn",
          key: "floor.license.grace",
          values: { date: licenseDayMonth(lastMomentBefore(license.phaseEndsAt), null) },
        };
  }
  if (!BLOCKED.has(license.state)) return null;
  const emergencyEnd = emergencyEndsAt(license);
  if (license.emergencyUntil !== null && emergencyEnd !== null && now.getTime() < emergencyEnd) {
    return {
      tone: "warn",
      key: `floor.license.${license.state}Emergency`,
      values: { until: licenseMinute(license.emergencyUntil, null) },
    };
  }
  return { tone: "error", key: `floor.license.${license.state}` };
}
