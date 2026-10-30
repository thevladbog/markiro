import { HostError } from "./client.js";
import { YANDEX_BACKUP_ERRORS } from "./yandex-backups.js";

/** Only these public reasons may be read from a Host error response. */
export const YANDEX_HOST_REASONS = [...YANDEX_BACKUP_ERRORS, "connection_changed"] as const;

/** Native failures carry codes only; neither raw errors nor response messages are shown. */
export const YANDEX_ACTION_ERRORS = [
  ...YANDEX_HOST_REASONS,
  "callback_busy",
  "restore_failed",
  "target_initialized",
  "host_role_required",
  "local_copies_present",
  "unsent_facts",
  "windows_required",
  "secret_prompt_failed",
  "local_storage_unavailable",
  "local_database_unavailable",
  "recovery_check_failed",
  "recovery_helper_failed",
  "copy_unpack_failed",
  "profile_dialog_failed",
  "profile_storage_failed",
  "browser_open_failed",
  "office_session_expired",
  "device_not_authorized",
  "office_forbidden",
  "host_operation_failed",
  "host_unreachable",
  "host_certificate_mismatch",
  "host_version_mismatch",
  "attempt_expired",
  "operation_busy",
  "operation_failed",
] as const;
export type YandexActionError = (typeof YANDEX_ACTION_ERRORS)[number];

export function yandexErrorCode(error: unknown): YandexActionError {
  if (error instanceof HostError) {
    if (error.kind === "transport") {
      if (error.code === "certificate_mismatch") return "host_certificate_mismatch";
      if (error.code === "not_paired") return "device_not_authorized";
      return error.code === "unreachable" || error.code === "timeout"
        ? "host_unreachable"
        : "host_operation_failed";
    }
    if (error.status === 401 || error.code === "unauthorized") {
      return error.credential === "device" ? "device_not_authorized" : "office_session_expired";
    }
    if (error.status === 403 || error.code === "forbidden") return "office_forbidden";
    if (
      error.status === 409 &&
      error.code === "conflict" &&
      error.details.constraint === "yandex_backup"
    ) {
      return (
        YANDEX_HOST_REASONS.find((code) => code === error.details.reason) ?? "host_operation_failed"
      );
    }
    return "host_operation_failed";
  }
  if (typeof error === "string") {
    const code =
      error === "quota"
        ? "quota_exceeded"
        : error === "reauth"
          ? "reauth_required"
          : error === "integrity"
            ? "integrity_failed"
            : error;
    return YANDEX_ACTION_ERRORS.find((candidate) => candidate === code) ?? "operation_failed";
  }
  return "operation_failed";
}
