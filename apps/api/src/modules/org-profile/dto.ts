import { z } from "zod";
import { hasValidCheckDigit } from "@markiro/domain";
import { isIanaTimeZone } from "../../lib/time-zone";

import type { SchemaObject } from "@nestjs/swagger";

/** GS1 GLN: exactly 13 digits with valid check digit. */
const glnSchema = z
  .string()
  .regex(/^\d{13}$/, "gln must be exactly 13 digits")
  .refine((v) => hasValidCheckDigit(v), { message: "GLN check digit is invalid" });

/** GS1 company prefix: 4-12 digits. */
const gs1PrefixSchema = z.string().regex(/^\d{4,12}$/, "gs1Prefixes entries must be 4-12 digits");

const timeZoneSchema = z.string().refine(isIanaTimeZone, "timeZone must be an IANA timezone");

export const putOrgProfileSchema = z.object({
  gln: glnSchema.nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  inn: z.string().nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  defaultBoxLabelTemplateId: z.string().uuid().nullable().optional(),
  pickupLimitsEnabled: z.boolean().optional(),
});
export type PutOrgProfileDto = z.infer<typeof putOrgProfileSchema>;

export interface OrgProfileDto {
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
  timeZone: string;
  defaultBoxLabelTemplateId: string | null;
  pickupLimitsEnabled: boolean;
  logoUrl: string | null;
  logoRevision: string | null;
}

export interface OrganizationLogoDto {
  logoRevision: string;
  logoUrl: string;
}

export interface KioskBrandingDto {
  organizationName: string;
  logoUrl: string | null;
  logoRevision: string | null;
}

/**
 * A 9-digit issuer prefix leaves a 7-digit serial, so the GS1-valid space is
 * 0..9_999_999 per extension digit. Fresh box allocation starts at 1, while
 * serial zero remains valid historical SSCC input. Seeding beyond the space
 * cannot produce a valid SSCC, so it is refused at the boundary rather than
 * at the first close.
 *
 * Shared by both the org-profile and counterparties controllers (Task 5) --
 * one tenant's own counter and each counterparty's counter carry the exact
 * same shape, so the schema is defined once here and imported by the other.
 */
export const ssccCounterSchema = z
  .object({
    extensionDigit: z.number().int().min(0).max(9),
    nextSerial: z.number().int().min(0).max(9_999_999),
  })
  .superRefine(({ extensionDigit, nextSerial }, ctx) => {
    if (extensionDigit === 0 && nextSerial < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["nextSerial"],
        message: "box nextSerial must be at least 1",
      });
    }
  });
export type SsccCounterDto = z.infer<typeof ssccCounterSchema>;

const uuidSchema = { type: "string", format: "uuid" } as const;

export const orgProfileOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "gln",
    "gs1Prefixes",
    "inn",
    "defaultBoxLabelTemplateId",
    "pickupLimitsEnabled",
    "logoUrl",
    "logoRevision",
  ],
  properties: {
    gln: { type: "string", pattern: "^\\d{13}$", nullable: true },
    gs1Prefixes: { type: "array", items: { type: "string", pattern: "^\\d{4,12}$" } },
    inn: { type: "string", nullable: true },
    defaultBoxLabelTemplateId: { ...uuidSchema, nullable: true },
    pickupLimitsEnabled: { type: "boolean" },
    logoUrl: { type: "string", nullable: true },
    logoRevision: { ...uuidSchema, nullable: true },
  },
};

export const organizationLogoOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["logoRevision", "logoUrl"],
  properties: {
    logoRevision: uuidSchema,
    logoUrl: { type: "string" },
  },
};

/** `GET /org/profile/sscc` response; mirrors `SsccCounterStateDto` (../sscc/dto). */
export const ssccCounterStateOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["extensionDigit", "nextSerial", "minSerial", "blockedBy"],
  properties: {
    extensionDigit: { type: "integer", minimum: 0, maximum: 9 },
    nextSerial: {
      type: "integer",
      minimum: 0,
      maximum: 9_999_999,
      description: "The value the next serial block will be cut from.",
    },
    minSerial: {
      type: "integer",
      minimum: 0,
      maximum: 9_999_999,
      description: "The lowest value PUT will accept right now.",
    },
    blockedBy: {
      nullable: true,
      description: "Why the counter cannot be reseeded right now, or null.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "shiftId", "shiftNumber"],
          properties: {
            kind: { type: "string", enum: ["active_shift"] },
            shiftId: uuidSchema,
            shiftNumber: { type: "string" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "deviceId", "deviceName"],
          properties: {
            kind: { type: "string", enum: ["device_out_of_sync"] },
            deviceId: uuidSchema,
            deviceName: { type: "string" },
          },
        },
      ],
    },
  },
};
