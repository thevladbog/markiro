import {
  TRACEABILITY_LOCATION_ROLES,
  validateLocationDescription,
  type LocationDescriptionInput,
  type LocationDescriptionIssue,
} from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";

const trimmedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const preservedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0);

const draftDescription: LocationDescriptionInput = {
  businessName: "valid",
  phoneNumber: null,
  addressKind: "street",
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: null,
  stateOrRegion: null,
  zipOrPostalCode: null,
  countryCode: null,
};

function isValidDescriptionField(field: keyof LocationDescriptionInput, value: string): boolean {
  const input: LocationDescriptionInput = {
    ...draftDescription,
    addressKind: field === "latitude" || field === "longitude" ? "coordinates" : "street",
    [field]: value,
  };
  return !validateLocationDescription(input, "draft").some((issue) => issue.field === field);
}

const nullableDescriptionText = (field: keyof LocationDescriptionInput, maximum: number) =>
  preservedText(maximum)
    .refine((value) => isValidDescriptionField(field, value))
    .nullable();

const nullablePhoneSchema = nullableDescriptionText("phoneNumber", 40);
const nullableStreetAddressSchema = nullableDescriptionText("streetAddress", 500);
const nullableCoordinateSchema = (field: "latitude" | "longitude") =>
  z
    .string()
    .refine((value) => value.trim().length > 0)
    .refine((value) => isValidDescriptionField(field, value))
    .nullable();
const nullableCitySchema = nullableDescriptionText("city", 200);
const nullableRegionSchema = nullableDescriptionText("stateOrRegion", 200);
const nullablePostalSchema = nullableDescriptionText("zipOrPostalCode", 32);
const nullableCountrySchema = nullableDescriptionText("countryCode", 2);

const contactPhoneSchema = z
  .string()
  .min(3)
  .max(40)
  .refine((value) => isValidDescriptionField("phoneNumber", value))
  .nullable();

const partyFields = {
  name: trimmedText(200),
  legalName: trimmedText(200).nullable(),
  contactName: trimmedText(200).nullable(),
  contactPhone: contactPhoneSchema,
  contactEmail: z.email().max(254).nullable(),
  notes: trimmedText(2000).nullable(),
};

export const createUsPartySchema = z
  .object({
    name: partyFields.name,
    legalName: partyFields.legalName.default(null),
    contactName: partyFields.contactName.default(null),
    contactPhone: partyFields.contactPhone.default(null),
    contactEmail: partyFields.contactEmail.default(null),
    notes: partyFields.notes.default(null),
  })
  .strict();

const nonemptyPatch = <Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) =>
  schema.refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Expected at least one field",
  });

