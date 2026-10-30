import { isValidInn } from "@markiro/domain";
import { z } from "zod";

import {
  platformNullableTimestampSchema,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

/**
 * Landing leads (spec 2026-10-20 §15): the public form contract `POST /api/landing-leads`
 * and the platform API of the «Заявки» section of the SaaS admin.
 */

/** Exact landing paths whose forms post to `/api/landing-leads` (spec §15.3). */
export const LANDING_LEAD_SOURCE_PATHS = ["/", "/skachat/", "/stoimost/"] as const;
export type LandingLeadSourcePath = (typeof LANDING_LEAD_SOURCE_PATHS)[number];

export const LANDING_LEAD_INTENTS = ["download", "invoice"] as const;
export type LandingLeadIntent = (typeof LANDING_LEAD_INTENTS)[number];

export const LANDING_LEAD_LINES_BUCKETS = ["1", "2-3", "4+"] as const;
export type LandingLeadLinesBucket = (typeof LANDING_LEAD_LINES_BUCKETS)[number];

export const LANDING_LEAD_STATUSES = [
  "new",
  "contacted",
  "trial",
  "invoice_sent",
  "won",
  "lost",
] as const;
export const landingLeadStatusSchema = z.enum(LANDING_LEAD_STATUSES);
export type LandingLeadStatus = z.infer<typeof landingLeadStatusSchema>;

export const LANDING_LEAD_EVENT_KINDS = [
  "download",
  "invoice_request",
  "demo_request",
  "status_change",
  "touch",
  "note",
  "linked_tenant",
  "activation_request",
  "anonymized",
] as const;
export const landingLeadEventKindSchema = z.enum(LANDING_LEAD_EVENT_KINDS);
export type LandingLeadEventKind = z.infer<typeof landingLeadEventKindSchema>;

/** The form kinds a lead can be filtered by. */
export const LANDING_LEAD_REQUEST_KINDS = ["download", "invoice_request", "demo_request"] as const;
export const landingLeadRequestKindSchema = z.enum(LANDING_LEAD_REQUEST_KINDS);
export type LandingLeadRequestKind = z.infer<typeof landingLeadRequestKindSchema>;

export const LANDING_LEAD_NOTE_MAX_LENGTH = 2_000;

/** Catalog plan code typed by the price page; the owner checks it when issuing the invoice. */
export const landingLeadTariffCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** An HTML form sends "" for an untouched optional field; it means "not given". */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === "" ? undefined : value));
}

const innSchema = z
  .string()
  .trim()
  .refine((value) => isValidInn(value), "inn");

export const landingLeadUtmSchema = z
  .object({
    source: optionalText(200),
    medium: optionalText(200),
    campaign: optionalText(200),
    content: optionalText(200),
    term: optionalText(200),
  })
  .strict();
export type LandingLeadUtm = z.infer<typeof landingLeadUtmSchema>;

export const landingLeadRequestSchema = z
  .object({
    requestId: z.uuid(),
    locale: z.enum(["ru", "en"]),
    sourcePath: z.enum(LANDING_LEAD_SOURCE_PATHS),
    intent: z.enum(LANDING_LEAD_INTENTS),
    email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
    /** Required on the download form; the invoice form asks for the INN instead. */
    company: optionalText(120),
    consentVersion: z.string().trim().min(1).max(64),
    /** Honeypot: must stay empty. */
    website: z.string().max(200),
    /** Accepted only for compatibility with cached legacy pages. */
    captchaToken: z.string().trim().min(1).max(4_096).optional(),
    name: optionalText(80),
    /** Raw input; the API normalizes it with the demo-request phone rules. */
    phone: optionalText(30),
    productGroup: optionalText(80),
    linesBucket: z.enum(LANDING_LEAD_LINES_BUCKETS).optional(),
    inn: z
      .union([z.literal(""), innSchema])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    tariffCode: z
      .union([z.literal(""), landingLeadTariffCodeSchema])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    // Accepted only for old clients; intake discards attribution before persistence.
    utm: landingLeadUtmSchema.optional(),
    referrer: optionalText(2_048),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent === "download") {
      if (value.company === undefined)
        context.addIssue({ code: "custom", path: ["company"], message: "company" });
      return;
    }
    if (value.inn === undefined)
      context.addIssue({ code: "custom", path: ["inn"], message: "inn" });
    if (value.tariffCode === undefined)
      context.addIssue({ code: "custom", path: ["tariffCode"], message: "tariffCode" });
  });
