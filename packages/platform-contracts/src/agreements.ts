import { z } from "zod";

import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

export const agreementStatusSchema = z.enum(["draft", "in_review", "sent", "signed", "terminated"]);
export type AgreementStatus = z.infer<typeof agreementStatusSchema>;

/**
 * Free movement among the editable statuses: a client asking for changes
 * after the agreement was sent is the normal path, not an exception. Nothing
 * returns from `signed`, because the printed document is frozen there.
 */
export const AGREEMENT_TRANSITIONS = {
  draft: ["in_review", "sent"],
  in_review: ["draft", "sent"],
  sent: ["draft", "in_review", "signed"],
  signed: ["terminated"],
  terminated: [],
} as const satisfies Record<AgreementStatus, readonly AgreementStatus[]>;

export const AGREEMENT_EDITABLE_STATUSES = ["draft", "in_review", "sent"] as const;

export function isAgreementTransitionAllowed(from: AgreementStatus, to: AgreementStatus): boolean {
  return (AGREEMENT_TRANSITIONS[from] as readonly AgreementStatus[]).includes(to);
}

export function isAgreementEditable(status: AgreementStatus): boolean {
  return (AGREEMENT_EDITABLE_STATUSES as readonly AgreementStatus[]).includes(status);
}

const commonRequisites = {
  name: z.string().trim().min(1).max(500),
  address: z.string().trim().min(1).max(1_000).nullable(),
  email: z.email().max(254).nullable(),
  phone: z.string().trim().min(1).max(64).nullable(),
  bankName: z.string().trim().min(1).max(300).nullable(),
  bic: z
    .string()
    .regex(/^\d{9}$/)
    .nullable(),
  settlementAccount: z
    .string()
    .regex(/^\d{20}$/)
    .nullable(),
  correspondentAccount: z
    .string()
    .regex(/^\d{20}$/)
    .nullable(),
};

const individualRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("individual"),
    inn: z
      .string()
      .regex(/^\d{12}$/)
      .nullable(),
  })
  .strict();
const selfEmployedRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("self_employed"),
    inn: z.string().regex(/^\d{12}$/),
  })
  .strict();
const soleProprietorRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("sole_proprietor"),
    inn: z.string().regex(/^\d{12}$/),
    ogrnip: z.string().regex(/^\d{15}$/),
  })
  .strict();
const legalEntityRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("legal_entity"),
    inn: z.string().regex(/^\d{10}$/),
    kpp: z.string().regex(/^\d{9}$/),
    ogrn: z.string().regex(/^\d{13}$/),
  })
  .strict();

export const agreementRequisitesSchema = z.discriminatedUnion("kind", [
  individualRequisites,
  selfEmployedRequisites,
  soleProprietorRequisites,
  legalEntityRequisites,
]);
export type AgreementRequisitesInput = z.infer<typeof agreementRequisitesSchema>;

