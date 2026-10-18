import { isKnownTimeZone } from "../../lib/civil-date.js";

/** A fixed source refusal; never includes the untrusted original zone in errors or logs. */
export class UnsupportedHistoryTimeZoneError extends Error {
  constructor() {
    super("history_time_zone_unsupported");
    this.name = "UnsupportedHistoryTimeZoneError";
  }
}

export function isSupportedHistoryTimeZone(zone: string | undefined): zone is string {
  return zone !== undefined && isKnownTimeZone(zone);
}

/** Frozen source data must not be reinterpreted in the site's current zone or UTC. */
export function requireHistoryTimeZone(zone: string | undefined): string {
  if (!isSupportedHistoryTimeZone(zone)) throw new UnsupportedHistoryTimeZoneError();
  return zone;
}
