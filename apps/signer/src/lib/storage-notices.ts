import type { StorageNotice } from "./bridge.js";

/** The i18n key that words a storage notice. */
export function storageNoticeKey(notice: StorageNotice): string {
  switch (notice.kind) {
    case "localLessDurable":
      return `storage.localLessDurable.${notice.reason}`;
    case "movePostponed":
      return "storage.movePostponed";
    case "legacyCleanupPending":
      return "storage.legacyCleanupPending";
    case "roamedCopyPresent":
      return notice.sameAgent ? "storage.roamedCopy.sameAgent" : "storage.roamedCopy.otherAgent";
    case "credentialUnreadable":
      return "storage.credentialUnreadable";
  }
}

/** The pairing screen repeats only what affects the pairing itself: a
 *  credential this Windows user cannot read, and a profile that discards
 *  everything at sign-out. */
export function concernsPairing(notice: StorageNotice): boolean {
  return (
    notice.kind === "credentialUnreadable" ||
    (notice.kind === "localLessDurable" && notice.reason !== "deleteRoamingCache")
  );
}
