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
  })
  .strict();

export const chzSignerTaskSchema = z
  .object({
    id: z.uuid(),
    type: z.literal("true_api_auth"),
    payload: chzTrueApiAuthPayloadSchema,
  })
  .strict();

export const chzSignerTaskCompleteSchema = z
  .object({
    token: z.string().min(1).max(8192),
    expiresAt: z.iso.datetime({ offset: true }),
    certThumbprint: z.string().trim().min(1).max(128),
    certSubject: z.string().trim().max(1000).optional(),
    certInn: innSchema.optional(),
    certNotAfter: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

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
export type ChzSignerTask = z.infer<typeof chzSignerTaskSchema>;
export type ChzSignerTaskComplete = z.infer<typeof chzSignerTaskCompleteSchema>;
export type ChzSignerTaskFail = z.infer<typeof chzSignerTaskFailSchema>;

export const chzSignerContracts = {
  pairRequest: chzSignerPairRequestSchema,
  pairResponse: chzSignerPairResponseSchema,
  task: chzSignerTaskSchema,
  trueApiAuthPayload: chzTrueApiAuthPayloadSchema,
  taskComplete: chzSignerTaskCompleteSchema,
  taskFail: chzSignerTaskFailSchema,
} as const;
