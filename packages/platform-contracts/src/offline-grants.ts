import { deviceReplacementTargetFenceSchema } from "./device-replacements.js";
import { z } from "zod";
import { grantOwnerSchema } from "@markiro/domain";
export {
  deviceKindSchema,
  grantCapabilitySchema,
  grantEventTypeSchema,
  grantOwnerSchema,
  grantProtectedHeaderSchema,
  budgetLineSchema,
  deviceGrantSchema,
  taskGrantSchema,
  offlineGrantSchema,
} from "@markiro/domain";
export type {
  DeviceKind,
  GrantCapability,
  GrantEventType,
  GrantOwner,
  GrantBase,
  DeviceGrant,
  BudgetLine,
  TaskGrant,
  OfflineGrant,
  GrantEnvelope,
  GrantTaskSnapshot,
  GrantIssueResult,
} from "@markiro/domain";

export const grantTaskSnapshotSchema = z
  .object({
    taskKind: z.enum(["shift", "inventory", "pickup"]),
    taskId: z.string().uuid(),
    snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
    canonical: z.string().min(1),
  })
  .strict();
export const grantEnvelopeSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    serverTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    owner: grantOwnerSchema,
    mode: z.enum(["observe", "strict"]),
    grants: z.array(z.string().min(1)),
    taskSnapshots: z.array(grantTaskSnapshotSchema),
  })
  .strict();
export const grantIssueResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("issued"), envelope: grantEnvelopeSchema }).strict(),
  z
    .object({
      status: z.literal("denied"),
      reason: z.enum([
        "policy_not_configured",
        "not_entitled",
        "facts_unknown",
        "task_not_frozen",
        "bounds_required",
      ]),
    })
    .strict(),
]);

/** Explicitly negotiated transport; never add fields to existing native DTOs. */
export const grantNegotiationSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    capability: z.literal("offline-grants-v1"),
    requestId: z.string().uuid(),
  })
  .strict();
export const grantClientReadinessRequestSchema = grantNegotiationSchema
  .omit({ capability: true })
  .extend({
    capability: z.literal("offline-grants-readiness-v1"),
    clientBuild: z.string().min(1).max(100),
    storageRevision: z.number().int().positive().max(2_147_483_647),
    installed: z
      .object({
        mode: z.enum(["observe", "strict"]),
        policyRevision: z.string().min(1).max(256).nullable(),
        keysetRevision: z.string().min(1).max(256).nullable(),
        verifiedGrantId: z.string().uuid().nullable(),
      })
      .strict(),
  })
  .strict();
export const grantClientReadinessResponseSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    requestId: z.string().uuid(),
    receivedAt: z.string().datetime({ offset: true }),
    accepted: z.literal(true),
    matchesCurrentConfiguration: z.boolean(),
    verifiedGrantMatched: z.boolean(),
  })
  .strict();
export const deviceGrantRequestSchema = grantNegotiationSchema;
export const taskGrantRequestSchema = grantNegotiationSchema
  .extend({
    taskKind: z.enum(["shift", "inventory", "pickup"]),
    taskId: z.string().uuid(),
  })
  .strict();
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const grantPublicKeySchema = z
  .object({
    kid: z.string().min(1).max(128),
    jwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: coordinate,
        y: coordinate,
        alg: z.literal("ES256").optional(),
        use: z.literal("sig").optional(),
      })
      .strict(),
  })
  .strict();
export const grantKeysetSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    origin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      }),
    revision: z.string().min(1).max(256),
    keys: z.array(grantPublicKeySchema).min(1).max(64),
    retiredKids: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict()
  .refine((value) => new Set(value.keys.map((key) => key.kid)).size === value.keys.length)
  .refine((value) => new Set(value.retiredKids).size === value.retiredKids.length);
