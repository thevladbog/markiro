import { HostError } from "./client.js";
import { DeviceError } from "./device.js";

/** Error codes of the host protocol (`markiro_proto::codes`). */
export const API_ERROR_CODES = [
  "not_found",
  "method_not_allowed",
  "protocol_unsupported",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "stale_revision",
  "conflict",
  "last_admin",
  "sscc_below_floor",
  "already_initialized",
  "loopback_only",
  "rate_limited",
  "internal",
  "pairing_code_invalid",
  "pairing_code_expired",
  "sscc_exhausted",
  "restore_pending",
  "export_store_full",
  "export_file_too_large",
  "export_file_corrupted",
  "package_verifying",
  "update_busy",
  // An office user's photo (plan АВА); the statuses are `AVATAR_ERROR_CODES` of protocol.ts.
  "avatar_too_large",
  "avatar_unsupported_type",
  "avatar_too_small",
  "avatar_dimensions_too_large",
  "avatar_not_square",
  "avatar_corrupt",
  "avatar_not_found",
  "forbidden_replace_other",
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** The i18n key of the text to show for an error from the host or the shell. */
export function errorMessageKey(error: unknown): string {
  if (error instanceof HostError) {
    if (error.kind === "transport") return `errors.transport.${error.code}`;
    const credential = error.credential;
    if (credential) return `errors.unauthorized.${credential}`;
    return API_CODES.has(error.code) ? `errors.api.${error.code}` : "errors.unknown";
  }
  if (error instanceof DeviceError) return `errors.device.${error.code}`;
  return "errors.unknown";
}
