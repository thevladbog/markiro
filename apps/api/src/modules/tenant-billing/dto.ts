import { z } from "zod";

const billingUuidSchema = z.string().uuid();
const billingMoneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/, "Expected a decimal amount");
const billingDateSchema = z.string().datetime({ offset: true });
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

export const billingPaginationSchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .default({ limit: 50, offset: 0 });

export const tenantInvoiceStatusSchema = z.enum([
  "draft",
  "issued",
  "overdue",
  "partially_paid",
  "paid",
  "cancelled",
]);
export const invoicePaymentStatusSchema = z.enum(["issued", "partially_paid", "paid"]);
export const tenantOfferStatusSchema = z.enum([
  "draft",
  "published",
  "paid",
  "expired",
  "cancelled",
]);
export const tenantDocumentTypeSchema = z.enum(["offer", "act"]);
export const tenantDocumentStatusSchema = z.enum(["pending", "ready", "failed"]);

const paginationShape = billingPaginationSchema.unwrap().shape;

export const listInvoicesQuerySchema = z.strictObject({
  ...paginationShape,
  status: tenantInvoiceStatusSchema.optional(),
  from: billingCivilDateSchema.optional(),
  to: billingCivilDateSchema.optional(),
});

export const listDocumentsQuerySchema = z.strictObject({
  ...paginationShape,
  type: tenantDocumentTypeSchema.optional(),
  from: billingCivilDateSchema.optional(),
  to: billingCivilDateSchema.optional(),
});

export const billingIdParamsSchema = z.strictObject({ id: billingUuidSchema });
export const invoiceDocumentParamsSchema = z.strictObject({
  id: billingUuidSchema,
  documentId: billingUuidSchema,
});
export const offerDocumentParamsSchema = invoiceDocumentParamsSchema;
export const actDocumentParamsSchema = invoiceDocumentParamsSchema;

const paymentSummarySchema = z.strictObject({
  confirmedAmount: billingMoneySchema,
  remainingAmount: billingMoneySchema,
  status: invoicePaymentStatusSchema,
});

const paymentSchema = z.strictObject({
  id: billingUuidSchema,
  amount: billingMoneySchema,
  currency: z.literal("RUB"),
  paidAt: billingDateSchema,
});

const documentSchema = z.strictObject({
  id: billingUuidSchema,
  revision: z.number().int().positive(),
  format: z.enum(["pdf", "html"]),
  status: tenantDocumentStatusSchema,
  contentType: z.string().nullable(),
  byteSize: z.number().int().positive().nullable(),
  createdAt: billingDateSchema,
});

export const tenantInvoiceSchema = z.strictObject({
  id: billingUuidSchema,
  number: z.string(),
  status: tenantInvoiceStatusSchema,
  issueDate: billingDateSchema.nullable(),
  dueDate: billingDateSchema.nullable(),
  total: billingMoneySchema,
  currency: z.literal("RUB"),
  paymentSummary: paymentSummarySchema.nullable(),
});

export const tenantInvoiceDetailSchema = tenantInvoiceSchema.extend({
  subtotal: billingMoneySchema,
  vatTotal: billingMoneySchema,
  payments: z.array(paymentSchema),
  lines: z.array(
    z.strictObject({
      id: billingUuidSchema,
      position: z.number().int().positive(),
      nameRu: z.string(),
      unit: z.string(),
      quantity: z.number().int().positive(),
      agreedUnitPrice: billingMoneySchema,
      lineTotal: billingMoneySchema,
    }),
  ),
  documents: z.array(documentSchema),
  request: z
    .strictObject({ id: billingUuidSchema, number: z.string(), status: z.string() })
    .nullable(),
});

export const tenantOfferDetailSchema = z.strictObject({
  id: billingUuidSchema,
  number: z.string().nullable(),
  status: tenantOfferStatusSchema,
  total: billingMoneySchema,
  expiresAt: billingDateSchema.nullable(),
  publishedAt: billingDateSchema.nullable(),
  paidAt: billingDateSchema.nullable(),
  termsMarkdown: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      id: billingUuidSchema,
      position: z.number().int().positive(),
      kind: z.enum(["plan", "addon", "service"]),
      nameRu: z.string(),
      quantity: z.number().int().positive(),
      unit: z.string(),
      agreedUnitPrice: billingMoneySchema,
      lineTotal: billingMoneySchema,
    }),
  ),
  documents: z.array(documentSchema),
  request: z
    .strictObject({ id: billingUuidSchema, number: z.string(), status: z.string() })
    .nullable(),
});

export const tenantDocumentSchema = z.strictObject({
  id: billingUuidSchema,
  type: tenantDocumentTypeSchema,
  entityId: billingUuidSchema,
  revision: z.number().int().positive(),
  format: z.enum(["pdf", "html"]),
  status: tenantDocumentStatusSchema,
  contentType: z.string().nullable(),
  byteSize: z.number().int().positive().nullable(),
  createdAt: billingDateSchema,
});

const subscriptionSchema = z.strictObject({
  id: billingUuidSchema,
  planVersionId: billingUuidSchema,
  status: z.enum([
    "pending_activation",
    "trial",
    "active",
    "scheduled",
    "expired",
    "cancelled",
    "superseded",
  ]),
  startsAt: billingDateSchema.nullable(),
  endsAt: billingDateSchema.nullable(),
  planName: z.string().nullable(),
});

export const tenantSubscriptionBillingSchema = z.strictObject({
  subscription: subscriptionSchema.nullable(),
  scheduledSubscription: subscriptionSchema.nullable(),
  access: z.enum(["managed", "read_only", "unmanaged"]),
  limits: z.strictObject({
    lines: z.number().int().nullable(),
    stations: z.number().int().nullable(),
    kiosks: z.number().int().nullable(),
    cabinetUsers: z.number().int().nullable(),
    labelEditor: z.boolean(),
    publicApi: z.boolean(),
    pallets: z.boolean(),
  }),
});

export const tenantBillingOverviewSchema = tenantSubscriptionBillingSchema.extend({
  actionableOffer: z
    .strictObject({
      id: billingUuidSchema,
      number: z.string().nullable(),
      total: billingMoneySchema,
    })
    .nullable(),
  recentOperations: z.array(
    z.strictObject({
      id: billingUuidSchema,
      kind: z.enum(["invoice", "offer", "request", "service", "act"]),
      status: z.string(),
      occurredAt: billingDateSchema,
      label: z.string(),
    }),
  ),
  activeRequest: z
    .strictObject({ id: billingUuidSchema, number: z.string(), status: z.string() })
    .nullable(),
  attentionCount: z.number().int().nonnegative(),
});

export const privateDownloadSchema = z.strictObject({ url: z.string().url() });

export type ListInvoicesQueryDto = z.infer<typeof listInvoicesQuerySchema>;
export type ListDocumentsQueryDto = z.infer<typeof listDocumentsQuerySchema>;
export type TenantInvoiceDto = z.infer<typeof tenantInvoiceSchema>;
export type TenantInvoiceDetailDto = z.infer<typeof tenantInvoiceDetailSchema>;
export type TenantOfferDetailDto = z.infer<typeof tenantOfferDetailSchema>;
export type TenantDocumentDto = z.infer<typeof tenantDocumentSchema>;
export type TenantSubscriptionBillingDto = z.infer<typeof tenantSubscriptionBillingSchema>;
export type TenantBillingOverviewDto = z.infer<typeof tenantBillingOverviewSchema>;
export type PrivateDownloadDto = z.infer<typeof privateDownloadSchema>;