export type DeviceGrantRequest = z.infer<typeof deviceGrantRequestSchema>;
export type TaskGrantRequest = z.infer<typeof taskGrantRequestSchema>;
export type GrantKeyset = z.infer<typeof grantKeysetSchema>;
export type GrantClientReadinessRequest = z.infer<typeof grantClientReadinessRequestSchema>;
export type GrantClientReadinessResponse = z.infer<typeof grantClientReadinessResponseSchema>;

export const kioskGrantReservationRequestSchema = grantNegotiationSchema
  .extend({
    order: z
      .object({
        deviceSeq: z.number().int().nonnegative().max(2147483647),
        badgeDigest: z.string().optional(),
        badgeCode: z.string().min(1).optional(),
        reason: z.enum(["buy", "writeoff"]),
        writeoffReasonId: z.string().uuid().nullable().optional(),
        items: z.array(z.object({ rawKm: z.string().min(1).max(1024) }).strict()).max(500),
        boxes: z
          .array(z.object({ sscc: z.string().regex(/^[0-9]{18}$/) }).strict())
          .max(100)
          .optional(),
        admissionNonce: z.string().min(32).max(128).optional(),
      })
      .strict(),
  })
  .strict();
/** The native order owner additionally validates badge, UTF-8 bytes and SSCC semantics. */
export type KioskGrantReservationRequest = z.infer<typeof kioskGrantReservationRequestSchema>;
export const kioskGrantReservationResultSchema = z.union([
  grantIssueResultSchema.options[1],
  z
    .object({
      status: z.literal("reserved"),
      protocol: z.literal("offline-grants-v1"),
      admission: z
        .object({ claimedAt: z.string().datetime(), admissionProof: z.string().min(1) })
        .strict(),
      task: z
        .object({
          taskKind: z.literal("pickup"),
          taskId: z.string().uuid(),
          snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    })
    .strict(),
]);
export const grantKeysetResultSchema = z.union([
  grantKeysetSchema,
  grantIssueResultSchema.options[1],
]);
export type KioskGrantReservationResult = z.infer<typeof kioskGrantReservationResultSchema>;

/** Recovery transport remains available when productive issuance is denied. */
export const grantConfigurationSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    owner: grantOwnerSchema,
    serverTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(["observe", "strict"]),
    policyRevision: z.string().min(1).nullable(),
    keyset: grantKeysetSchema.nullable(),
    replacement: deviceReplacementTargetFenceSchema.optional(),
  })
  .strict();
export type GrantConfiguration = z.infer<typeof grantConfigurationSchema>;

/**
 * payloadDigest is productLabelValueDigest(payload): sorted object keys, ordered
 * arrays and exact string bytes. Transport whitespace is deliberately excluded.
 * Event links use JSON pointer + #eventType; one native event may have two costs.
 * Native payload validation remains with its existing transactional owner.
 */
export const grantEvidenceEnvelopeSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    batchId: z.string().min(1).max(200),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
    grants: z.array(z.string().min(1).max(65536)).max(128),
    eventGrants: z.record(
      z
        .string()
        .regex(
          /^\/(?:[^#]*)#(?:shift\.(?:scan|box\.close|pallet\.close|label\.prepare|close)|inventory\.(?:scan|repack|box\.close|close)|pickup\.complete)\.v1$/,
        ),
      z.string().uuid(),
    ),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Evidence retention/classification and production reconciliation are separate. */
export const grantEvidenceReceiptSchema = z
  .object({
    protocol: z.literal("offline-grants-v1"),
    batchId: z.string().min(1).max(200),
    outcome: z.enum(["accepted", "duplicate", "quarantined"]),
    reason: z.string().nullable(),
    receiptId: z.string().uuid(),
    reconciliation: z
      .object({
        status: z.enum(["applied", "rejected", "not_applied"]),
        statusCode: z.number().int().min(100).max(599).nullable(),
        result: z.unknown().nullable(),
      })
      .strict(),
  })
  .strict();
export type GrantEvidenceEnvelope = z.infer<typeof grantEvidenceEnvelopeSchema>;
export type GrantEvidenceReceipt = z.infer<typeof grantEvidenceReceiptSchema>;
