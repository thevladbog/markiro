import { z } from "zod";

import {
  platformMoneySchema,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonNegativeIntegerSchema = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
const platformUserIdSchema = z.string().min(1).max(128);
const nullablePlatformUserIdSchema = platformUserIdSchema.nullable();
const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);
const nullableResponseTimestampSchema = responseTimestampSchema.nullable();
const serviceTimestampSchema = z.date();
const nullableServiceTimestampSchema = serviceTimestampSchema.nullable();
const requestDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const nullableRequestDateSchema = requestDateSchema.nullable();
const tenantDisplayNameSchema = z.string().trim().min(1).max(300);
const billingCivilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "Expected a real calendar date");
const vatRateSchema = z
  .string()
  .regex(/^\d{1,3}\.\d{2}$/)
  .nullable();
const nonNullUnknownSchema = z
  .unknown()
  .refine((value) => value !== null && value !== undefined, "Value must be present");

const moneyCents = (value: string): bigint => {
  const [whole = "0", fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
};
const centsMoney = (value: bigint): string =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;

export const billingProfileKindSchema = z.enum([
  "individual",
  "self_employed",
  "sole_proprietor",
  "legal_entity",
]);

export const normalizedBillingAddressSchema = z.object({
  value: z.string().trim().min(1).max(1_000),
  fiasId: z.string().max(100).nullable().optional(),
  kladrId: z.string().max(100).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  region: z.string().max(300).nullable().optional(),
  city: z.string().max(300).nullable().optional(),
  settlement: z.string().max(300).nullable().optional(),
  street: z.string().max(300).nullable().optional(),
  house: z.string().max(100).nullable().optional(),
  block: z.string().max(100).nullable().optional(),
  flat: z.string().max(100).nullable().optional(),
  latitude: z.string().max(50).nullable().optional(),
  longitude: z.string().max(50).nullable().optional(),
  qualityCode: z.string().max(100).nullable().optional(),
  completenessCode: z.string().max(100).nullable().optional(),
});

export const billingContactSchema = z
  .object({
    name: z.string().trim().min(1).max(300).nullable(),
    email: z.email().max(254).nullable(),
    phone: z.string().trim().min(1).max(50).nullable(),
  })
  .strict();

const sameAsLegalPostalAddressSchema = z.object({ sameAsLegal: z.literal(true) }).strict();
const separatePostalAddressSchema = z
  .object({
    sameAsLegal: z.literal(false),
    raw: z.string().trim().min(1).max(1_000),
    normalized: normalizedBillingAddressSchema.nullable().optional(),
  })
  .strict();
export const billingPostalAddressInputSchema = z.discriminatedUnion("sameAsLegal", [
  sameAsLegalPostalAddressSchema,
  separatePostalAddressSchema,
]);

const actualMatchesLegalSchema = z.object({ sameAsLegal: z.literal(true) }).strict();
const separateActualAddressSchema = z
  .object({
    sameAsLegal: z.literal(false),
    raw: z.string().trim().min(1).max(1_000),
    normalized: normalizedBillingAddressSchema.nullable().optional(),
  })
  .strict();
export const billingActualAddressInputSchema = z.discriminatedUnion("sameAsLegal", [
  actualMatchesLegalSchema,
  separateActualAddressSchema,
]);

const legacyBillingProfileInputCommonFields = {
  fullName: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(300),
  legalAddressRaw: z.string().trim().min(1).max(1_000),
  legalAddress: normalizedBillingAddressSchema.nullable().optional(),
  postalAddress: billingPostalAddressInputSchema,
  contact: billingContactSchema,
};
const billingProfileInputCommonFields = {
  ...legacyBillingProfileInputCommonFields,
  actualAddress: billingActualAddressInputSchema,
};

const individualBillingProfileInputSchema = z
  .object({
    ...billingProfileInputCommonFields,
    kind: z.literal("individual"),
    inn: z
      .string()
      .regex(/^\d{12}$/)
      .nullable()
      .optional(),
  })
  .strict();
const selfEmployedBillingProfileInputSchema = z
  .object({
    ...billingProfileInputCommonFields,
    kind: z.literal("self_employed"),
    inn: z.string().regex(/^\d{12}$/),
  })
  .strict();
const soleProprietorBillingProfileInputSchema = z
  .object({
    ...billingProfileInputCommonFields,
    kind: z.literal("sole_proprietor"),
    inn: z.string().regex(/^\d{12}$/),
    ogrnip: z.string().regex(/^\d{15}$/),
  })
  .strict();
const legalEntityBillingProfileInputSchema = z
  .object({
    ...billingProfileInputCommonFields,
    kind: z.literal("legal_entity"),
    inn: z.string().regex(/^\d{10}$/),
    kpp: z.string().regex(/^\d{9}$/),
    ogrn: z.string().regex(/^\d{13}$/),
  })
  .strict();

export const currentBillingProfileInputSchema = z.discriminatedUnion("kind", [
  individualBillingProfileInputSchema,
  selfEmployedBillingProfileInputSchema,
  soleProprietorBillingProfileInputSchema,
  legalEntityBillingProfileInputSchema,
]);
export const currentOperatorBillingProfileInputSchema = currentBillingProfileInputSchema;
const legacyIndividualBillingProfileInputSchema = z
  .object({
    ...legacyBillingProfileInputCommonFields,
    kind: z.literal("individual"),
    inn: z
      .string()
      .regex(/^\d{12}$/)
      .nullable()
      .optional(),
  })
  .strict();
const legacySelfEmployedBillingProfileInputSchema = z
  .object({
    ...legacyBillingProfileInputCommonFields,
    kind: z.literal("self_employed"),
    inn: z.string().regex(/^\d{12}$/),
  })
  .strict();
const legacySoleProprietorBillingProfileInputSchema = z
  .object({
    ...legacyBillingProfileInputCommonFields,
    kind: z.literal("sole_proprietor"),
    inn: z.string().regex(/^\d{12}$/),
    ogrnip: z.string().regex(/^\d{15}$/),
  })
  .strict();
const legacyLegalEntityBillingProfileInputSchema = z
  .object({
    ...legacyBillingProfileInputCommonFields,
    kind: z.literal("legal_entity"),
    inn: z.string().regex(/^\d{10}$/),
    kpp: z.string().regex(/^\d{9}$/),
    ogrn: z.string().regex(/^\d{13}$/),
  })
  .strict();
const legacyBillingProfileInputSchema = z.discriminatedUnion("kind", [
  legacyIndividualBillingProfileInputSchema,
  legacySelfEmployedBillingProfileInputSchema,
  legacySoleProprietorBillingProfileInputSchema,
  legacyLegalEntityBillingProfileInputSchema,
]);

export const billingProfileInputSchema = z.union([
  currentBillingProfileInputSchema,
  legacyBillingProfileInputSchema,
]);
export const operatorBillingProfileInputSchema = z.union([
  currentBillingProfileInputSchema,
  legacyLegalEntityBillingProfileInputSchema,
]);

export const billingProfileSchema = z.object({
  id: platformUuidSchema,
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
  isCurrent: z.boolean(),
  isConfirmed: z.boolean(),
  confirmedByPlatformUserId: nullablePlatformUserIdSchema,
  confirmedAt: nullableResponseTimestampSchema,
  createdByPlatformUserId: nullablePlatformUserIdSchema,
  createdAt: responseTimestampSchema,
});
export const operatorBillingProfileSchema = billingProfileSchema;
export const tenantBillingProfileSchema = billingProfileSchema.extend({
  tenantId: platformTenantIdSchema,
});

export const bankAccountStatusSchema = z.enum(["active", "archived"]);
export const bankAccountInputSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    settlementAccount: z.string().regex(/^\d{20}$/),
    bic: z.string().regex(/^\d{9}$/),
    bankName: z.string().trim().min(1).max(500),
    correspondentAccount: z.string().regex(/^\d{20}$/),
    currency: z.literal("RUB"),
  })
  .strict();
export const bankAccountSchema = z
  .object({
    id: platformUuidSchema,
    label: z.string().min(1).max(200),
    settlementAccount: z.string().regex(/^\d{20}$/),
    bic: z.string().regex(/^\d{9}$/),
    bankName: z.string().min(1).max(500),
    correspondentAccount: z.string().regex(/^\d{20}$/),
    currency: z.literal("RUB"),
    status: bankAccountStatusSchema,
    isDefault: z.boolean(),
    migrationSourceProfileId: platformUuidSchema.nullable(),
    createdByPlatformUserId: platformUserIdSchema,
    archivedByPlatformUserId: nullablePlatformUserIdSchema,
    archivedAt: nullableResponseTimestampSchema,
    createdAt: responseTimestampSchema,
    updatedAt: responseTimestampSchema,
  })
  .strict();
export const operatorBankAccountSchema = bankAccountSchema;
export const tenantBankAccountSchema = bankAccountSchema.extend({
  tenantId: platformTenantIdSchema,
});

