import { isKnownTimeZone } from "../../lib/civil-date.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { formatWhen } from "./backup-format.js";

/** Why the times are not in the organization's zone, when they are not. */
export type BackupTimeNote = "localTimeZone" | "localTime";

export interface BackupTime {
  /** Whether the organization's profile has been tried: the times are final only then. */
  ready: boolean;
  /** The organization's zone, or `null` while this PC's own is used. */
  zone: string | null;
  /** Why this PC's zone is used, or `null` when the organization's is. */
  note: BackupTimeNote | null;
  /** An instant the host reported, written in `zone`. */
  format: (instant: string) => string;
}

/**
 * The zone the copies' times are written in: the organization's (the
 * administrator reads the site's clock), else this PC's, and then the note
 * says so (the profile did not load, or names a zone this PC lacks). With
 * `enabled` false the profile is not read, and nothing waits for it.
 */
export function useBackupTime(enabled = true): BackupTime {
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token), { enabled });
  const known = org.isSuccess && isKnownTimeZone(org.data.timeZone);
  const zone = known ? org.data.timeZone : null;
  let note: BackupTimeNote | null = null;
  if (!known) note = org.isSuccess ? "localTimeZone" : "localTime";
  return {
    ready: !enabled || !org.isPending,
    zone,
    note,
    format: (instant) => formatWhen(instant, zone),
  };
}
