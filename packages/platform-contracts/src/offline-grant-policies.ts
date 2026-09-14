import { grantEventTypeSchema } from "@markiro/domain";
import { z } from "zod";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";

const finiteMaximumSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const eventBoundsSchema = z
  .object({
    maxEvents: finiteMaximumSchema,
    maxUnits: finiteMaximumSchema.optional(),
    maxContainers: finiteMaximumSchema.optional(),
  })
  .strict();
const taskBoundsSchema = z.record(z.string(), eventBoundsSchema).superRefine((bounds, ctx) => {
  for (const event of Object.keys(bounds)) {
    if (!grantEventTypeSchema.safeParse(event).success) {
      ctx.addIssue({ code: "custom", path: [event], message: "Unknown offline grant event" });
    }
  }
});

export const offlineGrantPolicySchema = z
  .object({
    version: z.literal(1),
    maxOfflineMs: finiteMaximumSchema.positive(),
    maxCompletionMs: finiteMaximumSchema.positive(),
    taskBounds: z
      .object({
        shift: taskBoundsSchema.optional(),
        inventoryCheck: taskBoundsSchema.optional(),
        inventoryRepack: taskBoundsSchema.optional(),
        pickup: taskBoundsSchema.optional(),
      })
      .strict(),
    rollout: z
      .object({
        protocol: z.literal("offline-grants-v1"),
        mode: z.enum(["observe", "strict"]),
        deviceIds: z
          .array(platformUuidSchema)
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length),
        decisionReference: z.string().trim().min(1).max(1_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const offlineGrantPolicyRecordSchema = z
  .object({
    id: platformUuidSchema,
    policyKey: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    status: z.enum(["draft", "approved"]),
    offlineGrant: offlineGrantPolicySchema,
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    decisionReference: z.string().nullable(),
    approvedAt: platformTimestampSchema.nullable(),
    approvedByPlatformUserId: z.string().nullable(),
    createdByPlatformUserId: z.string().min(1),
    createdAt: platformTimestampSchema,
  })
  .strict();
export const createOfflineGrantPolicySchema = z
  .object({
    policyKey: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    offlineGrant: offlineGrantPolicySchema,
  })
  .strict();
export const approveOfflineGrantPolicySchema = z
  .object({ decisionReference: z.string().trim().min(1).max(1_000) })
  .strict();

export const platformOfflineGrantPolicyContracts = {
  list: { response: z.object({ items: z.array(offlineGrantPolicyRecordSchema) }).strict() },
  create: {
    body: createOfflineGrantPolicySchema,
    response: offlineGrantPolicyRecordSchema.refine((policy) => policy.status === "draft"),
  },
  approve: {
    body: approveOfflineGrantPolicySchema,
    response: offlineGrantPolicyRecordSchema.refine((policy) => policy.status === "approved"),
  },
} as const;

export type OfflineGrantPolicy = z.output<typeof offlineGrantPolicySchema>;
export type OfflineGrantPolicyRecord = z.output<typeof offlineGrantPolicyRecordSchema>;
export type CreateOfflineGrantPolicy = z.output<typeof createOfflineGrantPolicySchema>;
export type ApproveOfflineGrantPolicy = z.output<typeof approveOfflineGrantPolicySchema>;