export const dadataSuggestionStatusSchema = z.enum([
  "ready",
  "unconfigured",
  "unavailable",
  "no_results",
]);
export const dadataAddressSuggestionSchema = normalizedBillingAddressSchema.strict();
export const dadataOrganizationSuggestionSchema = z
  .object({
    value: z.string().trim().min(1).max(1_000),
    kind: z.enum(["legal_entity", "sole_proprietor"]),
    fullName: z.string().trim().min(1).max(500),
    displayName: z.string().trim().min(1).max(300),
    inn: z.string().regex(/^\d{10}(?:\d{2})?$/),
    kpp: z
      .string()
      .regex(/^\d{9}$/)
      .nullable(),
    ogrn: z
      .string()
      .regex(/^\d{13}$/)
      .nullable(),
    ogrnip: z
      .string()
      .regex(/^\d{15}$/)
      .nullable(),
    legalAddress: dadataAddressSuggestionSchema.nullable(),
  })
  .strict();
export const dadataBankSuggestionSchema = z
  .object({
    value: z.string().trim().min(1).max(500),
    bic: z.string().regex(/^\d{9}$/),
    bankName: z.string().trim().min(1).max(500),
    correspondentAccount: z
      .string()
      .regex(/^\d{20}$/)
      .nullable(),
  })
  .strict();

const dadataResultSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      status: dadataSuggestionStatusSchema,
      items: z.array(item).max(20),
    })
    .strict();
export const dadataOrganizationResultSchema = dadataResultSchema(
  dadataOrganizationSuggestionSchema,
);
export const dadataAddressResultSchema = dadataResultSchema(dadataAddressSuggestionSchema);
export const dadataBankResultSchema = dadataResultSchema(dadataBankSuggestionSchema);
export const dadataStatusResponseSchema = z
  .object({ status: dadataSuggestionStatusSchema })
  .strict();
export const dadataSuggestionQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .transform((value) => value.replace(/\s+/g, " "))
      .pipe(z.string().min(3).max(300)),
  })
  .strict();
export const bankAccountArchiveSchema = z
  .object({
    replacementAccountId: platformUuidSchema.optional(),
  })
  .strict();

const bankAccountParamsSchema = z.object({ accountId: platformUuidSchema }).strict();
const tenantBankAccountParamsSchema = z
  .object({ tenantId: platformTenantIdSchema, accountId: platformUuidSchema })
  .strict();

export const offerActivationPolicySchema = z.enum(["immediately", "after_current"]);
export const invoiceActivationPolicySchema = z.enum(["immediate", "after_current", "manual"]);
export const commercialDocumentStatusSchema = z.enum(["pending", "ready", "failed"]);

const offerCreateLineSchema = z
  .object({
    kind: z.enum(["plan", "addon", "service"]),
    catalogVersionId: platformUuidSchema.nullable().optional(),
    nameRu: z.string().trim().min(1).max(300),
    nameEn: z.string().trim().min(1).max(300),
    descriptionRu: z.string().max(10_000).nullable().optional(),
    descriptionEn: z.string().max(10_000).nullable().optional(),
    quantity: positiveIntegerSchema,
    unit: z.string().trim().min(1).max(100),
    agreedUnitPrice: platformMoneySchema,
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean(),
    priceOverrideReason: z.string().trim().max(1_000).nullable().optional(),
    activationPolicy: offerActivationPolicySchema.nullable().optional(),
  })
  .strict();

export const offerCreateSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    sellerBankAccountId: platformUuidSchema.nullable().optional(),
    expiresAt: nullableRequestDateSchema.optional(),
    termsMarkdown: z.string().max(20_000).nullable().optional(),
    lines: z.array(offerCreateLineSchema).min(1).max(100),
  })
  .strict();

export const platformBillingRequestOfferCreateSchema = offerCreateSchema
  .omit({ tenantId: true })
  .extend({ idempotencyKey: platformUuidSchema })
  .strict();

export const offerPaymentSchema = z
  .object({
    amount: platformMoneySchema,
    currency: z.literal("RUB"),
    bankReference: z.string().trim().min(1).max(200),
  })
  .strict();

const offerRecordCommonSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    familyId: platformUuidSchema,
    revision: positiveIntegerSchema,
    previousRevisionId: platformUuidSchema.nullable(),
    sellerBankAccountId: platformUuidSchema.nullable().optional(),
    total: platformMoneySchema,
    expiresAt: nullableResponseTimestampSchema,
    termsMarkdown: z.string().max(20_000).nullable(),
    createdByPlatformUserId: nullablePlatformUserIdSchema,
    createdAt: responseTimestampSchema,
    updatedAt: responseTimestampSchema,
  })
  .strict();

const unpublishedOfferFields = {
  number: z.null(),
  publishedAt: z.null(),
  publishedByPlatformUserId: z.null(),
  paidAt: z.null(),
};
const publishedOfferFields = {
  number: z.string().min(1),
  publishedAt: responseTimestampSchema,
  publishedByPlatformUserId: platformUserIdSchema,
  paidAt: z.null(),
};
const paidOfferFields = {
  ...publishedOfferFields,
  paidAt: responseTimestampSchema,
};

const draftOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("draft"), ...unpublishedOfferFields })
  .strict();
const publishedOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("published"), ...publishedOfferFields })
  .strict();
const supersededOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("superseded"), ...publishedOfferFields })
  .strict();
const paidOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("paid"), ...paidOfferFields })
  .strict();
const cancelledOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("cancelled"), ...publishedOfferFields })
  .strict();
const expiredOfferSchema = offerRecordCommonSchema
  .extend({ status: z.literal("expired"), ...publishedOfferFields })
  .strict();

export const offerSchema = z.discriminatedUnion("status", [
  draftOfferSchema,
  publishedOfferSchema,
  supersededOfferSchema,
  paidOfferSchema,
  cancelledOfferSchema,
  expiredOfferSchema,
]);

export const offerServiceRecordSchema = offerRecordCommonSchema
  .extend({
    status: z.enum(["draft", "published", "superseded", "paid", "cancelled", "expired"]),
    number: z.string().min(1).nullable(),
    expiresAt: nullableServiceTimestampSchema,
    publishedAt: nullableServiceTimestampSchema,
    publishedByPlatformUserId: nullablePlatformUserIdSchema,
    paidAt: nullableServiceTimestampSchema,
    createdAt: serviceTimestampSchema,
    updatedAt: serviceTimestampSchema,
  })
  .strict();

const offerLineCommonSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    offerId: platformUuidSchema,
    position: positiveIntegerSchema,
    nameRu: z.string().min(1),
    nameEn: z.string().min(1),
    descriptionRu: z.string().nullable(),
    descriptionEn: z.string().nullable(),
    quantity: positiveIntegerSchema,
    unit: z.string().min(1),
    catalogUnitPrice: platformMoneySchema.nullable(),
    agreedUnitPrice: platformMoneySchema,
    vatRate: vatRateSchema,
    vatIncluded: z.boolean(),
    priceOverrideReason: z.string().nullable(),
    lineTotal: platformMoneySchema,
    createdAt: responseTimestampSchema,
  })
  .strict();

const planOfferLineSchema = offerLineCommonSchema
  .extend({
    kind: z.literal("plan"),
    catalogVersionId: platformUuidSchema,
    activationPolicy: offerActivationPolicySchema,
  })
  .strict();
const addonOfferLineSchema = offerLineCommonSchema
  .extend({
    kind: z.literal("addon"),
    catalogVersionId: platformUuidSchema,
    activationPolicy: z.null(),
  })
  .strict();
const serviceOfferLineSchema = offerLineCommonSchema
  .extend({
    kind: z.literal("service"),
    catalogVersionId: platformUuidSchema.nullable(),
    activationPolicy: z.null(),
  })
  .strict();

export const offerLineSchema = z.discriminatedUnion("kind", [
  planOfferLineSchema,
  addonOfferLineSchema,
  serviceOfferLineSchema,
]);

export const offerServiceLineSchema = offerLineCommonSchema
  .extend({
    kind: z.enum(["plan", "addon", "service"]),
    catalogVersionId: platformUuidSchema.nullable(),
    activationPolicy: offerActivationPolicySchema.nullable(),
    createdAt: serviceTimestampSchema,
  })
  .strict()
  .superRefine((line, context) => {
    if (line.kind === "plan" && (!line.catalogVersionId || !line.activationPolicy)) {
      context.addIssue({ code: "custom", message: "Plan offer lines require catalog and policy" });
    }
    if (line.kind === "addon" && (!line.catalogVersionId || line.activationPolicy !== null)) {
      context.addIssue({
        code: "custom",
        message: "Addon offer lines require catalog without policy",
      });
    }
    if (line.kind === "service" && line.activationPolicy !== null) {
      context.addIssue({ code: "custom", message: "Service offer lines cannot activate" });
    }
  });

