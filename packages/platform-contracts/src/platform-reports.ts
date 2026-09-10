import { z } from "zod";

import {
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

export const platformReportTypeSchema = z.enum([
  "shifts",
  "shift_operators",
  "inventories",
  "summary",
  "commerceml",
]);
export const platformReportPeriodBasisSchema = z.enum(["events", "production_date"]);
export const platformReportPrivacySchema = z.enum(["identified", "pseudonymous", "aggregate"]);
export const platformReportStatusSchema = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
]);
export const platformReportErrorCodeSchema = z.enum([
  "REPORT_LIMIT_EXCEEDED",
  "REPORT_INVALID_PARAMETERS",
  "REPORT_PERMISSION_REVOKED",
  "REPORT_SOURCE_FAILED",
  "REPORT_SOURCE_TIMEOUT",
  "REPORT_STORAGE_FAILED",
  "REPORT_RETRY_EXHAUSTED",
  "REPORT_GENERATION_FAILED",
]);

const calendarDateSchema = z.iso.date().refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
}, "Invalid calendar date");

const ianaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    if (/^[+-]\d{2}:?\d{2}$/.test(value)) return false;
    try {
      return (
        new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone.length > 0
      );
    } catch {
      return false;
    }
  }, "Invalid IANA timezone");

const distinctTenantIdsSchema = z
  .array(platformTenantIdSchema)
  .min(1)
  .max(10)
  .refine((tenantIds) => new Set(tenantIds).size === tenantIds.length, "Duplicate tenant IDs");

export const platformReportInputSchema = z
  .object({
    reportType: platformReportTypeSchema,
    tenantIds: distinctTenantIdsSchema,
    fromDate: calendarDateSchema,
    toDate: calendarDateSchema,
    timezone: ianaTimezoneSchema,
    periodBasis: platformReportPeriodBasisSchema,
    privacy: platformReportPrivacySchema,
    lineId: platformUuidSchema.optional(),
    productId: platformUuidSchema.optional(),
    gtin14: z
      .string()
      .regex(/^\d{14}$/)
      .optional(),
    operatorId: platformUuidSchema.optional(),
    status: z
      .enum([
        "planned",
        "active",
        "closed",
        "draft",
        "preparing",
        "ready",
        "cancelled",
        "running",
        "completed",
      ])
      .optional(),
    outcome: z.enum(["ok", "warn", "error"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const from = Date.parse(`${value.fromDate}T00:00:00Z`);
    const to = Date.parse(`${value.toDate}T00:00:00Z`);
    const inclusiveDays = (to - from) / 86_400_000 + 1;
    if (to < from) {
      context.addIssue({ code: "custom", path: ["toDate"], message: "toDate precedes fromDate" });
    } else if (inclusiveDays > 366) {
      context.addIssue({ code: "custom", path: ["toDate"], message: "Period exceeds 366 days" });
    }

    if (
      value.periodBasis === "production_date" &&
      !["shifts", "shift_operators"].includes(value.reportType)
    ) {
      context.addIssue({
        code: "custom",
        path: ["periodBasis"],
        message: "Period basis is not supported",
      });
    }
    if (value.operatorId && !["shifts", "shift_operators"].includes(value.reportType)) {
      context.addIssue({
        code: "custom",
        path: ["operatorId"],
        message: "Operator filter is not supported",
      });
    }
    if (value.privacy === "aggregate" && value.operatorId) {
      context.addIssue({
        code: "custom",
        path: ["operatorId"],
        message: "Aggregate reports cannot filter operators",
      });
    }
    if (value.reportType === "commerceml") {
      for (const filter of ["lineId", "productId", "gtin14", "operatorId", "status"] as const) {
        if (value[filter] !== undefined) {
          context.addIssue({ code: "custom", path: [filter], message: "Filter is not supported" });
        }
      }
    } else if (value.outcome !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Outcome is CommerceML-only",
      });
    }
    if (value.reportType === "summary" && value.status !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Summary status is ambiguous",
      });
    }
    if (
      ["shifts", "shift_operators"].includes(value.reportType) &&
      value.status !== undefined &&
      !["planned", "active", "closed"].includes(value.status)
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "Invalid shift status" });
    }
    if (
      value.reportType === "inventories" &&
      value.status !== undefined &&
      !["draft", "preparing", "ready", "cancelled", "running", "closed", "completed"].includes(
        value.status,
      )
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "Invalid inventory status" });
    }
  });
export type PlatformReportInput = z.infer<typeof platformReportInputSchema>;

export const platformReportCreateSchema = platformReportInputSchema.extend({
  idempotencyKey: platformUuidSchema,
});

export const platformReportSchema = z
  .object({
    id: platformUuidSchema,
    parameters: platformReportInputSchema,
    status: platformReportStatusSchema,
    createdAt: platformTimestampSchema,
    snapshotAt: platformTimestampSchema.nullable(),
    completedAt: platformTimestampSchema.nullable(),
    expiresAt: platformTimestampSchema,
    errorCode: platformReportErrorCodeSchema.nullable(),
    rowCount: z.number().int().nonnegative().nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    filename: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();
export type PlatformReport = z.infer<typeof platformReportSchema>;

const reportParamsSchema = z.object({ id: platformUuidSchema }).strict();
const reportListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const platformReportContracts = {
  options: {
    query: z
      .object({
        tenantIds: z
          .union([platformTenantIdSchema, distinctTenantIdsSchema])
          .transform((value) => (typeof value === "string" ? [value] : value)),
        kind: z.enum(["lines", "products", "operators"]),
        search: z.string().trim().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    response: z
      .object({
        items: z.array(
          z
            .object({ id: platformUuidSchema, name: z.string(), tenantId: platformTenantIdSchema })
            .strict(),
        ),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  },
  create: { body: platformReportCreateSchema, response: platformReportSchema },
  list: {
    query: reportListQuerySchema,
    response: z
      .object({
        items: z.array(platformReportSchema),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  },
  download: {
    params: reportParamsSchema,
    response: z
      .object({
        url: z.url(),
        filename: z.string().trim().min(1).max(255),
        expiresInSeconds: z.number().int().min(1).max(300),
      })
      .strict(),
  },
} as const;
