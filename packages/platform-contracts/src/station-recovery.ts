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

/** Existing pairing field meanings, with an explicit recovery protocol version. */
export const stationRecoveryResponseSchema = z
  .object({
    version: z.literal(1),
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
