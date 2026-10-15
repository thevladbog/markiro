import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";
import { standaloneSites } from "./standalone-licenses.js";

const HOST_KEY = sql`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/**
 * The history of support diagnostics of «Markiro Автоном» sites (plan ДИАГ):
 * one row per accepted token. The token and the pasted text are never stored —
 * `payload` is the validated plaintext, enough to recompute the aggregates.
 * Idempotent by the token's SHA-256 (globally) and by the exact generated
 * instant per host (a re-made report from the same moment is a repeat).
 */
export const standaloneSupportDiagnostics = pgTable(
  "standalone_support_diagnostics",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    siteId: uuid("site_id"),
    hostKey: text("host_key").notNull(),
    blobSha256: text("blob_sha256").notNull(),
    kid: text("kid").notNull(),
    payloadVersion: smallint("payload_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    receivedByPlatformUserId: text("received_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    appVersion: text("app_version"),
    hostVersion: text("host_version"),
    pcRole: text("pc_role"),
    devicesStation: integer("devices_station").notNull(),
    devicesOffice: integer("devices_office").notNull(),
    devicesHandheld: integer("devices_handheld").notNull(),
    license: jsonb("license").$type<Record<string, unknown>>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    unique("standalone_support_diagnostics_tenant_id_uq").on(t.tenantId, t.id),
    unique("standalone_support_diagnostics_blob_uq").on(t.blobSha256),
    unique("standalone_support_diagnostics_host_generated_uq").on(
      t.tenantId,
      t.hostKey,
      t.generatedAt,
    ),
    index("standalone_support_diagnostics_tenant_generated_idx").on(
      t.tenantId,
      t.generatedAt.desc(),
      t.id.desc(),
    ),
    index("standalone_support_diagnostics_tenant_host_generated_idx").on(
      t.tenantId,
      t.hostKey,
      t.generatedAt.desc(),
    ),
    index("standalone_support_diagnostics_received_idx").on(t.receivedAt),
    foreignKey({
      name: "standalone_support_diagnostics_tenant_site_fk",
      columns: [t.tenantId, t.siteId],
      foreignColumns: [standaloneSites.tenantId, standaloneSites.id],
    }),
    check(
      "standalone_support_diagnostics_host_key_check",
      sql`${t.hostKey} = 'unknown' or ${t.hostKey} ~ ${HOST_KEY}`,
    ),
    check("standalone_support_diagnostics_blob_check", sql`${t.blobSha256} ~ '^[0-9a-f]{64}$'`),
    check("standalone_support_diagnostics_kid_check", sql`length(${t.kid}) between 1 and 32`),
    check("standalone_support_diagnostics_version_check", sql`${t.payloadVersion} in (1, 2)`),
    check(
      "standalone_support_diagnostics_versions_check",
      sql`(${t.appVersion} is null or length(${t.appVersion}) <= 64) and (${t.hostVersion} is null or length(${t.hostVersion}) <= 64)`,
    ),
    check(
      "standalone_support_diagnostics_role_check",
      sql`${t.pcRole} is null or ${t.pcRole} in ('host', 'station', 'office')`,
    ),
    check(
      "standalone_support_diagnostics_devices_check",
      sql`${t.devicesStation} >= 0 and ${t.devicesOffice} >= 0 and ${t.devicesHandheld} >= 0`,
    ),
    check(
      "standalone_support_diagnostics_json_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 65536 and (${t.license} is null or (jsonb_typeof(${t.license}) = 'object' and octet_length(${t.license}::text) <= 8192))`,
    ),
  ],
);

/** The newest report's counts per tenant, host and calendar month. */
export const standaloneSupportUsageMonths = pgTable(
  "standalone_support_usage_months",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    hostKey: text("host_key").notNull(),
    month: text("month").notNull(),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull(),
    sourceDiagnosticId: uuid("source_diagnostic_id").notNull(),
    sourceGeneratedAt: timestamp("source_generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "standalone_support_usage_months_pkey",
      columns: [t.tenantId, t.hostKey, t.month],
    }),
    foreignKey({
      name: "standalone_support_usage_months_source_fk",
      columns: [t.tenantId, t.sourceDiagnosticId],
      foreignColumns: [standaloneSupportDiagnostics.tenantId, standaloneSupportDiagnostics.id],
    }).onDelete("cascade"),
    check(
      "standalone_support_usage_months_host_key_check",
      sql`${t.hostKey} = 'unknown' or ${t.hostKey} ~ ${HOST_KEY}`,
    ),
    check(
      "standalone_support_usage_months_month_check",
      sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "standalone_support_usage_months_stats_check",
      sql`jsonb_typeof(${t.stats}) = 'object' and octet_length(${t.stats}::text) <= 4096`,
    ),
  ],
);

/**
 * A token hash reserved for a report it did not create: a token re-made for the same host and
 * instant is a repeat of that report, and its hash belongs to the report's tenant exactly as the
 * first token's (`blob_sha256`) does. Goes with the report (retention, tenant deletion).
 */
export const standaloneSupportTokenAliases = pgTable(
  "standalone_support_token_aliases",
  {
    blobSha256: text("blob_sha256").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    diagnosticId: uuid("diagnostic_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "standalone_support_token_aliases_diagnostic_fk",
      columns: [t.tenantId, t.diagnosticId],
      foreignColumns: [standaloneSupportDiagnostics.tenantId, standaloneSupportDiagnostics.id],
    }).onDelete("cascade"),
    index("standalone_support_token_aliases_diagnostic_idx").on(t.tenantId, t.diagnosticId),
    check("standalone_support_token_aliases_blob_check", sql`${t.blobSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
