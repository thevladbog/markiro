import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

// The shell's commands of the distribution through the host (plan ОБН-3,
// src-tauri `update::fetch`, `update::stage`). The check and the launch are
// plan ОБН-2's (`office/info/update-shell.ts`). The webview never sees the
// installer: it gets paths the shell found or wrote.

/** `update_check_manifest`: a manifest whose signature checked out, as it is shown. */
export const manifestViewSchema = z
  .object({
    version: z.string(),
    channel: z.string(),
    releasedAt: z.string(),
    notes: z.array(z.string()),
    minUpgradeFrom: z.string(),
    protocol: z.number().int().nonnegative(),
    minProtocol: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ManifestView = z.infer<typeof manifestViewSchema>;

const fetchedSchema = z
  .object({
    version: z.string(),
    manifestPath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type FetchedPackage = z.infer<typeof fetchedSchema>;

const stagedSchema = z
  .object({ version: z.string(), sizeBytes: z.number().int().nonnegative() })
  .strict();
export type StagedPackage = z.infer<typeof stagedSchema>;

const progressSchema = z
  .object({ received: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
  .strict();
export type FetchProgress = z.infer<typeof progressSchema>;

/** `{ received, total }` while `update_fetch` downloads. */
export const UPDATE_PROGRESS_EVENT = "standalone://update-progress";

/** The bare codes of `update_fetch`, `update_stage` and `update_check_manifest` (plan ОБН-2's commands have their own, `UPDATE_SHELL_CODES`). */
export const UPDATE_ERROR_CODES = [
  "not_paired",
  "unreachable",
  "certificate_mismatch",
  "key_rejected",
  "package_unavailable",
  "package_verifying",
  "update_busy",
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "not_newer",
  "host_mismatch",
  "needs_intermediate",
  "too_long",
  "hash_mismatch",
  "interrupted",
  "storage",
  "invalid_request",
  "not_found",
  "session_ended",
  "forbidden",
  "package_not_newer",
  "manifest_refused",
  "installer_refused",
  "disk_full",
  "refused",
] as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

/** Every member is a function-typed property (`@typescript-eslint/unbound-method`). */
export interface UpdatesApi {
  /** This build's version (`tauri.conf.json`). */
  appVersion: () => Promise<string>;
  checkManifest: (manifest: string) => Promise<ManifestView>;
  /** The host's package into this PC's local data; `onProgress` while it runs. */
  fetch: (onProgress: (progress: FetchProgress) => void) => Promise<FetchedPackage>;
  /** A found package to the host, with the office session. */
  stage: (manifestPath: string, officeToken: string) => Promise<StagedPackage>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

function failure(command: string, error: unknown): UpdateError {
  const code = UPDATE_ERROR_CODES.find((candidate) => candidate === error);
  return new UpdateError(code ?? "refused", `${command}: ${String(error)}`);
}

export function createTauriUpdatesApi(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
  version: () => Promise<string> = getVersion,
): UpdatesApi {
  async function run<T>(
    command: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let answer: unknown;
    try {
      answer = await call(command, args);
    } catch (error) {
      throw failure(command, error);
    }
    return schema.parse(answer);
  }
  return {
    appVersion: version,
    checkManifest: (manifest) => run("update_check_manifest", { manifest }, manifestViewSchema),
    fetch: async (onProgress) => {
      const stop = await subscribe(UPDATE_PROGRESS_EVENT, (event) => {
        const parsed = progressSchema.safeParse(event.payload);
        if (parsed.success) onProgress(parsed.data);
      });
      try {
        return await run("update_fetch", {}, fetchedSchema);
      } finally {
        stop();
      }
    },
    stage: (manifestPath, officeToken) =>
      run("update_stage", { manifestPath, officeToken }, stagedSchema),
  };
}
