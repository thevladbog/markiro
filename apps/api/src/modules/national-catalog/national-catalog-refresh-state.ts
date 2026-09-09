import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chzRefreshErrorCodeSchema } from "@markiro/platform-contracts";
export const refreshActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);
export type RefreshActor = z.infer<typeof refreshActorSchema>;
export const refreshCheckpointSchema = z
  .object({
    version: z.literal(1),
    actor: refreshActorSchema,
    linkId: z.uuid(),
    revision: z.number().int(),
    cardId: z.string(),
    environment: z.enum(["production", "sandbox"]),
    boundGtin14: z.string().length(14),
    phase: z.enum(["card", "photo", "done"]),
    stepId: z.uuid(),
    runId: z.uuid().nullable(),
    attempts: z.number().int().min(0).max(4),
    enqueuePending: z.boolean(),
    nextRetryAt: z.iso.datetime().nullable(),
    photo: z
      .object({
        snapshotId: z.uuid(),
        sourceHash: z.string().length(64),
        selector: z
          .object({
            sourceId: z.string(),
            barcode: z.string().nullable(),
            primary: z.boolean(),
            urlHash: z.string().length(64),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RefreshCheckpoint = z.infer<typeof refreshCheckpointSchema>;
export function newRefreshCheckpoint(
  link: Pick<RefreshCheckpoint, "linkId" | "revision" | "cardId" | "environment" | "boundGtin14">,
  actor: RefreshActor,
): RefreshCheckpoint {
  return {
    version: 1,
    ...link,
    actor,
    phase: "card",
    stepId: randomUUID(),
    runId: null,
    attempts: 0,
    enqueuePending: true,
    nextRetryAt: null,
    photo: null,
  };
}
export function readRefreshCheckpoint(value: unknown): RefreshCheckpoint | null {
  const parsed = refreshCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function safeRefreshErrorCode(
  value: unknown,
): z.infer<typeof chzRefreshErrorCodeSchema> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "request_failed";
  if (
    [
      "unconfigured",
      "missing",
      "expired",
      "undecryptable",
      "provenance_unknown",
      "unauthorized",
    ].includes(value)
  )
    return "token_unavailable";
  if (["forbidden", "not_found"].includes(value)) return "card_unavailable";
  if (["unavailable", "rate_limited"].includes(value)) return "provider_unavailable";
  const parsed = chzRefreshErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "request_failed";
}
