import { z } from "zod";

export const YANDEX_BACKUP_ERRORS = [
  "network",
  "rate_limited",
  "quota_exceeded",
  "access_denied",
  "reauth_required",
  "identity_missing",
  "integrity_failed",
  "unsupported_format",
  "incompatible_version",
  "local_space",
  "remote_conflict",
  "cancelled",
  "client_credentials_invalid",
  "secret_unavailable",
  "client_secret_required",
] as const;
export type YandexBackupError = (typeof YANDEX_BACKUP_ERRORS)[number];

const timestamp = z.string().datetime({ offset: true }).nullable();
export const yandexBackupStatusSchema = z.object({
  connectionGeneration: z.uuid().nullable(),
  state: z.enum(["disconnected", "connecting", "connected", "reauth_required"]),
  clientId: z.string().max(128).nullable(),
  accountId: z.string().max(200).nullable(),
  accountLabel: z.string().max(200).nullable(),
  deliveryState: z.enum([
    "idle",
    "queued",
    "staging",
    "uploading",
    "verifying",
    "publishing",
    "confirmed",
    "failed",
  ]),
  pendingSince: timestamp,
  lastAttemptAt: timestamp,
  lastConfirmedSnapshotId: z.uuid().nullable(),
  lastConfirmedAt: timestamp,
  lastConfirmedCopyCreatedAt: timestamp,
  errorCode: z.enum(YANDEX_BACKUP_ERRORS).nullable(),
  progressBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextAttemptAt: timestamp,
});
export type YandexBackupStatus = z.infer<typeof yandexBackupStatusSchema>;

/** A safe portable identifier of the customer's own app. No credentials. */
export const yandexClientProfileSchema = z
  .object({
    format: z.literal(1),
    provider: z.literal("yandex_disk"),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    redirectUri: z.literal("http://127.0.0.1:45711/oauth/yandex/callback"),
    scopes: z.tuple([z.literal("cloud_api:disk.app_folder"), z.literal("login:info")]),
  })
  .strict();
export type YandexClientProfile = z.infer<typeof yandexClientProfileSchema>;
