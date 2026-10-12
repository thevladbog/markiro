import { z } from "zod";

// Backups and restore (plan РК): mirrors `markiro_proto::backup`. The host's
// answers are lenient like the Rust response types; the request bodies are
// strict like `deny_unknown_fields`. `proto/fixtures/backup-*.json`,
// `known-blocks-*.json` and `backup-codes.json` hold the shapes both sides
// read.

/** Why a copy into a folder failed (`markiro_proto::backup::failure`). */
export const BACKUP_FAILURES = [
  "destination_unavailable",
  "access_denied",
  "disk_full",
  "write_failed",
  "verify_failed",
  "local_copy_failed",
  "internal",
] as const;
export type BackupFailure = (typeof BACKUP_FAILURES)[number];

/** `details.reason` of a `conflict` on `backup_dir` (`markiro_proto::backup::dir_problems`). */
export const BACKUP_DIR_PROBLEMS = [
  "missing",
  "not_a_directory",
  "access_denied",
  "unwritable",
  "timeout",
  "inside_data_dir",
] as const;
export type BackupDirProblem = (typeof BACKUP_DIR_PROBLEMS)[number];

/** Codes of a refused block (`markiro_proto::backup::known_block_codes`). */
export const KNOWN_BLOCK_CODES = [
  "block_mismatch",
  "block_overlap",
  "prefix_unknown",
  "range_invalid",
] as const;

export const backupTriggerSchema = z.enum(["scheduled", "manual"]);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;

/** One verified copy in a folder. */
export const backupCopySchema = z.object({
  file: z.string(),
  createdAt: z.iso.datetime(),
  trigger: backupTriggerSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type BackupCopy = z.infer<typeof backupCopySchema>;

/** The last copy the host tried to make in a folder since it started; `code` when it failed. */
export const backupAttemptSchema = z.object({
  at: z.iso.datetime(),
  trigger: backupTriggerSchema,
  ok: z.boolean(),
  code: z.string().nullable(),
});
export type BackupAttempt = z.infer<typeof backupAttemptSchema>;

/** One folder of copies, its copies newest first. */
export const backupDestinationSchema = z.object({
  dir: z.string(),
  lastAttempt: backupAttemptSchema.nullable(),
  copies: z.array(backupCopySchema),
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

/**
 * The host holds the stations' facts since a restore, until an administrator
 * resumes them; each unrevoked station says whether it gave its blocks back.
 */
export const restoreHoldSchema = z.object({
  since: z.iso.datetime(),
  epoch: z.uuid(),
  stations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      lastSeenAt: z.iso.datetime().nullable(),
      reconciled: z.boolean(),
    }),
  ),
});
export type RestoreHold = z.infer<typeof restoreHoldSchema>;

/** `GET /v1/office/backups`; `POST`, `PUT …/settings` and `POST …/resume` answer it too. */
export const backupStateSchema = z.object({
  /** The host's clock: a copy's age is measured by it, never by this PC's. */
  now: z.iso.datetime(),
  local: backupDestinationSchema,
  second: backupDestinationSchema.nullable(),
  settingsRev: z.number().int(),
  running: z.object({ trigger: backupTriggerSchema, startedAt: z.iso.datetime() }).nullable(),
  restoreHold: restoreHoldSchema.nullable(),
});
export type BackupState = z.infer<typeof backupStateSchema>;

/** `PUT /v1/office/backups/settings`: the second folder, or `null` to stop copying there. */
export const backupSettingsUpdateSchema = z
  .object({ secondDir: z.string().nullable(), expectedRev: z.number().int() })
  .strict();
export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>;

/** One block a station holds, as the host issued it. */
export const knownBlockSchema = z
  .object({
    id: z.uuid(),
    issuerPrefix: z.string(),
    extension: z.number().int().min(0).max(9),
    fromSerial: z.number().int().nonnegative(),
    toSerial: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `POST /v1/device/sscc/blocks/known`: every block the station holds, after a restore, in
 * parts of 64 at most (`known_blocks::MAX_BLOCKS`); the host marks the station on the last
 * part, which may be empty (a station that never took a block, plans ХП and ОЧ).
 */
export const knownBlocksRequestSchema = z
  .object({
    blocks: z.array(knownBlockSchema).max(64),
    /** More parts of this run follow; absent — the last part (plan ОЧ). */
    more: z.boolean().optional(),
  })
  .strict();
export type KnownBlocksRequest = z.infer<typeof knownBlocksRequestSchema>;

/** What became of each block, in the request's order. */
export const knownBlocksResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      outcome: z.enum(["registered", "known", "refused"]),
      code: z.string().nullable(),
    }),
  ),
});
export type KnownBlocksResponse = z.infer<typeof knownBlocksResponseSchema>;
