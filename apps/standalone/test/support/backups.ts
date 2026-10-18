import type { BackupCopy, BackupState } from "../../src/host/backups.js";

/** A copy made at `createdAt`, 4 MiB. */
export function backupCopy(
  createdAt: string,
  trigger: BackupCopy["trigger"] = "scheduled",
): BackupCopy {
  const stamp = createdAt.replace(/[-:]/g, "");
  return {
    file: `markiro-host-${stamp}-7c1e2a9b.db`,
    createdAt,
    trigger,
    sizeBytes: 4 * 1024 * 1024,
    sha256: "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
    hostIdentity: true,
  };
}

/**
 * Copies as they should be: both folders copied at 14:00 by the host's
 * clock, nothing running. The office's default answer: it warns of nothing.
 */
export const HEALTHY_BACKUPS: BackupState = {
  now: "2026-10-09T14:20:00Z",
  local: {
    dir: "C:\\ProgramData\\Markiro\\Host\\backups",
    lastAttempt: { at: "2026-10-09T14:00:03Z", trigger: "scheduled", ok: true, code: null },
    copies: [backupCopy("2026-10-09T14:00:00Z"), backupCopy("2026-10-09T11:35:12Z", "manual")],
  },
  second: {
    dir: "\\\\ADMIN-PC\\MarkiroCopies",
    lastAttempt: { at: "2026-10-09T14:00:04Z", trigger: "scheduled", ok: true, code: null },
    copies: [backupCopy("2026-10-09T14:00:00Z")],
  },
  settingsRev: 7,
  running: null,
  restoreHold: null,
};
