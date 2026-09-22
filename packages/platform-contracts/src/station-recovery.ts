import { deviceReplacementTargetFenceSchema } from "./device-replacements.js";
import { z } from "zod";

/** Durable data owner: opaque existing tenant ID plus device UUID and kind. */
export const stationRecoveryIdentitySchema = z
  .object({
    tenantId: z.string().min(1),
    deviceId: z.uuid(),
    kind: z.enum(["station", "handheld"]),
  })
  .strict();

export const stationRecoveryRequestSchema = z
  .object({
    version: z.literal(1),
    code: z.string().regex(/^\d{8}$/),
    expected: stationRecoveryIdentitySchema,
  })
  .strict();

export const replacementEvidenceRecoverySchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("replacement_evidence_recovery"),
    // Recovery v1 never replaces the locally sealed owner's offline roster.
    operatorRoster: z.literal("preserve_sealed"),
    executionId: z.uuid(),
    intentId: z.uuid(),
    credentialEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.requestedAt), {
    message: "Recovery expiry must follow issuance",
  });
export type ReplacementEvidenceRecovery = z.infer<typeof replacementEvidenceRecoverySchema>;

/** Existing pairing field meanings, with an explicit recovery protocol version. */
export const stationRecoveryResponseSchema = z
  .object({
    version: z.literal(1),
    replacement: deviceReplacementTargetFenceSchema.optional(),
    recovery: replacementEvidenceRecoverySchema.optional(),
    device: z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.enum(["station", "handheld"]),
        tenantId: z.string().min(1),
        organizationName: z.string(),
        line: z.object({ id: z.uuid(), name: z.string() }).strict().nullable(),
      })
      .strict(),
    credential: z.object({ apiKey: z.string().min(1), serverUrl: z.url() }).strict(),
    operators: z.array(
      z
        .object({
          operatorId: z.string(),
          name: z.string(),
          login: z.string(),
          role: z.string(),
          pinHash: z.string(),
          badgeHash: z.string().nullable(),
          active: z.boolean(),
        })
        .strict(),
    ),
    subscription: z
      .object({
        access: z.enum(["managed", "read_only", "unmanaged"]),
        status: z.enum([
          "unmanaged",
          "pending_activation",
          "trial",
          "active",
          "expired",
          "read_only",
        ]),
        startsAt: z.iso.datetime().nullable(),
        endsAt: z.iso.datetime().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StationRecoveryIdentity = z.infer<typeof stationRecoveryIdentitySchema>;
export type StationRecoveryRequest = z.infer<typeof stationRecoveryRequestSchema>;
export type StationRecoveryResponse = z.infer<typeof stationRecoveryResponseSchema>;