export type LandingLeadRequest = z.infer<typeof landingLeadRequestSchema>;
export type LandingLeadRequestInput = z.input<typeof landingLeadRequestSchema>;

export const landingLeadAcceptedSchema = z
  .object({ accepted: z.literal(true), requestId: z.uuid() })
  .strict();
export type LandingLeadAccepted = z.infer<typeof landingLeadAcceptedSchema>;

/** Public errors are reduced to `{ code }`, exactly like `/api/demo-requests`. */
export const LANDING_LEAD_PUBLIC_ERROR_CODES = [
  "invalid_request",
  "captcha_invalid",
  "captcha_unavailable",
  "rate_limited",
  "submission_disabled",
  "submission_unavailable",
] as const;

// ---------------------------------------------------------------- platform API

export const LANDING_LEAD_ERROR_CODES = [
  "lead_not_found",
  "lead_anonymized",
  "lead_tenant_not_found",
  "lead_tenant_slug_taken",
] as const;
export type LandingLeadErrorCode = (typeof LANDING_LEAD_ERROR_CODES)[number];

const civilDateSchema = z.iso.date();

export const platformLeadListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().trim().max(200).optional(),
    status: landingLeadStatusSchema.optional(),
    kind: landingLeadRequestKindSchema.optional(),
    /** Inclusive civil dates (Europe/Moscow) of the lead's creation. */
    from: civilDateSchema.optional(),
    to: civilDateSchema.optional(),
  })
  .strict();
export type PlatformLeadListQuery = z.infer<typeof platformLeadListQuerySchema>;
export type PlatformLeadListQueryInput = z.input<typeof platformLeadListQuerySchema>;

const lastEventSchema = z
  .object({ kind: landingLeadEventKindSchema, createdAt: platformTimestampSchema })
  .strict();

