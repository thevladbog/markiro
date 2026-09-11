import { z } from "zod";
import { sellerTaxPolicySchema } from "./commercial-terms.js";

import {
  billingContactSchema,
  billingProfileKindSchema,
  cancelledOfferSchema,
  commercialDocumentListItemSchema,
  draftOfferSchema,
  expiredOfferSchema,
  normalizedBillingAddressSchema,
  offerDetailSchema,
  offerDetailV2Schema,
  offerSchema,
  offerStatusSchema,
  paidOfferSchema,
  platformBillingRequestStatusSchema,
  publishedOfferSchema,
  supersededOfferSchema,
} from "./commercial.js";
import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const positiveIntegerSchema = z.number().int().positive().max(2_147_483_647);
const nonNegativeIntegerSchema = z.number().int().min(0).max(2_147_483_647);
const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);
const nullableResponseTimestampSchema = responseTimestampSchema.nullable();
const queryTimestampSchema = z.iso.datetime({ offset: true });
const pageSizeSchema = z.coerce
  .number()
  .int()
  .refine((value) => value === 25 || value === 50 || value === 100, {
    message: "Expected a page size of 25, 50, or 100",
  });
const responsePageSizeSchema = z
  .number()
  .int()
  .refine((value) => value === 25 || value === 50 || value === 100, {
    message: "Expected a page size of 25, 50, or 100",
  });

export const offerRegistryQuerySchema = z
  .object({
    search: z
      .string()
      .max(200)
      .refine((value) => value.trim().length > 0, "Search must not be blank")
      .optional(),
    tenantId: platformTenantIdSchema.optional(),
    status: offerStatusSchema.optional(),
    createdFrom: queryTimestampSchema.optional(),
    createdTo: queryTimestampSchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: pageSizeSchema.default(25),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.createdFrom !== undefined &&
      query.createdTo !== undefined &&
      Date.parse(query.createdTo) < Date.parse(query.createdFrom)
    ) {
      context.addIssue({
        code: "custom",
        path: ["createdTo"],
        message: "createdTo precedes createdFrom",
      });
    }
  });

const registryProjectionFields = {
  tenantName: z.string().min(1).max(300),
  tenantSlug: z.string().min(1).max(300),
  buyerLegalName: z.string().min(1).max(500).nullable(),
  buyerTaxId: z.string().min(1).max(32).nullable(),
  lineSummary: z.array(z.string().min(1)).max(3),
  lineCount: nonNegativeIntegerSchema,
};

export const offerRegistryItemSchema = z.discriminatedUnion("status", [
  draftOfferSchema.extend(registryProjectionFields).strict(),
  publishedOfferSchema.extend(registryProjectionFields).strict(),
  supersededOfferSchema.extend(registryProjectionFields).strict(),
  paidOfferSchema.extend(registryProjectionFields).strict(),
  cancelledOfferSchema.extend(registryProjectionFields).strict(),
  expiredOfferSchema.extend(registryProjectionFields).strict(),
]);

export const offerRegistrySchema = z
  .object({
    items: z.array(offerRegistryItemSchema),
    page: positiveIntegerSchema,
    limit: responsePageSizeSchema,
    total: nonNegativeIntegerSchema,
  })
  .strict();

export const offerWorkspacePartySchema = z
  .object({
    kind: billingProfileKindSchema,
    fullName: z.string().min(1).max(500),
    displayName: z.string().min(1).max(300),
    inn: z.string().nullable(),
    kpp: z.string().nullable(),
    ogrn: z.string().nullable(),
    ogrnip: z.string().nullable(),
    legalAddressRaw: z.string().min(1).max(1_000),
    legalAddress: normalizedBillingAddressSchema.nullable(),
    actualSameAsLegal: z.boolean(),
    actualAddressRaw: z.string().max(1_000).nullable(),
    actualAddress: normalizedBillingAddressSchema.nullable(),
    postalSameAsLegal: z.boolean(),
    postalAddressRaw: z.string().max(1_000).nullable(),
    postalAddress: normalizedBillingAddressSchema.nullable(),
    contact: billingContactSchema.nullable(),
    revision: positiveIntegerSchema,
    confirmedAt: nullableResponseTimestampSchema,
  })
  .strict();

