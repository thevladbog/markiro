import { z } from "zod";

export const chzSignerPairRequestSchema = z
  .object({
    pairingCode: z.string().regex(/^\d{8}$/),
    hostname: z.string().trim().min(1).max(200),
    appVersion: z.string().trim().min(1).max(50),
  })
  .strict();

export const chzSignerPairResponseSchema = z
  .object({
    agentId: z.uuid(),
    agentSecret: z.string().min(32),
    tenantName: z.string(),
  })
  .strict();

const innSchema = z.string().regex(/^\d{10}(\d{2})?$/);

export const chzTrueApiAuthPayloadSchema = z
  .object({
    trueApiBaseUrl: z.url(),
    inn: innSchema.optional(),
    tokenFormat: z.enum(["jwt", "uuid"]).optional(),
  })
  .strict();

export const chzOmsAuthPayloadSchema = z
  .object({
    trueApiBaseUrl: z.url(),
    // СУЗ issues this identifier and documents it as hex-shaped only, so RFC-4122 validation would refuse real values.
    omsConnection: z.guid(),
    inn: innSchema.optional(),
  })
  .strict();

export const chzSignDetachedPayloadSchema = z
  .object({
    purpose: z.literal("oms_order"),
    orderId: z.uuid(),
    /** Exact request body bytes, base64. Order bodies are well under 1 KB; the cap only bounds abuse. */
    dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(4).max(256 * 1024),
  })
  .strict();

export const chzSignerTaskSchema = z.discriminatedUnion("type", [
  z.object({ id: z.uuid(), type: z.literal("true_api_auth"), payload: chzTrueApiAuthPayloadSchema }).strict(),
  z.object({ id: z.uuid(), type: z.literal("oms_auth"), payload: chzOmsAuthPayloadSchema }).strict(),
  z.object({ id: z.uuid(), type: z.literal("sign_detached"), payload: chzSignDetachedPayloadSchema }).strict(),
]);

export const chzSignerTaskCompleteSchema = z
  .object({
    // True API tokens do not have a published maximum length.
    // Keep a bounded value below Express's default JSON-body limit, but leave
    // enough room for certificate-heavy JWT claims returned in production.
    token: z
      .string()
      .min(1)
      .max(64 * 1024),
    expiresAt: z.iso.datetime({ offset: true }),
    certThumbprint: z.string().trim().min(1).max(128),
    certSubject: z.string().trim().max(1000).optional(),
    certInn: innSchema.optional(),
    certNotAfter: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const chzSignerSignatureCompleteSchema = z
  .object({
    signatureBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(4).max(64 * 1024),
    certThumbprint: z.string().trim().min(1).max(128),
  })
  .strict();

export const chzSignerTaskCompleteBodySchema = z.union([
  chzSignerTaskCompleteSchema,
  chzSignerSignatureCompleteSchema,
]);

export const CHZ_SIGNER_ERROR_CODES = [
  "CRYPTO_PROVIDER_MISSING",
  "CRYPTO_CERT_NOT_FOUND",
  "CRYPTO_CERT_EXPIRED",
  "CRYPTO_CONTAINER_UNAVAILABLE",
  "CRYPTO_PIN_REQUIRED",
  "NETWORK",
  "TRUE_API",
] as const;

export const chzSignerTaskFailSchema = z
  .object({
    errorCode: z.enum(CHZ_SIGNER_ERROR_CODES),
    message: z.string().trim().min(1).max(2000),
  })
  .strict();

export type ChzSignerPairRequest = z.infer<typeof chzSignerPairRequestSchema>;
export type ChzSignerPairResponse = z.infer<typeof chzSignerPairResponseSchema>;
export type ChzTrueApiAuthPayload = z.infer<typeof chzTrueApiAuthPayloadSchema>;
export type ChzOmsAuthPayload = z.infer<typeof chzOmsAuthPayloadSchema>;
export type ChzSignDetachedPayload = z.infer<typeof chzSignDetachedPayloadSchema>;
export type ChzSignerTask = z.infer<typeof chzSignerTaskSchema>;
export type ChzSignerTaskComplete = z.infer<typeof chzSignerTaskCompleteSchema>;
export type ChzSignerSignatureComplete = z.infer<typeof chzSignerSignatureCompleteSchema>;
export type ChzSignerTaskCompleteBody = z.infer<typeof chzSignerTaskCompleteBodySchema>;
export type ChzSignerTaskFail = z.infer<typeof chzSignerTaskFailSchema>;

export const chzSignerContracts = {
  pairRequest: chzSignerPairRequestSchema,
  pairResponse: chzSignerPairResponseSchema,
  task: chzSignerTaskSchema,
  trueApiAuthPayload: chzTrueApiAuthPayloadSchema,
  omsAuthPayload: chzOmsAuthPayloadSchema,
  signDetachedPayload: chzSignDetachedPayloadSchema,
  taskComplete: chzSignerTaskCompleteSchema,
  signatureComplete: chzSignerSignatureCompleteSchema,
  taskCompleteBody: chzSignerTaskCompleteBodySchema,
  taskFail: chzSignerTaskFailSchema,
} as const;