export const updateUsPartySchema = nonemptyPatch(
  z
    .object({
      name: partyFields.name.optional(),
      legalName: partyFields.legalName.optional(),
      contactName: partyFields.contactName.optional(),
      contactPhone: partyFields.contactPhone.optional(),
      contactEmail: partyFields.contactEmail.optional(),
      notes: partyFields.notes.optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
);

export const usPartySchema = z
  .object({
    id: platformUuidSchema,
    ...partyFields,
    archived: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const traceabilityLocationRoleSchema = z.enum(TRACEABILITY_LOCATION_ROLES);
const locationRolesSchema = z
  .array(traceabilityLocationRoleSchema)
  .max(TRACEABILITY_LOCATION_ROLES.length)
  .refine((roles) => new Set(roles).size === roles.length, "Duplicate location roles");

const locationDescriptionFields = {
  businessName: trimmedText(200),
  phoneNumber: nullablePhoneSchema,
  addressKind: z.enum(["street", "coordinates"]),
  streetAddress: nullableStreetAddressSchema,
  latitude: nullableCoordinateSchema("latitude"),
  longitude: nullableCoordinateSchema("longitude"),
  city: nullableCitySchema,
  stateOrRegion: nullableRegionSchema,
  zipOrPostalCode: nullablePostalSchema,
  countryCode: nullableCountrySchema,
};

const locationFields = {
  name: trimmedText(200),
  ...locationDescriptionFields,
  roles: locationRolesSchema,
};

function addDescriptionIssues(value: LocationDescriptionInput, context: z.RefinementCtx): void {
  for (const issue of validateLocationDescription(value, "draft")) {
    context.addIssue({ code: "custom", path: [issue.field], message: issue.code });
  }
}

export const createUsLocationSchema = z
  .object({
    partyId: platformUuidSchema,
    name: locationFields.name,
    businessName: locationFields.businessName,
    phoneNumber: locationFields.phoneNumber.default(null),
    addressKind: locationFields.addressKind.default("street"),
    streetAddress: locationFields.streetAddress.default(null),
    latitude: locationFields.latitude.default(null),
    longitude: locationFields.longitude.default(null),
    city: locationFields.city.default(null),
    stateOrRegion: locationFields.stateOrRegion.default(null),
    zipOrPostalCode: locationFields.zipOrPostalCode.default(null),
    countryCode: locationFields.countryCode.default(null),
    roles: locationFields.roles.default([]),
  })
  .strict()
  .superRefine(addDescriptionIssues);

export const updateUsLocationSchema = nonemptyPatch(
  z
    .object({
      name: locationFields.name.optional(),
      businessName: locationFields.businessName.optional(),
      phoneNumber: locationFields.phoneNumber.optional(),
      addressKind: locationFields.addressKind.optional(),
      streetAddress: locationFields.streetAddress.optional(),
      latitude: locationFields.latitude.optional(),
      longitude: locationFields.longitude.optional(),
      city: locationFields.city.optional(),
      stateOrRegion: locationFields.stateOrRegion.optional(),
      zipOrPostalCode: locationFields.zipOrPostalCode.optional(),
      countryCode: locationFields.countryCode.optional(),
      roles: locationFields.roles.optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
);

const descriptionIssueSchema: z.ZodType<LocationDescriptionIssue> = z
  .object({
    field: z.enum([
      "businessName",
      "phoneNumber",
      "addressKind",
      "streetAddress",
      "latitude",
      "longitude",
      "city",
      "stateOrRegion",
      "zipOrPostalCode",
      "countryCode",
    ]),
    code: z.enum(["required", "format"]),
  })
  .strict();

export const usLocationSchema = z
  .object({
    id: platformUuidSchema,
    partyId: platformUuidSchema,
    ...locationFields,
    archived: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    descriptionStatus: z
      .object({
        exportReady: z.boolean(),
        issues: z.array(descriptionIssueSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => addDescriptionIssues(value, context));

const archivedQuerySchema = z.enum(["true", "false", "all"]).default("false");

const canonicalQueryInteger = (minimum: number, maximum: number) =>
  z
    .union([
      z.number().int(),
      z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .transform((value) => Number(value)),
    ])
    .pipe(z.number().int().min(minimum).max(maximum));

const listQueryFields = {
  archived: archivedQuerySchema,
  search: z.string().trim().max(200).optional(),
  limit: canonicalQueryInteger(1, 100).default(50),
  offset: canonicalQueryInteger(0, 100000).default(0),
};

export const listUsPartiesQuerySchema = z.object(listQueryFields).strict();

const queryRolesSchema = z
  .union([traceabilityLocationRoleSchema, locationRolesSchema.min(1)])
  .transform((roles) => (Array.isArray(roles) ? roles : [roles]));

export const listUsLocationsQuerySchema = z
  .object({
    ...listQueryFields,
    partyId: platformUuidSchema.optional(),
    roles: queryRolesSchema.optional(),
  })
  .strict();

export const usPartyListSchema = z
  .object({
    items: z.array(usPartySchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
    }
  });

export const usLocationListSchema = z
  .object({
    items: z.array(usLocationSchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
    }
  });

export type CreateUsParty = z.infer<typeof createUsPartySchema>;
export type UpdateUsParty = z.infer<typeof updateUsPartySchema>;
export type UsParty = z.infer<typeof usPartySchema>;
export type CreateUsLocation = z.infer<typeof createUsLocationSchema>;
export type UpdateUsLocation = z.infer<typeof updateUsLocationSchema>;
export type UsLocation = z.infer<typeof usLocationSchema>;
export type ListUsPartiesQuery = z.infer<typeof listUsPartiesQuerySchema>;
export type ListUsLocationsQuery = z.infer<typeof listUsLocationsQuerySchema>;