export const offerServiceDetailSchema = offerServiceRecordSchema
  .extend({ lines: z.array(offerServiceLineSchema) })
  .strict();

const draftOfferDetailSchema = draftOfferSchema
  .extend({ lines: z.array(offerLineSchema) })
  .strict();
const publishedOfferDetailSchema = publishedOfferSchema
  .extend({ lines: z.array(offerLineSchema) })
  .strict();
const supersededOfferDetailSchema = supersededOfferSchema
  .extend({ lines: z.array(offerLineSchema) })
  .strict();
const paidOfferDetailSchema = paidOfferSchema.extend({ lines: z.array(offerLineSchema) }).strict();
const cancelledOfferDetailSchema = cancelledOfferSchema
  .extend({ lines: z.array(offerLineSchema) })
  .strict();
const expiredOfferDetailSchema = expiredOfferSchema
  .extend({ lines: z.array(offerLineSchema) })
  .strict();

export const offerDetailSchema = z.discriminatedUnion("status", [
  draftOfferDetailSchema,
  publishedOfferDetailSchema,
  supersededOfferDetailSchema,
  paidOfferDetailSchema,
  cancelledOfferDetailSchema,
  expiredOfferDetailSchema,
]);

const documentCommonFields = {
  id: platformUuidSchema,
  revision: positiveIntegerSchema,
  format: z.enum(["html", "pdf"]),
};
const pendingDocumentFields = {
  ...documentCommonFields,
  status: z.literal("pending"),
  contentType: z.null(),
  byteSize: z.null(),
  sha256: z.null(),
  errorCode: z.null(),
};
const readyDocumentFields = {
  ...documentCommonFields,
  status: z.literal("ready"),
  contentType: z.string().min(1),
  byteSize: nonNegativeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  errorCode: z.null(),
};
const failedDocumentFields = {
  ...documentCommonFields,
  status: z.literal("failed"),
  contentType: z.null(),
  byteSize: z.null(),
  sha256: z.null(),
  errorCode: z.string().min(1),
};

export const commercialDocumentSchema = z.discriminatedUnion("status", [
  z.object(pendingDocumentFields).strict(),
  z.object(readyDocumentFields).strict(),
  z.object(failedDocumentFields).strict(),
]);

export const commercialDocumentServiceSchema = z
  .object({
    ...documentCommonFields,
    format: z.string().min(1),
    status: z.string().min(1),
    contentType: z.string().min(1).nullable(),
    byteSize: nonNegativeIntegerSchema.nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    errorCode: z.string().min(1).nullable(),
  })
  .strict();

const listedDocumentTimestamps = {
  createdAt: responseTimestampSchema,
  updatedAt: responseTimestampSchema,
};
export const commercialDocumentListItemSchema = z.discriminatedUnion("status", [
  z.object({ ...pendingDocumentFields, ...listedDocumentTimestamps }).strict(),
  z.object({ ...readyDocumentFields, ...listedDocumentTimestamps }).strict(),
  z.object({ ...failedDocumentFields, ...listedDocumentTimestamps }).strict(),
]);
export const commercialDocumentListItemServiceSchema = commercialDocumentServiceSchema
  .extend({ createdAt: serviceTimestampSchema, updatedAt: serviceTimestampSchema })
  .strict();

const invoiceDocumentRecordFields = {
  tenantId: platformTenantIdSchema,
  invoiceId: platformUuidSchema,
  rendererVersion: z.string().min(1),
  ...listedDocumentTimestamps,
};
export const invoiceDocumentRecordSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...pendingDocumentFields,
      ...invoiceDocumentRecordFields,
      objectKey: z.null(),
    })
    .strict(),
  z
    .object({
      ...readyDocumentFields,
      ...invoiceDocumentRecordFields,
      objectKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...failedDocumentFields,
      ...invoiceDocumentRecordFields,
      objectKey: z.null(),
    })
    .strict(),
]);
export const invoiceDocumentRecordServiceSchema = commercialDocumentServiceSchema
  .extend({
    ...invoiceDocumentRecordFields,
    objectKey: z.string().min(1).nullable(),
    createdAt: serviceTimestampSchema,
    updatedAt: serviceTimestampSchema,
  })
  .strict();

export const commercialDocumentRenderResultSchema = z
  .object({
    revision: positiveIntegerSchema,
    documents: z.array(commercialDocumentSchema),
  })
  .strict();
export const commercialDocumentRenderServiceResultSchema = z
  .object({
    revision: positiveIntegerSchema,
    documents: z.array(commercialDocumentServiceSchema),
  })
  .strict();
export const commercialDocumentDownloadSchema = z.object({ url: z.url() }).strict();

const publishedOfferWithDocumentsSchema = publishedOfferDetailSchema
  .extend({ documents: commercialDocumentRenderResultSchema })
  .strict();

export const offerPaymentResultSchema = z
  .object({
    paymentId: platformUuidSchema,
    fulfilments: z.array(platformUuidSchema),
    subscriptionId: platformUuidSchema.optional(),
  })
  .strict();

export const billingRequestTypeSchema = z.enum([
  "renewal",
  "capacity_change",
  "additional_service",
  "documents",
  "other",
]);
export const platformBillingRequestStatusSchema = z.enum([
  "new",
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
]);
export const platformBillingRequestTargetStatusSchema = z.enum([
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
]);
const billingRequestResponsibleSideSchema = z.enum(["tenant", "markiro", "none"]);
const billingRequestEventKindSchema = z.enum([
  "created",
  "status_changed",
  "tenant_reply",
  "platform_comment",
  "offer_linked",
  "offer_accepted",
  "offer_changes_requested",
  "invoice_linked",
  "payment_confirmed",
  "service_linked",
  "act_linked",
]);
const billingActorKindSchema = z.enum(["tenant_user", "platform_user", "system"]);
const trimmedTextSchema = (maximum: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(maximum));

export const platformBillingRequestCommentSchema = z
  .object({
    message: trimmedTextSchema(2_000),
    idempotencyKey: platformUuidSchema,
  })
  .strict();
export const platformBillingRequestStatusMutationSchema = z
  .object({
    status: platformBillingRequestTargetStatusSchema,
    message: trimmedTextSchema(2_000).optional(),
    idempotencyKey: platformUuidSchema,
  })
  .strict();
const platformBillingRequestLinkCommon = {
  targetId: platformUuidSchema,
  idempotencyKey: platformUuidSchema,
};
export const platformBillingRequestLinkTypeSchema = z.enum([
  "offer",
  "invoice",
  "payment",
  "act",
  "ordered_service",
]);
export const platformBillingRequestLinkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), ...platformBillingRequestLinkCommon }).strict(),
  z.object({ type: z.literal("invoice"), ...platformBillingRequestLinkCommon }).strict(),
  z.object({ type: z.literal("payment"), ...platformBillingRequestLinkCommon }).strict(),
  z.object({ type: z.literal("act"), ...platformBillingRequestLinkCommon }).strict(),
  z.object({ type: z.literal("ordered_service"), ...platformBillingRequestLinkCommon }).strict(),
]);

export const platformBillingRequestEventSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    requestId: platformUuidSchema,
    kind: billingRequestEventKindSchema,
    fromStatus: platformBillingRequestStatusSchema.nullable(),
    toStatus: platformBillingRequestStatusSchema.nullable(),
    actorKind: billingActorKindSchema,
    actorUserId: z.string().min(1).nullable(),
    actorPlatformUserId: platformUserIdSchema.nullable(),
    message: z.string().nullable(),
    metadata: z.unknown().nullable(),
    createdAt: responseTimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    const actorShapeIsValid =
      (event.actorKind === "tenant_user" &&
        event.actorUserId !== null &&
        event.actorPlatformUserId === null) ||
      (event.actorKind === "platform_user" &&
        event.actorUserId === null &&
        event.actorPlatformUserId !== null) ||
      (event.actorKind === "system" &&
        event.actorUserId === null &&
        event.actorPlatformUserId === null);
    if (!actorShapeIsValid) {
      context.addIssue({ code: "custom", path: ["actorKind"], message: "Invalid event actor" });
    }
    if (
      event.kind === "status_changed" &&
      (event.fromStatus === null || event.toStatus === null || event.fromStatus === event.toStatus)
    ) {
      context.addIssue({
        code: "custom",
        path: ["toStatus"],
        message: "Status events require a real transition",
      });
    }
  });

export const platformBillingRequestLinkResponseSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    requestId: platformUuidSchema,
    type: platformBillingRequestLinkTypeSchema,
    targetId: platformUuidSchema,
    targetLabel: z.string().trim().min(1).max(1_000).nullable().default(null),
    targetHref: z.string().trim().startsWith("/").max(1_000).nullable().default(null),
    createdAt: responseTimestampSchema,
  })
  .strict();

const platformBillingRequestResolvedLinkSchema = platformBillingRequestLinkResponseSchema
  .extend({
    targetLabel: z.string().trim().min(1).max(1_000).nullable(),
    targetHref: z.string().trim().startsWith("/").max(1_000),
  })
  .strict();

