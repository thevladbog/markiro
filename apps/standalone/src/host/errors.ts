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