export const platformLeadListItemSchema = z
  .object({
    id: platformUuidSchema,
    company: z.string().min(1).max(300).nullable(),
    email: z.string().nullable(),
    inn: z.string().nullable(),
    status: landingLeadStatusSchema,
    nextTouchAt: platformNullableTimestampSchema,
    tariffCode: z.string().nullable(),
    lastEvent: lastEventSchema.nullable(),
    tenantId: platformTenantIdSchema.nullable(),
    anonymized: z.boolean(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type PlatformLeadListItem = z.infer<typeof platformLeadListItemSchema>;

export const platformLeadListResponseSchema = z
  .object({
    items: z.array(platformLeadListItemSchema).max(100),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export type PlatformLeadListResponse = z.infer<typeof platformLeadListResponseSchema>;

/** The menu badge: leads still in `new`. */
export const platformLeadSummarySchema = z
  .object({ newCount: z.number().int().nonnegative() })
  .strict();
export type PlatformLeadSummary = z.infer<typeof platformLeadSummarySchema>;

export const platformLeadEventSchema = z
  .object({
    id: platformUuidSchema,
    kind: landingLeadEventKindSchema,
    payload: z.record(z.string(), z.unknown()),
    actor: z
      .object({ id: z.string().min(1).max(128), name: z.string().nullable() })
      .strict()
      .nullable(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type PlatformLeadEvent = z.infer<typeof platformLeadEventSchema>;

export const platformLeadDetailSchema = z
  .object({
    id: platformUuidSchema,
    email: z.string().nullable(),
    company: z.string().min(1).max(300).nullable(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    inn: z.string().nullable(),
    productGroup: z.string().nullable(),
    linesBucket: z.enum(LANDING_LEAD_LINES_BUCKETS).nullable(),
    locale: z.enum(["ru", "en"]),
    status: landingLeadStatusSchema,
    statusChangedAt: platformTimestampSchema,
    nextTouchAt: platformNullableTimestampSchema,
    ownerNote: z.string().max(LANDING_LEAD_NOTE_MAX_LENGTH).nullable(),
    tariffCode: z.string().nullable(),
    firstSourcePath: z.string().min(1),
    firstUtm: z.record(z.string(), z.string()).nullable(),
    firstReferrer: z.string().nullable(),
    tenant: z
      .object({
        id: platformTenantIdSchema,
        name: z.string().min(1).max(300),
        cabinetAccess: z.enum(["enabled", "none"]),
      })
      .strict()
      .nullable(),
    anonymizedAt: platformNullableTimestampSchema,
    createdAt: platformTimestampSchema,
    updatedAt: platformTimestampSchema,
    events: z.array(platformLeadEventSchema).max(200),
  })
  .strict();
export type PlatformLeadDetail = z.infer<typeof platformLeadDetailSchema>;

export const platformLeadParamsSchema = z.object({ id: platformUuidSchema }).strict();

export const platformLeadUpdateSchema = z
  .object({
    status: landingLeadStatusSchema.optional(),
    ownerNote: z.string().trim().max(LANDING_LEAD_NOTE_MAX_LENGTH).nullable().optional(),
    nextTouchAt: platformTimestampSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.ownerNote !== undefined ||
      value.nextTouchAt !== undefined,
    { message: "empty" },
  );
export type PlatformLeadUpdate = z.infer<typeof platformLeadUpdateSchema>;
export type PlatformLeadUpdateInput = z.input<typeof platformLeadUpdateSchema>;

/** «Написал»: `contacted` plus the next touch, by default three days later (spec §15.5). */
export const LANDING_LEAD_DEFAULT_TOUCH_DAYS = 3;
export const platformLeadContactedSchema = z
  .object({ nextTouchAt: platformTimestampSchema.optional() })
  .strict();
export type PlatformLeadContacted = z.infer<typeof platformLeadContactedSchema>;

export const platformLeadLinkTenantSchema = z.object({ tenantId: platformTenantIdSchema }).strict();
export type PlatformLeadLinkTenant = z.infer<typeof platformLeadLinkTenantSchema>;

/** «Создать клиента без кабинета»: the same name/slug rules as tenant provisioning. */
export const platformLeadCreateTenantSchema = z
  .object({
    tenantName: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    tenantSlug: z
      .string()
      .trim()
      .max(128, "slugTooLong")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug"),
  })
  .strict();
export type PlatformLeadCreateTenant = z.infer<typeof platformLeadCreateTenantSchema>;

export const platformLeadContracts = {
  list: { query: platformLeadListQuerySchema, response: platformLeadListResponseSchema },
  summary: { response: platformLeadSummarySchema },
  detail: { params: platformLeadParamsSchema, response: platformLeadDetailSchema },
  update: {
    params: platformLeadParamsSchema,
    body: platformLeadUpdateSchema,
    response: platformLeadDetailSchema,
  },
  contacted: {
    params: platformLeadParamsSchema,
    body: platformLeadContactedSchema,
    response: platformLeadDetailSchema,
  },
  linkTenant: {
    params: platformLeadParamsSchema,
    body: platformLeadLinkTenantSchema,
    response: platformLeadDetailSchema,
  },
  createTenant: {
    params: platformLeadParamsSchema,
    body: platformLeadCreateTenantSchema,
    response: platformLeadDetailSchema,
  },
  anonymize: { params: platformLeadParamsSchema, response: platformLeadDetailSchema },
} as const;