export const platformBillingRequestLinkTargetQuerySchema = z
  .object({
    type: platformBillingRequestLinkTypeSchema,
    q: trimmedTextSchema(200),
  })
  .strict();
export const platformBillingRequestLinkTargetResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: platformUuidSchema,
          label: z.string().trim().min(1).max(1_000),
          href: z.string().trim().startsWith("/").max(1_000),
        })
        .strict(),
    ),
    truncated: z.boolean(),
  })
  .strict();

export const platformBillingRequestSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    tenantName: tenantDisplayNameSchema,
    number: z.string().min(1),
    type: billingRequestTypeSchema,
    status: platformBillingRequestStatusSchema,
    description: z.string().min(1).max(4_000),
    desiredAt: nullableResponseTimestampSchema,
    context: z
      .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) })
      .strict()
      .nullable(),
    responsibleSide: billingRequestResponsibleSideSchema,
    createdAt: responseTimestampSchema,
    updatedAt: responseTimestampSchema,
  })
  .strict();
export const platformBillingRequestListItemSchema = platformBillingRequestSchema
  .extend({
    latestEvent: platformBillingRequestEventSchema.nullable(),
    allowedTransitions: z.array(platformBillingRequestTargetStatusSchema),
  })
  .strict();
export const platformBillingRequestOfferActionSchema = z
  .object({
    offerId: platformUuidSchema,
    currentOfferId: platformUuidSchema,
    latestDecision: z.enum(["accepted", "changes_requested"]).nullable(),
    canRevise: z.boolean(),
    canCreateInvoice: z.boolean(),
  })
  .strict();
export const platformBillingRequestDetailSchema = platformBillingRequestSchema
  .extend({
    allowedTransitions: z.array(platformBillingRequestTargetStatusSchema),
    offerAction: platformBillingRequestOfferActionSchema.nullable(),
    events: z.array(platformBillingRequestEventSchema),
    links: z.array(platformBillingRequestResolvedLinkSchema),
  })
  .strict();
export const platformBillingRequestListQuerySchema = z
  .object({
    tenantId: platformTenantIdSchema.optional(),
    status: platformBillingRequestStatusSchema.optional(),
    type: billingRequestTypeSchema.optional(),
  })
  .strict();

export const offerReviseSchema = z.object({ idempotencyKey: platformUuidSchema }).strict();

const billingActIdempotencySchema = z.object({ idempotencyKey: platformUuidSchema }).strict();
export const billingActCreateSchema = z
  .object({
    tenantId: platformTenantIdSchema,
    requestId: platformUuidSchema.optional(),
    invoiceId: platformUuidSchema.optional(),
    orderedServiceId: platformUuidSchema.optional(),
    number: trimmedTextSchema(200),
    periodStart: billingCivilDateSchema,
    periodEnd: billingCivilDateSchema,
    idempotencyKey: platformUuidSchema,
  })
  .strict()
  .refine((act) => act.periodEnd >= act.periodStart, {
    path: ["periodEnd"],
    message: "Act period end must be on or after period start",
  });
export const billingActIssueSchema = billingActIdempotencySchema;
export const billingActCancelSchema = billingActIdempotencySchema;
export const billingActUploadMetadataSchema = z
  .object({
    contentType: z.literal("application/pdf"),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
  })
  .strict();
export const billingActUploadTooLargeErrorSchema = z
  .object({
    code: z.literal("billing_act_pdf_too_large"),
    message: z.literal("Billing act PDF exceeds the 5 MiB limit"),
    requestId: platformUuidSchema,
  })
  .strict();
