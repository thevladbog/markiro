import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { importPrepareSchema, type ImportPrepare } from "@markiro/platform-contracts";

const failure = z.object({ itemId: z.uuid(), reason: z.string(), retryable: z.boolean() }).strict();
const checkpointSchema = z
  .object({
    version: z.literal(1),
    stepId: z.uuid(),
    runId: z.uuid().nullable(),
    work: z.array(z.array(z.uuid()).min(1).max(25)).max(100),
    completed: z.array(z.object({ itemId: z.uuid(), previewId: z.uuid() }).strict()).max(100),
    failures: z.array(failure).max(100),
    attempts: z.number().int().min(0).max(4),
    state: z.enum(["pending", "started", "deferred", "blocked", "failed", "done"]),
    nextRetryAt: z.iso.datetime().nullable(),
    enqueuePending: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();
export type PreparationCheckpoint = z.infer<typeof checkpointSchema>;
export function parsePreparationCheckpoint(value: unknown): PreparationCheckpoint {
  return checkpointSchema.parse(value);
}
export function preparationStep(cp: PreparationCheckpoint): PreparationCheckpoint {
  const done = cp.work.length === 0;
  return {
    ...cp,
    stepId: randomUUID(),
    runId: null,
    attempts: 0,
    state: done ? "done" : "pending",
    nextRetryAt: null,
    enqueuePending: !done,
    reason: cp.failures[0]?.reason ?? null,
  };
}
export function preparationCheckpoint(ids: string[]): PreparationCheckpoint {
  return preparationStep({
    version: 1,
    stepId: randomUUID(),
    runId: null,
    work: chunks(ids),
    completed: [],
    failures: [],
    attempts: 0,
    state: "pending",
    nextRetryAt: null,
    enqueuePending: true,
    reason: null,
  });
}
export function chunks(ids: string[]): string[][] {
  return Array.from({ length: Math.ceil(ids.length / 25) }, (_, i) =>
    ids.slice(i * 25, i * 25 + 25),
  );
}
/** Fixed-key canonical request; requestId is the idempotency key, not content. */
export function canonicalPreparation(value: ImportPrepare): { body: ImportPrepare; hash: string } {
  const parsed = importPrepareSchema.parse(value);
  const body = {
    requestId: parsed.requestId,
    itemIds: [...parsed.itemIds].sort(),
    manualNames: [...parsed.manualNames].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    categoryChoices: [...parsed.categoryChoices].sort((a, b) => a.itemId.localeCompare(b.itemId)),
  };
  return {
    body,
    hash: hashContent({
      itemIds: body.itemIds,
      manualNames: body.manualNames,
      categoryChoices: body.categoryChoices,
    }),
  };
}
export function hashContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