export const offerWorkspaceDecisionSchema = z
  .object({
    id: platformUuidSchema,
    decision: z.enum(["accepted", "changes_requested"]),
    message: z.string().nullable(),
    createdAt: responseTimestampSchema,
  })
  .strict();

export const offerWorkspaceBankAccountSchema = z
  .object({
    id: platformUuidSchema,
    label: z.string().min(1).max(200),
    settlementAccount: z.string().regex(/^\d{20}$/),
    bic: z.string().regex(/^\d{9}$/),
    bankName: z.string().min(1).max(500),
    correspondentAccount: z.string().regex(/^\d{20}$/),
    currency: z.literal("RUB"),
  })
  .strict();

export const offerWorkspaceRequestSchema = z
  .object({
    id: platformUuidSchema,
    number: z.string().min(1),
    status: platformBillingRequestStatusSchema,
  })
  .strict();

export const offerWorkspaceSchema = z
  .object({
    offer: offerDetailSchema,
    tenant: z
      .object({
        id: platformTenantIdSchema,
        name: z.string().min(1).max(300),
        slug: z.string().min(1).max(300),
      })
      .strict(),
    parties: z
      .object({
        seller: offerWorkspacePartySchema.nullable(),
        buyer: offerWorkspacePartySchema.nullable(),
        sellerBankAccount: offerWorkspaceBankAccountSchema.nullable(),
        buyerBankAccount: offerWorkspaceBankAccountSchema.nullable(),
      })
      .strict(),
    revisions: z.array(offerSchema),
    decision: offerWorkspaceDecisionSchema.nullable(),
    documents: z.array(commercialDocumentListItemSchema),
    request: offerWorkspaceRequestSchema.nullable(),
    actions: z
      .object({
        publish: z.boolean(),
        cancel: z.boolean(),
        revise: z.boolean(),
        pay: z.boolean(),
        createInvoice: z.boolean(),
        addSignedVariant: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const offerPreviewSchema = z
  .object({ html: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type OfferPreview = z.output<typeof offerPreviewSchema>;

export const platformOfferWorkspaceContracts = {
  preview: {
    params: platformUuidSchema,
    response: offerPreviewSchema,
  },
  registry: {
    query: offerRegistryQuerySchema,
    response: offerRegistrySchema,
  },
  workspace: {
    params: platformUuidSchema,
    response: offerWorkspaceSchema,
  },
} as const;

export type OfferRegistryQuery = z.output<typeof offerRegistryQuerySchema>;
export type OfferRegistry = z.output<typeof offerRegistrySchema>;
export type OfferWorkspace = z.output<typeof offerWorkspaceSchema>;

export const offerWorkspacePartyV2Schema = offerWorkspacePartySchema
  .extend({
    taxPolicy: sellerTaxPolicySchema.nullable().optional(),
  })
  .strict();
export const offerWorkspaceV2Schema = offerWorkspaceSchema
  .extend({
    offer: offerDetailV2Schema,
    parties: offerWorkspaceSchema.shape.parties
      .extend({
        seller: offerWorkspacePartyV2Schema.nullable(),
        buyer: offerWorkspacePartyV2Schema.nullable(),
      })
      .strict(),
  })
  .strict();
export const platformOfferWorkspaceV2Contracts = {
  ...platformOfferWorkspaceContracts,
  workspace: { ...platformOfferWorkspaceContracts.workspace, response: offerWorkspaceV2Schema },
} as const;
export type OfferWorkspaceV2 = z.output<typeof offerWorkspaceV2Schema>;