export const billingActDocumentSchema = z.discriminatedUnion("state", [
  z
    .object({
      id: platformUuidSchema,
      revision: positiveIntegerSchema,
      state: z.literal("pending"),
      contentType: z.literal("application/pdf"),
      byteSize: positiveIntegerSchema.max(5 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      uploadedByPlatformUserId: platformUserIdSchema,
      readyAt: z.null(),
      createdAt: responseTimestampSchema,
      updatedAt: responseTimestampSchema,
    })
    .strict(),
  z
    .object({
      id: platformUuidSchema,
      revision: positiveIntegerSchema,
      state: z.literal("ready"),
      contentType: z.literal("application/pdf"),
      byteSize: positiveIntegerSchema.max(5 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      uploadedByPlatformUserId: platformUserIdSchema,
      readyAt: responseTimestampSchema,
      createdAt: responseTimestampSchema,
      updatedAt: responseTimestampSchema,
    })
    .strict(),
  z
    .object({
      id: platformUuidSchema,
      revision: positiveIntegerSchema,
      state: z.enum(["failed", "cleanup_required"]),
      contentType: z.literal("application/pdf"),
      byteSize: positiveIntegerSchema.max(5 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      uploadedByPlatformUserId: platformUserIdSchema,
      readyAt: z.null(),
      createdAt: responseTimestampSchema,
      updatedAt: responseTimestampSchema,
    })
    .strict(),
]);
export const billingActSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    requestId: platformUuidSchema.nullable(),
    invoiceId: platformUuidSchema.nullable(),
    orderedServiceId: platformUuidSchema.nullable(),
    number: z.string().min(1).max(200),
    status: z.enum(["draft", "issued", "cancelled"]),
    periodStart: billingCivilDateSchema,
    periodEnd: billingCivilDateSchema,
    createdByPlatformUserId: platformUserIdSchema,
    issuedByPlatformUserId: platformUserIdSchema.nullable(),
    issuedAt: nullableResponseTimestampSchema,
    cancelledByPlatformUserId: platformUserIdSchema.nullable(),
    cancelledAt: nullableResponseTimestampSchema,
    createdAt: responseTimestampSchema,
    updatedAt: responseTimestampSchema,
    document: billingActDocumentSchema.nullable(),
  })
  .strict()
  .superRefine((act, context) => {
    const issuedShape = act.issuedAt !== null && act.issuedByPlatformUserId !== null;
    const issuedFieldsMatch =
      (act.issuedAt === null && act.issuedByPlatformUserId === null) || issuedShape;
    const cancelledShape = act.cancelledAt !== null && act.cancelledByPlatformUserId !== null;
    const valid =
      (act.status === "draft" && !issuedShape && !cancelledShape) ||
      (act.status === "issued" &&
        issuedShape &&
        !cancelledShape &&
        act.document?.state === "ready") ||
      (act.status === "cancelled" && cancelledShape && issuedFieldsMatch);
    if (!valid) {
      context.addIssue({ code: "custom", path: ["status"], message: "Invalid act lifecycle" });
    }
  });

const invoiceCreateLineSchema = z
  .object({
    kind: z.enum(["plan", "addon", "service", "custom"]),
    catalogVersionId: platformUuidSchema.nullable().optional(),
    nameRu: z.string().trim().min(1).max(300).optional(),
    nameEn: z.string().trim().min(1).max(300).optional(),
    descriptionRu: z.string().max(10_000).nullable().optional(),
    descriptionEn: z.string().max(10_000).nullable().optional(),
    quantity: positiveIntegerSchema,
    unit: z.string().trim().min(1).max(100).optional(),
    catalogUnitPrice: platformMoneySchema.nullable().optional(),
    agreedUnitPrice: platformMoneySchema,
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean(),
    activationPolicy: invoiceActivationPolicySchema.nullable().optional(),
  })
  .strict();

const invoiceCreateCommonShape = {
  tenantId: platformTenantIdSchema,
  sellerBankAccountId: platformUuidSchema.nullable().optional(),
  dueDate: nullableRequestDateSchema.optional(),
  applicationMode: z.enum(["manual", "automatic"]),
  lines: z.array(invoiceCreateLineSchema).min(1).max(100),
} as const;

export const invoiceCreateSchema = z.union([
  z
    .object({
      ...invoiceCreateCommonShape,
      idempotencyKey: platformUuidSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...invoiceCreateCommonShape,
      idempotencyKey: platformUuidSchema,
      sourceOfferId: platformUuidSchema,
    })
    .strict(),
  z
    .object({
      ...invoiceCreateCommonShape,
      idempotencyKey: platformUuidSchema,
      sourceRequestId: platformUuidSchema,
    })
    .strict(),
  z
    .object({
      ...invoiceCreateCommonShape,
      idempotencyKey: platformUuidSchema,
      sourceOfferId: platformUuidSchema,
      sourceRequestId: platformUuidSchema,
    })
    .strict(),
]);

export const invoiceApplySchema = z
  .object({
    reason: z.string().trim().min(1).max(1_000),
    lines: z
      .array(
        z
          .object({
            lineId: platformUuidSchema,
            activationPolicy: z.enum(["immediate", "after_current"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, {
        message: "Invoice application lines must be unique",
      }),
  })
  .strict();

export const manualPaymentSchema = z
  .object({
    amount: platformMoneySchema,
    paidAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    bankReference: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const paymentImportSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    content: z.string().min(1).max(5_000_000),
  })
  .strict();

const invoiceRecordCommonSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    number: z.string().min(1),
    sellerBankAccountId: platformUuidSchema.nullable().optional(),
    sourceOfferId: platformUuidSchema.nullable().optional(),
    sourceRequestId: platformUuidSchema.nullable().optional(),
    dueDate: nullableResponseTimestampSchema,
    currency: z.literal("RUB"),
    subtotal: platformMoneySchema,
    vatTotal: platformMoneySchema,
    total: platformMoneySchema,
    applicationMode: z.enum(["manual", "automatic"]),
    createdByPlatformUserId: platformUserIdSchema,
    createdAt: responseTimestampSchema,
    updatedAt: responseTimestampSchema,
  })
  .strict();

const unissuedInvoiceFields = {
  issueDate: z.null(),
  sellerSnapshot: z.null(),
  buyerSnapshot: z.null(),
  sellerBankAccountSnapshot: z.null().optional(),
  buyerBankAccountSnapshot: z.null().optional(),
  issuedByPlatformUserId: z.null(),
  issuedAt: z.null(),
};
const issuedInvoiceFields = {
  issueDate: responseTimestampSchema,
  sellerSnapshot: nonNullUnknownSchema,
  buyerSnapshot: nonNullUnknownSchema,
  sellerBankAccountSnapshot: z.unknown().nullable().optional(),
  buyerBankAccountSnapshot: z.unknown().nullable().optional(),
  issuedByPlatformUserId: platformUserIdSchema,
  issuedAt: responseTimestampSchema,
};
const draftInvoiceSchema = invoiceRecordCommonSchema
  .extend({
    status: z.literal("draft"),
    ...unissuedInvoiceFields,
    paidAt: z.null(),
    cancelledAt: z.null(),
  })
  .strict();
const issuedInvoiceSchema = invoiceRecordCommonSchema
  .extend({
    status: z.literal("issued"),
    ...issuedInvoiceFields,
    paidAt: z.null(),
    cancelledAt: z.null(),
  })
  .strict();
const partiallyPaidInvoiceSchema = invoiceRecordCommonSchema
  .extend({
    status: z.literal("partially_paid"),
    ...issuedInvoiceFields,
    paidAt: z.null(),
    cancelledAt: z.null(),
  })
  .strict();
const paidInvoiceSchema = invoiceRecordCommonSchema
  .extend({
    status: z.literal("paid"),
    ...issuedInvoiceFields,
    paidAt: responseTimestampSchema,
    cancelledAt: z.null(),
  })
  .strict();
const cancelledInvoiceSchema = invoiceRecordCommonSchema
  .extend({
    status: z.literal("cancelled"),
    ...issuedInvoiceFields,
    paidAt: z.null(),
    cancelledAt: responseTimestampSchema,
  })
  .strict();

export const invoiceSchema = z.discriminatedUnion("status", [
  draftInvoiceSchema,
  issuedInvoiceSchema,
  partiallyPaidInvoiceSchema,
  paidInvoiceSchema,
  cancelledInvoiceSchema,
]);

const invoiceListItemSchema = z.discriminatedUnion("status", [
  draftInvoiceSchema.extend({ tenantName: tenantDisplayNameSchema }).strict(),
  issuedInvoiceSchema.extend({ tenantName: tenantDisplayNameSchema }).strict(),
  partiallyPaidInvoiceSchema.extend({ tenantName: tenantDisplayNameSchema }).strict(),
  paidInvoiceSchema.extend({ tenantName: tenantDisplayNameSchema }).strict(),
  cancelledInvoiceSchema.extend({ tenantName: tenantDisplayNameSchema }).strict(),
]);

export const invoiceServiceRecordSchema = invoiceRecordCommonSchema
  .extend({
    status: z.enum(["draft", "issued", "partially_paid", "paid", "cancelled"]),
    currency: z.string().min(1),
    issueDate: nullableServiceTimestampSchema,
    dueDate: nullableServiceTimestampSchema,
    sellerSnapshot: z.unknown().nullable(),
    buyerSnapshot: z.unknown().nullable(),
    sellerBankAccountSnapshot: z.unknown().nullable().optional(),
    buyerBankAccountSnapshot: z.unknown().nullable().optional(),
    issuedByPlatformUserId: nullablePlatformUserIdSchema,
    issuedAt: nullableServiceTimestampSchema,
    paidAt: nullableServiceTimestampSchema,
    cancelledAt: nullableServiceTimestampSchema,
    createdAt: serviceTimestampSchema,
    updatedAt: serviceTimestampSchema,
  })
  .strict();

const invoiceLineCommonSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    invoiceId: platformUuidSchema,
    position: positiveIntegerSchema,
    nameRu: z.string().min(1),
    nameEn: z.string().min(1),
    descriptionRu: z.string().nullable(),
    descriptionEn: z.string().nullable(),
    quantity: positiveIntegerSchema,
    unit: z.string().min(1),
    catalogUnitPrice: platformMoneySchema.nullable(),
    agreedUnitPrice: platformMoneySchema,
    vatRate: vatRateSchema,
    vatIncluded: z.boolean(),
    lineSubtotal: platformMoneySchema,
    lineVat: platformMoneySchema,
    lineTotal: platformMoneySchema,
    createdAt: responseTimestampSchema,
  })
  .strict();
const catalogInvoiceLineFields = {
  catalogVersionId: platformUuidSchema,
};
export const invoiceLineSchema = z.discriminatedUnion("kind", [
  invoiceLineCommonSchema
    .extend({
      kind: z.literal("plan"),
      ...catalogInvoiceLineFields,
      catalogKind: z.literal("plan"),
      activationPolicy: invoiceActivationPolicySchema,
    })
    .strict(),
  invoiceLineCommonSchema
    .extend({
      kind: z.literal("addon"),
      ...catalogInvoiceLineFields,
      catalogKind: z.literal("addon"),
      activationPolicy: invoiceActivationPolicySchema,
    })
    .strict(),
  invoiceLineCommonSchema
    .extend({
      kind: z.literal("service"),
      ...catalogInvoiceLineFields,
      catalogKind: z.literal("service"),
      activationPolicy: z.null(),
    })
    .strict(),
  invoiceLineCommonSchema
    .extend({
      kind: z.literal("custom"),
      catalogVersionId: z.null(),
      catalogKind: z.null(),
      activationPolicy: z.null(),
    })
    .strict(),
]);

export const invoiceServiceLineSchema = invoiceLineCommonSchema
  .extend({
    kind: z.string().min(1),
    catalogVersionId: platformUuidSchema.nullable(),
    catalogKind: z.string().min(1).nullable(),
    activationPolicy: z.string().min(1).nullable(),
    createdAt: serviceTimestampSchema,
  })
  .strict()
  .superRefine((line, context) => {
    if (line.kind === "custom") {
      if (line.catalogVersionId || line.catalogKind || line.activationPolicy) {
        context.addIssue({ code: "custom", message: "Custom invoice lines are literal" });
      }
      return;
    }
    if (!line.catalogVersionId || line.catalogKind !== line.kind) {
      context.addIssue({ code: "custom", message: "Catalog invoice line does not match version" });
    }
    if ((line.kind === "plan" || line.kind === "addon") && line.activationPolicy === null) {
      context.addIssue({ code: "custom", message: "Entitlement line requires activation policy" });
    }
    if (line.kind === "service" && line.activationPolicy !== null) {
      context.addIssue({ code: "custom", message: "Service invoice lines cannot activate" });
    }
  });

export const billingPaymentSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    invoiceId: platformUuidSchema,
    source: z.enum(["manual", "bank_import"]),
    paidAt: responseTimestampSchema,
    amount: platformMoneySchema,
    currency: z.literal("RUB"),
    bankReference: z.string().min(1),
    importRowId: platformUuidSchema.nullable(),
    platformUserId: platformUserIdSchema,
    idempotencyKey: z.string().min(1),
    createdAt: responseTimestampSchema,
  })
  .strict();
export const billingPaymentServiceSchema = billingPaymentSchema
  .extend({
    currency: z.string().min(1),
    paidAt: serviceTimestampSchema,
    createdAt: serviceTimestampSchema,
  })
  .strict();

export const invoicePaymentSummarySchema = z.strictObject({
  confirmedAmount: platformMoneySchema,
  remainingAmount: platformMoneySchema,
  status: z.enum(["issued", "partially_paid", "paid"]),
});

export const manualBillingPaymentSchema = billingPaymentSchema
  .extend({
    source: z.literal("manual"),
    importRowId: z.null(),
    invoiceStatus: invoicePaymentSummarySchema.shape.status,
    confirmedAmount: platformMoneySchema,
    remainingAmount: platformMoneySchema,
  })
  .strict()
  .superRefine((payment, context) => {
    const confirmed = moneyCents(payment.confirmedAmount);
    const remaining = moneyCents(payment.remainingAmount);
    if (
      !paymentSummaryStateIsValid(payment.invoiceStatus, confirmed, remaining) ||
      confirmed < moneyCents(payment.amount)
    ) {
      context.addIssue({
        code: "custom",
        path: ["invoiceStatus"],
        message: "Invoice status must match the confirmed and remaining amounts",
      });
    }
  });

const invoiceApplicationEventCommonSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    invoiceId: platformUuidSchema,
    invoiceLineId: platformUuidSchema,
    attempt: positiveIntegerSchema,
    kind: z.enum(["plan", "addon", "service", "custom"]),
    source: z.string().min(1),
    beforeSnapshot: z.unknown().nullable(),
    actorPlatformUserId: nullablePlatformUserIdSchema,
    createdAt: responseTimestampSchema,
  })
  .strict();

export const invoiceApplicationEventSchema = z.discriminatedUnion("status", [
  invoiceApplicationEventCommonSchema
    .extend({ status: z.literal("pending"), afterSnapshot: z.null(), errorCode: z.null() })
    .strict(),
  invoiceApplicationEventCommonSchema
    .extend({
      status: z.literal("applied"),
      afterSnapshot: nonNullUnknownSchema,
      errorCode: z.null(),
    })
    .strict(),
  invoiceApplicationEventCommonSchema
    .extend({
      status: z.literal("failed"),
      afterSnapshot: z.null(),
      errorCode: z.string().min(1),
    })
    .strict(),
  invoiceApplicationEventCommonSchema
    .extend({
      status: z.literal("skipped"),
      afterSnapshot: nonNullUnknownSchema,
      errorCode: z.null(),
    })
    .strict(),
]);

const invoiceApplicationEventServiceSchema = invoiceApplicationEventCommonSchema
  .extend({
    status: z.enum(["pending", "applied", "failed", "skipped"]),
    kind: z.string().min(1),
    afterSnapshot: z.unknown().nullable(),
    errorCode: z.string().nullable(),
    createdAt: serviceTimestampSchema,
  })
  .strict();

const unpaidInvoiceApplicationStateSchema = z
  .object({
    status: z.literal("not_paid"),
    latestByLine: z.array(invoiceApplicationEventSchema),
    attempts: z.array(invoiceApplicationEventSchema),
  })
  .strict();
const paidInvoiceApplicationStateSchema = z
  .object({
    status: z.enum(["pending", "partial_failure", "applied"]),
    latestByLine: z.array(invoiceApplicationEventSchema),
    attempts: z.array(invoiceApplicationEventSchema),
  })
  .strict();
const invoiceApplicationServiceStateSchema = z
  .object({
    status: z.enum(["not_paid", "pending", "partial_failure", "applied"]),
    latestByLine: z.array(invoiceApplicationEventServiceSchema),
    attempts: z.array(invoiceApplicationEventServiceSchema),
  })
  .strict();
const invoiceDetailRelationFields = {
  lines: z.array(invoiceLineSchema),
  documents: z.array(commercialDocumentListItemSchema),
};
const unpaidInvoiceDetailFields = {
  ...invoiceDetailRelationFields,
  payments: z.array(billingPaymentSchema).length(0),
  paymentSummary: invoicePaymentSummarySchema.extend({ status: z.literal("issued") }).strict(),
  application: unpaidInvoiceApplicationStateSchema,
};
const inactiveInvoiceDetailFields = {
  ...invoiceDetailRelationFields,
  payments: z.array(billingPaymentSchema).length(0),
  paymentSummary: z.null(),
  application: unpaidInvoiceApplicationStateSchema,
};
const partiallyPaidInvoiceDetailFields = {
  ...invoiceDetailRelationFields,
  payments: z.array(billingPaymentSchema).min(1),
  paymentSummary: invoicePaymentSummarySchema
    .extend({ status: z.literal("partially_paid") })
    .strict(),
  application: unpaidInvoiceApplicationStateSchema,
};
const paidInvoiceDetailFields = {
  ...invoiceDetailRelationFields,
  payments: z.array(billingPaymentSchema).min(1),
  paymentSummary: invoicePaymentSummarySchema.extend({ status: z.literal("paid") }).strict(),
  application: paidInvoiceApplicationStateSchema,
};
const draftInvoiceDetailSchema = draftInvoiceSchema
  .extend({ ...inactiveInvoiceDetailFields, tenantName: tenantDisplayNameSchema })
  .strict();
const issuedInvoiceDetailSchema = issuedInvoiceSchema
  .extend({ ...unpaidInvoiceDetailFields, tenantName: tenantDisplayNameSchema })
  .strict();
const partiallyPaidInvoiceDetailSchema = partiallyPaidInvoiceSchema
  .extend({ ...partiallyPaidInvoiceDetailFields, tenantName: tenantDisplayNameSchema })
  .strict();
const paidInvoiceDetailSchema = paidInvoiceSchema
  .extend({ ...paidInvoiceDetailFields, tenantName: tenantDisplayNameSchema })
  .strict();
const cancelledInvoiceDetailSchema = cancelledInvoiceSchema
  .extend({ ...inactiveInvoiceDetailFields, tenantName: tenantDisplayNameSchema })
  .strict();

export const invoiceDetailSchema = z
  .discriminatedUnion("status", [
    draftInvoiceDetailSchema,
    issuedInvoiceDetailSchema,
    partiallyPaidInvoiceDetailSchema,
    paidInvoiceDetailSchema,
    cancelledInvoiceDetailSchema,
  ])
  .superRefine((invoice, context) => {
    if (invoice.paymentSummary === null) return;
    const confirmed = invoice.payments.reduce(
      (sum, payment) => sum + moneyCents(payment.amount),
      0n,
    );
    const remaining = moneyCents(invoice.total) - confirmed;
    if (!paymentSummaryStateIsValid(invoice.paymentSummary.status, confirmed, remaining)) {
      context.addIssue({
        code: "custom",
        path: ["paymentSummary", "status"],
        message: "Payment summary status must match its amount boundaries",
      });
    }
    if (invoice.paymentSummary.confirmedAmount !== centsMoney(confirmed)) {
      context.addIssue({
        code: "custom",
        path: ["paymentSummary", "confirmedAmount"],
        message: "Confirmed amount must equal the payment aggregate",
      });
    }
    if (remaining < 0n || invoice.paymentSummary.remainingAmount !== centsMoney(remaining)) {
      context.addIssue({
        code: "custom",
        path: ["paymentSummary", "remainingAmount"],
        message: "Remaining amount must equal invoice total minus confirmed payments",
      });
    }
  });

function paymentSummaryStateIsValid(
  status: "issued" | "partially_paid" | "paid",
  confirmed: bigint,
  remaining: bigint,
): boolean {
  if (status === "issued") return confirmed === 0n && remaining >= 0n;
  if (status === "partially_paid") return confirmed > 0n && remaining > 0n;
  return confirmed > 0n && remaining === 0n;
}

export const invoiceServiceDetailSchema = invoiceServiceRecordSchema
  .extend({
    tenantName: tenantDisplayNameSchema,
    lines: z.array(invoiceServiceLineSchema),
    documents: z.array(commercialDocumentListItemServiceSchema),
    payments: z.array(billingPaymentServiceSchema),
    paymentSummary: invoicePaymentSummarySchema.nullable(),
    application: invoiceApplicationServiceStateSchema,
  })
  .strict();

export const invoiceListServiceRecordSchema = invoiceServiceRecordSchema
  .extend({ tenantName: tenantDisplayNameSchema })
  .strict();

const invoiceDeleteResultSchema = z
  .object({
    id: platformUuidSchema,
    tenantId: platformTenantIdSchema,
    number: z.string().min(1),
    deleted: z.literal(true),
  })
  .strict();

const draftInvoiceCreateResponseSchema = draftInvoiceSchema
  .extend({ lines: nonNegativeIntegerSchema })
  .strict();
export const invoiceCreateServiceResultSchema = invoiceServiceRecordSchema
  .extend({ lines: nonNegativeIntegerSchema })
  .strict();
const issuedInvoiceWithDocumentsSchema = issuedInvoiceSchema
  .extend({ documents: commercialDocumentRenderResultSchema })
  .strict();

const invoiceApplicationLineResultCommonSchema = z
  .object({
    lineId: platformUuidSchema,
    attempt: positiveIntegerSchema,
    kind: z.enum(["plan", "addon", "service", "custom"]),
  })
  .strict();
const invoiceApplicationLineResultSchema = z.discriminatedUnion("status", [
  invoiceApplicationLineResultCommonSchema
    .extend({ status: z.literal("pending"), result: z.null(), errorCode: z.null() })
    .strict(),
  invoiceApplicationLineResultCommonSchema
    .extend({ status: z.literal("applied"), result: nonNullUnknownSchema, errorCode: z.null() })
    .strict(),
  invoiceApplicationLineResultCommonSchema
    .extend({ status: z.literal("failed"), result: z.null(), errorCode: z.string().min(1) })
    .strict(),
  invoiceApplicationLineResultCommonSchema
    .extend({ status: z.literal("skipped"), result: nonNullUnknownSchema, errorCode: z.null() })
    .strict(),
]);

