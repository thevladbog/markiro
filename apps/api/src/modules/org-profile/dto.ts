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

/** One `{product group -> template}` default; the box and pallet lists share the shape. */
const categoryLabelTemplateDefaultSchema = z.object({
  chzProductGroupCode: z.number().int().positive(),
  templateId: z.string().uuid(),
});

const categoryLabelTemplateDefaultsSchema = (field: string) =>
  z
    .array(categoryLabelTemplateDefaultSchema)
    .refine(
      (items) => new Set(items.map((item) => item.chzProductGroupCode)).size === items.length,
      { message: `${field} must not repeat a product group` },
    )
    .optional();

export const putOrgProfileSchema = z.object({
  gln: glnSchema.nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  inn: z.string().nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  defaultBoxLabelTemplateId: z.string().uuid().nullable().optional(),
  /** Full replacement of the per-category box-label defaults; omitted keeps the current list. */
  categoryBoxLabelTemplateDefaults: categoryLabelTemplateDefaultsSchema(
    "categoryBoxLabelTemplateDefaults",
  ),
  /**
   * The pallet counterparts, in full symmetry with the two box fields above
   * (06d §1.5, "defaults mirror the box ones exactly"). They are not
   * cosmetic: migration 0135 seeds the stock «Паллета 100×150» for every
   * organisation and points `org_profiles.default_pallet_label_template_id`
   * at it, and `LABEL_TEMPLATE_REFERENCE_CONSTRAINTS` refuses to disable or
   * delete a template a default still names. Without a write path here that
   * seeded template would be permanently undisableable for every tenant.
   */
  defaultPalletLabelTemplateId: z.string().uuid().nullable().optional(),
  /** Full replacement of the per-category pallet-label defaults; omitted keeps the current list. */
  categoryPalletLabelTemplateDefaults: categoryLabelTemplateDefaultsSchema(
    "categoryPalletLabelTemplateDefaults",
  ),
  pickupLimitsEnabled: z.boolean().optional(),
});
export type PutOrgProfileDto = z.infer<typeof putOrgProfileSchema>;

export interface CategoryBoxLabelTemplateDefaultDto {
  chzProductGroupCode: number;
  templateId: string;
}

/** Same `{product group -> template}` shape as the box entry, for pallet labels. */
export type CategoryPalletLabelTemplateDefaultDto = CategoryBoxLabelTemplateDefaultDto;

export interface OrgProfileDto {
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
  timeZone: string;
  defaultBoxLabelTemplateId: string | null;
  categoryBoxLabelTemplateDefaults: CategoryBoxLabelTemplateDefaultDto[];
  defaultPalletLabelTemplateId: string | null;
  categoryPalletLabelTemplateDefaults: CategoryPalletLabelTemplateDefaultDto[];
  /** Distinct ЧЗ product-group codes of non-archived products, ascending. A UI hint only. */
  productGroupsInUse: number[];
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

const categoryLabelTemplateDefaultsOpenApiSchema: SchemaObject = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["chzProductGroupCode", "templateId"],
    properties: { chzProductGroupCode: { type: "integer" }, templateId: uuidSchema },
  },
};

export const orgProfileOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "gln",
    "gs1Prefixes",
    "inn",
    "defaultBoxLabelTemplateId",
    "categoryBoxLabelTemplateDefaults",
    "defaultPalletLabelTemplateId",
    "categoryPalletLabelTemplateDefaults",
    "productGroupsInUse",
    "pickupLimitsEnabled",
    "logoUrl",
    "logoRevision",
  ],
  properties: {
    gln: { type: "string", pattern: "^\\d{13}$", nullable: true },
    gs1Prefixes: { type: "array", items: { type: "string", pattern: "^\\d{4,12}$" } },
    inn: { type: "string", nullable: true },
    defaultBoxLabelTemplateId: { ...uuidSchema, nullable: true },
    categoryBoxLabelTemplateDefaults: { ...categoryLabelTemplateDefaultsOpenApiSchema },
    defaultPalletLabelTemplateId: { ...uuidSchema, nullable: true },
    categoryPalletLabelTemplateDefaults: { ...categoryLabelTemplateDefaultsOpenApiSchema },
    productGroupsInUse: { type: "array", items: { type: "integer" } },
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

/** One entry of `GET /org/profile/sscc`'s `counters` list; mirrors `SsccCounterStateDto` (../sscc/dto). */
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

/**
 * `GET /org/profile/sscc` response; mirrors `SsccCounterListDto` (../sscc/dto):
 * one entry per extension digit (boxes, then pallets) rather than two named
 * fields, so a third numbering space later needs no schema change here.
 */
export const ssccCounterListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["counters"],
  properties: {
    counters: { type: "array", items: ssccCounterStateOpenApiSchema },
  },
};