export const agreementSignatorySchema = z
  .object({
    position: z.string().trim().min(1).max(300).nullable(),
    fullName: z.string().trim().min(1).max(300).nullable(),
    authorityBasis: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const agreementTermsSchema = z
  .object({
    disputeVenue: z.string().trim().min(1).max(500).nullable(),
    penaltyRatePercent: z
      .string()
      .regex(/^\d{1,2}(,\d{1,3})?$/)
      .nullable(),
    penaltyCapPercent: z
      .string()
      .regex(/^\d{1,3}(,\d{1,2})?$/)
      .nullable(),
  })
  .strict();

const agreementSummarySchema = z
  .object({
    id: platformUuidSchema,
    number: z.string(),
    status: agreementStatusSchema,
    counterpartyName: z.string(),
    counterpartyInn: z.string().nullable(),
    conclusionDate: z.string().nullable(),
    tenantId: platformTenantIdSchema.nullable(),
    signedAt: platformTimestampSchema.nullable(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type AgreementSummary = z.infer<typeof agreementSummarySchema>;

export const agreementDocumentKindSchema = z.enum(["draft", "generated", "attachment"]);

const agreementDocumentSchema = z
  .object({
    id: platformUuidSchema,
    kind: agreementDocumentKindSchema,
    filename: z.string(),
    mediaType: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().positive(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type AgreementDocument = z.infer<typeof agreementDocumentSchema>;

const agreementDetailSchema = agreementSummarySchema
  .extend({
    city: z.string().nullable(),
    counterparty: agreementRequisitesSchema,
    contractor: agreementRequisitesSchema,
    signatory: agreementSignatorySchema,
    terms: agreementTermsSchema,
    terminatedAt: platformTimestampSchema.nullable(),
    terminationReason: z.string().nullable(),
    editable: z.boolean(),
    documents: z.array(agreementDocumentSchema).readonly(),
  })
  .strict();
export type AgreementDetail = z.infer<typeof agreementDetailSchema>;

const createBody = z
  .object({
    number: z.string().trim().min(1).max(120).optional(),
    conclusionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    city: z.string().trim().min(1).max(200).optional(),
    counterparty: agreementRequisitesSchema,
    signatory: agreementSignatorySchema.optional(),
    terms: agreementTermsSchema.optional(),
  })
  .strict();
export type CreateAgreementInput = z.infer<typeof createBody>;

const updateBody = z
  .object({
    number: z.string().trim().min(1).max(120).optional(),
    conclusionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    city: z.string().trim().min(1).max(200).nullable().optional(),
    counterparty: agreementRequisitesSchema.optional(),
    signatory: agreementSignatorySchema.optional(),
    terms: agreementTermsSchema.optional(),
  })
  .strict();
export type UpdateAgreementInput = z.infer<typeof updateBody>;

const transitionBody = z
  .object({
    status: agreementStatusSchema,
    terminationReason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "terminated" && !value.terminationReason) {
      context.addIssue({
        code: "custom",
        path: ["terminationReason"],
        message: "Termination requires a reason",
      });
    }
    if (value.status !== "terminated" && value.terminationReason) {
      context.addIssue({
        code: "custom",
        path: ["terminationReason"],
        message: "Only termination accepts a reason",
      });
    }
  });

const listQuery = z
  .object({
    status: agreementStatusSchema.optional(),
    // Not z.coerce.boolean(): that maps every non-empty string to true, so
    // ?withoutTenant=false would filter as if it were true.
    withoutTenant: z
      .union([z.boolean(), z.literal("true"), z.literal("false")])
      .transform((value) => value === true || value === "true")
      .optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AgreementListQuery = z.infer<typeof listQuery>;

const detailResponse = z.object({ agreement: agreementDetailSchema }).strict();

// There is no `documents.list`: the detail response already embeds the
// document rows, and a second endpoint would be a second source of truth.
export const platformAgreementContracts = {
  list: {
    query: listQuery,
    response: z.object({ agreements: z.array(agreementSummarySchema).readonly() }).strict(),
  },
  detail: { params: platformUuidSchema, response: detailResponse },
  create: { body: createBody, response: detailResponse },
  update: { params: platformUuidSchema, body: updateBody, response: detailResponse },
  transition: { params: platformUuidSchema, body: transitionBody, response: detailResponse },
  linkTenant: {
    params: platformUuidSchema,
    body: z.object({ tenantId: platformTenantIdSchema }).strict(),
    response: detailResponse,
  },
  unlinkTenant: { params: platformUuidSchema, response: detailResponse },
  tenantCandidates: {
    params: platformUuidSchema,
    response: z
      .object({
        candidates: z
          .array(
            z
              .object({
                tenantId: platformTenantIdSchema,
                name: z.string(),
                inn: z.string().nullable(),
              })
              .strict(),
          )
          .readonly(),
      })
      .strict(),
  },
  documents: {
    render: {
      params: platformUuidSchema,
      response: z.object({ document: agreementDocumentSchema }).strict(),
    },
    download: {
      params: z.object({ id: platformUuidSchema, documentId: platformUuidSchema }).strict(),
      response: z.object({ url: z.url() }).strict(),
    },
  },
  attachments: {
    upload: {
      params: platformUuidSchema,
      response: z.object({ document: agreementDocumentSchema }).strict(),
    },
    delete: {
      params: z.object({ id: platformUuidSchema, documentId: platformUuidSchema }).strict(),
      response: z.object({ deleted: z.literal(true) }).strict(),
    },
  },
} as const;