export const invoiceApplicationResultSchema = z
  .object({
    invoiceId: platformUuidSchema,
    status: z.enum(["pending", "applied", "partial_failure"]),
    results: z.array(invoiceApplicationLineResultSchema),
  })
  .strict();

export const paymentImportResultSchema = z
  .object({
    id: platformUuidSchema,
    source: z.literal("bank_import"),
    sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    fileName: z.string().max(255).nullable(),
    parserVersion: z.string().min(1),
    status: z.enum(["processing", "ready", "failed"]),
    rowCount: nonNegativeIntegerSchema,
    errorCount: nonNegativeIntegerSchema,
    createdByPlatformUserId: platformUserIdSchema,
    createdAt: responseTimestampSchema,
  })
  .strict();
export const paymentImportServiceResultSchema = paymentImportResultSchema
  .extend({
    source: z.enum(["manual", "bank_import"]),
    createdAt: serviceTimestampSchema,
  })
  .strict();

export const payerAccountEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("known"),
      last4: z.string().regex(/^\d{4}$/),
      accountStatus: bankAccountStatusSchema,
      label: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      last4: z.string().regex(/^\d{4}$/),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable"), last4: z.null() }).strict(),
]);

export const paymentMatchSchema = z
  .object({
    id: platformUuidSchema,
    importId: platformUuidSchema,
    importRowId: platformUuidSchema,
    sourceRowId: z.string().min(1).max(200),
    operationDate: nullableResponseTimestampSchema,
    amount: platformMoneySchema.nullable(),
    currency: z.string().max(10).nullable(),
    payerName: z.string().max(1_000).nullable(),
    paymentPurpose: z.string().max(5_000).nullable(),
    bankReference: z.string().max(1_000).nullable(),
    tenantId: platformTenantIdSchema.nullable(),
    invoiceId: platformUuidSchema.nullable(),
    invoiceNumber: z.string().min(1).nullable(),
    status: z.enum(["unmatched", "suggested", "matched", "rejected", "needs_review"]),
    score: z.number().int().min(0).max(100).nullable(),
    reason: z.string().max(1_000).nullable(),
    tenantBankAccountId: platformUuidSchema.nullable(),
    payerAccountEvidence: payerAccountEvidenceSchema.nullable(),
    decidedByPlatformUserId: nullablePlatformUserIdSchema,
    decidedAt: nullableResponseTimestampSchema,
    createdAt: responseTimestampSchema,
  })
  .strict();

export const paymentMatchServiceSchema = paymentMatchSchema
  .extend({
    operationDate: nullableServiceTimestampSchema,
    decidedAt: nullableServiceTimestampSchema,
    createdAt: serviceTimestampSchema,
  })
  .strict();

export const paymentMatchResolveSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("matched"),
      tenantId: platformTenantIdSchema,
      invoiceId: platformUuidSchema,
      tenantBankAccountId: platformUuidSchema.nullable(),
      reason: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      decision: z.literal("rejected"),
      reason: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);

const offerIdSchema = platformUuidSchema;
const invoiceIdSchema = platformUuidSchema;
const documentIdSchema = platformUuidSchema;

export const platformCommercialContracts = {
  billingProfiles: {
    operator: {
      get: { response: operatorBillingProfileSchema.nullable() },
      set: { body: operatorBillingProfileInputSchema, response: operatorBillingProfileSchema },
    },
    tenant: {
      get: { params: platformTenantIdSchema, response: tenantBillingProfileSchema.nullable() },
      set: {
        params: platformTenantIdSchema,
        body: billingProfileInputSchema,
        response: tenantBillingProfileSchema,
      },
    },
  },
  dadata: {
    organizations: {
      query: dadataSuggestionQuerySchema,
      response: dadataOrganizationResultSchema,
    },
    addresses: {
      query: dadataSuggestionQuerySchema,
      response: dadataAddressResultSchema,
    },
    banks: { query: dadataSuggestionQuerySchema, response: dadataBankResultSchema },
    status: { response: dadataStatusResponseSchema },
  },
  billingAccounts: {
    operator: {
      list: { response: z.array(operatorBankAccountSchema) },
      create: { body: bankAccountInputSchema, response: operatorBankAccountSchema },
      setDefault: { params: bankAccountParamsSchema, response: operatorBankAccountSchema },
      archive: {
        params: bankAccountParamsSchema,
        body: bankAccountArchiveSchema,
        response: operatorBankAccountSchema,
      },
    },
    tenant: {
      list: {
        params: z.object({ tenantId: platformTenantIdSchema }).strict(),
        response: z.array(tenantBankAccountSchema),
      },
      create: {
        params: z.object({ tenantId: platformTenantIdSchema }).strict(),
        body: bankAccountInputSchema,
        response: tenantBankAccountSchema,
      },
      setDefault: {
        params: tenantBankAccountParamsSchema,
        response: tenantBankAccountSchema,
      },
      archive: {
        params: tenantBankAccountParamsSchema,
        body: bankAccountArchiveSchema,
        response: tenantBankAccountSchema,
      },
    },
  },
  offers: {
    list: { response: z.array(offerSchema) },
    detail: { params: offerIdSchema, response: offerDetailSchema },
    create: { body: offerCreateSchema, response: draftOfferDetailSchema },
    revise: { params: offerIdSchema, body: offerReviseSchema, response: offerDetailSchema },
    publish: { params: offerIdSchema, response: publishedOfferWithDocumentsSchema },
    cancel: { params: offerIdSchema, response: cancelledOfferDetailSchema },
    payment: {
      params: offerIdSchema,
      body: offerPaymentSchema,
      response: offerPaymentResultSchema,
    },
    documents: {
      list: { params: offerIdSchema, response: z.array(commercialDocumentListItemSchema) },
      render: { params: offerIdSchema, response: commercialDocumentRenderResultSchema },
      download: {
        params: z.object({ offerId: offerIdSchema, documentId: documentIdSchema }).strict(),
        response: commercialDocumentDownloadSchema,
      },
    },
  },
  invoices: {
    list: { response: z.object({ items: z.array(invoiceListItemSchema) }).strict() },
    detail: { params: invoiceIdSchema, response: invoiceDetailSchema },
    create: { body: invoiceCreateSchema, response: draftInvoiceCreateResponseSchema },
    issue: { params: invoiceIdSchema, response: issuedInvoiceWithDocumentsSchema },
    document: { params: invoiceIdSchema, response: commercialDocumentRenderResultSchema },
    documentUrl: { params: invoiceIdSchema, response: commercialDocumentDownloadSchema },
    apply: {
      params: invoiceIdSchema,
      body: invoiceApplySchema,
      response: invoiceApplicationResultSchema,
    },
    cancel: { params: invoiceIdSchema, response: cancelledInvoiceSchema },
    delete: { params: invoiceIdSchema, response: invoiceDeleteResultSchema },
    documents: {
      list: { params: invoiceIdSchema, response: z.array(commercialDocumentListItemSchema) },
      render: { params: invoiceIdSchema, response: commercialDocumentRenderResultSchema },
      download: {
        params: z.object({ invoiceId: invoiceIdSchema, documentId: documentIdSchema }).strict(),
        response: commercialDocumentDownloadSchema,
      },
    },
  },
  billingRequests: {
    list: {
      query: platformBillingRequestListQuerySchema,
      response: z
        .object({
          items: z.array(platformBillingRequestListItemSchema),
          truncated: z.boolean(),
        })
        .strict(),
    },
    detail: { params: platformUuidSchema, response: platformBillingRequestDetailSchema },
    linkTargets: {
      params: platformUuidSchema,
      query: platformBillingRequestLinkTargetQuerySchema,
      response: platformBillingRequestLinkTargetResponseSchema,
    },
    createOffer: {
      params: platformUuidSchema,
      body: platformBillingRequestOfferCreateSchema,
      response: z
        .object({
          requestId: platformUuidSchema,
          tenantId: platformTenantIdSchema,
          offerId: platformUuidSchema,
          link: platformBillingRequestLinkResponseSchema,
        })
        .strict(),
    },
    comment: {
      params: platformUuidSchema,
      body: platformBillingRequestCommentSchema,
      response: platformBillingRequestEventSchema,
    },
    status: {
      params: platformUuidSchema,
      body: platformBillingRequestStatusMutationSchema,
      response: platformBillingRequestEventSchema,
    },
    link: {
      params: platformUuidSchema,
      body: platformBillingRequestLinkSchema,
      response: platformBillingRequestLinkResponseSchema,
    },
  },
  billingActs: {
    list: {
      query: z
        .object({
          tenantId: platformTenantIdSchema.optional(),
          status: z.enum(["draft", "issued", "cancelled"]).optional(),
        })
        .strict(),
      response: z.object({ items: z.array(billingActSchema) }).strict(),
    },
    detail: { params: platformUuidSchema, response: billingActSchema },
    create: { body: billingActCreateSchema, response: billingActSchema },
    issue: { params: platformUuidSchema, body: billingActIssueSchema, response: billingActSchema },
    cancel: {
      params: platformUuidSchema,
      body: billingActCancelSchema,
      response: billingActSchema,
    },
    document: billingActDocumentSchema,
    uploadMetadata: billingActUploadMetadataSchema,
  },
  payments: {
    list: { response: z.object({ items: z.array(billingPaymentSchema) }).strict() },
    matches: {
      list: { response: z.object({ items: z.array(paymentMatchSchema) }).strict() },
      resolve: {
        params: platformUuidSchema,
        body: paymentMatchResolveSchema,
        response: paymentMatchSchema,
      },
    },
    manual: {
      params: invoiceIdSchema,
      body: manualPaymentSchema,
      response: manualBillingPaymentSchema,
    },
    import: { body: paymentImportSchema, response: paymentImportResultSchema },
  },
} as const;

