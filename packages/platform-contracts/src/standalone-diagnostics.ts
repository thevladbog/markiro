import { z } from "zod";
import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";
import {
  standaloneMonthKeySchema,
  standaloneSupportLicenseSchema,
  standaloneUsageMonthSchema,
  standaloneUsageTotalsSchema,
} from "./standalone-support.js";

/** Plan ДИАГ: the operator pastes a support text, the API opens its token and keeps history and statistics. */
export const STANDALONE_DIAGNOSTICS_ERROR_CODES = [
  "standalone_diagnostics_not_configured",
  "standalone_diagnostics_text_too_large",
  "standalone_diagnostics_no_token",
  "standalone_diagnostics_token_malformed",
  "standalone_diagnostics_token_too_large",
  "standalone_diagnostics_unknown_key",
  "standalone_diagnostics_undecryptable",
  "standalone_diagnostics_payload_too_large",
  "standalone_diagnostics_payload_invalid",
  "standalone_diagnostics_generated_in_future",
  "standalone_diagnostics_host_other_tenant",
  "standalone_diagnostics_host_unbound",
  "standalone_diagnostics_token_conflict",
  "standalone_diagnostics_cursor_invalid",
] as const;
export type StandaloneDiagnosticsErrorCode = (typeof STANDALONE_DIAGNOSTICS_ERROR_CODES)[number];

/** The longest pasted text (characters); a real support text is 2-4 KiB. */
export const STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS = 32_768;

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A host, or `unknown` for beta 3 texts that carry no host id. */
export const standaloneHostKeySchema = z.union([
  z.literal("unknown"),
  z.string().regex(UUID_LOWER),
]);
const versionText = z.string().min(1).max(64).nullable();
const systemText = z.string().min(1).max(120).nullable();
const devicesSchema = z
  .object({
    station: z.number().int().nonnegative(),
    office: z.number().int().nonnegative(),
    handheld: z.number().int().nonnegative(),
  })
  .strict();

export const standaloneDiagnosticsIngestRequestSchema = z
  .object({ text: z.string().min(1), acknowledgeUnboundHost: z.boolean().optional() })
  .strict();
export type StandaloneDiagnosticsIngestRequest = z.infer<
  typeof standaloneDiagnosticsIngestRequestSchema
>;

export const standaloneDiagnosticSummarySchema = z
  .object({
    id: platformUuidSchema,
    hostKey: standaloneHostKeySchema,
    siteId: platformUuidSchema.nullable(),
    generatedAt: platformTimestampSchema,
    receivedAt: platformTimestampSchema,
    kid: z.string().min(1).max(32),
    payloadVersion: z.union([z.literal(1), z.literal(2)]),
    appVersion: versionText,
    hostVersion: versionText,
    pcRole: z.enum(["host", "station", "office"]).nullable(),
    os: systemText,
    arch: systemText,
    webview: systemText,
    licenseState: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type StandaloneDiagnosticSummary = z.infer<typeof standaloneDiagnosticSummarySchema>;

export const standaloneDiagnosticsIngestResponseSchema = z
  .object({
    duplicate: z.boolean(),
    diagnostic: standaloneDiagnosticSummarySchema,
    monthsApplied: z.number().int().nonnegative().max(12),
    monthsSkipped: z.number().int().nonnegative().max(12),
  })
  .strict();
export type StandaloneDiagnosticsIngestResponse = z.infer<
  typeof standaloneDiagnosticsIngestResponseSchema
>;

export const standaloneDiagnosticsHistoryQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^([1-9]|[1-4][0-9]|50)$/)
      .optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
  })
  .strict();
export type StandaloneDiagnosticsHistoryQuery = z.infer<
  typeof standaloneDiagnosticsHistoryQuerySchema
>;

export const standaloneDiagnosticsHistorySchema = z
  .object({
    items: z.array(standaloneDiagnosticSummarySchema).max(50),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .nullable(),
  })
  .strict();
export type StandaloneDiagnosticsHistory = z.infer<typeof standaloneDiagnosticsHistorySchema>;

export const standaloneDiagnosticsHostSchema = z
  .object({
    hostKey: standaloneHostKeySchema,
    siteId: platformUuidSchema.nullable(),
    siteName: z.string().nullable(),
    last: standaloneDiagnosticSummarySchema,
    license: standaloneSupportLicenseSchema.nullable(),
    devices: devicesSchema,
    /** The newest file the cloud issued for the site, to compare with the PC's file. */
    cloudLicense: z
      .object({
        sequence: z.number().int().positive(),
        validUntil: platformTimestampSchema,
      })
      .strict()
      .nullable(),
    /** `null` while no published build is known (plan ДИАГ, Р7). */
    outdated: z.boolean().nullable(),
  })
  .strict();
export const standaloneDiagnosticsOverviewSchema = z
  .object({
    hosts: z.array(standaloneDiagnosticsHostSchema).max(200),
    latestPublishedVersion: versionText,
  })
  .strict();
export type StandaloneDiagnosticsOverview = z.infer<typeof standaloneDiagnosticsOverviewSchema>;

export const standaloneDiagnosticsStatisticsQuerySchema = z
  .object({
    hostKey: standaloneHostKeySchema.optional(),
    from: standaloneMonthKeySchema.optional(),
    to: standaloneMonthKeySchema.optional(),
  })
  .strict();
export type StandaloneDiagnosticsStatisticsQuery = z.infer<
  typeof standaloneDiagnosticsStatisticsQuerySchema
>;

export const standaloneDiagnosticsStatisticsSchema = z
  .object({
    hosts: z.array(standaloneHostKeySchema).max(200),
    /** The sum covers several hosts of one tenant (a rebind counts twice for a month both reported). */
    multipleHosts: z.boolean(),
    months: z
      .array(
        z
          .object({
            month: standaloneMonthKeySchema,
            hostCount: z.number().int().positive(),
            stats: standaloneUsageTotalsSchema,
          })
          .strict(),
      )
      .max(2400),
  })
  .strict();
export type StandaloneDiagnosticsStatistics = z.infer<typeof standaloneDiagnosticsStatisticsSchema>;

export const standaloneDiagnosticDetailSchema = z
  .object({
    diagnostic: standaloneDiagnosticSummarySchema,
    devices: devicesSchema,
    months: z.array(standaloneUsageMonthSchema).max(12),
    license: standaloneSupportLicenseSchema.nullable(),
  })
  .strict();
export type StandaloneDiagnosticDetail = z.infer<typeof standaloneDiagnosticDetailSchema>;

const base = "/platform/tenants/:tenantId/standalone-diagnostics";
export const platformStandaloneDiagnosticsContracts = {
  ingest: {
    method: "POST",
    path: base,
    body: standaloneDiagnosticsIngestRequestSchema,
    response: standaloneDiagnosticsIngestResponseSchema,
  },
  history: {
    method: "GET",
    path: base,
    query: standaloneDiagnosticsHistoryQuerySchema,
    response: standaloneDiagnosticsHistorySchema,
  },
  overview: {
    method: "GET",
    path: `${base}/overview`,
    response: standaloneDiagnosticsOverviewSchema,
  },
  statistics: {
    method: "GET",
    path: `${base}/statistics`,
    query: standaloneDiagnosticsStatisticsQuerySchema,
    response: standaloneDiagnosticsStatisticsSchema,
  },
  detail: {
    method: "GET",
    path: `${base}/:diagnosticId`,
    response: standaloneDiagnosticDetailSchema,
  },
} as const;
