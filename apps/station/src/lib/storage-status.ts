import { invoke } from "@tauri-apps/api/core";

export type LessDurableReason = "temporary_profile" | "mandatory_profile" | "delete_roaming_cache";

/** Mirrors `StorageNotice` in src-tauri/src/storage/mod.rs. */
export type StorageNotice =
  | { kind: "legacy_in_use" }
  | { kind: "move_failed" }
  | { kind: "local_less_durable"; reason: LessDurableReason }
  | { kind: "roamed_copy_present"; sameMachineId: boolean }
  | { kind: "claim_leftovers" };

export interface StationStorageStatus {
  dir: string;
  mode: "local" | "legacy";
  notices: StorageNotice[];
}

const REASONS: readonly string[] = [
  "temporary_profile",
  "mandatory_profile",
  "delete_roaming_cache",
];

function isNotice(value: unknown): value is StorageNotice {
  if (typeof value !== "object" || value === null) return false;
  const notice = value as Record<string, unknown>;
  switch (notice.kind) {
    case "legacy_in_use":
    case "move_failed":
    case "claim_leftovers":
      return true;
    case "local_less_durable":
      return typeof notice.reason === "string" && REASONS.includes(notice.reason);
    case "roamed_copy_present":
      return typeof notice.sameMachineId === "boolean";
    default:
      return false;
  }
}

function isStatus(value: unknown): value is StationStorageStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.dir === "string" &&
    (status.mode === "local" || status.mode === "legacy") &&
    Array.isArray(status.notices) &&
    status.notices.every(isNotice)
  );
}

/**
 * Where the station files live and why, for diagnostics. Never rejects: a
 * blocked storage already stops startup through `readConfig`, and a missing
 * or unknown answer only hides the diagnostics.
 */
export async function readStorageStatus(): Promise<StationStorageStatus | null> {
  try {
    const status: unknown = await invoke("station_storage_status");
    return isStatus(status) ? status : null;
  } catch {
    return null;
  }
}

/** The i18n key under `storage.notices` for one notice. */
export function storageNoticeKey(notice: StorageNotice): string {
  switch (notice.kind) {
    case "local_less_durable":
      return `storage.notices.local_less_durable.${notice.reason}`;
    case "roamed_copy_present":
      return notice.sameMachineId
        ? "storage.notices.roamed_copy_present.sameMachine"
        : "storage.notices.roamed_copy_present.otherMachine";
    default:
      return `storage.notices.${notice.kind}`;
  }
}

/** A copy of this station elsewhere risks duplicate SSCCs: an error. */
export function storageNoticeTone(notice: StorageNotice): "warn" | "info" | "error" {
  switch (notice.kind) {
    case "roamed_copy_present":
      return notice.sameMachineId ? "error" : "warn";
    case "claim_leftovers":
      return "info";
    case "legacy_in_use":
    case "move_failed":
    case "local_less_durable":
      return "warn";
  }
}

/** Temporary and mandatory profiles lose the pairing and data at sign-out. */
export function pairingUnsafe(notices: readonly StorageNotice[]): boolean {
  return notices.some(
    (notice) =>
      notice.kind === "local_less_durable" &&
      (notice.reason === "temporary_profile" || notice.reason === "mandatory_profile"),
  );
}