export type CreateOfferInput = z.input<typeof offerCreateSchema>;
export type CreateOfferDto = z.output<typeof offerCreateSchema>;
export type OfferPaymentInput = z.input<typeof offerPaymentSchema>;
export type OfferPaymentDto = z.output<typeof offerPaymentSchema>;
export type Offer = z.output<typeof offerSchema>;
export type OfferSource = z.input<typeof offerSchema>;
export type OfferServiceRecordSource = z.input<typeof offerServiceRecordSchema>;
export type OfferDetail = z.output<typeof offerDetailSchema>;
export type OfferDetailSource = z.input<typeof offerDetailSchema>;
export type OfferServiceDetailSource = z.input<typeof offerServiceDetailSchema>;
export type OfferPaymentResult = z.output<typeof offerPaymentResultSchema>;
export type OfferPaymentResultSource = z.input<typeof offerPaymentResultSchema>;
export type OfferReviseDto = z.output<typeof offerReviseSchema>;
export type CommercialDocument = z.output<typeof commercialDocumentSchema>;
export type CommercialDocumentSource = z.input<typeof commercialDocumentSchema>;
export type CommercialDocumentServiceSource = z.input<typeof commercialDocumentServiceSchema>;
export type CommercialDocumentListItem = z.output<typeof commercialDocumentListItemSchema>;
export type CommercialDocumentListItemSource = z.input<typeof commercialDocumentListItemSchema>;
export type CommercialDocumentListItemServiceSource = z.input<
  typeof commercialDocumentListItemServiceSchema
>;
export type CommercialDocumentRenderResult = z.output<typeof commercialDocumentRenderResultSchema>;
export type CommercialDocumentRenderResultSource = z.input<
  typeof commercialDocumentRenderResultSchema
>;
export type CommercialDocumentRenderServiceResultSource = z.input<
  typeof commercialDocumentRenderServiceResultSchema
>;
export type CommercialDocumentDownload = z.output<typeof commercialDocumentDownloadSchema>;
export type CommercialDocumentDownloadSource = z.input<typeof commercialDocumentDownloadSchema>;
export type CreateInvoiceInput = z.input<typeof invoiceCreateSchema>;
export type CreateInvoiceDto = z.output<typeof invoiceCreateSchema>;
export type ApplyInvoiceInput = z.input<typeof invoiceApplySchema>;
export type ApplyInvoiceDto = z.output<typeof invoiceApplySchema>;
export type Invoice = z.output<typeof invoiceListItemSchema>;
export type InvoiceSource = z.input<typeof invoiceListItemSchema>;
export type InvoiceServiceRecordSource = z.input<typeof invoiceServiceRecordSchema>;
export type InvoiceListServiceRecordSource = z.input<typeof invoiceListServiceRecordSchema>;
export type InvoiceDetail = z.output<typeof invoiceDetailSchema>;
export type InvoiceDetailSource = z.input<typeof invoiceDetailSchema>;
export type InvoiceServiceDetailSource = z.input<typeof invoiceServiceDetailSchema>;
export type InvoiceDeleteResult = z.output<typeof invoiceDeleteResultSchema>;
export type InvoiceCreateServiceResultSource = z.input<typeof invoiceCreateServiceResultSchema>;
export type InvoiceApplicationResult = z.output<typeof invoiceApplicationResultSchema>;
export type InvoiceApplicationResultSource = z.input<typeof invoiceApplicationResultSchema>;
export type ManualPaymentInput = z.input<typeof manualPaymentSchema>;
export type ManualPaymentDto = z.output<typeof manualPaymentSchema>;
export type BillingPayment = z.output<typeof billingPaymentSchema>;
export type BillingPaymentSource = z.input<typeof billingPaymentSchema>;
export type BillingPaymentServiceSource = z.input<typeof billingPaymentServiceSchema>;
export type InvoicePaymentSummary = z.output<typeof invoicePaymentSummarySchema>;
export type ManualBillingPayment = z.output<typeof manualBillingPaymentSchema>;
export type ManualBillingPaymentServiceResultSource = z.input<typeof manualBillingPaymentSchema>;
export type PaymentImportInput = z.input<typeof paymentImportSchema>;
export type PaymentImportDto = z.output<typeof paymentImportSchema>;
export type PaymentImportResult = z.output<typeof paymentImportResultSchema>;
export type PaymentImportResultSource = z.input<typeof paymentImportResultSchema>;
export type PaymentImportServiceResultSource = z.input<typeof paymentImportServiceResultSchema>;
export type PayerAccountEvidence = z.output<typeof payerAccountEvidenceSchema>;
export type PaymentMatch = z.output<typeof paymentMatchSchema>;
export type PaymentMatchServiceSource = z.input<typeof paymentMatchServiceSchema>;
export type PaymentMatchResolveInput = z.input<typeof paymentMatchResolveSchema>;
export type PaymentMatchResolveDto = z.output<typeof paymentMatchResolveSchema>;
export type PlatformBillingRequestListQueryDto = z.output<
  typeof platformBillingRequestListQuerySchema
>;
export type PlatformBillingRequestCommentDto = z.output<typeof platformBillingRequestCommentSchema>;
export type PlatformBillingRequestOfferCreateDto = z.output<
  typeof platformBillingRequestOfferCreateSchema
>;
export type PlatformBillingRequestStatusMutationDto = z.output<
  typeof platformBillingRequestStatusMutationSchema
>;
export type PlatformBillingRequestLinkDto = z.output<typeof platformBillingRequestLinkSchema>;
export type PlatformBillingRequestLinkTargetQueryDto = z.output<
  typeof platformBillingRequestLinkTargetQuerySchema
>;
export type PlatformBillingRequest = z.output<typeof platformBillingRequestSchema>;
export type PlatformBillingRequestEvent = z.output<typeof platformBillingRequestEventSchema>;
export type PlatformBillingRequestLink = z.output<typeof platformBillingRequestLinkResponseSchema>;
export type BillingActCreateDto = z.output<typeof billingActCreateSchema>;
export type BillingActIssueDto = z.output<typeof billingActIssueSchema>;
export type BillingActCancelDto = z.output<typeof billingActCancelSchema>;
export type BillingAct = z.output<typeof billingActSchema>;
export type BillingActDocument = z.output<typeof billingActDocumentSchema>;
export type BillingProfileInput = z.output<typeof currentBillingProfileInputSchema>;
export type OperatorBillingProfileInput = z.output<typeof currentOperatorBillingProfileInputSchema>;
export type CompatibleBillingProfileInput = z.output<typeof billingProfileInputSchema>;
export type CompatibleOperatorBillingProfileInput = z.output<
  typeof operatorBillingProfileInputSchema
>;
export type BillingProfile = z.output<typeof billingProfileSchema>;
export type OperatorBillingProfile = z.output<typeof operatorBillingProfileSchema>;
export type TenantBillingProfile = z.output<typeof tenantBillingProfileSchema>;
export type BankAccountStatus = z.output<typeof bankAccountStatusSchema>;
export type BankAccountInput = z.output<typeof bankAccountInputSchema>;
export type BankAccount = z.output<typeof bankAccountSchema>;
export type OperatorBankAccount = z.output<typeof operatorBankAccountSchema>;
export type TenantBankAccount = z.output<typeof tenantBankAccountSchema>;
export type BankAccountArchiveInput = z.output<typeof bankAccountArchiveSchema>;
export type DadataSuggestionStatus = z.output<typeof dadataSuggestionStatusSchema>;
export type DadataAddressSuggestion = z.output<typeof dadataAddressSuggestionSchema>;
export type DadataOrganizationSuggestion = z.output<typeof dadataOrganizationSuggestionSchema>;
export type DadataBankSuggestion = z.output<typeof dadataBankSuggestionSchema>;
