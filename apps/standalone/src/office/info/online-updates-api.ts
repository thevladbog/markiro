import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { manifestViewSchema, type FetchProgress } from "../../update/updates-api.js";

export type ReleaseChannel = "stable" | "beta";
const offerSchema = z
  .object({ manifest: manifestViewSchema, newer: z.boolean(), compatible: z.boolean() })
  .strict();
export type OnlineOffer = z.infer<typeof offerSchema>;
const downloadedSchema = z
  .object({
    version: z.string(),
    manifestPath: z.string().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
const progressSchema = z
  .object({ received: z.number().int().nonnegative(), total: z.number().int().positive() })
  .strict();
export const ONLINE_PROGRESS_EVENT = "standalone://online-update-progress";
const CODES = [
  "unreachable",
  "package_unavailable",
  "invalid_request",
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "not_newer",
  "needs_intermediate",
  "offer_changed",
  "too_long",
  "hash_mismatch",
  "interrupted",
  "storage",
  "update_busy",
  "refused",
] as const;
export class OnlineUpdateError extends Error {
  readonly code: (typeof CODES)[number];
  constructor(code: (typeof CODES)[number]) {
    super(code);
    this.name = "OnlineUpdateError";
    this.code = code;
  }
}
export interface OnlineUpdatesApi {
  check: (channel: ReleaseChannel) => Promise<OnlineOffer>;
  download: (
    channel: ReleaseChannel,
    version: string,
    progress: (value: FetchProgress) => void,
  ) => Promise<z.infer<typeof downloadedSchema>>;
}
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;
export function createOnlineUpdatesApi(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
): OnlineUpdatesApi {
  async function run<T>(
    command: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return schema.parse(await call(command, args));
    } catch (error) {
      if (typeof error !== "string") throw error;
      throw new OnlineUpdateError(CODES.find((code) => code === error) ?? "refused");
    }
  }
  return {
    check: (channel) => run("update_online_check", { channel }, offerSchema),
    download: async (channel, version, progress) => {
      const stop = await subscribe(ONLINE_PROGRESS_EVENT, ({ payload }) => {
        const parsed = progressSchema.safeParse(payload);
        if (parsed.success && parsed.data.received <= parsed.data.total) progress(parsed.data);
      });
      try {
        return await run("update_online_download", { channel, version }, downloadedSchema);
      } finally {
        stop();
      }
    },
  };
}
